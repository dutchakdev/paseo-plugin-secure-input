import type { PayloadEntry, SealedEnvelope } from "../shared/seal";
import type { Next } from "./outcome";

/**
 * What an envelope was sealed to. The ciphertext is bound to the request and to the digest of what it asked for
 * (`buildAad`) and readable only with the request's key, so an envelope is good for exactly this and nothing else.
 */
export interface SealTarget {
  requestId: string;
  publicKey: string;
  requestDigest: string;
}

/**
 * The envelope of the last submission together with the entries it was sealed from, kept in component memory while the
 * form is open. The daemon recognises a submission by the digest of its ciphertext: the same envelope sent again is
 * answered with the same result, but the same values sealed anew are a second, different submission, and one that
 * arrives after the first was accepted is refused as `request_closed` and flagged as tampering.
 */
export interface SealedSubmission {
  target: SealTarget;
  entries: readonly PayloadEntry[];
  envelope: SealedEnvelope;
  /** True after a call whose reply never came: the daemon may or may not have taken this envelope. */
  lostReply: boolean;
}

export type EnvelopeChoice = { reuse: true; envelope: SealedEnvelope } | { reuse: false };

function sameTarget(a: SealTarget, b: SealTarget): boolean {
  return a.requestId === b.requestId && a.publicKey === b.publicKey && a.requestDigest === b.requestDigest;
}

/** The same key, and the same text or the same file: a text and a file are never the same, whatever characters they have. */
function sameEntry(a: PayloadEntry, b: PayloadEntry): boolean {
  if (a.key !== b.key) return false;
  if ("file" in a) return "file" in b && a.file === b.file;
  return !("file" in b) && a.value === b.value;
}

/** Same entries, same order. The values are compared where they already are, in memory; nothing derived from one is made. */
function sameEntries(a: readonly PayloadEntry[], b: readonly PayloadEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && sameEntry(entry, other);
  });
}

/** The kept envelope when the entries are the ones it was sealed from, to the same request. Otherwise the caller seals anew. */
export function chooseEnvelope(cache: SealedSubmission | null, target: SealTarget, entries: readonly PayloadEntry[]): EnvelopeChoice {
  if (cache !== null && sameTarget(cache.target, target) && sameEntries(cache.entries, entries)) {
    return { reuse: true, envelope: cache.envelope };
  }
  return { reuse: false };
}

/**
 * Takes its own copy of the entries, of each its key and its text or its file and nothing else: what the caller does
 * with its list afterwards must not change what the envelope was sealed from.
 */
export function remember(target: SealTarget, entries: readonly PayloadEntry[], envelope: SealedEnvelope): SealedSubmission {
  const copies = entries.map((entry): PayloadEntry => ("file" in entry ? { key: entry.key, file: entry.file } : { key: entry.key, value: entry.value }));
  return { target: { ...target }, entries: copies, envelope, lostReply: false };
}

/** The call was made and no reply came. */
export function markLost(cache: SealedSubmission): SealedSubmission {
  return { ...cache, lostReply: true };
}

/** An answer came, even a refusal: whether the daemon took the envelope is known again. */
export function markKnown(cache: SealedSubmission): SealedSubmission {
  return { ...cache, lostReply: false };
}

/** True when what is kept was sent to this request and nobody knows whether it was taken. */
export function unknownOutcome(cache: SealedSubmission | null, target: SealTarget): boolean {
  return cache !== null && cache.lostReply && sameTarget(cache.target, target);
}

/** What is kept once the answer is known: the same, unless the answer says the envelope is of no further use. */
export function keepAfter(cache: SealedSubmission | null, next: Pick<Next, "dropEnvelope">): SealedSubmission | null {
  return next.dropEnvelope ? null : cache;
}
