import type { ErrorCode } from "../shared/errors";
import type { RequestState } from "../shared/request";

/**
 * What the daemon answers to a submission, as the fulfil contract (`shared/contracts.ts`) declares it. Written out
 * here so that this module needs no SDK: the form hands the RPC's answer in, and the compiler holds the two together.
 */
export type FulfillResult =
  | { ok: true; state: RequestState }
  | { ok: false; code: ErrorCode; retryable: boolean; detail?: string };

/** The line at the top of the form when the plugin did not take what was sent, but the request may still be open. */
export const UNAVAILABLE = "Плагін зараз недоступний. Натисни «→» ще раз.";

/** The line at the top of the form when the request is closed: what was typed stays, and «→» is disabled. */
export const CLOSED = "Запит уже закрито.";

/**
 * A plain description of what the form does next. The component does exactly this and decides nothing. Every flag is
 * false and the line null unless the row says otherwise.
 */
export interface Next {
  /** The one line at the top of the form, or none. Nothing the plugin said besides its code is ever in it. */
  top: string | null;
  /** The form closes. */
  close: boolean;
  /** The request is closed on the plugin's side: «→» is disabled from now on, and what was typed stays. */
  closed: boolean;
  /** What was typed is thrown away and every file wiped. False means it stays for the next try. */
  clearForm: boolean;
  /** The sealed envelope kept for a resend is thrown away. */
  dropEnvelope: boolean;
  /**
   * An answer came, and it does not say what became of the submission: the plugin may have taken it. The envelope is
   * kept as one whose outcome is not known, exactly as after a call whose reply never came, so that other values are
   * not sealed and sent before the request has been read again.
   */
  outcomeUnknown: boolean;
}

const STAY: Next = { top: null, close: false, closed: false, clearForm: false, dropEnvelope: false, outcomeUnknown: false };

const unavailable = (): Next => ({ ...STAY, top: UNAVAILABLE });

/** The request is closed: what was typed stays on screen, «→» is disabled, and the envelope is of no use any more. */
const closedNow = (): Next => ({ ...STAY, top: CLOSED, closed: true, dropEnvelope: true });

/**
 * The plugin answered. A submission it took closes the form, which wipes what it held; there is no toast and no
 * screen of success, and the pill turns green. A refusal that closed the request is the closed line, whatever its
 * code; one that left it open is the line that asks for «→» again, and keeps the envelope for that, unless the
 * envelope may be the trouble (`decrypt_failed`, after which the next press seals anew) or what became of it is not
 * known (`service_unavailable`, the handler's fixed answer).
 */
export function afterFulfill(result: FulfillResult): Next {
  if (result.ok) return { ...STAY, close: true, clearForm: true, dropEnvelope: true };
  if (!result.retryable) return closedNow();
  switch (result.code) {
    case "decrypt_failed":
      return { ...unavailable(), dropEnvelope: true };
    case "service_unavailable":
      return { ...unavailable(), outcomeUnknown: true };
    default:
      return unavailable();
  }
}

/** The call failed or timed out. Whether the plugin got the envelope is not known, so the same envelope is what goes next. */
export function afterLostReply(): Next {
  return unavailable();
}

/** Sealing failed in the app, before anything was sent. */
export function afterSealFailure(): Next {
  return unavailable();
}

/** The request had to be read again before new values were sealed, and could not be: none were sent. */
export function afterCheckFailed(): Next {
  return unavailable();
}

/** A view of another request than the one the form was opened for, held or read. Nothing is sent. */
export function afterMismatch(): Next {
  return unavailable();
}

/** A reading found the request closed: nothing new goes out, and the envelope is of no use any more. */
export function afterReadClosed(): Next {
  return closedNow();
}

/** «✕» declined the request, and the form closes; when the decline failed, the form stays and asks to try again. */
export function afterDecline(succeeded: boolean): Next {
  return succeeded ? { ...STAY, close: true, clearForm: true, dropEnvelope: true } : unavailable();
}
