import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, randomBytes, toBase64Url, toHex, utf8 } from "./bytes";
import { canonicalJson } from "./canonical";
import { LIMITS, PASEO_RPC_MAX_BYTES, RPC_FRAME_MARGIN } from "./limits";

export const SEAL_INFO = "paseo-secure-input/v1";
export const PAD_BLOCK = 1024;
/** The tag ChaCha20-Poly1305 adds to the ciphertext. */
export const AEAD_TAG_BYTES = 16;

/** A text field's value, as it was typed. */
export interface Entry {
  key: string;
  value: string;
}

/** A file field's content: the bytes of the file, as base64url. */
export interface FileEntry {
  key: string;
  file: string;
}

/** One entry of a submission: a text, or a file. */
export type PayloadEntry = Entry | FileEntry;

export interface SealedEnvelope {
  v: 1;
  epk: string;
  nonce: string;
  ct: string;
}

export interface RequestKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export class SealError extends Error {}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function deriveKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  if (shared.every((byte) => byte === 0)) throw new SealError("degenerate shared secret");
  return hkdf(sha256, shared, concat(ephemeralPublic, recipientPublic), utf8.encode(SEAL_INFO), 32);
}

/** A key pair for one request. The secret key it drew is wiped if the public key cannot be derived from it: nobody else holds it yet. */
export function generateRequestKeyPair(): RequestKeyPair {
  const secretKey = randomBytes(32);
  try {
    return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
  } catch (error) {
    secretKey.fill(0);
    throw error;
  }
}

/**
 * Seal to a one-time recipient key. A fresh ephemeral key per call makes the AEAD key single-use.
 * Every secret this call creates is wiped on every exit, and no library message escapes: the ephemeral key is drawn
 * inside the guard too, so a host without usable randomness is a sealing failure like any other and not a raw
 * error of the platform.
 */
export function seal(recipientPublic: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): SealedEnvelope {
  let ephemeral: RequestKeyPair | undefined;
  let shared: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    ephemeral = generateRequestKeyPair();
    shared = x25519.getSharedSecret(ephemeral.secretKey, recipientPublic);
    key = deriveKey(shared, ephemeral.publicKey, recipientPublic);
    const nonce = randomBytes(12);
    const ciphertext = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return { v: 1, epk: toBase64Url(ephemeral.publicKey), nonce: toBase64Url(nonce), ct: toBase64Url(ciphertext) };
  } catch (error) {
    // Library messages are not ours to vouch for; never forward them.
    throw new SealError(error instanceof SealError ? error.message : "sealing failed");
  } finally {
    ephemeral?.secretKey.fill(0);
    shared?.fill(0);
    key?.fill(0);
  }
}

export function open(secretKey: Uint8Array, envelope: SealedEnvelope, aad: Uint8Array): Uint8Array {
  let shared: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    if (envelope.v !== 1) throw new SealError("unsupported envelope version");
    const ephemeralPublic = fromBase64Url(envelope.epk);
    const nonce = fromBase64Url(envelope.nonce);
    if (ephemeralPublic.length !== 32 || nonce.length !== 12) throw new SealError("malformed envelope");
    shared = x25519.getSharedSecret(secretKey, ephemeralPublic);
    key = deriveKey(shared, ephemeralPublic, x25519.getPublicKey(secretKey));
    return chacha20poly1305(key, nonce, aad).decrypt(fromBase64Url(envelope.ct));
  } catch (error) {
    // Library messages are not ours to vouch for; never forward them.
    throw new SealError(error instanceof SealError ? error.message : "authentication failed");
  } finally {
    shared?.fill(0);
    key?.fill(0);
  }
}

/**
 * Binds a ciphertext to one request and to what it asked for: the digest of its declared keys and whether each is
 * optional (`requestDigestOf` in the registry). The server builds this from its own record, the app from the view.
 */
export function buildAad(requestId: string, requestDigest: string): Uint8Array {
  // canonicalJson drops undefined properties, so a missing digest would otherwise yield an AAD with no digest in it.
  if (typeof requestId !== "string" || requestId === "" || typeof requestDigest !== "string" || requestDigest === "") {
    throw new SealError("malformed binding");
  }
  return utf8.encode(canonicalJson({ v: 2, requestId, requestDigest }));
}

/** The letter the padding is made of. */
const PAD_LETTER = "x";

/** A control character is one byte of UTF-8 and six of canonical JSON (`\u0001`): the worst a byte of a text can grow to. */
const WORST_JSON_BYTES_PER_BYTE = 6;

/** How long the unpadded base64url of `bytes` bytes is: three bytes make four characters, a remainder of n bytes makes n + 1. */
function base64UrlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** The frame of a payload with no entry, and of each kind of entry with an empty key and nothing in it: `{"pad":"","values":[]}` and the like. */
const FRAME_BYTES = canonicalJson({ pad: "", values: [] }).length;
const TEXT_ENTRY_BYTES = canonicalJson({ key: "", value: "" }).length;
const FILE_ENTRY_BYTES = canonicalJson({ file: "", key: "" }).length;
/** What the quotes of an empty string add, which the frames above count once for each string. */
const QUOTES = 2;

/**
 * The most a payload may be. Two bounds, and the smaller one with it, rounded down to a block:
 *
 * - what the per-field limits allow: `LIMITS.fields` entries, each with a key of `LIMITS.key` and the larger of the two
 *   kinds at their worst (a text of `LIMITS.valueBytes`, every byte written as six; a file of `LIMITS.fileBytes`, as
 *   base64url), in the encoder's frame and padded to a block as the encoder pads it;
 * - what one Paseo RPC carries: its bytes less the frame of the fulfil call, as the base64url of a ciphertext, less the
 *   tag the cipher adds.
 *
 * Here and not in `./limits`, because it is measured on the encoder's frame. A test seals a payload of this size and
 * holds the RPC that carries it to `PASEO_RPC_MAX_BYTES`.
 */
function largestPayload(): number {
  const text = TEXT_ENTRY_BYTES + WORST_JSON_BYTES_PER_BYTE * LIMITS.valueBytes;
  const file = FILE_ENTRY_BYTES + base64UrlLength(LIMITS.fileBytes);
  const entries = LIMITS.fields * (LIMITS.key + Math.max(text, file)) + (LIMITS.fields - 1);
  const allowed = Math.ceil((FRAME_BYTES + entries) / PAD_BLOCK) * PAD_BLOCK;
  const carried = Math.floor(((PASEO_RPC_MAX_BYTES - RPC_FRAME_MARGIN) * 3) / 4) - AEAD_TAG_BYTES;
  return Math.min(allowed, Math.floor(carried / PAD_BLOCK) * PAD_BLOCK);
}

/** The largest padded payload one submission may have: a multiple of `PAD_BLOCK` (see `largestPayload`). */
export const MAX_PAYLOAD_BYTES = largestPayload();

function isFileEntry(entry: PayloadEntry): entry is FileEntry {
  return typeof (entry as Partial<FileEntry>).file === "string";
}

/**
 * How many bytes of UTF-8 the JSON of `text` takes, quotes included, as `JSON.stringify` writes it: `"` and `\` and the
 * five control characters that have a short escape take two, every other control character and every surrogate with
 * no partner six (`\u0001`, `\ud800`); every other character its UTF-8, a well-formed pair four. Nothing is built.
 */
function jsonTextBytes(text: string): number {
  let bytes = QUOTES;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/**
 * The size `encodeValues` would give these entries, padding included, without building the payload: no copy of a value
 * is made to measure it. The app says it before anything is sealed; the encoder refuses on it.
 */
export function payloadSize(values: readonly PayloadEntry[]): number {
  let bytes = FRAME_BYTES + Math.max(0, values.length - 1);
  for (const entry of values) {
    bytes += isFileEntry(entry)
      ? FILE_ENTRY_BYTES - 2 * QUOTES + jsonTextBytes(entry.file) + jsonTextBytes(entry.key)
      : TEXT_ENTRY_BYTES - 2 * QUOTES + jsonTextBytes(entry.value) + jsonTextBytes(entry.key);
  }
  return Math.ceil(bytes / PAD_BLOCK) * PAD_BLOCK;
}

/**
 * Canonical JSON padded to a block multiple, to reduce the precision of length information in message traces.
 *
 * A payload larger than `MAX_PAYLOAD_BYTES` is refused before anything is built: it would not fit the RPC that carries
 * it. Otherwise the payload is built once to be measured and, unless it fills its blocks already, once more with the
 * padding it needs. Both buildings hold every value, so the first one is wiped on every way out, also when the second
 * fails; the one that is returned is the caller's to wipe. Of an entry only its key and its value, or its key and its
 * file, are written, whatever else it was handed with: the decoder refuses a member it does not know, and what it
 * refuses is never written. An entry is a file entry when it has a file.
 */
export function encodeValues(values: readonly PayloadEntry[]): Uint8Array {
  if (payloadSize(values) > MAX_PAYLOAD_BYTES) throw new SealError("payload too large");
  const entries = values.map((entry) => (isFileEntry(entry) ? { key: entry.key, file: entry.file } : { key: entry.key, value: entry.value }));
  const body = (pad: string): Uint8Array => utf8.encode(canonicalJson({ pad, values: entries }));
  const bare = body("");
  const missing = (PAD_BLOCK - (bare.length % PAD_BLOCK)) % PAD_BLOCK;
  if (missing === 0) return bare;
  try {
    return body(PAD_LETTER.repeat(missing));
  } finally {
    bare.fill(0);
  }
}

/** The members of a payload, and of each kind of entry in it. Sets, so that a name from a prototype is no member. */
const PAYLOAD_MEMBERS: ReadonlySet<string> = new Set(["pad", "values"]);
const TEXT_MEMBERS: ReadonlySet<string> = new Set(["key", "value"]);
const FILE_MEMBERS: ReadonlySet<string> = new Set(["key", "file"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(record: Record<string, unknown>, members: ReadonlySet<string>): boolean {
  return Object.keys(record).every((name) => members.has(name));
}

/** The padding the encoder writes: its own letter and nothing else, and less than a block of it, because a whole block is never needed. */
function isEncoderPad(pad: unknown): boolean {
  if (typeof pad !== "string" || pad.length >= PAD_BLOCK) return false;
  for (let index = 0; index < pad.length; index++) {
    if (pad[index] !== PAD_LETTER) return false;
  }
  return true;
}

/**
 * The entries of a payload. Strict: a payload that does not have the shape `encodeValues` writes is refused, always
 * with the same words and nothing of the payload in them. It fills its blocks; it is an object with a `pad` and the
 * `values`, and no other member; the pad is the encoder's (its letter, less than a block of it); every entry is exactly
 * a key and a value, or exactly a key and a file, each of them text, and no other member: an entry that is both, or
 * neither, is refused.
 *
 * What is held to the encoder is the shape, not the spelling: the bytes are not compared with a second encoding of
 * what was read (the same members in another order, or JSON whitespace, are read as the same payload). Comparing
 * them would put one more copy of every value into the daemon's memory, for a payload the AEAD has already
 * authenticated and whose entries the registry checks against the request.
 */
export function decodeValues(plaintext: Uint8Array): PayloadEntry[] {
  // encodeValues always pads to a block; anything else did not come from it.
  if (plaintext.length === 0 || plaintext.length % PAD_BLOCK !== 0) throw new SealError("malformed payload");
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(plaintext));
  } catch {
    throw new SealError("malformed payload");
  }
  if (!isRecord(parsed) || !hasOnly(parsed, PAYLOAD_MEMBERS)) throw new SealError("malformed payload");
  if (!isEncoderPad(parsed.pad)) throw new SealError("malformed payload");
  const values = parsed.values;
  if (!Array.isArray(values)) throw new SealError("malformed payload");
  return values.map((item: unknown): PayloadEntry => {
    if (!isRecord(item) || typeof item.key !== "string") throw new SealError("malformed payload");
    const { key } = item;
    if (hasOnly(item, TEXT_MEMBERS) && typeof item.value === "string") return { key, value: item.value };
    if (hasOnly(item, FILE_MEMBERS) && typeof item.file === "string") return { key, file: item.file };
    throw new SealError("malformed payload");
  });
}

export function digestHex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}
