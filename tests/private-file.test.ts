import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVATE_FILE_REFUSALS, PrivateFileError, privateFileRefusal, readPrivateFile } from "../server/io/private-file";
import { SecureInputError } from "../shared/errors";
import { promptly, tempDir } from "./helpers";

const CANARY = "CANARY-sk_live_4242";
const CAP = 64;

/** What the call resolved to, or the exact message of its rejection; anything but a SecureInputError is spelled out, so it cannot pass for a refusal. */
async function outcome(subject: Promise<string | null>): Promise<string | null> {
  try {
    return await subject;
  } catch (error) {
    return error instanceof SecureInputError ? `rejected ${error.message}` : `raw error: ${String(error)}`;
  }
}

describe("readPrivateFile", () => {
  it("answers null for a file that does not exist", async () => {
    expect(await outcome(readPrivateFile(join(tempDir(), "missing.json"), CAP))).toBeNull();
  });

  it("reads a regular file, an empty one included, as text", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "state.json"), '["a", "é", "\u{1f511}"]');
    writeFileSync(join(directory, "empty.json"), "");
    expect(await outcome(readPrivateFile(join(directory, "state.json"), CAP))).toBe('["a", "é", "\u{1f511}"]');
    expect(await outcome(readPrivateFile(join(directory, "empty.json"), CAP))).toBe("");
  });

  it("reads a file of exactly the cap and refuses one byte more, without quoting what it holds", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "exact"), "a".repeat(CAP));
    writeFileSync(join(directory, "over"), `${CANARY}${"a".repeat(CAP - CANARY.length + 1)}`);
    expect(await outcome(readPrivateFile(join(directory, "exact"), CAP))).toBe("a".repeat(CAP));
    const refusal = await outcome(readPrivateFile(join(directory, "over"), CAP));
    expect(refusal).toBe(`rejected write_failed: larger than ${CAP} bytes`);
    expect(refusal).not.toContain(CANARY);
  });

  it("refuses a link, to a file or dangling, and leaves both the link and its target alone", async () => {
    const directory = tempDir();
    const real = join(directory, "real.json");
    writeFileSync(real, CANARY);
    symlinkSync(real, join(directory, "to-file.json"));
    symlinkSync(join(directory, "missing.json"), join(directory, "dangling.json"));
    expect(await outcome(readPrivateFile(join(directory, "to-file.json"), CAP))).toBe("rejected write_failed: ELOOP");
    expect(await outcome(readPrivateFile(join(directory, "dangling.json"), CAP))).toBe("rejected write_failed: ELOOP");
    expect(lstatSync(join(directory, "to-file.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(CANARY);
  });

  it("refuses a directory", async () => {
    const directory = join(tempDir(), "state.json");
    mkdirSync(directory);
    expect(await outcome(readPrivateFile(directory, CAP))).toBe("rejected write_failed: not a regular file");
  });

  it("refuses a FIFO at once instead of waiting for a writer", async () => {
    const fifo = join(tempDir(), "state.json");
    execFileSync("mkfifo", [fifo]);
    try {
      expect(await promptly(outcome(readPrivateFile(fifo, CAP)))).toBe("rejected write_failed: not a regular file");
      expect(lstatSync(fifo).isFIFO()).toBe(true);
    } finally {
      // Only a regression leaves an open blocked on the FIFO; a writer lets it finish so the process can still exit.
      closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK));
    }
  });

  it("refuses bytes that are not UTF-8 instead of decoding them lossily", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "latin1"), Buffer.from([0x5b, 0x22, 0xe9, 0x22, 0x5d]));
    writeFileSync(join(directory, "truncated"), Buffer.from([0x61, 0xe2, 0x82]));
    expect(await outcome(readPrivateFile(join(directory, "latin1"), CAP))).toBe("rejected write_failed: not valid UTF-8");
    expect(await outcome(readPrivateFile(join(directory, "truncated"), CAP))).toBe("rejected write_failed: not valid UTF-8");
  });

  it("names the errno, and nothing else, when the file cannot be opened", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "plain"), "x");
    writeFileSync(join(directory, "locked.json"), "x");
    chmodSync(join(directory, "locked.json"), 0o000);
    expect(await outcome(readPrivateFile(join(directory, "plain", "below.json"), CAP))).toBe("rejected write_failed: ENOTDIR");
    expect(await outcome(readPrivateFile(join(directory, "locked.json"), CAP))).toBe("rejected write_failed: EACCES");
  });

  describe("says why, as a token a caller can go by", () => {
    /** The token of the rejection, or what came back instead of one. */
    async function refusal(subject: Promise<string | null>): Promise<unknown> {
      try {
        return { read: await subject };
      } catch (error) {
        // The token and the error it came on: one of this module's, with the plugin's code.
        return error instanceof PrivateFileError && error.code === "write_failed" ? privateFileRefusal(error) : `raw error: ${String(error)}`;
      }
    }

    it("names each way a file is not one the plugin wrote, and no way for a file that could not be read just now", async () => {
      const directory = tempDir();
      const at = (name: string) => join(directory, name);
      writeFileSync(at("real.json"), "[]");
      symlinkSync(at("real.json"), at("link"));
      symlinkSync(at("missing.json"), at("dangling"));
      mkdirSync(at("directory"));
      execFileSync("mkfifo", [at("fifo")]);
      writeFileSync(at("large"), "a".repeat(CAP + 1));
      writeFileSync(at("binary"), Buffer.from([0x61, 0xe2, 0x82]));
      writeFileSync(at("locked"), "x");
      chmodSync(at("locked"), 0o000);
      try {
        expect(await refusal(readPrivateFile(at("link"), CAP))).toBe("link");
        expect(await refusal(readPrivateFile(at("dangling"), CAP))).toBe("link");
        expect(await refusal(readPrivateFile(at("directory"), CAP))).toBe("not_regular");
        expect(await promptly(refusal(readPrivateFile(at("fifo"), CAP)))).toBe("not_regular");
        expect(await refusal(readPrivateFile(at("large"), CAP))).toBe("too_large");
        expect(await refusal(readPrivateFile(at("binary"), CAP))).toBe("not_utf8");
        // Not read, and nothing known about what they hold:
        expect(await refusal(readPrivateFile(at("locked"), CAP))).toBeNull();
        expect(await refusal(readPrivateFile(join(at("real.json"), "below"), CAP))).toBeNull();
        // And no refusal at all:
        expect(await refusal(readPrivateFile(at("real.json"), CAP))).toEqual({ read: "[]" });
        expect(await refusal(readPrivateFile(at("nothing-here"), CAP))).toEqual({ read: null });
      } finally {
        closeSync(openSync(at("fifo"), constants.O_RDWR | constants.O_NONBLOCK));
      }
      expect([...PRIVATE_FILE_REFUSALS].sort()).toEqual(["link", "not_regular", "not_utf8", "too_large"]);
    });

    it("gives no token for an error that is not this reader's, whatever its words", () => {
      // The words of a refusal on another error are not a refusal: nothing is read out of a message.
      for (const message of ["ELOOP", "not a regular file", "larger than 64 bytes", "not valid UTF-8"]) {
        expect(privateFileRefusal(new SecureInputError("write_failed", message))).toBeNull();
        expect(privateFileRefusal(new Error(`write_failed: ${message}`))).toBeNull();
      }
      expect(privateFileRefusal(undefined)).toBeNull();
      expect(privateFileRefusal(new PrivateFileError("EIO", null))).toBeNull();
      expect(privateFileRefusal(new PrivateFileError("not valid UTF-8", "not_utf8"))).toBe("not_utf8");
    });
  });
});
