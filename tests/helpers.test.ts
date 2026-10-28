import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecureInputError } from "../shared/errors";
import { MIN_TYPED_LENGTH, assertNotRoot, codeOf, codeOfAsync, errorOf, leaksOf, promptly, refusalOf, rejectionOf, removeTempDirs, searchable, spellings, tempDir } from "./helpers";

describe("codeOf", () => {
  const rejection = () => Promise.reject(Object.assign(new Error("nope"), { code: "boom" }));

  it("reads the code of a synchronous throw and reports ok otherwise", () => {
    expect(codeOf(() => { throw Object.assign(new Error("x"), { code: "boom" }); })).toBe("boom");
    expect(codeOf(() => { throw new Error("x"); })).toBe("unexpected");
    expect(codeOf(() => 1)).toBe("ok");
  });

  it("refuses an async subject instead of reporting ok for a rejection", () => {
    expect(() => codeOf(rejection)).toThrow(/codeOfAsync/);
    expect(() => codeOf(() => Promise.resolve(1))).toThrow(/codeOfAsync/);
  });

  it("is what codeOfAsync is for", async () => {
    await expect(codeOfAsync(rejection)).resolves.toBe("boom");
    await expect(codeOfAsync(Promise.resolve(1))).resolves.toBe("ok");
  });
});

describe("tempDir", () => {
  it("is removed by removeTempDirs, including directories a test made unreadable and unwritable, and leaves a link's target alone", () => {
    const directory = tempDir();
    const another = tempDir("si another-");
    const deep = join(directory, "locked", "deeper");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "file"), "x");
    chmodSync(deep, 0o000);
    chmodSync(join(directory, "locked"), 0o500);
    // Registered with nobody: if the clean-up followed the link it would change this directory and empty it.
    const outside = mkdtempSync(join(tmpdir(), "helpers-outside-"));
    try {
      writeFileSync(join(outside, "keep"), "KEEP");
      chmodSync(outside, 0o750);
      symlinkSync(outside, join(directory, "link-out"));
      removeTempDirs();
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(another)).toBe(false);
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("KEEP");
      expect(statSync(outside).mode & 0o777).toBe(0o750);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("removeTempDirs does not fail when a directory is already gone, or when called twice", () => {
    const directory = tempDir();
    rmSync(directory, { recursive: true });
    expect(() => removeTempDirs()).not.toThrow();
    expect(() => removeTempDirs()).not.toThrow();
  });
});

describe("assertNotRoot", () => {
  it("names the reason when the suite runs as root, and says nothing for any other user", () => {
    expect(() => assertNotRoot(0)).toThrow("the suite must not run as root: its permission cases need a user the kernel can refuse");
    expect(() => assertNotRoot(501)).not.toThrow();
    expect(() => assertNotRoot(undefined)).not.toThrow();
    expect(process.getuid?.()).not.toBe(0);
  });
});

describe("the capture helpers", () => {
  it("fail the test when nothing was rejected, which is what makes them a check", async () => {
    await expect(errorOf(Promise.resolve(1))).rejects.toThrow("expected a rejection, got a result");
    await expect(errorOf(async () => 1)).rejects.toThrow("expected a rejection, got a result");
    await expect(rejectionOf(Promise.resolve(1))).rejects.toThrow("expected a rejection, got a result");
    await expect(refusalOf(Promise.resolve(1))).rejects.toThrow("expected a rejection, got a result");
  });

  it("hand back what was rejected: its code and text, or the refusal itself", async () => {
    expect(await rejectionOf(Promise.reject(Object.assign(new Error("nope"), { code: "boom" })))).toEqual({ code: "boom", message: "nope" });
    expect(await rejectionOf(() => Promise.reject(new Error("plain")))).toEqual({ code: "unexpected", message: "plain" });
    const refusal = new SecureInputError("write_failed", "EIO");
    expect(await refusalOf(Promise.reject(refusal))).toBe(refusal);
    expect(await rejectionOf(Promise.reject(refusal), "refusal")).toEqual({ code: "write_failed", message: "write_failed: EIO" });
  });

  it("refuse a raw error where a refusal of the plugin is required", async () => {
    const raw = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    await expect(refusalOf(Promise.reject(raw))).rejects.toBe(raw);
    await expect(rejectionOf(Promise.reject(raw), "refusal")).rejects.toBe(raw);
  });
});

describe("promptly", () => {
  it("gives the promise's own answer when it comes in time and \"hung\" when it does not", async () => {
    expect(await promptly(Promise.resolve("done"))).toBe("done");
    expect(await promptly(new Promise<string>(() => undefined), 20)).toBe("hung");
    await expect(promptly(Promise.reject(new Error("kept")))).rejects.toThrow("kept");
  });
});

describe("the search for typed values", () => {
  it("refuses a value shorter than six characters, counted as characters and not as UTF-16 units", () => {
    expect(MIN_TYPED_LENGTH).toBe(6);
    for (const value of ["", "v", "short", "five5", "\u{1F511}".repeat(5)]) expect(() => searchable(value), JSON.stringify(value)).toThrow(/at least 6 characters/);
    for (const value of ["sixsix", "\u{1F511}".repeat(6), "CANARY-sk_live_4242"]) expect(searchable(value)).toBe(value);
  });

  it("spells a value as typed and as JSON writes it", () => {
    expect(spellings("plain-value")).toEqual(["plain-value"]);
    expect(spellings('line\none "quoted" \\ back')).toEqual(['line\none "quoted" \\ back', 'line\\none \\"quoted\\" \\\\ back']);
  });

  it("finds a value in a payload in either spelling, and nothing in a payload that does not hold it", () => {
    const typed = ["CANARY-one", 'two\nlines "here"'];
    expect(leaksOf(typed, [JSON.stringify({ receipt: "keys A, B" }), "[redacted]"])).toEqual([]);
    expect(leaksOf(typed, [JSON.stringify({ note: "see CANARY-one" })])).toEqual(['"CANARY-one" is in {"note":"see CANARY-one"}']);
    expect(leaksOf(typed, [JSON.stringify({ note: 'two\nlines "here"' })])).toHaveLength(1);
    expect(leaksOf(typed, ['raw two\nlines "here" text'])).toHaveLength(1);
    expect(leaksOf([], ["anything"])).toEqual([]);
  });
});
