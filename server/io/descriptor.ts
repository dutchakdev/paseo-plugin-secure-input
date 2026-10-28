import type { FileHandle } from "node:fs/promises";

/** How a file is opened. The modules that take one use `open` of `node:fs/promises`; a test hands in one whose handle fails. */
export type OpenFile = (path: string, flags: number, mode?: number) => Promise<FileHandle>;

/** What may stand in an error as the reason: an errno name such as `ENOSPC`, never text a library wrote. */
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** The errno name of a failure of the disk, or undefined when the error has none that may be shown. */
export function errnoToken(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && ERRNO_CODE.test(code) ? code : undefined;
}

/**
 * The lifetime of one descriptor: `use` works on the handle, and the handle is closed on every way out, with the
 * close waited for.
 *
 * The first failure is the one that is reported. When `use` fails, what the close then says is dropped: it came
 * second, and the reason a write or a read did not work (a full disk, a failing one) is the one worth telling. When
 * `use` succeeds, a close that fails is the failure: for a file that was written, the close is where a filesystem
 * may still say that the bytes did not arrive, and a write is not reported as done over that.
 *
 * Errors come out as they were raised; the caller turns them into the plugin's own.
 */
export async function withHandle<T>(handle: FileHandle, use: (handle: FileHandle) => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await use(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return result;
}
