import { sanitizeText } from "./sanitize";

/** Every code the plugin answers with. The codes of v1's destinations (a path, git, an existing file, a dotenv format) went with them. */
export const ERROR_CODES = [
  "invalid_request",
  "request_already_pending",
  "unknown_agent",
  "service_unavailable",
  "write_failed",
  "retry_limit",
  "request_closed",
  "decrypt_failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The only error the plugin raises on purpose. `detail` may name a key or a path.
 * It must never contain a typed value: the daemon writes handler error text into
 * its activity log.
 */
export class SecureInputError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SecureInputError";
  }
}

export function errorCodeOf(error: unknown, fallback: ErrorCode): ErrorCode {
  return error instanceof SecureInputError ? error.code : fallback;
}

/**
 * What an error of the plugin's own says besides its code: the detail its author wrote for a person (key names, a
 * path, a fixed phrase; never a value), cleaned of anything that hides or reorders text and cut to `max` characters.
 * Undefined when the error has none, and for every error that is not the plugin's own: what a library, the system
 * or a schema wrote in a message is never passed on, to an agent or to the dialog.
 */
export function errorDetailOf(error: unknown, max: number): string | undefined {
  if (!(error instanceof SecureInputError)) return undefined;
  const prefix = `${error.code}: `;
  if (!error.message.startsWith(prefix)) return undefined;
  const detail = sanitizeText(error.message.slice(prefix.length), max);
  return detail === "" ? undefined : detail;
}
