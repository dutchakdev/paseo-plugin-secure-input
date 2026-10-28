const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index] as const));

/** base64url without padding. Hand-rolled because Hermes has neither Buffer nor a guaranteed btoa. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 63];
  }
  return out;
}

/**
 * How many bytes a text of base64url without padding stands for, from its length alone: every four characters are three
 * bytes, and the two or three left over are one or two. For every text `fromBase64Url` takes, its array is this long, so
 * a limit on the bytes can be held to a text before anything of it is decoded.
 */
export function decodedLength(text: string): number {
  return Math.floor((text.length * 3) / 4);
}

/**
 * The bytes of a text of base64url without padding. The text is checked whole before anything is decoded: a length an
 * encoder makes, every character of the alphabet, and no bits set after the last byte (otherwise two different texts
 * would decode to the same bytes). So a text that is refused leaves no array behind with any of its bytes, which the
 * caller could not wipe, having never been given it; and nothing is refused once the array exists.
 */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("invalid base64url length");
  let last = 0;
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) throw new Error("invalid base64url character");
    last = value;
  }
  // The bits of the last character that are past the last byte: four after two characters of a group, two after three.
  const spare = text.length % 4 === 2 ? 0b1111 : text.length % 4 === 3 ? 0b11 : 0;
  if ((last & spare) !== 0) throw new Error("invalid base64url trailing bits");
  const out = new Uint8Array(decodedLength(text));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    buffer = ((buffer << 6) | (LOOKUP.get(char) as number)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export const utf8 = {
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};

/**
 * How many bytes `utf8.encode(text)` would have, without making them: a limit in bytes can be checked on a typed
 * value with no second copy of it left in memory. A pair of surrogates is one character of four bytes; a surrogate
 * with no partner counts three, because an encoder writes U+FFFD in its place.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** One getRandomValues call fills at most 65 536 bytes on every platform we run on. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 65_536) {
    throw new Error("randomBytes: length must be an integer from 0 to 65536");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
