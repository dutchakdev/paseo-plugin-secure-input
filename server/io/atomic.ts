import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { SecureInputError } from "../../shared/errors";
import { errnoToken, withHandle } from "./descriptor";

/** The one error this module raises for anything that went wrong on disk. The detail is an errno name or nothing. */
function failed(error: unknown): SecureInputError {
  if (error instanceof SecureInputError) return error;
  return new SecureInputError("write_failed", errnoToken(error));
}

/**
 * The error says no file is at this path: no entry of that name (ENOENT), a
 * parent that is no directory (ENOTDIR), or a name too long to exist on the
 * volume (ENAMETOOLONG). A file can still appear there later; this is only
 * what was seen.
 */
function isAbsent(error: unknown): boolean {
  const code = errnoToken(error);
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

/** `unlink` never removes a directory and never follows a link. Never throws, so clean-up cannot replace the outcome of a write. */
async function unlinkFile(path: string): Promise<"removed" | "absent" | "stuck"> {
  try {
    await unlink(path);
    return "removed";
  } catch (error) {
    return isAbsent(error) ? "absent" : "stuck";
  }
}

/**
 * The rule behind every clean-up: a temporary name is ours only while it refers
 * to the file this call created (`dev` and `ino` of the handle it opened).
 * Absent is gone. The same file is unlinked. Another file is a stranger's: it is
 * left alone, whatever the name. A name that cannot be looked at is stuck.
 */
async function removeIfOurs(path: string, dev: bigint, ino: bigint): Promise<"gone" | "foreign" | "stuck"> {
  let info: BigIntStats;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    return isAbsent(error) ? "gone" : "stuck";
  }
  if (info.dev !== dev || info.ino !== ino) return "foreign";
  return (await unlinkFile(path)) === "stuck" ? "stuck" : "gone";
}

/** A failure here means this call created nothing, so whatever is at `path` is not ours to remove. */
function createExclusive(path: string, mode: number): Promise<FileHandle> {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
}

/**
 * Writes, flushes and closes. Of two failures the first is the one that comes out (a full disk, not what the close
 * said after it), and a close that fails after a write that worked is a failure too: see `withHandle`.
 */
function fill(handle: FileHandle, content: string): Promise<void> {
  return withHandle(handle, async () => {
    await handle.writeFile(content);
    await handle.sync();
  });
}

/**
 * The question a step of the plugin's start-up asks right before each thing it does to a path the plugin shares with
 * whichever plugin is started after it on the same data directory: what is in `drop/`, the stub and the shim. The
 * answer is no once the plugin the step belongs to is being stopped (for the sweep and the load, which are let finish
 * within the wait of the stop: once that wait is over). By then those paths may be the next plugin's, and the step does
 * not do the thing. It is asked with nothing awaited between the answer and the call that does the thing, so all that is
 * left between the two is that one call.
 */
export type StillWanted = () => boolean;

/** Atomic replace for the plugin's own state files. These never hold a typed value. */
export async function writePrivateFile(path: string, content: string, mode = 0o600): Promise<void> {
  await writePrivateFileIf(path, content, mode, () => true);
}

/**
 * `writePrivateFile` for a step of the start-up. `stillWanted` is asked twice. First before anything is made: on "no"
 * nothing is written at all, not the directory and not a temporary file. Then when the new content is whole under its
 * temporary name, right before the `rename` that puts it at `path`: on "no" the rename is not made and the temporary
 * file is removed as after a failed write. Either way the answer is `false` and `path` is as it was; `true` when the
 * file was written. A write that fails before its content is staged does not ask the second time.
 */
export async function writePrivateFileIf(path: string, content: string, mode: number, stillWanted: StillWanted): Promise<boolean> {
  try {
    if (!stillWanted()) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await createExclusive(temp, mode);
    let identity: { dev: bigint; ino: bigint };
    try {
      const { dev, ino } = await handle.stat({ bigint: true });
      identity = { dev, ino };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    try {
      await fill(handle, content);
      if (stillWanted()) {
        await rename(temp, path);
        return true;
      }
    } catch (error) {
      await removeIfOurs(temp, identity.dev, identity.ino);
      throw error;
    }
    await removeIfOurs(temp, identity.dev, identity.ino);
    return false;
  } catch (error) {
    throw failed(error);
  }
}
