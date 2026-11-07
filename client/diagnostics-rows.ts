import type { Diagnostics } from "../shared/contracts";
import { ERROR_CODES, type ErrorCode } from "../shared/errors";
import { describeCode } from "./codes";
import type { Translate } from "./messages";
import type { Tone } from "./tone";

/** What the settings screen says of how the values travel: the construction `shared/seal.ts` really uses, and nothing else. */
export const SETTINGS_BADGE = "X25519 · HKDF-SHA256 · ChaCha20-Poly1305";

/**
 * One line of the «Status» section. The dot is green (`ok`), amber (`warn`: something to see, nothing to fix) or red
 * (`bad`: something to do), and only a red row has an explanation under it.
 */
export interface StatusRow {
  label: "status.plugin" | "status.files" | "status.pending" | "status.errors";
  value: string;
  dot: "ok" | "warn" | "bad";
  explanation: string | null;
}

const ok = (label: StatusRow["label"], value: string): StatusRow => ({ label, value, dot: "ok", explanation: null });
const warn = (label: StatusRow["label"], value: string): StatusRow => ({ label, value, dot: "warn", explanation: null });
const bad = (label: StatusRow["label"], value: string, explanation: string): StatusRow => ({ label, value, dot: "bad", explanation });

/** The time of day on the clock of this machine, «09:05»: when the nearest set goes is said as a person reads a clock. */
export function clockTime(ms: number): string {
  const time = new Date(ms);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** A set, so that a name from a prototype is no code. */
const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

function isKnownCode(code: string): code is ErrorCode {
  return KNOWN_CODES.has(code);
}

function pluginRow(t: Translate, data: Diagnostics): StatusRow {
  if (data.startup !== null) {
    const { code, detail } = data.startup;
    const sentence = code === "unexpected" ? t("status.unexpected") : describeCode(t, code);
    return bad("status.plugin", t("status.notStarted"), detail === "" ? sentence : `${sentence} — ${detail}`);
  }
  // The daemon's API arrives with the first call, and messages are held back until the start-up has read the requests.
  if (!data.attached || data.messagesHeld) return warn("status.plugin", t("status.starting"));
  return ok("status.plugin", t("status.running"));
}

function filesRow(t: Translate, data: Diagnostics): StatusRow {
  const { delivered, nextDeleteBy } = data.requests;
  if (data.registry.drop === "failing") {
    return bad(
      "status.files",
      t("status.notAllDeleted", { delivered }),
      t("status.deleteFailedHint", { action: t("settings.deleteAll"), dir: data.dataDir }),
    );
  }
  if (delivered === 0) return ok("status.files", t("status.none"));
  // The contract allows a deadline of none beside a set; the count is true all the same.
  if (nextDeleteBy === null) return warn("status.files", String(delivered));
  return warn("status.files", t("status.nextGoesAt", { delivered, time: clockTime(nextDeleteBy) }));
}

function waitingRow(t: Translate, data: Diagnostics): StatusRow {
  const { pending } = data.requests;
  return pending > 0 ? warn("status.pending", String(pending)) : ok("status.pending", t("status.none"));
}

const HOOK_FAILURE = /^([^:\s][^:]*): ([a-z_]+)$/;

/** `<hook>: <code>` with the sentence for a code the plugin knows; anything else is shown as it was kept. */
function hookFailure(t: Translate, kept: string): string {
  const parts = HOOK_FAILURE.exec(kept);
  const hook = parts?.[1];
  const code = parts?.[2];
  if (hook === undefined || code === undefined) return kept;
  if (code === "unexpected") return `${hook}: ${t("status.unexpected")}`;
  return isKnownCode(code) ? `${hook}: ${describeCode(t, code)}` : kept;
}

/** The first thing that is the matter, in the order of the table, or null. */
function firstProblem(t: Translate, data: Diagnostics): string | null {
  if (data.registry.persistence === "failing") return t("status.saveRequestsFailed");
  if (data.registry.stored === "unreadable") return t("status.requestsUnreadable");
  if (data.outbox.persistence === "failing") return t("status.saveMessagesFailed");
  if (data.cardsOwed > 0) return t("status.cardsOwed", { cards: data.cardsOwed });
  if (data.lastHookFailure !== null) return hookFailure(t, data.lastHookFailure);
  return null;
}

function problemsRow(t: Translate, data: Diagnostics): StatusRow {
  const problem = firstProblem(t, data);
  return problem === null ? ok("status.errors", t("status.none")) : bad("status.errors", t("status.some"), problem);
}

/**
 * The four lines of the «Status» section, from what the plugin says of itself. Read-only: nothing here changes anything. Not
 * every number of the contract has a line: the counts of entries left out of the stored requests and of the outbox
 * (`registry.dropped`, `outbox.unsaved`, `outbox.dropped`) are kept in the contract and are not shown.
 */
export function statusRows(t: Translate, data: Diagnostics): StatusRow[] {
  return [pluginRow(t, data), filesRow(t, data), waitingRow(t, data), problemsRow(t, data)];
}

/**
 * Whether the button that deletes every file is shown: while the plugin has a delivered set, and while its drop is
 * failing, which can be with none delivered (the sweep of a start, or of an earlier deletion, left an entry it could not
 * remove). The red row of the secrets sends the human to this button by its words, so the two are there together.
 */
export function canDeleteAll(data: Diagnostics): boolean {
  return data.requests.delivered > 0 || data.registry.drop === "failing";
}

/** The colour of a row's dot, from the theme. */
export function dotColor(dot: StatusRow["dot"], colors: Tone): string {
  switch (dot) {
    case "ok":
      return colors.success;
    case "warn":
      return colors.warning;
    default:
      return colors.danger;
  }
}
