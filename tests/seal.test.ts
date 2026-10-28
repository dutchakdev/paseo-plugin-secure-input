import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSelfTest, clearSelfTests, finishSelfTest } from "../server/core/selftest";
import { fromBase64Url, toBase64Url, utf8 } from "../shared/bytes";
import { canonicalJson } from "../shared/canonical";
import { ENVELOPE_CT_MAX } from "../shared/contracts";
import { SecureInputError } from "../shared/errors";
import { LIMITS, PASEO_RPC_MAX_BYTES, RPC_FRAME_MARGIN } from "../shared/limits";
import {
  MAX_PAYLOAD_BYTES,
  PAD_BLOCK,
  SealError,
  buildAad,
  decodeValues,
  digestHex,
  encodeValues,
  generateRequestKeyPair,
  open,
  payloadSize,
  seal,
  type PayloadEntry,
  type SealedEnvelope,
} from "../shared/seal";

/** An independent implementation on node:crypto. If it opens what noble sealed, both agree on the construction. */
function nodeOpen(secretKey: Uint8Array, publicKey: Uint8Array, envelope: SealedEnvelope, aad: Uint8Array): Buffer {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const ephemeral = Buffer.from(envelope.epk, "base64url");
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: b64(secretKey), x: b64(publicKey) }, format: "jwk" }),
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64(ephemeral) }, format: "jwk" }),
  });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, Buffer.from(publicKey)]), "paseo-secure-input/v1", 32));
  const ciphertext = Buffer.from(envelope.ct, "base64url");
  const decipher = createDecipheriv("chacha20-poly1305", key, Buffer.from(envelope.nonce, "base64url"), { authTagLength: 16 });
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  // @types/node requires plaintextLength for chacha20-poly1305, although the runtime accepts a call without it.
  decipher.setAAD(Buffer.from(aad), { plaintextLength: body.length });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Asserts both the class and the exact text: library messages must never reach a caller. */
function expectSealError(run: () => unknown, message: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SealError);
  expect((caught as SealError).message).toBe(message);
}

/**
 * A payload written by hand: the members given, after a `pad` of exactly the length the encoder would choose for
 * them. So the frame is the encoder's own, and only what the members say can be wrong.
 */
function paddedJson(members: string): Uint8Array {
  const frame = (pad: string): string => `{"pad":"${pad}",${members}}`;
  const bare = utf8.encode(frame("")).length;
  return utf8.encode(frame("x".repeat((PAD_BLOCK - (bare % PAD_BLOCK)) % PAD_BLOCK)));
}

/** JSON text followed by spaces up to a block: what the decoder took before it read the payload strictly. */
function spacePadded(text: string): Uint8Array {
  return utf8.encode(text.padEnd(PAD_BLOCK, " "));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

describe("seal / open", () => {
  const aad = buildAad("r_1", "digest-a");

  it("round-trips and is opened by an independent node:crypto implementation", () => {
    const keys = generateRequestKeyPair();
    const plaintext = utf8.encode("sk_live_canary 🔑");
    const envelope = seal(keys.publicKey, plaintext, aad);
    expect(Buffer.from(open(keys.secretKey, envelope, aad))).toEqual(Buffer.from(plaintext));
    expect(nodeOpen(keys.secretKey, keys.publicKey, envelope, aad)).toEqual(Buffer.from(plaintext));
  });

  it("produces a different envelope every time", () => {
    const keys = generateRequestKeyPair();
    const a = seal(keys.publicKey, utf8.encode("x"), aad);
    const b = seal(keys.publicKey, utf8.encode("x"), aad);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
  });

  it("refuses another request's AAD, a flipped bit and another key", () => {
    const keys = generateRequestKeyPair();
    const envelope = seal(keys.publicKey, utf8.encode("x"), aad);
    expectSealError(() => open(keys.secretKey, envelope, buildAad("r_2", "digest-a")), "authentication failed");
    expectSealError(() => open(keys.secretKey, envelope, buildAad("r_1", "digest-b")), "authentication failed");
    const bytes = fromBase64Url(envelope.ct);
    bytes[0] = (bytes[0] as number) ^ 1;
    expectSealError(() => open(keys.secretKey, { ...envelope, ct: toBase64Url(bytes) }, aad), "authentication failed");
    expectSealError(() => open(generateRequestKeyPair().secretKey, envelope, aad), "authentication failed");
  });

  it("refuses a malformed envelope without leaking library messages", () => {
    const keys = generateRequestKeyPair();
    const bad = { v: 1, epk: "AA", nonce: "AA", ct: "AA" } as const;
    expectSealError(() => open(keys.secretKey, bad, aad), "malformed envelope");
  });

  it("refuses an ephemeral key that gives no shared secret", () => {
    const keys = generateRequestKeyPair();
    const nonce = toBase64Url(new Uint8Array(12).fill(7));
    const ct = toBase64Url(new Uint8Array(48).fill(9));
    const points = [new Uint8Array(32), hex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800")];
    for (const point of points) {
      expect(point).toHaveLength(32);
      let caught: unknown;
      try {
        open(keys.secretKey, { v: 1, epk: toBase64Url(point), nonce, ct }, aad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SealError);
      // Framing is valid, so the refusal must come from the key and be one of our own two texts.
      expect(["authentication failed", "degenerate shared secret"]).toContain((caught as SealError).message);
    }
  });

  it("refuses to seal to an unusable recipient key without leaking library messages", () => {
    expectSealError(() => seal(new Uint8Array(31), utf8.encode("x"), aad), "sealing failed");
    expectSealError(() => seal(new Uint8Array(33), utf8.encode("x"), aad), "sealing failed");
    expectSealError(() => seal(new Uint8Array(32), utf8.encode("x"), aad), "sealing failed");
  });

  it("carries the largest file a field may hold, its bytes as they are", () => {
    const keys = generateRequestKeyPair();
    const bytes = Uint8Array.from({ length: LIMITS.fileBytes }, (_, index) => (index * 7) % 256);
    const plaintext = encodeValues([{ key: "SA_JSON", file: toBase64Url(bytes) }]);
    const envelope = seal(keys.publicKey, plaintext, aad);
    const [entry] = decodeValues(open(keys.secretKey, envelope, aad));
    expect(entry !== undefined && "file" in entry ? Buffer.from(fromBase64Url(entry.file)).equals(Buffer.from(bytes)) : false).toBe(true);
  });
});

/** The ID and digest of a request as the registry makes them. */
const ID = `r_${"7f3a".repeat(8)}`;
const DIGEST = "d".repeat(64);

/** Entries whose payload is exactly `size` bytes: one key, and a value that fills the rest. `size` is a multiple of a block. */
function entriesOfPaddedSize(size: number): PayloadEntry[] {
  const bare = utf8.encode(canonicalJson({ pad: "", values: [{ key: "K", value: "" }] })).length;
  return [{ key: "K", value: "v".repeat(size - bare) }];
}

describe("the size of a submission", () => {
  it("fits the largest submission into one Paseo RPC", () => {
    expect(MAX_PAYLOAD_BYTES % PAD_BLOCK).toBe(0);
    const { publicKey } = generateRequestKeyPair();
    const envelope = seal(publicKey, new Uint8Array(MAX_PAYLOAD_BYTES), buildAad(ID, DIGEST));
    expect(envelope.ct.length).toBe(ENVELOPE_CT_MAX);
    expect(Buffer.byteLength(JSON.stringify({ requestId: ID, envelope })) + RPC_FRAME_MARGIN).toBeLessThanOrEqual(PASEO_RPC_MAX_BYTES);
    expect(() => encodeValues(entriesOfPaddedSize(MAX_PAYLOAD_BYTES + PAD_BLOCK))).toThrow("payload too large");
  }, 30_000);

  it("takes a payload of exactly the cap, and refuses the next one in fixed words, before it has built anything", () => {
    expect(encodeValues(entriesOfPaddedSize(MAX_PAYLOAD_BYTES))).toHaveLength(MAX_PAYLOAD_BYTES);
    const over = entriesOfPaddedSize(MAX_PAYLOAD_BYTES + PAD_BLOCK);
    const encode = vi.spyOn(utf8, "encode");
    expectSealError(() => encodeValues(over), "payload too large");
    // No copy of the values was made for a payload that is refused.
    expect(encode).not.toHaveBeenCalled();
  }, 30_000);

  it("is the most the per-field limits allow, which is less than one RPC carries", () => {
    // The worst a field can be: a text of 64 KiB of control characters, six bytes of JSON each, under a key of 128.
    // Thirty-two of them, padded to a block. The RPC would carry more: its share of the relay's plaintext, less the frame.
    expect(MAX_PAYLOAD_BYTES).toBe(12_588_032);
    expect(ENVELOPE_CT_MAX).toBe(16_784_064);
    expect(Math.floor(((PASEO_RPC_MAX_BYTES - RPC_FRAME_MARGIN) * 3) / 4) - 16).toBeGreaterThan(MAX_PAYLOAD_BYTES);
  });

  // Every spelling the canonical JSON gives a string: escapes of two characters and of six, characters it leaves as
  // they are, UTF-8 of one to four bytes, a surrogate with no partner, and sizes around the edge of a block.
  const TABLE: ReadonlyArray<readonly [string, PayloadEntry[]]> = [
    ["no entry", []],
    ["an empty value", [{ key: "K", value: "" }]],
    ["plain text", [{ key: "K", value: "plain-value" }]],
    ["quotes and backslashes", [{ key: "Q", value: '"quoted" \\ back\\slash /' }]],
    ["the short escapes", [{ key: "C", value: "\b\f\n\r\t" }]],
    ["the long escapes and DEL", [{ key: "U", value: String.fromCharCode(0, 1, 0x1f, 0x7f) }]],
    ["the line and paragraph separators", [{ key: "S", value: String.fromCharCode(0x2028, 0x2029) }]],
    ["surrogates with no partner", [{ key: "L", value: `${String.fromCharCode(0xd800)}x${String.fromCharCode(0xdc00)}${String.fromCharCode(0xdbff)}` }]],
    ["two, three and four bytes of UTF-8", [{ key: "E", value: `\u{1F511}ключ\u20ac${String.fromCharCode(0x7ff, 0x800, 0xffff)}` }]],
    ["an empty file", [{ key: "F", file: "" }]],
    ["a file", [{ key: "F", file: toBase64Url(Uint8Array.from({ length: 1000 }, (_, index) => index % 256)) }]],
    ["text and files together", [{ key: "A", value: "a" }, { key: "F", file: "AQID" }, { key: "B", value: "ключ" }, { key: "G", file: "" }]],
    ["a key of the longest", [{ key: "K".repeat(LIMITS.key), value: "x".repeat(70_000) }]],
    ["a key that is not one", [{ key: 'a "quoted" key\n', value: "v" }]],
  ];

  it.each(TABLE)("measures a payload without building it: %s", (_name, entries) => {
    const stringify = vi.spyOn(JSON, "stringify");
    const encode = vi.spyOn(utf8, "encode");
    let measured: number;
    try {
      measured = payloadSize(entries);
      expect(stringify).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      encode.mockRestore();
    }
    expect(measured).toBe(encodeValues(entries).length);
  });

  it("measures a payload at every size around the edge of a block", () => {
    const bare = utf8.encode(canonicalJson({ pad: "", values: [{ key: "K", value: "" }] })).length;
    for (const length of [PAD_BLOCK - bare - 1, PAD_BLOCK - bare, PAD_BLOCK - bare + 1, 2 * PAD_BLOCK - bare, 2 * PAD_BLOCK - bare + 1]) {
      for (const filler of ["v", "\n", "ї"]) {
        const entries = [{ key: "K", value: filler.repeat(length) }];
        expect(payloadSize(entries), `${length} of ${JSON.stringify(filler)}`).toBe(encodeValues(entries).length);
      }
    }
  });
});

describe("encodeValues", () => {
  it("pads every payload to a multiple of the block and round-trips", () => {
    for (const length of [0, 1, 17, 900, 1023, 1024, 1025, 5000]) {
      const values = [{ key: "K", value: "v".repeat(length) }, { key: "U", value: "ключ" }];
      const encoded = encodeValues(values);
      expect(encoded.length % PAD_BLOCK).toBe(0);
      expect(decodeValues(encoded)).toEqual(values);
    }
  });

  it("rejects a payload that is not a list of string pairs", () => {
    expect(() => decodeValues(utf8.encode('{"values":[{"key":"K","value":1}]}'))).toThrow(SealError);
    expect(() => decodeValues(utf8.encode('{"values":"x"}'))).toThrow(SealError);
    // Padded to a block as the encoder pads, so the padding rule passes and only the shape check can refuse these.
    expectSealError(() => decodeValues(paddedJson('"values":[{"key":"K","value":1}]')), "malformed payload");
    expectSealError(() => decodeValues(paddedJson('"values":"x"')), "malformed payload");
    expectSealError(() => decodeValues(paddedJson('"values":[null]')), "malformed payload");
    expectSealError(() => decodeValues(spacePadded("not json")), "malformed payload");
    // The same padded frame with a valid shape is accepted, so the refusals above are about the shape.
    expect(decodeValues(paddedJson('"values":[{"key":"K","value":"v"}]'))).toEqual([{ key: "K", value: "v" }]);
  });

  it("rejects a payload that is empty or not padded to a block", () => {
    expectSealError(() => decodeValues(new Uint8Array(0)), "malformed payload");
    expectSealError(() => decodeValues(utf8.encode('{"pad":"","values":[]}')), "malformed payload");
    expectSealError(() => decodeValues(new Uint8Array(PAD_BLOCK + 1).fill(0x20)), "malformed payload");
  });
});

describe("the payload is read strictly", () => {
  // The member an earlier app put into the payload of a command's submission. It is no member of a payload now.
  const OLD_TOKEN = toBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index * 5 + 3));
  const CANARY = "CANARY-9d41-never-in-a-refusal";
  const entry = `{"key":"K","value":"${CANARY}"}`;
  const values = [{ key: "K", value: CANARY }];

  /** The refusal, which must be the fixed one and hold nothing of the payload. */
  function expectMalformed(payload: Uint8Array): void {
    let caught: unknown;
    try {
      decodeValues(payload);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SealError);
    expect((caught as SealError).message).toBe("malformed payload");
    expect(String((caught as SealError).stack)).not.toContain("CANARY");
  }

  it("takes the frames this test writes by hand when they are what the encoder writes", () => {
    // The helper is held to the encoder, so that a refusal below is about what the test added and not about the frame.
    expect(Buffer.from(paddedJson(`"values":[${entry}]`))).toEqual(Buffer.from(encodeValues(values)));
    expect(decodeValues(paddedJson(`"values":[${entry}]`))).toEqual(values);
  });

  it("refuses an otherwise valid payload with a member it does not know, the token an earlier app added among them", () => {
    expectMalformed(paddedJson(`"values":[${entry}],"zeta":1`));
    expectMalformed(paddedJson(`"extra":"x","values":[${entry}]`));
    expectMalformed(paddedJson(`"token":"${OLD_TOKEN}","values":[${entry}]`));
    expectMalformed(paddedJson(`"__proto__":{"values":[]},"values":[${entry}]`));
    expectMalformed(paddedJson(`"constructor":null,"values":[${entry}]`));
  });

  it("refuses an entry with a member besides its key and its value", () => {
    expectMalformed(paddedJson(`"values":[{"key":"K","note":"n","value":"${CANARY}"}]`));
    expectMalformed(paddedJson(`"values":[{"key":"K","value":"${CANARY}","__proto__":null}]`));
    expectMalformed(paddedJson(`"values":[["K","${CANARY}"]]`));
    expectMalformed(paddedJson(`"values":[{"file":"${CANARY}","key":"K","name":"n"}]`));
  });

  it("carries file entries beside text entries, and refuses an entry that is both or neither", () => {
    const values: PayloadEntry[] = [
      { key: "A", value: CANARY },
      { key: "F", file: toBase64Url(Uint8Array.from([0, 1, 255])) },
      { key: "B", value: "" },
      { key: "G", file: "" },
    ];
    expect(decodeValues(encodeValues(values))).toEqual(values);
    expect(decodeValues(paddedJson('"values":[{"file":"AAEC","key":"F"}]'))).toEqual([{ key: "F", file: "AAEC" }]);
    // Both, neither, or one of them that is no text.
    expectMalformed(paddedJson(`"values":[{"file":"AAEC","key":"K","value":"${CANARY}"}]`));
    expectMalformed(paddedJson('"values":[{"key":"K"}]'));
    expectMalformed(paddedJson('"values":[{"file":1,"key":"K"}]'));
    expectMalformed(paddedJson('"values":[{"file":null,"key":"K"}]'));
    expectMalformed(paddedJson('"values":[{"file":["AAEC"],"key":"K"}]'));
    expectMalformed(paddedJson('"values":[{"file":"AAEC","key":7}]'));
    expectMalformed(paddedJson('"values":[{"file":"AAEC"}]'));
  });

  it("refuses a payload that is no object", () => {
    for (const text of ["null", "[]", `[${entry}]`, '"text"', "7", "true"]) expectMalformed(spacePadded(text));
  });

  it("refuses a pad that is not what the encoder writes", () => {
    const framed = (pad: string, members = `"values":[${entry}]`): Uint8Array => {
      const text = `{"pad":${pad},${members}}`;
      return utf8.encode(text.padEnd(Math.ceil(utf8.encode(text).length / PAD_BLOCK) * PAD_BLOCK, " "));
    };
    // No pad at all, with spaces after the JSON to fill the block: the frame the decoder took before.
    expectMalformed(spacePadded(`{"values":[${entry}]}`));
    // A pad of another type, of other characters, or of a block and more.
    for (const pad of ["null", "7", "[]", '{"x":1}', '"y"', '"xxX"', '" "', `"${CANARY}"`, `"${"x".repeat(PAD_BLOCK)}"`, `"${"x".repeat(PAD_BLOCK + 5)}"`]) {
      expectMalformed(framed(pad));
    }
    // The same frames with the encoder's own letter are taken, so the refusals above are about the pad. (What is
    // compared is the pad: its type, its letters and its length. The spelling of the rest of the JSON is not.)
    expect(decodeValues(framed('"xxx"'))).toEqual(values);
  });

  it("still opens what the encoder writes, at every size of padding", () => {
    for (const length of [0, 1, 2, 500, 970, 971, 972, 973, 1023, 1024, 1025, 2047, 2048, 70_000]) {
      const typed = [{ key: "K", value: "v".repeat(length) }, { key: "U", value: "ключ 🔑" }];
      expect(decodeValues(encodeValues(typed)), String(length)).toEqual(typed);
    }
    expect(decodeValues(encodeValues([]))).toEqual([]);
  });
});

describe("what the encoder writes", () => {
  // The bytes of a payload, held to digests that this file does not compute: for each length of the first value, the
  // size and the SHA-256 of the payload. They were made outside this code base, by a second writing of the format (the
  // members `pad` and `values` in that order, an entry as `key` then `value`, no whitespace, text as UTF-8, the pad of
  // `x` that fills the last block of 1024), and they are what the encoder gave before its buffers were wiped and what
  // it gives now (6,028 payloads of the two were compared, byte for byte). A formula restated here would move with
  // the encoder; these do not.
  const GOLDEN: ReadonlyArray<readonly [length: number, bytes: number, digest: string]> = [
    [0, 1024, "ae17d0a9c72338ee6c0403ad691394054c4fbdba851b99a45de80a214e0f7d3c"],
    [1, 1024, "f42818bee4cb0921f29a5acfc7dea7f5b6e6e17fa27f73165bb079419f7c47cd"],
    [17, 1024, "7628d6682fe363d84c2b2baff9f48410d64bfa978296557d97e23ccc23fd94b1"],
    [900, 1024, "ada021ced93a0ada8ba347e678aeb99fd6737902fdab6fb28cede45888f8cda0"],
    [989, 2048, "93de370ad24e673f883e39d37c6bb3f51834c3e099faea337e394882825e0410"],
    [990, 2048, "9c1ea2c214f31ae4c9b8a5480e24bb374491e66cdb8652a261a8f1b653814b27"],
    [991, 2048, "60b058a2e6d80d0de8c8088889c5bf1f187aa0f11812399e11bc016a2c6972d2"],
    [1023, 2048, "5ef6689326696d353421ef55749b3049717a2a5bacbdba4278656333c43fe431"],
    [1024, 2048, "873ce5eef3ceaf9df519b3c8736da0407d4b8fb7215d523243177acb044e0e94"],
    [1025, 2048, "320a897fb4f178d14f4d8ef20c74536991cbe30163157dc451ca31819a83caf1"],
    [5000, 5120, "3d3938410ebb3e7674e5ac04779c5e30f5db690398a2224f5f7520325cbc4b5e"],
  ];

  const pair = String.fromCodePoint(0x43a, 0x43b, 0x44e, 0x447);

  it.each(GOLDEN)("writes, for a first value of %i characters, the %i bytes it always wrote", (length, bytes, digest) => {
    const values = [{ key: "K", value: "v".repeat(length) }, { key: "U", value: pair }];
    const plain = encodeValues(values);
    expect([plain.length, digestHex(plain)]).toEqual([bytes, digest]);
  });

  it("reads every one of those payloads back", () => {
    for (const [length] of GOLDEN) {
      const values = [{ key: "K", value: "v".repeat(length) }, { key: "U", value: pair }];
      expect(decodeValues(encodeValues(values))).toEqual(values);
    }
  });

  it("writes of an entry its key and its value, or its key and its file, and nothing else it was handed", () => {
    // What the decoder would refuse is never written: a row's id, say, must not close a request.
    const withMore = [{ key: "K", value: "v", id: 7, note: "n" }];
    expect(Buffer.from(encodeValues(withMore))).toEqual(Buffer.from(encodeValues([{ key: "K", value: "v" }])));
    expect(decodeValues(encodeValues(withMore))).toEqual([{ key: "K", value: "v" }]);
    const fileWithMore = [{ key: "F", file: "AQID", name: "key.p12", size: 3 }];
    expect(Buffer.from(encodeValues(fileWithMore))).toEqual(Buffer.from(encodeValues([{ key: "F", file: "AQID" }])));
    expect(decodeValues(encodeValues(fileWithMore))).toEqual([{ key: "F", file: "AQID" }]);
  });

  it("writes a file entry as its file and its key, the members in the order the canonical JSON puts them", () => {
    expect(utf8.decode(encodeValues([{ key: "F", file: "AQID" }])).startsWith('{"pad":"')).toBe(true);
    expect(utf8.decode(encodeValues([{ key: "F", file: "AQID" }]))).toContain('"values":[{"file":"AQID","key":"F"}]}');
  });
});

describe("the buffers the encoder makes", () => {
  const CANARY = "CANARY-2c7e-in-a-buffer";
  const values = [{ key: "K", value: CANARY }];

  /** Every buffer `utf8.encode` returns while the spy is on, with a copy of what it held when it was made. */
  function watchEncoder(failAt?: number) {
    const made: Array<{ buffer: Uint8Array; before: Uint8Array }> = [];
    const real = utf8.encode;
    let calls = 0;
    vi.spyOn(utf8, "encode").mockImplementation((text: string) => {
      calls += 1;
      if (calls === failAt) throw new Error("the encoder failed");
      const buffer = real(text);
      made.push({ buffer, before: buffer.slice() });
      return buffer;
    });
    return made;
  }

  const isZero = (buffer: Uint8Array): boolean => buffer.every((byte) => byte === 0);
  const holds = (buffer: Uint8Array, text: string): boolean => Buffer.from(buffer).includes(text);

  it("are zeroed, all but the one that is returned", () => {
    const made = watchEncoder();
    const returned = encodeValues(values);
    expect(made.length).toBeGreaterThan(1);
    // Each held the value when it was made: the test looks at buffers that mattered.
    for (const { before } of made) expect(holds(before, CANARY)).toBe(true);
    const others = made.filter(({ buffer }) => buffer !== returned);
    expect(others).toHaveLength(made.length - 1);
    for (const { buffer } of others) expect(isZero(buffer)).toBe(true);
    // The one that is returned is whole: the caller seals it and wipes it.
    expect(holds(returned, CANARY)).toBe(true);
    expect(decodeValues(returned)).toEqual(values);
  });

  it("are zeroed when the second build throws", () => {
    const made = watchEncoder(2);
    expect(() => encodeValues(values)).toThrow("the encoder failed");
    // The first build was made, held the value, and is not left behind.
    expect(made).toHaveLength(1);
    expect(holds(made[0]?.before as Uint8Array, CANARY)).toBe(true);
    expect(isZero(made[0]?.buffer as Uint8Array)).toBe(true);
  });

  it("are one, used as it is, when the payload already fills its blocks", () => {
    // Find a value that makes the bare payload a block exactly: no second build, and nothing to wipe.
    const bare = utf8.encode(canonicalJson({ pad: "", values: [{ key: "K", value: "" }] })).length;
    const exact = [{ key: "K", value: "v".repeat(PAD_BLOCK - bare) }];
    const made = watchEncoder();
    const returned = encodeValues(exact);
    expect(made).toHaveLength(1);
    expect(made[0]?.buffer).toBe(returned);
    expect(returned).toHaveLength(PAD_BLOCK);
    expect(decodeValues(returned)).toEqual(exact);
  });
});

describe("sealing on a host that cannot do it", () => {
  const aad = buildAad("r_1", "digest-a");

  it("fails as a sealing failure, not as the platform's error, when there is no usable randomness", () => {
    const recipient = generateRequestKeyPair().publicKey;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new TypeError("crypto.getRandomValues is not a function: CANARY-platform-text");
    });
    expectSealError(() => seal(recipient, utf8.encode("x"), aad), "sealing failed");
  });

  it("fails the same way when the host has no crypto at all", () => {
    const recipient = generateRequestKeyPair().publicKey;
    vi.stubGlobal("crypto", undefined);
    try {
      expectSealError(() => seal(recipient, utf8.encode("x"), aad), "sealing failed");
    } finally {
      vi.unstubAllGlobals();
    }
    // With the host's crypto back, the same call seals.
    expect(seal(recipient, utf8.encode("x"), aad).v).toBe(1);
  });

  it("fails the same way when randomness gives out while the key pair is derived, and wipes the secret key it had drawn", () => {
    // The curve library blinds the scalar with random bytes of its own when it derives a public key (seen with
    // @noble/curves 2.4.0: one draw of 16 bytes for every call). So the first draw is the secret key and the second
    // comes from inside the derivation: before the key pair was made inside the guard, this one escaped it.
    const recipient = generateRequestKeyPair().publicKey;
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const drawn: Uint8Array[] = [];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      drawn.push(array);
      if (drawn.length > 1) throw new Error("entropy pool closed");
      return real(array);
    }) as typeof globalThis.crypto.getRandomValues);
    expectSealError(() => seal(recipient, utf8.encode("x"), aad), "sealing failed");
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toHaveLength(32);
    expect(drawn[0]?.every((byte) => byte === 0)).toBe(true);
    // The same failure outside `seal` wipes the key as well, and is passed on as it came.
    drawn.length = 0;
    expect(() => generateRequestKeyPair()).toThrow("entropy pool closed");
    expect(drawn[0]).toHaveLength(32);
    expect(drawn[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("fails the same way when randomness gives out for the nonce, after the keys were made", () => {
    const recipient = generateRequestKeyPair().publicKey;
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let nonces = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      // The nonce is the one draw of twelve bytes.
      if (array.length !== 12) return real(array);
      nonces += 1;
      throw new Error("entropy pool closed");
    }) as typeof globalThis.crypto.getRandomValues);
    expectSealError(() => seal(recipient, utf8.encode("x"), aad), "sealing failed");
    expect(nonces).toBe(1);
  });

  // Opening draws randomness too: the curve library blinds the scalar when it derives the recipient's public key (the
  // draw of sixteen bytes seen above, once for every derivation). That derivation is inside the guard of `open`.
  it("opens nothing, as a failure to open and not as the platform's error, when randomness gives out while the recipient's key is derived", () => {
    const pair = generateRequestKeyPair();
    const envelope = seal(pair.publicKey, utf8.encode("x"), aad);
    const kept = Uint8Array.from(pair.secretKey);
    let draws = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      draws += 1;
      throw new Error("entropy pool closed: CANARY-platform-text");
    });
    expectSealError(() => open(pair.secretKey, envelope, aad), "authentication failed");
    // The library did ask, inside `open`: had it not, this test would say nothing about the guard.
    expect(draws).toBe(1);
    // The recipient's key is the caller's: it is neither wiped nor changed by a failure to open.
    expect(pair.secretKey).toEqual(kept);
    vi.restoreAllMocks();
    expect(utf8.decode(open(pair.secretKey, envelope, aad))).toBe("x");
  });

  it("wipes the secret key it drew when the public key cannot be derived from it", () => {
    // A source of randomness that answers with a key of the wrong length: the derivation refuses it.
    const drawn: Uint8Array[] = [];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((() => {
      const short = new Uint8Array(31).fill(7);
      drawn.push(short);
      return short;
    }) as unknown as typeof globalThis.crypto.getRandomValues);
    expect(() => generateRequestKeyPair()).toThrow();
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.every((byte) => byte === 0)).toBe(true);
    // Inside `seal` the same failure is a sealing failure, and its key is wiped as well.
    const recipient = new Uint8Array(32).fill(9);
    expectSealError(() => seal(recipient, utf8.encode("x"), aad), "sealing failed");
    expect(drawn).toHaveLength(2);
    expect(drawn[1]?.every((byte) => byte === 0)).toBe(true);
  });
});

describe("buildAad", () => {
  it("binds the request and the digest of what it asked for, in version 2 of the binding", () => {
    expect(buildAad("r", "d")).toEqual(utf8.encode('{"requestDigest":"d","requestId":"r","v":2}'));
    expect(buildAad(ID, DIGEST)).toEqual(utf8.encode(`{"requestDigest":"${DIGEST}","requestId":"${ID}","v":2}`));
  });

  it("fails closed when the request or the digest is missing", () => {
    expectSealError(() => buildAad("", "d"), "malformed binding");
    expectSealError(() => buildAad("r", ""), "malformed binding");
    expectSealError(() => buildAad(undefined as unknown as string, "d"), "malformed binding");
    expectSealError(() => buildAad("r", undefined as unknown as string), "malformed binding");
  });
});

describe("self-test", () => {
  const CANNOT_START = "service_unavailable: the self-test cannot be started";

  /** What `beginSelfTest` throws. */
  function refusalOfBegin(): unknown {
    try {
      beginSelfTest();
    } catch (error) {
      return error;
    }
    throw new Error("expected the self-test not to begin");
  }

  it("answers a host without usable randomness with a fixed refusal, and nothing of the platform's error", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new TypeError("crypto.getRandomValues is not a function: CANARY-platform-text");
    });
    const error = refusalOfBegin();
    expect(error).toBeInstanceOf(SecureInputError);
    expect((error as SecureInputError).code).toBe("service_unavailable");
    expect((error as SecureInputError).message).toBe(CANNOT_START);
    expect(String((error as Error).stack)).not.toContain("CANARY");
  });

  it("draws the probe's id before it makes the key: when randomness gives out for the id, no key was made that nobody holds", () => {
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const drawn: Uint8Array[] = [];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      drawn.push(array);
      // The id is the one draw of eight bytes.
      if (array.length === 8) throw new Error("entropy pool closed");
      return real(array);
    }) as typeof globalThis.crypto.getRandomValues);
    expect((refusalOfBegin() as Error).message).toBe(CANNOT_START);
    // Nothing was drawn before the id, so there is no secret key of thirty-two bytes left anywhere.
    expect(drawn.map((array) => array.length)).toEqual([8]);
  });

  it("wipes the key it had drawn when randomness gives out while the key pair is derived, and keeps no probe for it", () => {
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const drawn: Uint8Array[] = [];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      drawn.push(array);
      // The id (eight bytes) and the secret key (thirty-two) are drawn; the library's own draw inside the derivation fails.
      if (drawn.length > 2) throw new Error("entropy pool closed");
      return real(array);
    }) as typeof globalThis.crypto.getRandomValues);
    expect((refusalOfBegin() as Error).message).toBe(CANNOT_START);
    expect(drawn.map((array) => array.length)).toEqual([8, 32, 16]);
    expect(drawn[1]?.every((byte) => byte === 0)).toBe(true);
    // The id that was drawn names no probe: a submission to it is answered as to any unknown one.
    vi.restoreAllMocks();
    const probeId = `p_${Buffer.from(drawn[0] as Uint8Array).toString("hex")}`;
    const envelope = seal(generateRequestKeyPair().publicKey, new Uint8Array(8), buildAad(probeId, "selftest"));
    expect(finishSelfTest(probeId, envelope, "00")).toEqual({ ok: false, bytes: 0 });
  });

  it("accepts a correct probe once and rejects everything else", () => {
    const { probeId, publicKey } = beginSelfTest();
    const payload = new Uint8Array(2048).fill(0x61);
    const envelope = seal(fromBase64Url(publicKey), payload, buildAad(probeId, "selftest"));
    expect(finishSelfTest(probeId, envelope, digestHex(payload))).toEqual({ ok: true, bytes: 2048 });
    expect(finishSelfTest(probeId, envelope, digestHex(payload))).toEqual({ ok: false, bytes: 0 });
    const second = beginSelfTest();
    const sealed = seal(fromBase64Url(second.publicKey), payload, buildAad(second.probeId, "selftest"));
    expect(finishSelfTest(second.probeId, sealed, "00")).toEqual({ ok: false, bytes: 2048 });
  });

  it("wipes the payload it opened once it has hashed it, whether the digest was right or not", () => {
    const payload = new Uint8Array(4096).fill(0x61);
    // The opener is a parameter so that the test can look at the buffer it gave back.
    const opened: Array<{ buffer: Uint8Array; before: Uint8Array }> = [];
    const watching: typeof open = (secretKey, envelope, aad) => {
      const buffer = open(secretKey, envelope, aad);
      opened.push({ buffer, before: buffer.slice() });
      return buffer;
    };
    for (const digest of [digestHex(payload), "00"]) {
      const probe = beginSelfTest();
      const envelope = seal(fromBase64Url(probe.publicKey), payload, buildAad(probe.probeId, "selftest"));
      expect(finishSelfTest(probe.probeId, envelope, digest, watching)).toEqual({ ok: digest !== "00", bytes: 4096 });
    }
    expect(opened).toHaveLength(2);
    for (const { buffer, before } of opened) {
      expect(Buffer.from(before)).toEqual(Buffer.from(payload));
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("answers the same, and has nothing to wipe, when the payload cannot be opened", () => {
    const probe = beginSelfTest();
    const other = beginSelfTest();
    const payload = new Uint8Array(64).fill(0x61);
    const envelope = seal(fromBase64Url(other.publicKey), payload, buildAad(probe.probeId, "selftest"));
    expect(finishSelfTest(probe.probeId, envelope, digestHex(payload))).toEqual({ ok: false, bytes: 0 });
    clearSelfTests();
  });

  it("forgets every probe on clearSelfTests", () => {
    const { probeId, publicKey } = beginSelfTest();
    const payload = new Uint8Array(64).fill(0x61);
    const envelope = seal(fromBase64Url(publicKey), payload, buildAad(probeId, "selftest"));
    clearSelfTests();
    expect(finishSelfTest(probeId, envelope, digestHex(payload))).toEqual({ ok: false, bytes: 0 });
  });

  it("drops the oldest probe when more than sixteen are open", () => {
    clearSelfTests();
    const payload = new Uint8Array(64).fill(0x61);
    const probes = Array.from({ length: 17 }, () => beginSelfTest());
    const sealTo = (probe: { probeId: string; publicKey: string }) =>
      seal(fromBase64Url(probe.publicKey), payload, buildAad(probe.probeId, "selftest"));
    const [oldest, newest] = [probes[0] as (typeof probes)[number], probes[16] as (typeof probes)[number]];
    expect(finishSelfTest(oldest.probeId, sealTo(oldest), digestHex(payload))).toEqual({ ok: false, bytes: 0 });
    expect(finishSelfTest(newest.probeId, sealTo(newest), digestHex(payload))).toEqual({ ok: true, bytes: 64 });
    clearSelfTests();
  });
});
