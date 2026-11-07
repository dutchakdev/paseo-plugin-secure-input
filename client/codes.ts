import { ERROR_CODES, type ErrorCode } from "../shared/errors";
import type { messages, Translate } from "./messages";

/**
 * One key for every code the plugin can answer with, so a new code is a compile error until English has its sentence.
 * The settings screen says them, with the code, about a start-up or a hook that failed. The form says none of them:
 * every refusal there is one of its two lines (`./outcome`). A map keeps a name from the prototype (`constructor`,
 * `__proto__`) from finding a sentence.
 */
const CODE_KEYS: ReadonlyMap<string, `codes.${keyof typeof messages.resources.en.codes}`> = new Map(ERROR_CODES.map((code) => [code, `codes.${code}`] as const));

/** The sentence first; the code after it, in parentheses, for whoever the human asks for help. */
export function describeCode(t: Translate, code: ErrorCode): string {
  return `${t(CODE_KEYS.get(code) ?? "codes.unknown")} (${code})`;
}
