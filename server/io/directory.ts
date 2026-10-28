import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { SecureInputError } from "../../shared/errors";
import { uid } from "./ownership";

function unavailable(detail: string): SecureInputError {
  return new SecureInputError("service_unavailable", detail);
}

/**
 * The directory must be a real directory (never a link) of this user, held at
 * 0700. `mkdir` does nothing to one that exists, so this looks at it through a
 * handle opened without following links, and only as a directory: the owner
 * check and the chmod then concern the one inode that was opened. `what` names
 * the directory in the refusal ("data", "drop", "bridge"); it is always one
 * of our own words, never a caller's text.
 */
export async function holdDirectory(directory: string, what: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw unavailable(`the ${what} directory cannot be created`);
  }
  const unsafe = (): SecureInputError => unavailable(`the ${what} directory is not a private directory of this user`);
  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw unsafe();
  }
  try {
    const stats = await handle.stat();
    if (stats.uid !== uid()) throw unsafe();
    if ((stats.mode & 0o7777) !== 0o700) await handle.chmod(0o700);
  } catch (error) {
    throw error instanceof SecureInputError ? error : unsafe();
  } finally {
    await handle.close().catch(() => undefined);
  }
}
