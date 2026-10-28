import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { SecureInputError } from "../shared/errors";
import { codePointLength } from "../shared/text";

/**
 * Many cases here are built from a permission the kernel refuses (a mode of 000, a directory nobody may enter, a file of
 * another owner), and root is refused none of them. Said once, by name, instead of by dozens of cases that fail oddly.
 */
export function assertNotRoot(uid: number | undefined): void {
  if (uid === 0) throw new Error("the suite must not run as root: its permission cases need a user the kernel can refuse");
}
assertNotRoot(process.getuid?.());

const created: string[] = [];

/** A real temporary directory with symlinks resolved (macOS tmp lives behind /private). Removed when the test file that asked for it has finished. */
export function tempDir(prefix = "si-"): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(directory);
  return directory;
}

/** Makes every directory below `path` enterable and writable again, so a mode a test tightened cannot keep it alive. Links are not followed. */
function unlock(path: string): void {
  try {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) unlock(join(path, name));
  } catch {
    // Best effort: whatever cannot be unlocked is left for the removal to report, and removal reports nothing.
  }
}

/** Removes every directory `tempDir` made so far. Best effort: it never throws, so clean-up cannot fail a run. */
export function removeTempDirs(): void {
  for (const directory of created.splice(0)) {
    unlock(directory);
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A directory that stays is litter, not a failure.
    }
  }
}

afterAll(removeTempDirs);

/**
 * The error code of a synchronous throw, or "ok" when nothing failed. For an
 * async subject use `codeOfAsync`: a subject that returns a thenable is refused
 * here, so a rejection can never be reported as "ok".
 */
export function codeOf(subject: () => unknown): string {
  let result: unknown;
  try {
    result = subject();
  } catch (error) {
    return (error as { code?: string }).code ?? "unexpected";
  }
  if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
    // Observe the rejection so refusing the subject does not also raise an unhandled rejection.
    (result as PromiseLike<unknown>).then(undefined, () => undefined);
    throw new Error("codeOf got a promise or thenable; use codeOfAsync for async subjects");
  }
  return "ok";
}

export async function codeOfAsync(subject: Promise<unknown> | (() => Promise<unknown>)): Promise<string> {
  try {
    await (typeof subject === "function" ? subject() : subject);
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "unexpected";
  }
}

/**
 * The error a promise (or a function returning one) rejects with, whatever it is. Fails the test when nothing was
 * rejected: a capture that returned something else for "it did not fail" would let a missing refusal pass.
 */
export async function errorOf(subject: Promise<unknown> | (() => Promise<unknown>)): Promise<Error & { code?: string }> {
  try {
    await (typeof subject === "function" ? subject() : subject);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected a rejection, got a result");
}

/**
 * The code and the text of a rejection; the code is "unexpected" for an error that has none. Fails the test when nothing
 * was rejected, and, with `only: "refusal"`, when what was rejected is not a `SecureInputError`.
 */
export async function rejectionOf(
  subject: Promise<unknown> | (() => Promise<unknown>),
  only: "any" | "refusal" = "any",
): Promise<{ code: string; message: string }> {
  const error = only === "refusal" ? await refusalOf(subject) : await errorOf(subject);
  return { code: error.code ?? "unexpected", message: error.message };
}

/** The refusal a promise rejects with. Anything that is not a `SecureInputError` (a raw ENOENT, say) is rethrown, and so is a result. */
export async function refusalOf(subject: Promise<unknown> | (() => Promise<unknown>)): Promise<SecureInputError> {
  const error = await errorOf(subject);
  if (error instanceof SecureInputError) return error;
  throw error;
}

/**
 * Every byte array that `run` makes with `new Uint8Array`, and what it threw, if it threw. The constructor is looked up
 * when the code under test runs, so it is the one put in its place here for the length of `run`, and the one before it
 * again afterwards, whatever happens. `run` must not wait: what runs while it waits would be watched too.
 */
export function arraysMadeBy(run: () => unknown): { made: Uint8Array[]; error: unknown } {
  const Original = globalThis.Uint8Array;
  const made: Uint8Array[] = [];
  class Watched extends Original {
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      made.push(this);
    }
  }
  let error: unknown;
  globalThis.Uint8Array = Watched as unknown as Uint8ArrayConstructor;
  try {
    const result = run();
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") throw new Error("arraysMadeBy got a promise: what it waits for would be watched too");
  } catch (thrown) {
    error = thrown;
  } finally {
    globalThis.Uint8Array = Original;
  }
  return { made, error };
}

/** The arrays of `made` that still hold a byte that is not zero. */
export const unwiped = (made: readonly Uint8Array[]): Uint8Array[] => made.filter((bytes) => bytes.some((byte) => byte !== 0));

/**
 * Resolves "hung" when the promise has not settled within `milliseconds`: a call that blocks (on a pipe, on a lock)
 * must fail its test, not stall the run.
 */
export async function promptly<T>(promise: Promise<T>, milliseconds = 2000): Promise<T | "hung"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The search for typed values. A test registers what it types where it seals (the helper that seals does it, so no test has
// to remember), and the harness searches everything its subject said for each value, as typed and as JSON spells it.
// ---------------------------------------------------------------------------------------------------------------------

/** A shorter value would be found in a payload by accident (a key, a state, a count), and a search that cries wolf gets turned off. */
export const MIN_TYPED_LENGTH = 6;

/** Throws for a value the search could not tell from the words around it; hands every other value back. */
export function searchable<T extends string>(value: T): T {
  if (codePointLength(value) < MIN_TYPED_LENGTH) {
    throw new Error(`a value a test types must be at least ${MIN_TYPED_LENGTH} characters, or searching for it matches by accident: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The ways a value is spelled in JSON text: as it is, and with the escapes JSON puts in. */
export function spellings(value: string): string[] {
  return [...new Set([value, JSON.stringify(value).slice(1, -1)])];
}

/** Every typed value found in a payload, one line each: the value and the start of the payload that holds it. Empty when none is. */
export function leaksOf(typed: Iterable<string>, payloads: readonly string[]): string[] {
  const found: string[] = [];
  for (const value of typed) {
    for (const spelling of spellings(value)) {
      const hit = payloads.find((payload) => payload.includes(spelling));
      if (hit !== undefined) found.push(`${JSON.stringify(value)} is in ${hit.slice(0, 160)}`);
    }
  }
  return found;
}
