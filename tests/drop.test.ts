import { randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StillWanted } from "../server/io/atomic";
import type { OpenFile } from "../server/io/descriptor";
import { DROP_MAX_DEPTH, DropStore, filePath, setName, setPath, type DropFile, type Removal, type SweepResult } from "../server/io/drop";
import { SecureInputError } from "../shared/errors";
import { DROP_PREFIX, caseCollision } from "../shared/limits";
import { refusalOf, rejectionOf, tempDir } from "./helpers";

const ID = `r_${"ab12".repeat(8)}`;
const mode = (path: string) => statSync(path).mode & 0o777;
const bytes = (text: string) => Buffer.from(text, "utf8");
function store(options?: { openFile?: OpenFile }) { const root = join(tempDir("si drop-"), "drop"); return { root, drop: new DropStore(root, options) }; }
function outside(name = "API_KEY") { const dir = tempDir("si-outside-"); writeFileSync(join(dir, name), "keep-me"); return { dir, file: join(dir, name) }; }
const kept = (file: string) => readFileSync(file, "utf8") === "keep-me";

/** Everything below `dir` as it is on disk, entry by entry: a directory as such, a link as where it points, a file as its bytes. Nothing is followed. */
function tree(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (path: string, at: string): void => {
    for (const name of readdirSync(path).sort()) {
      const entry = join(path, name);
      const where = at === "" ? name : `${at}/${name}`;
      const info = lstatSync(entry);
      if (info.isSymbolicLink()) found[where] = `link to ${readlinkSync(entry)}`;
      else if (info.isDirectory()) {
        found[where] = "directory";
        walk(entry, where);
      } else found[where] = `file ${readFileSync(entry).toString("base64")}`;
    }
  };
  walk(dir, "");
  return found;
}

/** A sweep's answer with its names in order: a directory is listed in whatever order its file system keeps. */
const sorted = (result: SweepResult): SweepResult => ({ ...result, took: [...result.took].sort(), left: [...result.left].sort() });
const SET = `si-secret-${ID}`;

/** The name `write` builds a set under: the set's own name, a dot, sixteen hex digits and `.tmp`. */
const STAGING = new RegExp(`^si-secret-${ID}\\.[0-9a-f]{16}\\.tmp$`);
const two = (): DropFile[] => [{ key: "A_1", bytes: bytes("value-one") }, { key: "B_2", bytes: bytes("value-two") }];
const failure = (error: SecureInputError) => ({ code: error.code, message: error.message });

const NOT_THE_ID = { code: "invalid_request", message: "invalid_request: the request id is not valid" };
const NOT_A_FILE_NAME = { code: "invalid_request", message: "invalid_request: a key is not a valid file name" };
const NOT_PRIVATE = { code: "service_unavailable", message: "service_unavailable: the drop directory is not a private directory of this user" };
const CANNOT_BE_MADE = { code: "service_unavailable", message: "service_unavailable: the drop directory cannot be created" };

/** The code and the exact text of the refusal a synchronous call raises; anything that is not a refusal is rethrown. */
function refused(subject: () => unknown): { code: string; message: string } {
  try {
    subject();
  } catch (error) {
    if (error instanceof SecureInputError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal, got a result");
}

// What is not an id the registry gives, and what is not a key a person can name a value by.
const NOT_IDS: ReadonlyArray<readonly [string, unknown]> = [
  ["empty", ""],
  ["without the prefix", "ab12".repeat(8)],
  ["one digit short", `r_${"ab12".repeat(7)}abc`],
  ["one digit long", `${ID}0`],
  ["in upper case", `r_${"AB12".repeat(8)}`],
  ["not hexadecimal", `r_${"zz12".repeat(8)}`],
  ["followed by a line feed", `${ID}\n`],
  ["a path up", `../${ID}`],
  ["a path down", `${ID}/x`],
  ["not a string", undefined],
  ["a number", 42],
  ["an object that reads as an id", { toString: () => ID }],
];
const NOT_KEYS: ReadonlyArray<readonly [string, unknown]> = [
  ["empty", ""],
  ["starting with a digit", "1A"],
  ["with a dash", "A-B"],
  ["with a space", "A B"],
  ["followed by a line feed", "A\n"],
  ["a path up", "../escape"],
  ["a path down", "a/b"],
  ["a dot", "."],
  ["two dots", ".."],
  ["129 characters long", "K".repeat(129)],
  ["reserved: __proto__", "__proto__"],
  ["reserved: constructor", "constructor"],
  ["reserved: prototype", "prototype"],
  ["not ASCII", "é"],
  ["with a NUL", `A${String.fromCodePoint(0)}B`],
  ["not a string", 5],
  ["undefined", undefined],
];

it("caseCollision finds two keys that name one file when case is ignored", () => {
  expect(caseCollision(["API_KEY", "api_key"])).toEqual(["API_KEY", "api_key"]);
  expect(caseCollision(["A", "B", "A"])).toEqual(["A", "A"]);
  expect(caseCollision(["A", "B", "A_1"])).toBeNull();
});

describe("caseCollision, besides", () => {
  it("says null for no keys and for one, and keeps the order the keys came in", () => {
    expect(caseCollision([])).toBeNull();
    expect(caseCollision(["Key"])).toBeNull();
    expect(caseCollision(["key", "Key"])).toEqual(["key", "Key"]);
    expect(caseCollision(["Key", "OTHER", "KEY", "other"])).toEqual(["Key", "KEY"]);
    expect(caseCollision(["A_1", "a_1", "A_1"])).toEqual(["A_1", "a_1"]);
  });

  it("looks a key up in a map, so that no name an object would treat specially is a collision of its own", () => {
    expect(caseCollision(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])).toBeNull();
    expect(caseCollision(["constructor", "CONSTRUCTOR"])).toEqual(["constructor", "CONSTRUCTOR"]);
  });
});

describe("setPath and filePath", () => {
  it("name the set under the root with the prefix, and a file in it by its key", () => {
    expect(DROP_PREFIX).toBe("si-secret-");
    expect(setName(ID)).toBe(`si-secret-${ID}`);
    expect(setPath("/data/drop", ID)).toBe(`/data/drop/si-secret-${ID}`);
    expect(filePath("/data/drop", ID, "API_KEY")).toBe(`/data/drop/si-secret-${ID}/API_KEY`);
    for (const key of ["A", "_", "K".repeat(128), "constructors", "protos"]) {
      expect(filePath("/data/drop", ID, key), key).toBe(`/data/drop/si-secret-${ID}/${key}`);
    }
  });

  it.each(NOT_IDS)("refuse an id that is %s", (_what, id) => {
    expect(refused(() => setName(id as string))).toEqual(NOT_THE_ID);
    expect(refused(() => setPath("/data/drop", id as string))).toEqual(NOT_THE_ID);
    expect(refused(() => filePath("/data/drop", id as string, "API_KEY"))).toEqual(NOT_THE_ID);
  });

  it.each(NOT_KEYS)("filePath refuses a key that is %s", (_what, key) => {
    expect(refused(() => filePath("/data/drop", ID, key as string))).toEqual(NOT_A_FILE_NAME);
  });
});

describe("write", () => {
  it("writes the set whole: a 0700 directory, one 0600 file per key, the bytes as given, binary too", async () => {
    const { root, drop } = store();
    const files = [{ key: "API_KEY", bytes: bytes("sk_test_4242424242") }, { key: "P12", bytes: Uint8Array.from([0, 255, 13, 10, 0x30, 0x82]) }, { key: "WORD", bytes: bytes("пароль-\u{1F511}") }];
    await drop.write(ID, files);
    expect(readdirSync(root)).toEqual([`si-secret-${ID}`]);
    expect([mode(root), mode(setPath(root, ID))]).toEqual([0o700, 0o700]);
    for (const { key, bytes: content } of files) {
      expect(mode(filePath(root, ID, key))).toBe(0o600);
      expect(readFileSync(filePath(root, ID, key)).equals(Buffer.from(content))).toBe(true);
    }
  });

  it("writes an empty value as an empty file, a view of a larger buffer as the view, and a large value whole", async () => {
    const { root, drop } = store();
    const large = randomBytes(300 * 1024 + 7);
    const files = [
      { key: "EMPTY", bytes: new Uint8Array(0) },
      { key: "VIEW", bytes: bytes("xxSECRETyy").subarray(2, 8) },
      { key: "LARGE", bytes: large },
    ];
    await drop.write(ID, files);
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["EMPTY", "LARGE", "VIEW"]);
    expect(readFileSync(filePath(root, ID, "EMPTY")).length).toBe(0);
    expect(readFileSync(filePath(root, ID, "VIEW"), "utf8")).toBe("SECRET");
    expect(readFileSync(filePath(root, ID, "LARGE")).equals(large)).toBe(true);
    for (const { key } of files) expect(mode(filePath(root, ID, key)), key).toBe(0o600);
  });

  it("makes the set private whatever the umask says", async () => {
    const { root, drop } = store();
    // A daemon started with an odd umask: what it creates comes out without write access for its owner.
    const previous = process.umask(0o277);
    try {
      await drop.write(ID, two());
    } finally {
      process.umask(previous);
    }
    const paths = [root, setPath(root, ID), filePath(root, ID, "A_1"), filePath(root, ID, "B_2")];
    expect(paths.map(mode)).toEqual([0o700, 0o700, 0o600, 0o600]);
  });

  it("puts the set in place only whole: right before it appears, its path is empty and every file is written", async () => {
    const { root, drop } = store();
    const seen: unknown[] = [];
    await drop.write(ID, two(), () => {
      const names = readdirSync(root);
      const staging = names.find((name) => STAGING.test(name));
      seen.push({
        names: names.map((name) => (name === staging ? "<staging>" : name)),
        appeared: existsSync(setPath(root, ID)),
        contents:
          staging === undefined
            ? null
            : Object.fromEntries(
                readdirSync(join(root, staging))
                  .sort()
                  .map((name) => [name, readFileSync(join(root, staging, name), "utf8")]),
              ),
      });
    });
    expect(seen).toEqual([{ names: ["<staging>"], appeared: false, contents: { A_1: "value-one", B_2: "value-two" } }]);
    expect(readdirSync(root)).toEqual([`si-secret-${ID}`]);
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
  });

  it("leaves nothing behind when a file cannot be written, and names only the errno", async () => {
    let opened = 0;
    let asked = 0;
    const failingSecond: OpenFile = async (...args) => {
      opened += 1;
      if (opened === 2) throw Object.assign(new Error("the disk said CANARY-library-text"), { code: "ENOSPC" });
      return open(...args);
    };
    const { root, drop } = store({ openFile: failingSecond });
    const files = [{ key: "A_1", bytes: bytes("CANARY-typed-one") }, { key: "B_2", bytes: bytes("CANARY-typed-two") }];
    const left: string[] = [];
    const error = await refusalOf(() => drop.write(ID, files, () => void (asked += 1), (name) => void left.push(name)));
    expect(failure(error)).toEqual({ code: "write_failed", message: "write_failed: ENOSPC" });
    expect(JSON.stringify(error) + String(error.stack)).not.toContain("CANARY");
    expect(opened).toBe(2);
    expect(asked).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    // The clean-up took everything, so nothing is left to tell of.
    expect(left).toEqual([]);
  });

  it("names what it staged when a failed write cannot take it away, and leaves it there for the caller to take later", async () => {
    let opened = 0;
    // The second file cannot be written, and by then the staging directory can no longer be changed: the clean-up fails too.
    const failingSecond: OpenFile = async (...args) => {
      opened += 1;
      if (opened === 2) {
        chmodSync(dirname(args[0]), 0o500);
        throw Object.assign(new Error("the disk said CANARY-library-text"), { code: "ENOSPC" });
      }
      return open(...args);
    };
    const { root, drop } = store({ openFile: failingSecond });
    const left: string[] = [];
    const error = await refusalOf(() => drop.write(ID, two(), undefined, (name) => void left.push(name)));
    expect(failure(error)).toEqual({ code: "write_failed", message: "write_failed: ENOSPC" });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(STAGING);
    const staging = join(root, left[0] as string);
    try {
      expect(readdirSync(root)).toEqual(left);
      expect(readdirSync(staging)).toEqual(["A_1"]);
    } finally {
      chmodSync(staging, 0o700);
    }
    // Once it can go, it goes by its name, and nothing else in the root is touched.
    await drop.write(`r_${"cd34".repeat(8)}`, two());
    expect(await drop.remove(left[0] as string)).toBe("removed");
    expect(readdirSync(root)).toEqual([`si-secret-r_${"cd34".repeat(8)}`]);
  });

  it("looks at the root once more right before the set takes effect, and puts no set in place through a root swapped since it was held", async () => {
    const base = tempDir("si drop-");
    const root = join(base, "drop");
    const aside = join(base, "aside");
    let opened = 0;
    // Once the last file is open, the root is renamed aside and a link to it takes its place: a rename by path would go
    // through the link and put the set in place where the link leads.
    const swapping: OpenFile = async (...args) => {
      const handle = await open(...args);
      if ((opened += 1) === 2) {
        renameSync(root, aside);
        symlinkSync(aside, root);
      }
      return handle;
    };
    const drop = new DropStore(root, { openFile: swapping });
    const left: string[] = [];
    let asked = 0;
    const error = await refusalOf(() => drop.write(ID, two(), () => void (asked += 1), (name) => void left.push(name)));
    expect(failure(error)).toEqual(NOT_PRIVATE);
    // The look comes before the caller's last word, so that nothing is awaited between that word and the rename.
    expect(asked).toBe(0);
    // No set took effect behind the link. What was staged is still there, beyond a root that is no longer the one that was
    // held, and it is named for the caller to take later.
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(STAGING);
    expect(readdirSync(aside)).toEqual(left);
    expect(readdirSync(join(aside, left[0] as string)).sort()).toEqual(["A_1", "B_2"]);
    expect(readlinkSync(root)).toBe(aside);
  });

  it("leaves nothing behind when the caller turns the write back at the last moment", async () => {
    class TurnedBack extends Error {}
    const { root, drop } = store();
    const sentinel = new TurnedBack("the caller said no");
    let asked = 0;
    await expect(
      drop.write(ID, two(), () => {
        asked += 1;
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(asked).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses an id or a key that is not one, two keys for one file, or nothing, before anything is made", async () => {
    const { root, drop } = store();
    const one = { key: "API_KEY", bytes: bytes("value-one") };
    const refusedWrite = (id: unknown, files: DropFile[]) => rejectionOf(() => drop.write(id as string, files), "refusal");
    for (const [what, id] of NOT_IDS) expect(await refusedWrite(id, [one]), what).toEqual(NOT_THE_ID);
    for (const [what, key] of NOT_KEYS) expect(await refusedWrite(ID, [{ key: key as string, bytes: bytes("value-one") }]), what).toEqual(NOT_A_FILE_NAME);
    expect(await refusedWrite(ID, [one, { key: "api_key", bytes: bytes("value-two") }])).toEqual({
      code: "invalid_request",
      message: "invalid_request: API_KEY and api_key name the same file",
    });
    expect(await refusedWrite(ID, [{ key: "A", bytes: bytes("one") }, { key: "B", bytes: bytes("two") }, { key: "A", bytes: bytes("three") }])).toEqual({
      code: "invalid_request",
      message: "invalid_request: A and A name the same file",
    });
    expect(await refusedWrite(ID, [])).toEqual({ code: "invalid_request", message: "invalid_request: nothing to write" });
    expect(existsSync(root)).toBe(false);
    expect(readdirSync(dirname(root))).toEqual([]);
  });

  it.each([
    ["a link to a directory", (path: string, far: { dir: string; file: string }) => symlinkSync(far.dir, path)],
    ["a link to a file", (path: string, far: { dir: string; file: string }) => symlinkSync(far.file, path)],
    ["a link to nothing", (path: string, far: { dir: string; file: string }) => symlinkSync(join(far.dir, "created-through-the-link"), path)],
    ["a file", (path: string) => writeFileSync(path, "planted")],
  ])("does not write through a link planted where the set goes: %s", async (_what, plant) => {
    const { root, drop } = store();
    const far = outside();
    await drop.hold();
    const set = setPath(root, ID);
    plant(set, far);
    const before = lstatSync(set).isSymbolicLink() ? `link to ${readlinkSync(set)}` : readFileSync(set, "utf8");
    const error = await refusalOf(() => drop.write(ID, [{ key: "API_KEY", bytes: bytes("CANARY-typed-value") }]));
    expect(failure(error)).toEqual({ code: "write_failed", message: "write_failed: ENOTDIR" });
    expect(lstatSync(set).isSymbolicLink() ? `link to ${readlinkSync(set)}` : readFileSync(set, "utf8")).toBe(before);
    expect(readdirSync(far.dir)).toEqual(["API_KEY"]);
    expect(kept(far.file)).toBe(true);
    expect(readdirSync(root)).toEqual([basename(set)]);
  });

  it("does not replace a set that is already there", async () => {
    const { root, drop } = store();
    await drop.write(ID, [{ key: "A_1", bytes: bytes("first-value") }]);
    const error = await refusalOf(() => drop.write(ID, [{ key: "A_1", bytes: bytes("second-value") }, { key: "B_2", bytes: bytes("more") }]));
    expect(failure(error)).toEqual({ code: "write_failed", message: "write_failed: ENOTEMPTY" });
    expect(readdirSync(root)).toEqual([`si-secret-${ID}`]);
    expect(readdirSync(setPath(root, ID))).toEqual(["A_1"]);
    expect(readFileSync(filePath(root, ID, "A_1"), "utf8")).toBe("first-value");
  });

  it("replaces an empty directory planted at the set's path, which holds nothing to lose", async () => {
    // What `rename` does with a directory onto an empty one, on the system the plugin runs on: it replaces it, as
    // `server/io/drop.ts` says. A link, a file or a directory that holds anything is refused above.
    const { root, drop } = store();
    await drop.hold();
    mkdirSync(setPath(root, ID));
    await drop.write(ID, two());
    expect(readdirSync(root)).toEqual([`si-secret-${ID}`]);
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
    expect(mode(setPath(root, ID))).toBe(0o700);
  });

  it("refuses a root that is a link and writes nothing behind it", async () => {
    const base = tempDir("si drop-");
    const far = tempDir("si-far-");
    const root = join(base, "drop");
    symlinkSync(far, root);
    const error = await refusalOf(() => new DropStore(root).write(ID, two()));
    expect(failure(error)).toEqual(NOT_PRIVATE);
    expect(readdirSync(far)).toEqual([]);
    expect(readlinkSync(root)).toBe(far);
  });

  describe("each file is created new, and never through a link", () => {
    /** An `openFile` that, once, puts something at the path it is asked to create: a process of this user can do it between the directory's making and the file's. */
    function planting(plant: (path: string) => void): OpenFile {
      let planted = false;
      return async (...args) => {
        if (!planted) {
          planted = true;
          plant(args[0]);
        }
        return open(...args);
      };
    }

    it.each([
      ["a file", (path: string) => writeFileSync(path, "PLANTED")],
      ["a link to a file", (path: string, far: { dir: string; file: string }) => symlinkSync(far.file, path)],
      ["a link to a directory", (path: string, far: { dir: string; file: string }) => symlinkSync(far.dir, path)],
      ["a link to nothing", (path: string, far: { dir: string; file: string }) => symlinkSync(join(far.dir, "created-through-the-link"), path)],
      ["a directory", (path: string) => mkdirSync(path)],
    ])("%s put at a file's path: the write fails, and nothing of the value goes through it", async (_what, plant) => {
      const far = outside("A_1");
      const { root, drop } = store({ openFile: planting((path) => plant(path, far)) });
      const error = await refusalOf(() => drop.write(ID, [{ key: "A_1", bytes: bytes("CANARY-typed-value") }]));
      expect(failure(error)).toEqual({ code: "write_failed", message: "write_failed: EEXIST" });
      expect(JSON.stringify(error) + String(error.stack)).not.toContain("CANARY");
      expect(readdirSync(far.dir)).toEqual(["A_1"]);
      expect(kept(far.file)).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    });

    it("opens every file for creation only, never through a link, at 0600", async () => {
      const opened: Array<{ path: string; flags: number; mode: number | undefined }> = [];
      const recording: OpenFile = async (path, flags, fileMode) => {
        opened.push({ path, flags, mode: fileMode });
        return open(path, flags, fileMode);
      };
      const { root, drop } = store({ openFile: recording });
      await drop.write(ID, two());
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      expect(opened.map((call) => [call.flags, call.mode])).toEqual([[flags, 0o600], [flags, 0o600]]);
      expect(opened.map((call) => basename(call.path))).toEqual(["A_1", "B_2"]);
      for (const { path } of opened) {
        expect(dirname(dirname(path))).toBe(root);
        expect(basename(dirname(path))).toMatch(STAGING);
      }
    });
  });

  describe("a descriptor is closed on every way out, and the first failure is the one reported", () => {
    type Fault = "chmod" | "writeFile" | "sync" | "close";

    // A handle that fails is a real one, opened on the real file, with some of its operations made to fail with an error
    // of the disk: the only thing that is replaced is how the store is handed its descriptor.
    function faulty(faults: Partial<Record<Fault, string>>, seen: { closed: number }): OpenFile {
      const failWith = (code: string) => Object.assign(new Error(`the disk said CANARY-library-text (${code})`), { code });
      return async (...args) => {
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        for (const operation of ["chmod", "writeFile", "sync"] as const) {
          const code = faults[operation];
          if (code !== undefined) {
            Object.defineProperty(handle, operation, {
              value: async () => {
                throw failWith(code);
              },
            });
          }
        }
        Object.defineProperty(handle, "close", {
          value: async () => {
            seen.closed += 1;
            await close();
            if (faults.close !== undefined) throw failWith(faults.close);
          },
        });
        return handle;
      };
    }

    it.each([
      ["the mode cannot be set", { chmod: "EPERM" }, "EPERM"],
      ["the write fails and the close fails after it", { writeFile: "ENOSPC", close: "EIO" }, "ENOSPC"],
      ["the flush fails and the close fails after it", { sync: "EDQUOT", close: "EIO" }, "EDQUOT"],
      ["the close fails after a write that worked", { close: "EIO" }, "EIO"],
    ] as const)("%s", async (_what, faults, errno) => {
      const seen = { closed: 0 };
      const { root, drop } = store({ openFile: faulty(faults, seen) });
      const error = await refusalOf(() => drop.write(ID, [{ key: "A_1", bytes: bytes("CANARY-typed-value") }]));
      expect(failure(error)).toEqual({ code: "write_failed", message: `write_failed: ${errno}` });
      expect(JSON.stringify(error) + String(error.stack)).not.toContain("CANARY");
      expect(seen.closed).toBe(1);
      expect(readdirSync(root)).toEqual([]);
    });
  });
});

describe("hold", () => {
  it("makes the root a private directory of this user, and tightens one that is open", async () => {
    const { root, drop } = store();
    await drop.hold();
    expect(mode(root)).toBe(0o700);
    chmodSync(root, 0o755);
    await drop.hold();
    expect(mode(root)).toBe(0o700);
  });

  it("refuses a root that is a link, or a file, without touching what is behind it", async () => {
    const base = tempDir("si drop-");
    const far = outside("A_1");
    symlinkSync(far.dir, join(base, "link"));
    writeFileSync(join(base, "file"), "just-a-file");
    expect(failure(await refusalOf(() => new DropStore(join(base, "link")).hold()))).toEqual(NOT_PRIVATE);
    expect(failure(await refusalOf(() => new DropStore(join(base, "file")).hold()))).toEqual(CANNOT_BE_MADE);
    expect(readdirSync(far.dir)).toEqual(["A_1"]);
    expect(readFileSync(join(base, "file"), "utf8")).toBe("just-a-file");
  });
});

describe("release and exists", () => {
  it("removes a set, then says absent; exists follows it", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    expect(await drop.exists(ID)).toBe(true);
    expect(await drop.release(ID)).toBe("removed");
    expect(readdirSync(root)).toEqual([]);
    expect(await drop.exists(ID)).toBe(false);
    expect(await drop.release(ID)).toBe("absent");
    expect(mode(root)).toBe(0o700);
  });

  it("says absent, and makes nothing, when there is no root", async () => {
    const { root, drop } = store();
    expect(await drop.exists(ID)).toBe(false);
    expect(await drop.release(ID)).toBe("absent");
    expect(existsSync(root)).toBe(false);
  });

  it("takes apart whatever a set came to hold: directories, hidden files, what the agent added", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    const set = setPath(root, ID);
    writeFileSync(join(set, ".DS_Store"), "finder");
    mkdirSync(join(set, "copy", "of", "values"), { recursive: true });
    writeFileSync(join(set, "copy", "of", "values", "A_1"), "value-one");
    mkdirSync(join(set, "empty"));
    expect(await drop.release(ID)).toBe("removed");
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes a link inside a set as a link; what it points to stays", async () => {
    const { root, drop } = store();
    const far = outside();
    await drop.write(ID, two());
    const set = setPath(root, ID);
    symlinkSync(far.file, join(set, "TO_FILE"));
    symlinkSync(far.dir, join(set, "TO_DIRECTORY"));
    symlinkSync(join(far.dir, "missing"), join(set, "TO_NOTHING"));
    expect(await drop.release(ID)).toBe("removed");
    expect(readdirSync(root)).toEqual([]);
    expect(kept(far.file)).toBe(true);
    expect(readdirSync(far.dir)).toEqual(["API_KEY"]);
  });

  it("removes a set path that is a link to a directory as a link; the directory keeps its files", async () => {
    const { root, drop } = store();
    const far = outside("A_1");
    await drop.hold();
    symlinkSync(far.dir, setPath(root, ID));
    expect(await drop.exists(ID)).toBe(true);
    expect(await drop.release(ID)).toBe("removed");
    expect(readdirSync(root)).toEqual([]);
    expect(await drop.exists(ID)).toBe(false);
    expect(kept(far.file)).toBe(true);
    expect(readdirSync(far.dir)).toEqual(["A_1"]);
  });

  it("finds no set under a root that is a file, and says stuck for its release: the root is not one the store works through", async () => {
    const base = tempDir("si drop-");
    writeFileSync(join(base, "drop"), "just-a-file");
    const drop = new DropStore(join(base, "drop"));
    expect(await drop.exists(ID)).toBe(false);
    expect(await drop.release(ID)).toBe("stuck");
    expect(readFileSync(join(base, "drop"), "utf8")).toBe("just-a-file");
  });

  it("takes a set it cannot look at to be there, and says stuck when it cannot take it away", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    chmodSync(root, 0o000);
    try {
      expect(await drop.exists(ID)).toBe(true);
      expect(await drop.release(ID)).toBe("stuck");
    } finally {
      chmodSync(root, 0o700);
    }
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
    expect(await drop.release(ID)).toBe("removed");
  });

  it("never reaches outside the root through an id that is not one", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    for (const [what, id] of NOT_IDS) {
      expect(await rejectionOf(() => drop.release(id as string), "refusal"), what).toEqual(NOT_THE_ID);
      expect(await rejectionOf(() => drop.exists(id as string), "refusal"), what).toEqual(NOT_THE_ID);
    }
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
  });

  describe("how deep it goes", () => {
    /** `levels` directories below the set, one in the other. The set itself is the first level. */
    const chain = (set: string, levels: number) => join(set, ...Array.from({ length: levels }, () => "d"));

    it("takes apart a tree down to DROP_MAX_DEPTH levels, the set being the first", async () => {
      const { root, drop } = store();
      await drop.write(ID, two());
      const deepest = chain(setPath(root, ID), DROP_MAX_DEPTH - 1);
      mkdirSync(deepest, { recursive: true });
      writeFileSync(join(deepest, "leaf"), "x");
      expect(await drop.release(ID)).toBe("removed");
      expect(readdirSync(root)).toEqual([]);
    });

    it("leaves a tree deeper than DROP_MAX_DEPTH and counts it stuck", async () => {
      const { root, drop } = store();
      await drop.write(ID, two());
      const set = setPath(root, ID);
      const tooDeep = chain(set, DROP_MAX_DEPTH);
      mkdirSync(tooDeep, { recursive: true });
      writeFileSync(join(tooDeep, "leaf"), "x");
      expect(await drop.release(ID)).toBe("stuck");
      expect(readFileSync(join(tooDeep, "leaf"), "utf8")).toBe("x");
      expect(lstatSync(set).isDirectory()).toBe(true);
      // Nothing is lost by trying again, and nothing outside the tree is touched on the way.
      expect(await drop.release(ID)).toBe("stuck");
      expect(readFileSync(join(tooDeep, "leaf"), "utf8")).toBe("x");
    });

    it("does not go down a tree without a bound", async () => {
      const { root, drop } = store();
      await drop.write(ID, two());
      const set = setPath(root, ID);
      const deep = chain(set, 100);
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "leaf"), "x");
      expect(await drop.release(ID)).toBe("stuck");
      expect(readFileSync(join(deep, "leaf"), "utf8")).toBe("x");
    });
  });
});

describe("the root guard of a removal", () => {
  /** Somewhere outside: a directory named as the set, with a file in it, and a file beside it. What a removal would take, were it led there. */
  function lookalike(): string {
    const dir = tempDir("si-far-");
    mkdirSync(join(dir, SET));
    writeFileSync(join(dir, SET, "KEY"), "keep-me");
    writeFileSync(join(dir, "notes.txt"), "keep-me too");
    return dir;
  }

  /** A store whose root is swapped (`swap`) right after the guard has looked at it: the one point where a test can act between that look and the removal. */
  function swappedAfterLook(root: string, swap: () => void): DropStore {
    class SwappedAfterLook extends DropStore {
      protected override async lookAtRoot(): ReturnType<DropStore["lookAtRoot"]> {
        const look = await super.lookAtRoot();
        swap();
        return look;
      }
    }
    return new SwappedAfterLook(root);
  }

  it("never takes a release through a root that was replaced by a link before it: the tree behind the link stays byte for byte", async () => {
    // No race: the real root is renamed aside and a link to somewhere else is put in its place, at any time before the release.
    const { root, drop } = store();
    await drop.write(ID, two());
    const far = lookalike();
    const before = tree(far);
    const aside = join(tempDir(), "aside");
    renameSync(root, aside);
    symlinkSync(far, root);
    expect(await drop.release(ID)).toBe("stuck");
    expect(tree(far)).toEqual(before);
    expect(readlinkSync(root)).toBe(far);
    // The set itself, gone aside with its root, is beyond the store's reach, and untouched.
    expect(readdirSync(join(aside, SET)).sort()).toEqual(["A_1", "B_2"]);
  });

  it("looks at the root again right before the removal: a root swapped for a link after the first look is not worked through", async () => {
    const base = tempDir("si drop-");
    const root = join(base, "drop");
    const aside = join(base, "aside");
    const far = lookalike();
    const before = tree(far);
    await new DropStore(root).write(ID, two());
    const drop = swappedAfterLook(root, () => {
      renameSync(root, aside);
      symlinkSync(far, root);
    });
    expect(await drop.release(ID)).toBe("stuck");
    expect(tree(far)).toEqual(before);
    expect(readdirSync(join(aside, SET)).sort()).toEqual(["A_1", "B_2"]);
  });

  it("looks at the root again right before the removal: a root swapped for another directory after the first look is not worked through", async () => {
    const base = tempDir("si drop-");
    const root = join(base, "drop");
    const aside = join(base, "aside");
    const other = lookalike();
    const before = tree(other);
    await new DropStore(root).write(ID, two());
    const drop = swappedAfterLook(root, () => {
      renameSync(root, aside);
      renameSync(other, root);
    });
    expect(await drop.release(ID)).toBe("stuck");
    // Now under the root's own name, and as it was: a directory is not the root for being at its path.
    expect(tree(root)).toEqual(before);
    expect(readdirSync(join(aside, SET)).sort()).toEqual(["A_1", "B_2"]);
  });

  it("removes one entry of the root by its name, whatever it is, a link as a link, and says absent once it is gone", async () => {
    const { root, drop } = store();
    const far = outside();
    await drop.write(ID, two());
    writeFileSync(join(root, "stray"), "stray-bytes");
    mkdirSync(join(root, `${SET}.0123456789abcdef.tmp`, "deeper"), { recursive: true });
    writeFileSync(join(root, `${SET}.0123456789abcdef.tmp`, "deeper", "A_1"), "half-written");
    symlinkSync(far.dir, join(root, "link"));
    for (const name of ["stray", `${SET}.0123456789abcdef.tmp`, "link"]) {
      expect(await drop.remove(name), name).toBe("removed");
      expect(await drop.remove(name), name).toBe("absent");
    }
    // What was not named is where it was, and what the link led to too.
    expect(readdirSync(root)).toEqual([SET]);
    expect(readdirSync(far.dir)).toEqual(["API_KEY"]);
    expect(kept(far.file)).toBe(true);
  });

  it("refuses, before it touches anything, a name that is not one entry of the root", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    const NOT_A_NAME = { code: "invalid_request", message: "invalid_request: the name is not an entry of the drop directory" };
    for (const name of ["", ".", "..", `${SET}/A_1`, `../${SET}`, "/etc", `a${String.fromCodePoint(0)}b`, 7, undefined, { toString: () => SET }]) {
      expect(await rejectionOf(() => drop.remove(name as string), "refusal"), String(name)).toEqual(NOT_A_NAME);
    }
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
  });

  it("guards a removal by name as it guards a release: no root is absent, a root that is a link or a file is stuck, and what is behind it stays", async () => {
    const base = tempDir("si drop-");
    expect(await new DropStore(join(base, "missing")).remove("stray")).toBe("absent");
    expect(existsSync(join(base, "missing"))).toBe(false);
    const far = lookalike();
    const before = tree(far);
    symlinkSync(far, join(base, "link"));
    expect(await new DropStore(join(base, "link")).remove(SET)).toBe("stuck");
    expect(await new DropStore(join(base, "link")).remove("notes.txt")).toBe("stuck");
    expect(tree(far)).toEqual(before);
    writeFileSync(join(base, "file"), "just-a-file");
    expect(await new DropStore(join(base, "file")).remove("stray")).toBe("stuck");
    expect(readFileSync(join(base, "file"), "utf8")).toBe("just-a-file");
  });

  it("does not work through a root that is a directory of another user: the file system's own root, which holds no set", async () => {
    // The suite never runs as root (`helpers.ts`), so `/` is another user's. A removal through it would look for the set
    // there and say absent; the guard says stuck without looking.
    expect(lstatSync("/").uid).not.toBe(process.getuid?.());
    expect(await new DropStore("/").release(ID)).toBe("stuck");
    expect(await new DropStore("/").remove(SET)).toBe("stuck");
  });
});

describe("sweep", () => {
  it("sweeps everything in the root, of every kind, and keeps the root at 0700", async () => {
    const { root, drop } = store();
    const far = outside();
    await drop.write(ID, two());
    writeFileSync(join(root, ".stray"), "stray-bytes");
    mkdirSync(join(root, "empty"));
    mkdirSync(join(root, "deep", "er", "est"), { recursive: true });
    writeFileSync(join(root, "deep", "er", "est", "file"), "x");
    symlinkSync(far.dir, join(root, "link"));
    expect(readdirSync(root)).toHaveLength(5);
    expect(sorted(await drop.sweep())).toEqual({ removed: 5, stuck: 0, took: [".stray", "deep", "empty", "link", SET], left: [] });
    expect(readdirSync(root)).toEqual([]);
    expect(mode(root)).toBe(0o700);
    expect(kept(far.file)).toBe(true);
    expect(await drop.sweep()).toEqual({ removed: 0, stuck: 0, took: [], left: [] });
  });

  it("makes the root when there is none, and says nothing was there", async () => {
    const { root, drop } = store();
    expect(await drop.sweep()).toEqual({ removed: 0, stuck: 0, took: [], left: [] });
    expect(readdirSync(root)).toEqual([]);
    expect(mode(root)).toBe(0o700);
  });

  it("clears what a write that was killed half-way left, whatever its name", async () => {
    const { root, drop } = store();
    await drop.hold();
    const leftover = join(root, `si-secret-${ID}.0123456789abcdef.tmp`);
    mkdirSync(leftover);
    writeFileSync(join(leftover, "A_1"), "half-written");
    expect(await drop.sweep()).toEqual({ removed: 1, stuck: 0, took: [`${SET}.0123456789abcdef.tmp`], left: [] });
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not follow a set directory that is swapped for a link while it is being emptied", async () => {
    const far = outside("B_2");
    class Swapping extends DropStore {
      swapped = false;
      protected override async removeChild(...args: Parameters<DropStore["removeChild"]>): Promise<Removal> {
        if (!this.swapped) { this.swapped = true; renameSync(setPath(this.root, ID), join(tempDir(), "moved")); symlinkSync(far.dir, setPath(this.root, ID)); }
        return super.removeChild(...args);
      }
    }
    const drop = new Swapping(join(tempDir(), "drop"));
    await drop.write(ID, [{ key: "A_1", bytes: bytes("value-one") }, { key: "B_2", bytes: bytes("value-two") }]);
    expect(await drop.sweep()).toEqual({ removed: 0, stuck: 1, took: [], left: [SET] });
    expect(kept(far.file)).toBe(true);   // fails without the re-check
    expect(await drop.sweep()).toEqual({ removed: 1, stuck: 0, took: [SET], left: [] });
    expect(kept(far.file)).toBe(true);
  });

  it("does not remove a directory that is not the one it emptied", async () => {
    const moved = join(tempDir(), "moved");
    class SwappingAtTheEnd extends DropStore {
      private removals = 0;
      protected override async removeChild(...args: Parameters<DropStore["removeChild"]>): Promise<Removal> {
        const removal = await super.removeChild(...args);
        // The set's last file is gone: another directory takes the set's place before the set itself is taken away.
        if ((this.removals += 1) === 2) {
          renameSync(setPath(this.root, ID), moved);
          mkdirSync(setPath(this.root, ID));
        }
        return removal;
      }
    }
    const drop = new SwappingAtTheEnd(join(tempDir(), "drop"));
    await drop.write(ID, two());
    expect(await drop.sweep()).toEqual({ removed: 0, stuck: 1, took: [], left: [SET] });
    expect(lstatSync(setPath(drop.root, ID)).isDirectory()).toBe(true);
    expect(readdirSync(moved)).toEqual([]);
    // The directory that stands there now is no set of this store's: once looked at afresh, it is taken away like any other.
    expect(await drop.sweep()).toEqual({ removed: 1, stuck: 0, took: [SET], left: [] });
    expect(readdirSync(drop.root)).toEqual([]);
  });

  describe("a root that is swapped while it is being swept", () => {
    const IDS = [ID, `r_${"cd34".repeat(8)}`, `r_${"ef56".repeat(8)}`];

    /** Somewhere that has a directory of the same name as each set, with a file in it: what a sweep would take away, were it led there. */
    function lookalikes() {
      const dir = tempDir("si-far-");
      const files = IDS.map((id) => join(dir, `si-secret-${id}`, "API_KEY"));
      for (const file of files) {
        mkdirSync(dirname(file));
        writeFileSync(file, "keep-me");
      }
      return { dir, files };
    }

    /** A store whose root is swapped (`swap`) once the first set has lost its last file and before that set is taken away: where a test can act between two entries of a sweep. */
    function swappedMidSweep(root: string, swap: () => void): DropStore {
      class SwappedMidSweep extends DropStore {
        private removals = 0;
        protected override async removeChild(...args: Parameters<DropStore["removeChild"]>): Promise<Removal> {
          const removal = await super.removeChild(...args);
          if ((this.removals += 1) === 2) swap();
          return removal;
        }
      }
      return new SwappedMidSweep(root);
    }

    it("refuses a root that is swapped for a link right after it is held, and removes nothing behind it", async () => {
      // Somewhere else entirely: a document and a folder of photos.
      const far = outside("thesis.docx");
      mkdirSync(join(far.dir, "photos"));
      writeFileSync(join(far.dir, "photos", "a.jpg"), "keep-me");
      const root = join(tempDir("si drop-"), "drop");
      const moved = join(tempDir(), "moved");
      await new DropStore(root).write(ID, two());
      // `hold` has looked at the root, and the root is swapped right after it: the one point where a test can act.
      class SwappedAfterHold extends DropStore {
        override async hold(): Promise<void> {
          await super.hold();
          renameSync(this.root, moved);
          symlinkSync(far.dir, this.root);
        }
      }
      expect(failure(await refusalOf(() => new SwappedAfterHold(root).sweep()))).toEqual(NOT_PRIVATE);
      expect(readdirSync(far.dir).sort()).toEqual(["photos", "thesis.docx"]);
      expect(kept(far.file)).toBe(true);
      expect(kept(join(far.dir, "photos", "a.jpg"))).toBe(true);
      expect(readlinkSync(root)).toBe(far.dir);
      expect(readdirSync(join(moved, `si-secret-${ID}`)).sort()).toEqual(["A_1", "B_2"]);
    });

    it("ends the sweep, with that entry stuck, when the root is swapped for a link between two entries", async () => {
      const root = join(tempDir("si drop-"), "drop");
      const moved = join(tempDir(), "moved");
      const far = lookalikes();
      const drop = swappedMidSweep(root, () => {
        renameSync(root, moved);
        symlinkSync(far.dir, root);
      });
      for (const id of IDS) await drop.write(id, two());
      // The first set is emptied and then the root is a link: that set is no longer the directory that was emptied, the
      // next entry finds the root is no longer the directory the sweep began in, and the third is not tried.
      expect(sorted(await drop.sweep())).toEqual({ removed: 0, stuck: 2, took: [], left: IDS.map(setName).sort() });
      for (const file of far.files) expect(kept(file)).toBe(true);
      expect(readlinkSync(root)).toBe(far.dir);
      // Behind the link nothing was done: one set lost its files before the swap, the other two are whole.
      expect(IDS.map((id) => readdirSync(join(moved, `si-secret-${id}`)).length).sort()).toEqual([0, 2, 2]);
    });

    it("ends the sweep, with that entry stuck, when the root is swapped for another directory between two entries", async () => {
      const root = join(tempDir("si drop-"), "drop");
      const moved = join(tempDir(), "moved");
      const other = lookalikes();
      const drop = swappedMidSweep(root, () => {
        renameSync(root, moved);
        renameSync(other.dir, root);
      });
      for (const id of IDS) await drop.write(id, two());
      expect(sorted(await drop.sweep())).toEqual({ removed: 0, stuck: 2, took: [], left: IDS.map(setName).sort() });
      // Now under the root's own name, and untouched: a directory is not the root for being at its path.
      for (const id of IDS) expect(kept(join(root, `si-secret-${id}`, "API_KEY"))).toBe(true);
      expect(IDS.map((id) => readdirSync(join(moved, `si-secret-${id}`)).length).sort()).toEqual([0, 2, 2]);
    });
  });

  it("does not take an entry for stuck when it is gone by the time it is taken away", async () => {
    const { root, drop } = store();
    const set = setPath(root, ID);
    // The agent deletes its own files while the plugin is taking them away. The question that comes right before each
    // removal is the one point where a test can act.
    await drop.write(ID, two());
    let asked = 0;
    expect(
      await drop.sweep(() => {
        asked += 1;
        if (asked === 1) for (const name of ["A_1", "B_2"]) rmSync(join(set, name));
        return true;
      }),
    ).toEqual({ removed: 1, stuck: 0, took: [SET], left: [] });
    expect(readdirSync(root)).toEqual([]);
    // And the set itself, gone right before it is taken away: nothing was removed, and nothing is left.
    await drop.write(ID, two());
    asked = 0;
    expect(
      await drop.sweep(() => {
        asked += 1;
        if (asked === 3) rmdirSync(set);
        return true;
      }),
    ).toEqual({ removed: 0, stuck: 0, took: [], left: [] });
    expect(asked).toBe(3);
    expect(readdirSync(root)).toEqual([]);
  });

  it("takes a directory that has turned into a file for still there, not for gone", async () => {
    const { root, drop } = store();
    const set = setPath(root, ID);
    await drop.write(ID, two());
    let asked = 0;
    // Asked right before the set is taken away, with its files gone: something that is no directory takes its place.
    expect(
      await drop.sweep(() => {
        asked += 1;
        if (asked === 3) {
          rmdirSync(set);
          writeFileSync(set, "planted");
        }
        return true;
      }),
    ).toEqual({ removed: 0, stuck: 1, took: [], left: [SET] });
    expect(readFileSync(set, "utf8")).toBe("planted");
    expect(await drop.sweep()).toEqual({ removed: 1, stuck: 0, took: [SET], left: [] });
  });

  it("removes nothing once it is no longer wanted", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    writeFileSync(join(root, "stray"), "stray-bytes");
    mkdirSync(join(root, "empty"));
    expect(sorted(await drop.sweep(() => false))).toEqual({ removed: 0, stuck: 1, took: [], left: ["empty", SET, "stray"] });
    expect(readdirSync(root).sort()).toEqual(["empty", `si-secret-${ID}`, "stray"]);
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
    expect(sorted(await drop.sweep())).toEqual({ removed: 3, stuck: 0, took: ["empty", SET, "stray"], left: [] });
  });

  it("asks right before each removal, and a no ends the removal there", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    const set = setPath(root, ID);
    // Each question sees what is left of the set: one removal happens between two questions, the directory is asked
    // about only once it is empty, and no question comes after the no.
    const left: number[] = [];
    const twiceYes: StillWanted = () => {
      left.push(readdirSync(set).length);
      return left.length <= 2;
    };
    expect(await drop.sweep(twiceYes)).toEqual({ removed: 0, stuck: 1, took: [], left: [SET] });
    expect(left).toEqual([2, 1, 0]);
    expect(readdirSync(root)).toEqual([`si-secret-${ID}`]);
    expect(readdirSync(set)).toEqual([]);
    expect(await drop.sweep()).toEqual({ removed: 1, stuck: 0, took: [SET], left: [] });
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes nothing and rejects when the root is a link or a file", async () => {
    const base = tempDir("si drop-");
    const far = outside("A_1");
    symlinkSync(far.dir, join(base, "link"));
    writeFileSync(join(base, "file"), "just-a-file");
    expect(failure(await refusalOf(() => new DropStore(join(base, "link")).sweep()))).toEqual(NOT_PRIVATE);
    expect(failure(await refusalOf(() => new DropStore(join(base, "file")).sweep()))).toEqual(CANNOT_BE_MADE);
    expect(readlinkSync(join(base, "link"))).toBe(far.dir);
    expect(readdirSync(far.dir)).toEqual(["A_1"]);
    expect(kept(far.file)).toBe(true);
    expect(readFileSync(join(base, "file"), "utf8")).toBe("just-a-file");
  });

  it("counts an entry it cannot take away as stuck, and goes on with the rest", async () => {
    const { root, drop } = store();
    await drop.hold();
    // A directory its owner cannot write to: what is in it cannot be unlinked. And one its owner cannot read: what is
    // in it cannot be told.
    const locked = join(root, "locked");
    const unreadable = join(root, "unreadable");
    mkdirSync(locked);
    writeFileSync(join(locked, "file"), "x");
    mkdirSync(unreadable);
    writeFileSync(join(root, "free"), "x");
    chmodSync(locked, 0o500);
    chmodSync(unreadable, 0o000);
    try {
      expect(sorted(await drop.sweep())).toEqual({ removed: 1, stuck: 2, took: ["free"], left: ["locked", "unreadable"] });
      expect(readdirSync(root).sort()).toEqual(["locked", "unreadable"]);
      expect(readdirSync(locked)).toEqual(["file"]);
    } finally {
      chmodSync(locked, 0o700);
      chmodSync(unreadable, 0o700);
    }
    expect(sorted(await drop.sweep())).toEqual({ removed: 2, stuck: 0, took: ["locked", "unreadable"], left: [] });
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects, and removes nothing, when the root cannot be read", async () => {
    const root = join(tempDir("si drop-"), "drop");
    await new DropStore(root).write(ID, two());
    // The root is held, and then something makes it unreadable: the end of `hold` is the one point where a test can act.
    class Unreadable extends DropStore {
      override async hold(): Promise<void> {
        await super.hold();
        chmodSync(root, 0o000);
      }
    }
    try {
      expect(failure(await refusalOf(() => new Unreadable(root).sweep()))).toEqual({
        code: "service_unavailable",
        message: "service_unavailable: the drop directory cannot be read",
      });
    } finally {
      chmodSync(root, 0o700);
    }
    expect(readdirSync(setPath(root, ID)).sort()).toEqual(["A_1", "B_2"]);
  });

  it("counts a tree deeper than DROP_MAX_DEPTH as stuck, and goes on with the rest", async () => {
    const { root, drop } = store();
    await drop.write(ID, two());
    writeFileSync(join(root, "stray"), "stray-bytes");
    const tooDeep = join(setPath(root, ID), ...Array.from({ length: DROP_MAX_DEPTH }, () => "d"));
    mkdirSync(tooDeep, { recursive: true });
    expect(sorted(await drop.sweep())).toEqual({ removed: 1, stuck: 1, took: ["stray"], left: [SET] });
    expect(readdirSync(root)).toEqual([`si-secret-${ID}`]);
    expect(lstatSync(tooDeep).isDirectory()).toBe(true);
  });
});
