import { describe, expect, it } from "vitest";
import { sealEntries } from "../client/sealing";
import { fromBase64Url, toBase64Url } from "../shared/bytes";
import { buildAad, decodeValues, encodeValues, generateRequestKeyPair, open, type PayloadEntry, type SealedEnvelope } from "../shared/seal";

const CANARY = "CANARY-5c1d-sealed-only";

const pair = generateRequestKeyPair();
const view = { id: "r_aaaaaaaaaaaaaaaa", publicKey: toBase64Url(pair.publicKey), requestDigest: "d".repeat(64) };
const binary = Uint8Array.from([0x30, 0x82, 0x00, 0xff]);
const entries: PayloadEntry[] = [
  { key: "A", value: CANARY },
  { key: "B", value: "two" },
  { key: "P12", file: toBase64Url(binary) },
];

/** The envelope for the fixture, or a failure of the test if none came. */
function sealed(): SealedEnvelope {
  const envelope = sealEntries(view, entries);
  if (envelope === null) throw new Error("sealing the fixture failed");
  return envelope;
}

/** An encoder that keeps what it returned, and a copy of what that was, so a test can look at the buffer after the call. */
function watchedEncoder() {
  const kept: Array<{ buffer: Uint8Array; before: Uint8Array }> = [];
  const encode = (values: readonly PayloadEntry[]): Uint8Array => {
    const buffer = encodeValues(values);
    kept.push({ buffer, before: buffer.slice() });
    return buffer;
  };
  return { kept, encode };
}

describe("sealing the entries in the app", () => {
  it("makes an envelope the request's key opens, bound to this request and to what it asked for, files included", () => {
    const opened = decodeValues(open(pair.secretKey, sealed(), buildAad(view.id, view.requestDigest)));
    expect(opened).toEqual(entries);
    const file = opened[2];
    expect(file !== undefined && "file" in file ? fromBase64Url(file.file) : null).toEqual(binary);
  });

  it("makes an envelope that opens for no other request and nothing else asked for", () => {
    const envelope = sealed();
    expect(() => open(pair.secretKey, envelope, buildAad("r_bbbbbbbbbbbbbbbb", view.requestDigest))).toThrow();
    expect(() => open(pair.secretKey, envelope, buildAad(view.id, "e".repeat(64)))).toThrow();
  });

  it("carries the values only as ciphertext", () => {
    // A marker long enough that base64 text cannot spell it by chance.
    expect(JSON.stringify(sealed())).not.toContain("CANARY");
  });

  it("seals the same values to a different ciphertext each time", () => {
    expect(sealed().ct).not.toBe(sealed().ct);
  });

  it("answers null, not an error, when the key it was given cannot be used, and says nothing of the values", () => {
    for (const publicKey of ["", "short", "!".repeat(43), "A".repeat(44)]) {
      expect(sealEntries({ ...view, publicKey }, entries), publicKey).toBeNull();
    }
  });

  it("answers null when the binding is incomplete", () => {
    expect(sealEntries({ ...view, requestDigest: "" }, entries)).toBeNull();
    expect(sealEntries({ ...view, id: "" }, entries)).toBeNull();
  });
});

describe("the bytes of the encoded values", () => {
  it("are zeroed after a successful seal", () => {
    const { kept, encode } = watchedEncoder();
    expect(sealEntries(view, entries, encode)).not.toBeNull();
    expect(kept).toHaveLength(1);
    // The buffer held the values when it was made, and holds nothing now.
    expect(kept[0]?.before.some((byte) => byte !== 0)).toBe(true);
    expect(kept[0]?.buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("are zeroed after a seal that threw", () => {
    const { kept, encode } = watchedEncoder();
    expect(sealEntries({ ...view, publicKey: "short" }, entries, encode)).toBeNull();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.before.some((byte) => byte !== 0)).toBe(true);
    expect(kept[0]?.buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("are zeroed after a seal with an unusable binding", () => {
    const { kept, encode } = watchedEncoder();
    expect(sealEntries({ ...view, requestDigest: "" }, entries, encode)).toBeNull();
    expect(kept[0]?.buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("are never made when the encoder refuses, and nothing escapes", () => {
    const refusing = (): Uint8Array => {
      throw new Error(`library says ${CANARY}`);
    };
    expect(sealEntries(view, entries, refusing)).toBeNull();
  });
});
