import { describe, expect, it } from "vitest";
import { chooseEnvelope, keepAfter, markKnown, markLost, remember, unknownOutcome, type SealTarget } from "../client/envelope-cache";
import { afterFulfill, afterLostReply, type FulfillResult } from "../client/outcome";
import { ERROR_CODES } from "../shared/errors";
import { toBase64Url, utf8 } from "../shared/bytes";
import { buildAad, decodeValues, encodeValues, generateRequestKeyPair, open, seal, type PayloadEntry, type SealedEnvelope } from "../shared/seal";

const target: SealTarget = { requestId: "r_aaaaaaaaaaaaaaaa", publicKey: "P".repeat(43), requestDigest: "d".repeat(64) };
const envelope: SealedEnvelope = { v: 1, epk: "E".repeat(43), nonce: "N".repeat(16), ct: "C".repeat(40) };
const FILE = toBase64Url(utf8.encode('{"type":"service_account"}'));
const entries: PayloadEntry[] = [
  { key: "A", value: "one" },
  { key: "B", value: "two" },
  { key: "SA", file: FILE },
];

describe("the sealed envelope that is kept while the form is open", () => {
  it("is sent again when the same values and files come again in the same order", () => {
    const cache = remember(target, entries, envelope);
    const again = chooseEnvelope(cache, target, [
      { key: "A", value: "one" },
      { key: "B", value: "two" },
      { key: "SA", file: FILE },
    ]);
    expect(again).toEqual({ reuse: true, envelope });
    // The very object, not a copy of it: the ciphertext is what the daemon recognises a resend by.
    expect(again.reuse && again.envelope).toBe(envelope);
  });

  it("is not used when there is nothing kept", () => {
    expect(chooseEnvelope(null, target, entries)).toEqual({ reuse: false });
  });

  it("is not used when a value or a file changed", () => {
    const cache = remember(target, entries, envelope);
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "one" }, { key: "B", value: "twp" }, { key: "SA", file: FILE }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "one" }, { key: "B", value: "two" }, { key: "SA", file: `${FILE}A` }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "one" }, { key: "B", value: "two" }, { key: "SA", file: "" }])).toEqual({ reuse: false });
  });

  it("is not used when a text became a file with the same characters, or a file a text", () => {
    const cache = remember(target, [{ key: "A", value: "AQID" }], envelope);
    expect(chooseEnvelope(cache, target, [{ key: "A", file: "AQID" }])).toEqual({ reuse: false });
    const files = remember(target, [{ key: "A", file: "AQID" }], envelope);
    expect(chooseEnvelope(files, target, [{ key: "A", value: "AQID" }])).toEqual({ reuse: false });
    expect(chooseEnvelope(files, target, [{ key: "A", file: "AQID" }])).toEqual({ reuse: true, envelope });
  });

  it("is not used when a key changed, the rows were put in another order, or a row was added or removed", () => {
    const cache = remember(target, entries, envelope);
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "one" }, { key: "C", value: "two" }, { key: "SA", file: FILE }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [{ key: "B", value: "two" }, { key: "A", value: "one" }, { key: "SA", file: FILE }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [...entries, { key: "C", value: "three" }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, entries.slice(0, 2))).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [])).toEqual({ reuse: false });
  });

  it("is not used when one value only differs in what a loose comparison would ignore", () => {
    const cache = remember(target, [{ key: "A", value: "1" }], envelope);
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "1 " }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "1\n" }])).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, target, [{ key: "a", value: "1" }])).toEqual({ reuse: false });
    // A value that is a prefix of the kept one, and one that extends it.
    const long = remember(target, [{ key: "A", value: "secret-long" }], envelope);
    expect(chooseEnvelope(long, target, [{ key: "A", value: "secret" }])).toEqual({ reuse: false });
    expect(chooseEnvelope(long, target, [{ key: "A", value: "secret-long-er" }])).toEqual({ reuse: false });
  });

  it("is not used for another request, another key, or what another request asked for", () => {
    const cache = remember(target, entries, envelope);
    expect(chooseEnvelope(cache, { ...target, requestId: "r_bbbbbbbbbbbbbbbb" }, entries)).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, { ...target, publicKey: "Q".repeat(43) }, entries)).toEqual({ reuse: false });
    expect(chooseEnvelope(cache, { ...target, requestDigest: "e".repeat(64) }, entries)).toEqual({ reuse: false });
  });

  it("holds its own copy of the entries it was sealed from, and of nothing else an entry was handed with", () => {
    const typed: PayloadEntry[] = [{ key: "A", value: "one" }, { key: "SA", file: FILE }];
    const cache = remember(target, typed, envelope);
    // What the caller does with its list afterwards does not change what the envelope was sealed from.
    (typed[0] as { value: string }).value = "changed";
    (typed[1] as { file: string }).file = "AAAA";
    typed.push({ key: "B", value: "extra" });
    expect(chooseEnvelope(cache, target, [{ key: "A", value: "one" }, { key: "SA", file: FILE }])).toEqual({ reuse: true, envelope });
    expect(chooseEnvelope(cache, target, typed)).toEqual({ reuse: false });
    const extra = remember(target, [{ key: "A", value: "one", note: "x" } as PayloadEntry], envelope);
    expect(extra.entries).toEqual([{ key: "A", value: "one" }]);
  });

  it("is kept after every answer that leaves the request open, except a failed decryption, and after a reply that never came", () => {
    const cache = remember(target, entries, envelope);
    for (const code of ERROR_CODES.filter((candidate) => candidate !== "decrypt_failed")) {
      expect(keepAfter(cache, afterFulfill({ ok: false, code, retryable: true })), code).toBe(cache);
    }
    expect(keepAfter(cache, afterLostReply())).toBe(cache);
  });

  it("is dropped after a failed decryption, after every refusal that closed the request, and after an accepted submission", () => {
    const cache = remember(target, entries, envelope);
    expect(keepAfter(cache, afterFulfill({ ok: false, code: "decrypt_failed", retryable: true }))).toBeNull();
    for (const code of ERROR_CODES) {
      const closing: FulfillResult = { ok: false, code, retryable: false };
      expect(keepAfter(cache, afterFulfill(closing)), code).toBeNull();
    }
    expect(keepAfter(cache, afterFulfill({ ok: true, state: "delivered" }))).toBeNull();
    expect(keepAfter(null, afterLostReply())).toBeNull();
  });

  it("knows whether the outcome of what it holds is unknown", () => {
    const fresh = remember(target, entries, envelope);
    expect(fresh.lostReply).toBe(false);
    expect(unknownOutcome(fresh, target)).toBe(false);
    const lost = markLost(fresh);
    expect(lost.lostReply).toBe(true);
    expect(unknownOutcome(lost, target)).toBe(true);
    // Another request's doubt is not this request's.
    expect(unknownOutcome(lost, { ...target, requestId: "r_bbbbbbbbbbbbbbbb" })).toBe(false);
    expect(unknownOutcome(null, target)).toBe(false);
    // An answer, even a refusal, settles it.
    expect(markKnown(lost).lostReply).toBe(false);
    expect(markLost(fresh).envelope).toBe(envelope);
    expect(markKnown(lost).envelope).toBe(envelope);
    expect(markLost(fresh).entries).toBe(fresh.entries);
  });
});

describe("the envelope that is sent again is a real one", () => {
  it("opens with the request's key, and a second seal of the same values is a different ciphertext", () => {
    const pair = generateRequestKeyPair();
    const values: PayloadEntry[] = [{ key: "A", value: "one" }, { key: "SA", file: FILE }];
    const aad = buildAad("r_aaaaaaaaaaaaaaaa", "d".repeat(64));
    const sealed = seal(pair.publicKey, encodeValues(values), aad);
    const real: SealTarget = { requestId: "r_aaaaaaaaaaaaaaaa", publicKey: toBase64Url(pair.publicKey), requestDigest: "d".repeat(64) };
    expect(chooseEnvelope(remember(real, values, sealed), real, [{ key: "A", value: "one" }, { key: "SA", file: FILE }])).toEqual({ reuse: true, envelope: sealed });
    expect(decodeValues(open(pair.secretKey, sealed, aad))).toEqual(values);
    // The point of keeping it: sealing the same values anew gives the daemon a different ciphertext, which it reads as a different submission.
    expect(seal(pair.publicKey, encodeValues(values), aad).ct).not.toBe(sealed.ct);
  });
});
