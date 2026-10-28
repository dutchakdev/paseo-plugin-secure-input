import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_SENTENCE } from "../client/codes";
import { afterFailedAttempts, attemptsFailed } from "../client/text";
import { continuationText, submissionsFailed } from "../server/core/continuation";
import { MAX_RETRIES } from "../server/core/registry";
import { MAX_RETRIES as STORED_MAX_RETRIES, parseRecord } from "../server/core/registry-store";
import * as limits from "../shared/limits";
import { InputRequestSchema } from "../shared/request";

// The limit on failed submissions is one number, in `shared/limits`. The registry counts to it, the app says it to
// the human and the plugin says it to the agent, both in words. These hold the words to the number: the tables of
// words below are the test's own, so a sentence typed in by hand again, or a number changed without its words,
// fails here.
describe("the number of failed submissions that closes a request", () => {
  const UKRAINIAN: Record<number, { failed: string; after: string }> = {
    1: { failed: "Одна спроба не вдалась", after: "Після однієї невдалої спроби" },
    2: { failed: "Дві спроби не вдались", after: "Після двох невдалих спроб" },
    3: { failed: "Три спроби не вдались", after: "Після трьох невдалих спроб" },
    4: { failed: "Чотири спроби не вдались", after: "Після чотирьох невдалих спроб" },
    5: { failed: "П'ять спроб не вдалось", after: "Після п'яти невдалих спроб" },
  };
  const ENGLISH: Record<number, string> = {
    1: "One submission failed",
    2: "Two submissions failed",
    3: "Three submissions failed",
    4: "Four submissions failed",
    5: "Five submissions failed",
  };

  /** A request the registry rejected with the retry limit, as it would store it. */
  function rejectedAtTheLimit() {
    const record = parseRecord({
      id: `r_${"7f3a".repeat(8)}`,
      agentId: "agent-1",
      agentCwd: "/work",
      agentTitle: null,
      request: InputRequestSchema.parse({ fields: [{ key: "A" }] }),
      state: "rejected",
      publicKey: "A".repeat(43),
      requestDigest: "0".repeat(64),
      retries: MAX_RETRIES,
      tamper: false,
      errorCode: "retry_limit",
      fulfilledDigest: null,
      written: null,
      deleteBy: null,
      createdAt: 1,
      updatedAt: 2,
    });
    if (record === null) throw new Error("the registry would not store the record");
    return record;
  }

  it("is declared once, where both halves can read it, and the registry counts to that", () => {
    expect(limits.MAX_RETRIES).toBe(3);
    expect(MAX_RETRIES).toBe(limits.MAX_RETRIES);
    expect(STORED_MAX_RETRIES).toBe(limits.MAX_RETRIES);
  });

  it("has words in this test for the number it is, so that the comparisons below compare something", () => {
    expect(Object.hasOwn(UKRAINIAN, MAX_RETRIES)).toBe(true);
    expect(Object.hasOwn(ENGLISH, MAX_RETRIES)).toBe(true);
  });

  it("is the number the app says to the human, in each of the two sentences that say it", () => {
    const words = UKRAINIAN[MAX_RETRIES] as { failed: string; after: string };
    expect(CODE_SENTENCE.retry_limit.startsWith(`${words.failed}: `)).toBe(true);
    expect(CODE_SENTENCE.decrypt_failed.endsWith(` ${words.after} запит закривається.`)).toBe(true);
    // No other sentence states a number of attempts.
    expect(attemptsFailed(MAX_RETRIES)).toBe(words.failed);
    expect(afterFailedAttempts(MAX_RETRIES)).toBe(words.after);
  });

  it("is the number the plugin says to the agent", () => {
    const text = continuationText(rejectedAtTheLimit(), "/data/drop");
    expect(text).toContain(`(retry_limit). ${ENGLISH[MAX_RETRIES]}: the sealed values could not be opened.`);
    expect(submissionsFailed(MAX_RETRIES)).toBe(ENGLISH[MAX_RETRIES]);
  });

  it("makes both sentences follow the number, whatever it is", () => {
    for (const [count, words] of Object.entries(UKRAINIAN)) {
      expect(attemptsFailed(Number(count)), count).toBe(words.failed);
      expect(afterFailedAttempts(Number(count)), count).toBe(words.after);
    }
    for (const [count, words] of Object.entries(ENGLISH)) expect(submissionsFailed(Number(count)), count).toBe(words);
    expect(submissionsFailed(12)).toBe("12 submissions failed");
  });
});

describe("the other values both halves hold", () => {
  it("has a sentence for every failure a hook remembers: a hook remembers a code, and no word of its own", () => {
    // What a hook remembers is `failureCode(error)`: one of the plugin's codes, which the settings screen has a sentence
    // for, or `unexpected`, which it says in words of its own. The screen shows anything else as it was kept, so a word a
    // hook spelled out itself would reach the owner untranslated: if a call moves, changes shape or remembers a word,
    // this fails and the person who did it looks here.
    const source = readFileSync(join(import.meta.dirname, "..", "server", "paseo", "hooks.ts"), "utf8");
    const remembered = [...source.matchAll(/deps\.failed\("[a-z_.]+", (.+?)\);/g)].map((match) => match[1] as string);
    expect(remembered).toEqual(["failureCode(error)", "failureCode(error)", "failureCode(error)", "failureCode(error)", "failureCode(error)"]);
    expect(source.match(/deps\.failed\(/g)).toHaveLength(remembered.length);
  });
});

// The size of one Paseo RPC is not ours to choose: it is the smallest limit on the way from either app to the daemon,
// read from Paseo's source (`shared/limits.ts` cites each). These hold the number to the Paseo packages installed here,
// so that an update of them that moves a limit fails here, and not on a phone.
describe("the most one Paseo RPC may carry", () => {
  const ROOT = join(import.meta.dirname, "..");
  const installed = (name: string) => join(ROOT, "node_modules", "@getpaseo", name);
  // A compatibility run (`scripts/paseo-compat.mjs --with-sdk`) installs the SDK of a later Paseo over the pinned one
  // and names that release here: the limits are then held to it, and a release that moves one fails its run.
  const release = process.env.PASEO_COMPAT_SDK ?? "0.14.0-beta.1";

  it("is what the installed protocol says of the daemon's WebSocket and of the relay's frame", () => {
    const protocol = readFileSync(join(installed("protocol"), "dist", "websocket-message-limit.js"), "utf8");
    expect(protocol).toContain("export const MAX_WEBSOCKET_MESSAGE_BYTES = 100 * 1024 * 1024;");
    expect(protocol).toContain("export const MAX_RELAY_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;");
    const version = (name: string) => (JSON.parse(readFileSync(join(installed(name), "package.json"), "utf8")) as { version: string }).version;
    expect([version("protocol"), version("relay")]).toEqual([release, release]);
  });

  it("reads only packages the plugin declares, at the exact version it holds the number to", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies["@getpaseo/protocol"]).toBe("0.14.0-beta.1");
    expect(manifest.devDependencies["@getpaseo/relay"]).toBe("0.14.0-beta.1");
    // The lock file says it too, in the same commit as the manifest.
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, { devDependencies?: Record<string, string> }> };
    expect(lock.packages[""]?.devDependencies?.["@getpaseo/relay"]).toBe("0.14.0-beta.1");
  });

  it("is the plaintext the installed relay fits into its largest frame, the smaller of the two", async () => {
    const { maxSecuredPlaintextByteLength } = (await import("@getpaseo/relay")) as { maxSecuredPlaintextByteLength(wireBytes: number): number };
    const relay = maxSecuredPlaintextByteLength(32 * 1024 * 1024);
    expect(relay).toBeLessThan(100 * 1024 * 1024);
    expect(limits.PASEO_RPC_MAX_BYTES).toBe(relay);
    expect(limits.PASEO_RPC_MAX_BYTES).toBe(25_156_584);
  });
});

// The settings screen says which version of the plugin this is and which Paseo it needs. Both are written once in
// `shared/limits`, where the app can read them, and held here to the files that decide them.
describe("the version of the plugin and the Paseo it needs, as the settings screen says them", () => {
  const ROOT = join(import.meta.dirname, "..");
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(ROOT, name), "utf8")) as T;

  it("is the version in package.json, and the lock file agrees", () => {
    const manifest = read<{ version: string }>("package.json");
    expect(limits.PLUGIN_VERSION).toBe(manifest.version);
    expect(limits.PLUGIN_VERSION).toBe("0.2.1");
    const lock = read<{ version: string; packages: Record<string, { version: string }> }>("package-lock.json");
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""]?.version).toBe(manifest.version);
  });

  it("is the release of Paseo that the manifest of the plugin requires", () => {
    const requirement = read<{ requirements: { paseo: string } }>("paseo-plugin.json").requirements.paseo;
    expect(requirement).toBe(">=0.14.0-beta.1");
    const minimum = /^>=(\d+\.\d+)\.\d+/.exec(requirement);
    expect(minimum).not.toBeNull();
    expect(limits.PASEO_SINCE).toBe(`Paseo ${(minimum as RegExpExecArray)[1]}+`);
    expect(limits.PASEO_SINCE).toBe("Paseo 0.14+");
  });
});
