import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SecureInputError } from "../../shared/errors";
import { DROP_PREFIX, caseCollision, isValidKey } from "../../shared/limits";
import { REQUEST_ID_PATTERN } from "../../shared/request-id";
import type { StillWanted } from "./atomic";
import { errnoToken, withHandle, type OpenFile } from "./descriptor";
import { holdDirectory } from "./directory";
import { uid } from "./ownership";

// The drop is the one place a delivered value lives on the daemon, and this is the only code that creates or deletes
// anything under `<data>/drop/`. A request's values are a directory `si-secret-<requestId>` (0700) with a file for each
// key (0600), each holding the bytes it was given, as they are.
//
// Writing: the set is built under a temporary name in the root and renamed to its place, so that nobody ever finds half
// of it; a failure at any step takes away what was built and says only the errno. What stands at the set's path decides
// the rename: a link, a file or a directory that holds anything makes the write fail, and an empty directory is replaced.
// What a failed write cannot take away is named to the caller (`write`), which owes it from then on.
//
// Removing: `unlink` and `rmdir` only. Every entry is looked at with `lstat` first, so a link is unlinked as a link and
// what it points to is not touched. Node has no `unlinkat` or `openat`, so every call goes by path, and a path is only as
// good as the directories on the way to it. The store therefore looks at a directory again before it works in it, and goes
// on only if it is still the one it was reading. The root has one guard for every removal (`removeFromRoot`, with
// `lookAtRoot` before it): it is looked at without following a link, it has to be a real directory of this user, its
// device and inode are kept, and it is looked at again right before each of its entries is taken away. A root that is a
// link, a file or another user's is not worked through at all, and one swapped since it was looked at is not worked
// through from there on. Any other directory is looked at again before each of its entries and before it is taken away
// itself (`removeChild`, `removeEmptied`). A directory swapped for a link, or for another directory, since it was read is
// not worked through. What this leaves is a swap by a process of the same user that lands between a look and the call it
// guards (the entry's own `lstat` and, for a file, its `unlink`): it narrows that swap and does not close it. A write holds
// the root first and looks at it once more right before the rename that puts the set in place; between the two, its
// files are made by path in the directory it staged them in.
//
// The caller owns the bytes it gives and wipes them. Nothing here copies them, keeps them or puts any of them in an error.

/** The mode of the root and of every set in it: a directory only this user can enter, list or change. */
export const DIRECTORY_MODE = 0o700;

/** The mode of every file of a set: a file only this user can read or write. */
export const FILE_MODE = 0o600;

/**
 * How many levels of directories a removal goes down, the set being the first. A set holds files, so this is far more than
 * an honest one has; what is deeper was not put there by this plugin, and is left, and counted as stuck.
 */
export const DROP_MAX_DEPTH = 8;

/** What became of an entry: taken away; not there (or gone while it was looked at); or still there, whether because it could not be taken away, may not be, or is too deep. */
export type Removal = "removed" | "absent" | "stuck";

export interface SweepResult {
  /** The entries of the root that were taken away. A set counts once, not once for each of its files. */
  removed: number;
  /** The entries of the root that are still there: each that could not be taken away, and the one a sweep that ended early ended at. */
  stuck: number;
  /** The names of the entries that were taken away, as `removed` counts them. */
  took: string[];
  /**
   * The names of the entries that were read and are, as far as the sweep knows, still there: each that could not be
   * taken away, and, when the sweep ended early, every one it did not come to. Not the ones it found gone.
   */
  left: string[];
}

/** One file of a set. The caller owns `bytes` and wipes them; the store neither copies nor keeps them. */
export interface DropFile {
  key: string;
  bytes: Uint8Array;
}

/** A directory as it was seen: a path says where, never which, and a swap changes the one without the other. */
interface Identity {
  dev: bigint;
  ino: bigint;
}

/** The words `holdDirectory` refuses the root with when it is no real directory of this user; a sweep and a write say the same of a root that has become something else since. */
const ROOT_NOT_PRIVATE = "the drop directory is not a private directory of this user";

/** What a sweep says of a root it cannot read, or that is gone by the time it looks again. */
const ROOT_UNREADABLE = "the drop directory cannot be read";

/** `si-secret-<requestId>`, the name of a request's set in the root. Only an id of the shape the registry gives makes a name, so no id can name anything outside the root. */
export function setName(requestId: string): string {
  // `typeof` first: the pattern's `test` turns anything into text, and an object that reads as an id is not one.
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new SecureInputError("invalid_request", "the request id is not valid");
  }
  return `${DROP_PREFIX}${requestId}`;
}

/** `<root>/si-secret-<requestId>`: see `setName`. */
export function setPath(root: string, requestId: string): string {
  return join(root, setName(requestId));
}

/**
 * Whether `name` can be one entry of the root as a directory lists it: text, not empty, not `.` or `..`, and with no `/`
 * and no NUL in it. What a sweep or a write names to the caller is always such a name; anything else would be a path.
 */
function isEntryName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes(String.fromCodePoint(0));
}

/** `<root>/si-secret-<requestId>/<key>`. A key is a name no path can be made of, and not one an object treats specially: see `isValidKey`. */
export function filePath(root: string, requestId: string, key: string): string {
  const set = setPath(root, requestId);
  if (!isValidKey(key)) throw new SecureInputError("invalid_request", "a key is not a valid file name");
  return join(set, key);
}

/** The one error a write raises for anything that went wrong on disk: the errno name, or nothing. A refusal of our own passes as it is. */
function failed(error: unknown): SecureInputError {
  return error instanceof SecureInputError ? error : new SecureInputError("write_failed", errnoToken(error));
}

/**
 * Of `lstat` and `unlink`: no entry of that name (ENOENT), or a parent that is no directory (ENOTDIR). Either way nothing
 * is there. A file can still appear there later; this is only what was seen.
 */
function isAbsent(error: unknown): boolean {
  const code = errnoToken(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Of `readdir` and `rmdir`, which are made on a path that was a directory a moment ago: only ENOENT says it is gone.
 * ENOTDIR says something that is no directory is there now, and that is still there.
 */
function isGone(error: unknown): boolean {
  return errnoToken(error) === "ENOENT";
}

/** Whether `path` is, right now, the directory that was seen: a directory (a link to one is not), with that device and inode. Never throws. */
async function isDirectoryOf(path: string, seen: Identity): Promise<boolean> {
  try {
    const info = await lstat(path, { bigint: true });
    return info.isDirectory() && info.dev === seen.dev && info.ino === seen.ino;
  } catch {
    return false;
  }
}

/**
 * What stands at the root, looked at without following a link: a real directory of this user, by its device and inode;
 * nothing (`absent`); anything else, a link, a file or a directory of another user (`other`); or what cannot be looked at
 * (`unreadable`).
 */
type RootLook = { kind: "directory"; seen: Identity } | { kind: "absent" } | { kind: "other" } | { kind: "unreadable" };

/**
 * `unlink` never removes a directory and never follows a link. `stillWanted` is asked first, with nothing awaited between
 * its answer and the call: see `StillWanted`. Never throws, so a clean-up cannot replace the outcome of a write.
 */
async function unlinkFile(path: string, stillWanted: StillWanted): Promise<Removal> {
  if (!stillWanted()) return "stuck";
  try {
    await unlink(path);
    return "removed";
  } catch (error) {
    return isAbsent(error) ? "absent" : "stuck";
  }
}

/** `rmdir` of a directory that was emptied: only if it is still the directory that was emptied, and only if it is still wanted. Never throws. */
async function removeEmptied(path: string, seen: Identity, stillWanted: StillWanted): Promise<Removal> {
  if (!(await isDirectoryOf(path, seen))) return "stuck";
  if (!stillWanted()) return "stuck";
  try {
    await rmdir(path);
    return "removed";
  } catch (error) {
    return isGone(error) ? "absent" : "stuck";
  }
}

/** What ended a write short of its end: a failure of the store's own, or whatever the caller's last word threw. `undefined` is "nothing yet". */
type Ended = { error: unknown } | undefined;

/** Asks the caller's last word, and says what it threw, if it did. What the caller threw is not the store's to turn into anything else. */
function turnedBack(beforeEffect: (() => void) | undefined): Ended {
  try {
    beforeEffect?.();
    return undefined;
  } catch (error) {
    return { error };
  }
}

export class DropStore {
  private readonly openFile: OpenFile;

  /** `openFile` is how each file of a set is opened; only a test passes one. */
  constructor(
    readonly root: string,
    options: { openFile?: OpenFile } = {},
  ) {
    this.openFile = options.openFile ?? open;
  }

  /** The root is a real directory of this user at 0700, made if it is not there; anything else (a link, a file, another user's) is refused. */
  hold(): Promise<void> {
    return holdDirectory(this.root, "drop");
  }

  /** The root as it is now (`RootLook`), by `lstat`, which follows no link. Never throws. The first look of the root's guard; a test acts right after it. */
  protected async lookAtRoot(): Promise<RootLook> {
    try {
      const info = await lstat(this.root, { bigint: true });
      if (!info.isDirectory() || info.uid !== BigInt(uid())) return { kind: "other" };
      return { kind: "directory", seen: { dev: info.dev, ino: info.ino } };
    } catch (error) {
      return isAbsent(error) ? { kind: "absent" } : { kind: "unreadable" };
    }
  }

  /**
   * The root held for what makes entries in it or sweeps them (`write`, `sweep`): `hold` first, which makes it when it is
   * missing and refuses a link, a file or another user's directory, and then looked at again (`lookAtRoot`), since `hold`
   * looked by path and the root can have been swapped since. Its device and inode are what the guard compares with from
   * then on. Not caught: a swap for another directory in the instant between `hold`'s look and this one, which has no
   * identity of `hold`'s to compare with.
   */
  private async holdRoot(): Promise<Identity> {
    await this.hold();
    const root = await this.lookAtRoot();
    if (root.kind === "directory") return root.seen;
    if (root.kind === "other") throw new SecureInputError("service_unavailable", ROOT_NOT_PRIVATE);
    throw new SecureInputError("service_unavailable", ROOT_UNREADABLE);
  }

  /**
   * Puts a request's files in place as one set: every file written and flushed under a temporary name, then the
   * directory renamed to `si-secret-<requestId>`. Right before the rename the root is looked at once more, and a root
   * that is no longer the directory that was held fails the write (`the drop directory is not a private directory of this
   * user`): the rename goes by path, and through a root swapped for a link it would put the set where the link leads.
   * Then the caller's last word, `beforeEffect`, is asked once, with every file written and nothing yet at the set's path
   * (the registry says no there once it is shutting down), and nothing is awaited between its answer and the rename; what
   * it throws comes out as it was thrown. After a failure at any step what was staged is taken away, under the root's
   * guard, and what comes out is a refusal of this module's own, or `write_failed` with the errno. What the clean-up could
   * not take away (a staging directory it may not change, a root that is no longer the one that was held) is left where it
   * is, and its name in the root is given to `onLeftover` before the failure comes out: from then on the caller owes it.
   *
   * The rename is what refuses a set's path that is taken: a link or a file there fails it (ENOTDIR), and so does a
   * directory that holds anything (ENOTEMPTY). Only an empty directory is replaced.
   */
  async write(requestId: string, files: readonly DropFile[], beforeEffect?: () => void, onLeftover?: (name: string) => void): Promise<void> {
    if (files.length === 0) throw new SecureInputError("invalid_request", "nothing to write");
    const set = setPath(this.root, requestId);
    for (const { key } of files) filePath(this.root, requestId, key);
    const collision = caseCollision(files.map(({ key }) => key));
    if (collision !== null) throw new SecureInputError("invalid_request", `${collision[0]} and ${collision[1]} name the same file`);

    const seen = await this.holdRoot();
    const name = `${setName(requestId)}.${randomBytes(8).toString("hex")}.tmp`;
    const staging = join(this.root, name);
    try {
      await mkdir(staging, { mode: DIRECTORY_MODE });
    } catch (error) {
      // Nothing of ours is at that name, so there is nothing to take away.
      throw failed(error);
    }
    let ended: Ended = undefined;
    try {
      // The umask may have taken bits from the mode the directory was made with.
      await chmod(staging, DIRECTORY_MODE);
      for (const { key, bytes } of files) await this.put(join(staging, key), bytes);
      if (!(await isDirectoryOf(this.root, seen))) throw new SecureInputError("service_unavailable", ROOT_NOT_PRIVATE);
      ended = turnedBack(beforeEffect);
      if (ended === undefined) await rename(staging, set);
    } catch (error) {
      ended = { error: failed(error) };
    }
    if (ended !== undefined) {
      const cleanup = await this.removeFromRoot(seen, name, () => true);
      if (cleanup === "stuck" || cleanup === "moved") {
        try {
          onLeftover?.(name);
        } catch {
          // What the caller does with the name never replaces the outcome of the write.
        }
      }
      throw ended.error;
    }
  }

  /** One file: created new and never through a link, 0600 whatever the umask says, written, flushed and closed. */
  private async put(path: string, content: Uint8Array): Promise<void> {
    const handle = await this.openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    await withHandle(handle, async () => {
      await handle.chmod(FILE_MODE);
      await handle.writeFile(content);
      await handle.sync();
    });
  }

  /** False only when the set is known to be gone: one that cannot be looked at is taken to be there. */
  async exists(requestId: string): Promise<boolean> {
    const path = setPath(this.root, requestId);
    try {
      await lstat(path);
      return true;
    } catch (error) {
      return !isAbsent(error);
    }
  }

  /**
   * Takes the set away, whatever it came to hold, links as links, under the root's guard. `absent` when there is none (no
   * root either); `stuck` when anything of it is still there, and when the root is a link, a file or anything but a real
   * directory of this user, or has been swapped since it was looked at: what it points to is not touched.
   */
  async release(requestId: string): Promise<Removal> {
    return this.removeNamed(setName(requestId));
  }

  /**
   * Takes away one entry of the root by its name, whatever it is, links as links, under the root's guard, as `release`
   * does a set: what a sweep left or a failed write could not take away, which the caller owes and tries again by itself.
   * A name that is not one entry of the root (a path, `..`) is refused before anything is touched.
   */
  async remove(name: string): Promise<Removal> {
    if (!isEntryName(name)) throw new SecureInputError("invalid_request", "the name is not an entry of the drop directory");
    return this.removeNamed(name);
  }

  /** One entry of the root, by its name, under the root's guard: see `release`. Made nothing: a missing root is not made. */
  private async removeNamed(name: string): Promise<Removal> {
    const root = await this.lookAtRoot();
    if (root.kind === "absent") return "absent";
    if (root.kind !== "directory") return "stuck";
    const removal = await this.removeFromRoot(root.seen, name, () => true);
    return removal === "moved" ? "stuck" : removal;
  }

  /**
   * The root's guard, right before one of its entries is taken away: the root is looked at again, and the entry is taken
   * away only while the root is still the directory that was looked at (`seen`). `moved` when it is not: nothing of the
   * entry is touched then, since its path leads somewhere else now.
   */
  private async removeFromRoot(seen: Identity, name: string, stillWanted: StillWanted): Promise<Removal | "moved"> {
    if (!(await isDirectoryOf(this.root, seen))) return "moved";
    return this.removeEntry(join(this.root, name), 1, stillWanted);
  }

  /**
   * Takes away everything in the root, of every kind (sets, leftovers of a write that was killed, whatever else was put
   * there) and leaves the root. The root is held first (`holdRoot`), which refuses a link or a file, and then guarded as
   * for every removal (`removeFromRoot`): before each entry it is looked at once more, and if it is no longer the
   * directory that was held (swapped for a link, or for another directory) the sweep ends there, with that entry stuck and
   * nothing of it removed. Not caught: a swap that lands between a look and the removal it guards (see the top of the
   * file). A `stillWanted` that says no ends the sweep too: nothing more is removed or tried, and the entry it stopped at
   * is stuck. The answer names what was taken away and what is left: the entries that are stuck, and those a sweep that
   * ended early did not come to.
   */
  async sweep(stillWanted: StillWanted = () => true): Promise<SweepResult> {
    const seen = await this.holdRoot();
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      throw new SecureInputError("service_unavailable", ROOT_UNREADABLE);
    }
    let wanted = true;
    const ask: StillWanted = () => {
      if (wanted) wanted = stillWanted();
      return wanted;
    };
    const result: SweepResult = { removed: 0, stuck: 0, took: [], left: [] };
    for (const [index, name] of names.entries()) {
      if (!wanted) {
        result.left.push(...names.slice(index));
        break;
      }
      // Right before each entry, not once for the sweep: the root can be swapped at any point of it. A root that is not
      // the directory the sweep began in is left alone, and the sweep ends with this entry stuck.
      const removal = await this.removeFromRoot(seen, name, ask);
      if (removal === "moved") {
        result.stuck += 1;
        result.left.push(...names.slice(index));
        break;
      }
      if (removal === "removed") {
        result.removed += 1;
        result.took.push(name);
      } else if (removal === "stuck") {
        result.stuck += 1;
        result.left.push(name);
      }
    }
    return result;
  }

  /**
   * Takes one entry away, `depth` levels below the root; a link is unlinked as a link, not followed. No failure of the
   * disk makes it throw: what cannot be done is `stuck`. A directory is emptied entry by entry, and the first that is
   * stuck ends it: `rmdir` is not tried on a directory that still holds something, and `stillWanted` is asked right
   * before each `unlink` and each `rmdir`.
   */
  private async removeEntry(path: string, depth: number, stillWanted: StillWanted): Promise<Removal> {
    let info: BigIntStats;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      return isAbsent(error) ? "absent" : "stuck";
    }
    if (!info.isDirectory()) return unlinkFile(path, stillWanted);
    if (depth > DROP_MAX_DEPTH) return "stuck";
    const seen: Identity = { dev: info.dev, ino: info.ino };
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      return isGone(error) ? "absent" : "stuck";
    }
    for (const name of names) {
      if ((await this.removeChild(path, seen, name, depth + 1, stillWanted)) === "stuck") return "stuck";
    }
    return removeEmptied(path, seen, stillWanted);
  }

  /**
   * Takes the entry `name` out of `parent`, which is `depth` levels below the root. First `parent` is looked at again:
   * `unlink` and `rmdir` go by path, and if the directory that was read has been swapped for a link (or for any other
   * directory) since, the path now leads somewhere else: the entry is then stuck, not removed through it. A swap after
   * this look is the gap the top of the file speaks of.
   */
  protected async removeChild(parent: string, seen: Identity, name: string, depth: number, stillWanted: StillWanted): Promise<Removal> {
    if (!(await isDirectoryOf(parent, seen))) return "stuck";
    return this.removeEntry(join(parent, name), depth, stillWanted);
  }
}
