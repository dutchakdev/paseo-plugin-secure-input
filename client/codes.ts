import type { ErrorCode } from "../shared/errors";
import { MAX_RETRIES } from "../shared/limits";
import { afterFailedAttempts, attemptsFailed } from "./text";

/** The end of the sentence about a refusal that counts: the limit is the plugin's own number, said in words. */
const CLOSES_AFTER = `${afterFailedAttempts(MAX_RETRIES)} запит закривається.`;

/**
 * One sentence for the human for every code the plugin can answer with, so a new code is a compile error until it has
 * one. The settings screen says them, with the code, about a start-up or a hook that failed. The form says none of
 * them: every refusal there is one of its two lines (`./outcome`).
 */
export const CODE_SENTENCE: Readonly<Record<ErrorCode, string>> = {
  invalid_request: "Запит або надіслані значення не вдалося прочитати.",
  request_already_pending: "Від агента вже є ще один відкритий запит.",
  unknown_agent: "Плагін не зміг визначити, який агент надіслав запит.",
  service_unavailable: "Плагін зараз не може прийняти запит.",
  write_failed: "Файл не вдалося записати.",
  retry_limit: `${attemptsFailed(MAX_RETRIES)}: зашифровані значення не вдалося розкрити.`,
  request_closed: "Запит уже було закрито, коли ви відповіли (наприклад, плагін перезапускали).",
  decrypt_failed: `Плагін не зміг розкрити зашифровані значення — можливе втручання в канал. Перевірте, що з'єднання йде через relay або Tailscale, і спробуйте ще раз. ${CLOSES_AFTER}`,
};

const UNKNOWN_SENTENCE = "Невідома помилка.";

/** A map, so a name from the prototype (`constructor`, `__proto__`) finds nothing. */
const SENTENCES: ReadonlyMap<string, string> = new Map(Object.entries(CODE_SENTENCE));

/** The sentence first; the code after it, in parentheses, for whoever the human asks for help. */
export function describeCode(code: ErrorCode): string {
  return `${SENTENCES.get(code) ?? UNKNOWN_SENTENCE} (${code})`;
}
