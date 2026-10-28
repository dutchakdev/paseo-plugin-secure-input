import type { PayloadEntry, SealedEnvelope } from "../shared/seal";
import type { RequestView } from "../shared/view";
import { chooseEnvelope, keepAfter, markKnown, markLost, remember, unknownOutcome, type SealedSubmission } from "./envelope-cache";
import { afterCheckFailed, afterFulfill, afterLostReply, afterMismatch, afterReadClosed, afterSealFailure, type FulfillResult, type Next } from "./outcome";

/** What the sequence needs from outside: the daemon's two calls and the sealer. */
export interface SubmitDeps {
  get(input: { requestId: string }): Promise<RequestView>;
  fulfill(input: { requestId: string; envelope: SealedEnvelope }): Promise<FulfillResult>;
  /** `null` when sealing is not possible. */
  seal(view: Pick<RequestView, "id" | "publicKey" | "requestDigest">, entries: readonly PayloadEntry[]): SealedEnvelope | null;
}

export interface SubmitInput {
  /** The request the human is submitting to: the form was opened for this id. */
  requestId: string;
  /** The view the human is looking at. */
  view: RequestView;
  entries: readonly PayloadEntry[];
  cache: SealedSubmission | null;
}

export interface SubmitOutcome {
  next: Next;
  /** What the form holds now. */
  cache: SealedSubmission | null;
  /** A view the sequence read, to hold instead of the one the human had. */
  view: RequestView | null;
}

const outcome = (next: Next, cache: SealedSubmission | null, view: RequestView | null = null): SubmitOutcome => ({ next, cache, view });

/** Seals, or says it cannot; a sealer that throws is the same as one that says no. */
function sealed(deps: SubmitDeps, view: RequestView, entries: readonly PayloadEntry[]): SealedEnvelope | null {
  try {
    return deps.seal(view, entries);
  } catch {
    return null;
  }
}

/**
 * The whole of a submission, decided here and not in the component: which envelope goes (the kept one for the same
 * entries, a new one otherwise), under which id, what is read first, and what each answer or silence means for the
 * form. The component calls it and does what the outcome says. What goes to the daemon is the request id and the
 * envelope, and nothing else.
 *
 * After a call whose reply never came, a press with changed entries does not send a different submission blindly: if
 * the first one landed, the daemon would answer `request_closed` and flag tampering on the human's own retry. The
 * request is read first. This narrows the gap and does not close it: a view can still say `pending` while the first
 * submission is queued behind other work.
 */
export async function submitEntries(deps: SubmitDeps, submission: SubmitInput): Promise<SubmitOutcome> {
  const { requestId, view, entries } = submission;
  // A view of another request, under typed values, is the one thing nothing may be sealed or sent for.
  if (view.id !== requestId) return outcome(afterMismatch(), submission.cache);

  const target = { requestId, publicKey: view.publicKey, requestDigest: view.requestDigest };
  const choice = chooseEnvelope(submission.cache, target, entries);

  if (!choice.reuse && unknownOutcome(submission.cache, target)) {
    let fresh: RequestView;
    try {
      fresh = await deps.get({ requestId });
    } catch {
      return outcome(afterCheckFailed(), submission.cache);
    }
    if (fresh.id !== requestId) return outcome(afterMismatch(), submission.cache);
    if (fresh.state !== "pending") return outcome(afterReadClosed(), null, fresh);
  }

  let held: SealedSubmission;
  if (choice.reuse && submission.cache !== null) {
    held = submission.cache;
  } else {
    const envelope = sealed(deps, view, entries);
    if (envelope === null) return outcome(afterSealFailure(), submission.cache);
    held = remember(target, entries, envelope);
  }

  let result: FulfillResult;
  try {
    result = await deps.fulfill({ requestId, envelope: held.envelope });
  } catch {
    return outcome(afterLostReply(), markLost(held));
  }

  const next = afterFulfill(result);
  // An answer says what became of the envelope, unless it says that it cannot: then the envelope is kept as after a
  // reply that never came, and a press with other entries reads the request again before it seals them.
  return outcome(next, keepAfter(next.outcomeUnknown ? markLost(held) : markKnown(held), next));
}
