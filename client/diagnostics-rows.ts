import type { Diagnostics } from "../shared/contracts";
import { ERROR_CODES, type ErrorCode } from "../shared/errors";
import { describeCode } from "./codes";
import type { Tone } from "./tone";

/** What the settings screen says of how the values travel: the construction `shared/seal.ts` really uses, and nothing else. */
export const SETTINGS_BADGE = "X25519 · HKDF-SHA256 · ChaCha20-Poly1305";

/**
 * The words of the button that deletes every file. The explanation under a row that is red sends the human to the button
 * by these words, so the button and the sentence cannot name it differently.
 */
export const DELETE_ALL = "Видалити всі файли секретів зараз";

/**
 * The line under that button when the deletion itself was refused (the plugin is stopping, or `drop/` could not be swept):
 * fixed words, and nothing of what the refusal said. What is left shows in the rows, read again after the press.
 */
export const DELETE_FAILED = "Не вдалося видалити";

/**
 * One line of the «Стан» section. The dot is green (`ok`), amber (`warn`: something to see, nothing to fix) or red
 * (`bad`: something to do), and only a red row has an explanation under it.
 */
export interface StatusRow {
  label: "Плагін" | "Секрети на сервері" | "Запити, що чекають" | "Помилки";
  value: string;
  dot: "ok" | "warn" | "bad";
  explanation: string | null;
}

const NONE = "Немає";

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

const UNEXPECTED = "Непередбачена помилка. (unexpected)";

function pluginRow(data: Diagnostics): StatusRow {
  if (data.startup !== null) {
    const { code, detail } = data.startup;
    const sentence = code === "unexpected" ? UNEXPECTED : describeCode(code);
    return bad("Плагін", "Не запустився", detail === "" ? sentence : `${sentence} — ${detail}`);
  }
  // The daemon's API arrives with the first call, and messages are held back until the start-up has read the requests.
  if (!data.attached || data.messagesHeld) return warn("Плагін", "Запускається");
  return ok("Плагін", "Працює");
}

function filesRow(data: Diagnostics): StatusRow {
  const { delivered, nextDeleteBy } = data.requests;
  if (data.registry.drop === "failing") {
    return bad(
      "Секрети на сервері",
      `${delivered} · не все видалено`,
      `Не вдалося видалити деякі файли. Натисніть «${DELETE_ALL}» або видаліть ${data.dataDir}/drop.`,
    );
  }
  if (delivered === 0) return ok("Секрети на сервері", NONE);
  // The contract allows a deadline of none beside a set; the count is true all the same.
  if (nextDeleteBy === null) return warn("Секрети на сервері", String(delivered));
  return warn("Секрети на сервері", `${delivered} · найближчий зникне о ${clockTime(nextDeleteBy)}`);
}

function waitingRow(data: Diagnostics): StatusRow {
  const { pending } = data.requests;
  return pending > 0 ? warn("Запити, що чекають", String(pending)) : ok("Запити, що чекають", NONE);
}

const HOOK_FAILURE = /^([^:\s][^:]*): ([a-z_]+)$/;

/** `<hook>: <code>` with the sentence for a code the plugin knows; anything else is shown as it was kept. */
function hookFailure(kept: string): string {
  const parts = HOOK_FAILURE.exec(kept);
  const hook = parts?.[1];
  const code = parts?.[2];
  if (hook === undefined || code === undefined) return kept;
  if (code === "unexpected") return `${hook}: ${UNEXPECTED}`;
  return isKnownCode(code) ? `${hook}: ${describeCode(code)}` : kept;
}

/** The first thing that is the matter, in the order of the table, or null. */
function firstProblem(data: Diagnostics): string | null {
  if (data.registry.persistence === "failing") return "Не вдається зберегти стан запитів.";
  if (data.registry.stored === "unreadable") return "Файл запитів не читається.";
  if (data.outbox.persistence === "failing") return "Не вдається зберегти повідомлення агентам.";
  if (data.cardsOwed > 0) return `Картку не показано в чаті: ${data.cardsOwed}.`;
  if (data.lastHookFailure !== null) return hookFailure(data.lastHookFailure);
  return null;
}

function problemsRow(data: Diagnostics): StatusRow {
  const problem = firstProblem(data);
  return problem === null ? ok("Помилки", NONE) : bad("Помилки", "Є", problem);
}

/**
 * The four lines of the «Стан» section, from what the plugin says of itself. Read-only: nothing here changes anything. Not
 * every number of the contract has a line: the counts of entries left out of the stored requests and of the outbox
 * (`registry.dropped`, `outbox.unsaved`, `outbox.dropped`) are kept in the contract and are not shown.
 */
export function statusRows(data: Diagnostics): StatusRow[] {
  return [pluginRow(data), filesRow(data), waitingRow(data), problemsRow(data)];
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
