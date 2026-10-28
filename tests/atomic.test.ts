import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePrivateFile, writePrivateFileIf } from "../server/io/atomic";
import { codeOfAsync, refusalOf, tempDir } from "./helpers";

// The plugin's own state files (`requests.json`, `outbox.json`, the stub of v1's bridge) are written here: whole, at
// 0600, by a rename of a temporary file that only this call created.

describe("writePrivateFile", () => {
  it("writes a private file atomically", async () => {
    const file = join(tempDir(), "state.json");
    await writePrivateFile(file, "{}");
    await writePrivateFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("creates missing directories as 0700, tightens an old mode and leaves no temporary file", async () => {
    const base = tempDir();
    const file = join(base, "nested", "state.json");
    await writePrivateFile(file, "{}");
    expect(statSync(join(base, "nested")).mode & 0o777).toBe(0o700);
    chmodSync(file, 0o644);
    await writePrivateFile(file, '{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(base, "nested"))).toEqual(["state.json"]);
  });

  it("uses the mode it is given", async () => {
    const file = join(tempDir(), "state.json");
    await writePrivateFile(file, "{}", 0o400);
    expect(statSync(file).mode & 0o777).toBe(0o400);
  });

  it("rejects with write_failed and the errno, never a raw error, and leaves nothing behind", async () => {
    const base = tempDir();
    writeFileSync(join(base, "file"), "x");
    const error = await refusalOf(() => writePrivateFile(join(base, "file", "state.json"), "{}"));
    expect(error.code).toBe("write_failed");
    expect(error.message).toBe("write_failed: EEXIST");
    expect(readdirSync(base)).toEqual(["file"]);
  });

  it("a foreign file that takes its temporary name while it writes is left alone", async () => {
    const base = tempDir();
    async function* swapThenFail(): AsyncGenerator<never, void> {
      const [temp] = readdirSync(base);
      rmSync(join(base, temp as string));
      writeFileSync(join(base, temp as string), "FOREIGN");
      throw new Error("disk full");
    }
    expect(await codeOfAsync(() => writePrivateFile(join(base, "state.json"), swapThenFail() as unknown as string))).toBe("write_failed");
    const [left, ...others] = readdirSync(base);
    expect(others).toEqual([]);
    expect(readFileSync(join(base, left as string), "utf8")).toBe("FOREIGN");
  });

  it("does not leave its temporary file when the replace fails", async () => {
    const base = tempDir();
    mkdirSync(join(base, "state.json"));
    expect(await codeOfAsync(() => writePrivateFile(join(base, "state.json"), "{}"))).toBe("write_failed");
    expect(readdirSync(base)).toEqual(["state.json"]);
  });
});

// A step of the plugin's start-up may come to its effects after the plugin was stopped and another was started on the
// same directory. It asks whether it is still wanted right before each of them. What the question finds when it is
// asked is looked at from inside it, which is the only place from which "right before" can be seen.
describe("writePrivateFileIf: a write that asks whether it is still wanted", () => {
  /** A directory, and a question that answers from a list and records the names in the directory, and what the temporary file holds, at the moment it is asked. */
  function world(answers: boolean[]) {
    const base = tempDir();
    const file = join(base, "state.json");
    const asked: Array<{ names: string[]; staged: string | null }> = [];
    const stillWanted = (): boolean => {
      const names = readdirSync(base).sort();
      const temporary = names.find((name) => /^state\.json\.[0-9a-f]{16}\.tmp$/.test(name));
      asked.push({ names: names.map((name) => (name === temporary ? "<temporary>" : name)), staged: temporary === undefined ? null : readFileSync(join(base, temporary), "utf8") });
      return answers[asked.length - 1] as boolean;
    };
    return { base, file, asked, stillWanted };
  }
  /** What the two questions find when a file is replaced: nothing of the write yet, and then the new content whole beside the old file. */
  const BEFORE = { names: ["state.json"], staged: null };
  const STAGED = { names: ["state.json", "<temporary>"], staged: "NEW" };

  it("asks before it makes anything and again with the new content whole under the temporary name, and then replaces the file", async () => {
    const { base, file, asked, stillWanted } = world([true, true]);
    writeFileSync(file, "OLD", { mode: 0o644 });
    expect(await writePrivateFileIf(file, "NEW", 0o600, stillWanted)).toBe(true);
    expect(asked).toEqual([BEFORE, STAGED]);
    expect(readFileSync(file, "utf8")).toBe("NEW");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(base)).toEqual(["state.json"]);
  });

  it("on no the first time, writes nothing at all: no temporary file, and not the directory the file would be in", async () => {
    const { base, asked, stillWanted } = world([false]);
    expect(await writePrivateFileIf(join(base, "nested", "state.json"), "NEW", 0o600, stillWanted)).toBe(false);
    expect(asked).toEqual([{ names: [], staged: null }]);
    expect(readdirSync(base)).toEqual([]);
  });

  it("on no the second time, leaves the file as it was, removes its temporary file and says that nothing was written", async () => {
    const { base, file, asked, stillWanted } = world([true, false]);
    writeFileSync(file, "OLD", { mode: 0o644 });
    const before = lstatSync(file, { bigint: true });
    expect(await writePrivateFileIf(file, "NEW", 0o600, stillWanted)).toBe(false);
    expect(asked).toEqual([BEFORE, STAGED]);
    expect(readFileSync(file, "utf8")).toBe("OLD");
    const after = lstatSync(file, { bigint: true });
    expect([after.ino, after.mode, after.mtimeNs]).toEqual([before.ino, before.mode, before.mtimeNs]);
    expect(readdirSync(base)).toEqual(["state.json"]);
  });

  it("on no the second time, makes no file where there was none", async () => {
    const { base, file, asked, stillWanted } = world([true, false]);
    expect(await writePrivateFileIf(file, "NEW", 0o600, stillWanted)).toBe(false);
    expect(asked).toEqual([
      { names: [], staged: null },
      { names: ["<temporary>"], staged: "NEW" },
    ]);
    expect(readdirSync(base)).toEqual([]);
  });

  it("is not asked a second time for a write that fails before its content is staged", async () => {
    const base = tempDir();
    writeFileSync(join(base, "file"), "x");
    let asked = 0;
    expect(await codeOfAsync(() => writePrivateFileIf(join(base, "file", "state.json"), "{}", 0o600, () => (asked += 1) > 0))).toBe("write_failed");
    expect(asked).toBe(1);
  });
});
