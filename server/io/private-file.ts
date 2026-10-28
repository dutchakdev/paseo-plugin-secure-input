import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { SecureInputError } from "../../shared/errors";
import { errnoToken } from "./descriptor";

/**
 * Why `readPrivateFile` refuses a file for what it is, as opposed to a read that failed just now: a link in its place,
 * something that is no regular file (a pipe, a directory, a device), more bytes than the caller allows, bytes that are
 * not UTF-8. A file refused for one of these is not one the plugin wrote; a caller that owns the file may replace it.
 */
export const PRIVATE_FILE_REFUSALS = ["link", "not_regular", "too_large", "not_utf8"] as const;
export type PrivateFileRefusal = (typeof PRIVATE_FILE_REFUSALS)[number];

/** The errno a link in place of the file gives under `O_NOFOLLOW`: `ELOOP`, and `EMLINK` where that is the errno. */
const LINK_ERRNOS: ReadonlySet<string> = new Set(["ELOOP", "EMLINK"]);

/**
 * What `readPrivateFile` rejects with. `refusal` is the token of the reason when the file itself was refused, and
 * `null` when it could not be read just now (`EACCES`, `EIO`, `EMFILE`, ...), which says nothing about what it holds.
 * The message is the one a `SecureInputError` has: `write_failed`, then an errno name or a fixed phrase.
 */
export class PrivateFileError extends SecureInputError {
  constructor(
    detail: string | undefined,
    readonly refusal: PrivateFileRefusal | null,
  ) {
    super("write_failed", detail);
    this.name = "PrivateFileError";
  }
}

/** The token of the reason `readPrivateFile` refused a file for, or `null` for any other error. */
export function privateFileRefusal(error: unknown): PrivateFileRefusal | null {
  return error instanceof PrivateFileError ? error.refusal : null;
}

function failed(error: unknown): PrivateFileError {
  if (error instanceof PrivateFileError) return error;
  const errno = errnoToken(error);
  return new PrivateFileError(errno, errno !== undefined && LINK_ERRNOS.has(errno) ? "link" : null);
}

/**
 * The text of a state file of the plugin's own, which the agent can also write: so it is read as hostile input. One
 * handle, no link followed, no wait on a pipe, a regular file only (the one thing `fstat` is trusted for), no more than
 * `maxBytes` (one byte more is read, so a file that grows meanwhile is still caught) and UTF-8 only. `null` when there
 * is no such file. Everything else rejects with a `PrivateFileError`: `write_failed` and a detail that is an errno name
 * or a fixed phrase, never anything the file held.
 *
 * Scope: this is for files inside the plugin's own 0700 data directory. It does not check who owns the file, how many
 * links it has or whether it is executable, so it is not for files anywhere else. `O_NOFOLLOW` covers the last
 * component of the path only; the directories above it are the caller's. `write_failed` is this codebase's code for
 * "the plugin's own file is unusable", whether it was being read or written. A caller tells the reasons apart by
 * `privateFileRefusal`, not by the text: `link` (`ELOOP`, or `EMLINK` where that is the errno), `not_regular` ("not a
 * regular file"), `too_large` ("larger than N bytes") and `not_utf8` ("not valid UTF-8") mean the file is not what the
 * plugin wrote; `null` goes with any other errno name, or none, and means the file could not be read right now.
 */
export async function readPrivateFile(path: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errnoToken(error) === "ENOENT") return null;
    throw failed(error);
  }
  try {
    if (!(await handle.stat()).isFile()) throw new PrivateFileError("not a regular file", "not_regular");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new PrivateFileError(`larger than ${maxBytes} bytes`, "too_large");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new PrivateFileError("not valid UTF-8", "not_utf8");
    }
  } catch (error) {
    throw failed(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
