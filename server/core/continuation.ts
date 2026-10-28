import type { ErrorCode } from "../../shared/errors";
import { DROP_TTL_MS, MAX_RETRIES } from "../../shared/limits";
import { filePath, setPath } from "../io/drop";
import type { RequestRecord } from "./registry";
import type { ReleasedBy } from "./registry-store";

const PREFIX = "[secure-input]";

const COUNT_WORDS: readonly string[] = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/**
 * "Three submissions failed": how many submissions it takes to reach the retry limit, in words, as the start of a
 * sentence. Built from the number the registry counts to, so the sentence cannot say another one. A number past the
 * list is written in digits.
 */
export function submissionsFailed(count: number): string {
  return `${COUNT_WORDS[count] ?? String(count)} ${count === 1 ? "submission" : "submissions"} failed`;
}

/** One sentence for every code a request can be rejected with, so a new code is a compile error until it has one. */
const HINTS: Record<ErrorCode, string> = {
  invalid_request: "The request or the submitted values could not be read.",
  request_already_pending: "Another request from you was still open.",
  unknown_agent: "The plugin could not tell which agent asked.",
  service_unavailable: "The plugin was not able to take the request.",
  write_failed: "The plugin could not write the files.",
  retry_limit: `${submissionsFailed(MAX_RETRIES)}: the sealed values could not be opened.`,
  request_closed: "The request was no longer open when the user answered, for example because the plugin restarted.",
  decrypt_failed: "The sealed values could not be opened.",
};

const NO_REASON = "The plugin did not record a reason.";

/**
 * Rejections the agent cannot repair by itself: a new request would only fail the same way, and every request makes the
 * user type the values again. Their message ends by sending the agent to the user instead of to a new request.
 */
const ONLY_THE_USER_CAN_FIX: ReadonlySet<ErrorCode> = new Set([
  "invalid_request",
  "unknown_agent",
  "service_unavailable",
  "write_failed",
  "retry_limit",
  "decrypt_failed",
]);

const FIX_AND_ASK = "Fix the cause and make a new request.";
const TELL_THE_USER = "Tell the user what happened. Do not make a new request yourself; each one makes the user type the values again.";

/** What a rejection says: the code (when this version knows it), its sentence and what to do next. */
function reasonOf(code: ErrorCode | null): { named: string; hint: string; next: string } {
  // `Object.hasOwn`, because a code the table does not know must not reach `constructor` or `__proto__`.
  if (code === null || typeof code !== "string" || !Object.hasOwn(HINTS, code)) return { named: "", hint: NO_REASON, next: TELL_THE_USER };
  return { named: ` (${code})`, hint: HINTS[code], next: ONLY_THE_USER_CAN_FIX.has(code) ? TELL_THE_USER : FIX_AND_ASK };
}

/**
 * When the files of a set went, for each way of release that has a message: the agent is told this when the message
 * about the files was still waiting when they went. A set the agent released, or that went at the end of the turn the
 * message started, has none: the agent took them, or was told and had its turn.
 */
const GONE: Readonly<Partial<Record<ReleasedBy, string>>> = {
  time: `${DROP_TTL_MS / 60_000} minutes after they were written`,
  restart: "when the plugin restarted",
  stop: "when the plugin stopped",
  human: "by the user",
};

/**
 * A path as a shell reads it: as it is when it is made of letters, digits and `_./-` alone, and otherwise in single
 * quotes, a quote in it written as `'\''`. Nothing in a path quoted so is expanded or run.
 */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** What the agent is told of a delivery: where each value is, what never to do with it, what to do, and when the files go. */
function deliveredText(head: string, record: RequestRecord, drop: string): string | null {
  const { written, deleteBy } = record;
  if (written === null || deleteBy === null) return null;
  const empty = record.request.fields.map((field) => field.key).filter((key) => !written.includes(key));
  return [
    `${head} delivered ${written.length} value(s) as files only your OS user can read:`,
    ...written.map((key) => `  ${key} → ${shellPath(filePath(drop, record.id, key))}`),
    ...(empty.length > 0 ? [`Left empty by the user, so no file: ${empty.join(", ")}.`] : []),
    "The values were not shown to you. Never let the content of a file or directory whose name starts with si-secret- reach you: do not read, print, open, compare or log it, and do not pass it as an argument.",
    "Move each value where it is needed only by redirection or by copy, for example `command < PATH` or `cp PATH DESTINATION`.",
    `Then delete the directory (\`rm -r ${shellPath(setPath(drop, record.id))}\`) or call release_secret.`,
    `The files are deleted at the end of the turn this message starts, and at ${new Date(deleteBy).toISOString()} at the latest.`,
  ].join("\n");
}

/** What the agent is told of a set that went before its message reached it, or null when there is nothing to tell. */
function releasedText(head: string, by: ReleasedBy | undefined): string | null {
  // `Object.hasOwn`, because a way this version does not know must not reach `constructor` or `__proto__`.
  if (by === undefined || typeof by !== "string" || !Object.hasOwn(GONE, by)) return null;
  return `${head} was delivered, but its files were deleted ${GONE[by] as string}, before this message reached you. Nothing is left to move. If the values are still needed, make a new request.`;
}

/**
 * The fixed text an agent receives about a request, or null when the record has nothing to tell. Built from the
 * record's id, the keys it asked for and the keys that were written, its deadline, its error code and how it ended, and
 * from the drop the files are in; nothing the agent wrote in the request (reason, labels) is repeated. The record holds
 * no value, so no text can.
 */
export function continuationText(record: RequestRecord, drop: string): string | null {
  const head = `${PREFIX} Request ${record.id}`;
  switch (record.state) {
    case "delivered":
      return deliveredText(head, record, drop);
    case "released":
      return releasedText(head, record.releasedBy);
    case "rejected": {
      const { named, hint, next } = reasonOf(record.errorCode);
      return `${head} was rejected before any file was written${named}. ${hint} ${next}`;
    }
    case "declined":
      return `${head}: the user declined to provide the values. Do not ask again in a different way. Ask the user how they want to proceed.`;
    case "expired":
      if (record.expiredBy === "restart") return `${head} expired when the plugin restarted. Nothing was delivered. If the values are still needed, make a new request.`;
      return `${head} expired before the user answered. If the values are still needed, make a new request.`;
    default:
      return null;
  }
}

/** The states whose arrival the agent is told of. `released` is not one: a message that still waits says it instead (`continuationText`). */
const ANNOUNCED: ReadonlySet<RequestRecord["state"]> = new Set(["delivered", "rejected", "declined", "expired"]);

/** Whether a request that has just come to its state is told to its agent. */
export function announces(record: RequestRecord): boolean {
  return ANNOUNCED.has(record.state);
}

/** Sent when a second, different submission reached a request whose values were delivered. Built from the id alone. */
export function tamperText(record: RequestRecord): string {
  return (
    `${PREFIX} Warning for request ${record.id}: a second, different submission arrived after the values were delivered. ` +
    "The files you were given may have held values the user did not type. Tell the user to check what you did with them and to rotate the secret."
  );
}

/**
 * The message an outbox item stands for, or null when the record has nothing to say for it: the tamper warning only
 * when the registry flagged the request as tampered with, the continuation only when the record has one at the moment
 * it is sent. `drop` is where the files of a set are.
 */
export function messageFor(record: RequestRecord, kind: "continuation" | "tamper", drop: string): string | null {
  if (kind === "tamper") return record.tamper ? tamperText(record) : null;
  return continuationText(record, drop);
}
