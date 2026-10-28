import { describe, expect, it } from "vitest";
import { buildView } from "../server/core/view";
import * as contracts from "../shared/contracts";
import type { Diagnostics } from "../shared/contracts";
// @ts-expect-error The compatibility script is plain ESM without declarations.
import { PLUGIN, RESERVED_PORT, cacheKey, candidates, checkPort, childEnv, excerptOf, failureOf, firstProblem, issueBody, issueTitle, jsonFrom, parseVersions, planReport, select } from "../scripts/paseo-compat.mjs";

// scripts/paseo-compat.mjs runs the plugin against a real daemon of each new Paseo release; that part is checked by
// running it (CONTRIBUTING.md, "Paseo compatibility"). These hold the parts the workflow decides with, and the parts
// that keep a run away from the owner's daemon, to what they are meant to do.

const SHA = "f3a3cdf0123456789abcdef0123456789abcdef0";
const RUN = { url: "https://github.com/dutchakdev/paseo-plugin-secure-input/actions/runs/1", sha: SHA };
const RUNNERS = ["macos-15", "ubuntu-24.04"];

describe("which Paseo releases a run tests", () => {
  it("takes npm's latest and beta of the CLI, once each, and names the tags", () => {
    expect(candidates({ distTags: { latest: "0.13.2", beta: "0.14.0-beta.2", next: "9.9.9" } })).toEqual({
      fromTags: true,
      versions: [
        { version: "0.13.2", tags: ["latest"] },
        { version: "0.14.0-beta.2", tags: ["beta"] },
      ],
    });
    // A stable release that both tags point at is tested once.
    expect(candidates({ distTags: { latest: "0.15.0", beta: "0.15.0" } }).versions).toEqual([{ version: "0.15.0", tags: ["latest", "beta"] }]);
    expect(candidates({ distTags: { beta: "0.15.0-beta.1" } }).versions).toEqual([{ version: "0.15.0-beta.1", tags: ["beta"] }]);
    expect(() => candidates({ distTags: {} })).toThrow("neither a latest nor a beta");
    expect(() => candidates({ distTags: { latest: "0.15" } })).toThrow("not a release number");
  });

  it("takes the versions it is given instead, deduplicated, and not from the cache", () => {
    expect(candidates({ distTags: { latest: "0.13.2" }, input: " 0.14.0-beta.1, 0.15.0 0.14.0-beta.1 " })).toEqual({
      fromTags: false,
      versions: [
        { version: "0.14.0-beta.1", tags: [] },
        { version: "0.15.0", tags: [] },
      ],
    });
    expect(candidates({ distTags: { latest: "0.13.2" }, input: "" }).fromTags).toBe(true);
  });

  it("refuses anything but a release number, so no other npm spec reaches npm install", () => {
    for (const bad of ["latest", "^0.14.0", "v0.14.0", "0.14", "0.14.0+build.1", "0.14.0;rm", "file:../x", "0.14.0-", "-0.14.0"]) {
      expect(() => parseVersions(bad), bad).toThrow("not a Paseo release number");
    }
    expect(parseVersions("0.14.0 0.14.0-beta.2,1.0.0-rc.1")).toEqual(["0.14.0", "0.14.0-beta.2", "1.0.0-rc.1"]);
  });

  it("records a pass per version and commit, and leaves out the versions whose record exists", () => {
    expect(cacheKey("0.14.0-beta.2", SHA)).toBe(`paseo-compat-0.14.0-beta.2-${SHA}`);
    expect(() => cacheKey("latest", SHA)).toThrow();
    expect(() => cacheKey("0.14.0", "main")).toThrow();
    expect(select(["0.13.9", "0.14.0-beta.2"], ["true", "false"])).toEqual({ tested: ["0.14.0-beta.2"], cached: ["0.13.9"] });
    // A lookup that did not run (an empty output) is no hit.
    expect(select(["0.14.0"], [""])).toEqual({ tested: ["0.14.0"], cached: [] });
  });
});

describe("what keeps a run away from the owner's daemon", () => {
  it("refuses the owner's port", () => {
    expect(RESERVED_PORT).toBe(6767);
    expect(() => checkPort(6767)).toThrow("refusing port 6767");
    for (const bad of [0, 65536, 1.5, Number.NaN]) expect(() => checkPort(bad)).toThrow("not a port");
    expect(checkPort(63017)).toBe(63017);
  });

  it("gives no child the variables of an agent session or anything in the owner's Paseo home", () => {
    const owner = "/Users/someone/.paseo";
    const env = childEnv(
      {
        PATH: `/usr/bin:${owner}/bin:/opt/homebrew/bin`,
        HOME: "/Users/someone",
        PASEO_AGENT_ID: "agent",
        PASEO_HOME: owner,
        PASEO_HOST: "127.0.0.1:6767",
        PASEO_AGENT_CWD: "/work",
        PASEO_PASSWORD: "password",
        PASEO_TERMINAL_ID: "terminal",
        SECURE_INPUT_BINDING: "binding",
        SECURE_INPUT_CLI: `${owner}/secure-input/bin/cli`,
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/socket",
        CLAUDE_CONFIG_DIR: `${owner}/account-switcher/accounts/a/claude`,
        npm_config_prefix: "/elsewhere",
        npm_lifecycle_event: "test:paseo",
        LANG: "en_US.UTF-8",
        PASEOX: "kept: not a PASEO_ variable",
        ELSEWHERE: "/Users/someone/.paseo-other/x",
      },
      { HOME: "/tmp/run/user", PASEO_NODE_ENV: "development" },
      owner,
    );
    expect(env).toEqual({
      PATH: "/usr/bin:/opt/homebrew/bin",
      HOME: "/tmp/run/user",
      LANG: "en_US.UTF-8",
      PASEOX: "kept: not a PASEO_ variable",
      ELSEWHERE: "/Users/someone/.paseo-other/x",
      PASEO_NODE_ENV: "development",
    });
  });
});

describe("reading what the Paseo CLI printed", () => {
  it("finds the JSON after the lines some commands print first", () => {
    expect(jsonFrom('Created workspace wks_1 - work\n{\n  "agentId": "a",\n  "status": "completed"\n}\n')).toEqual({ agentId: "a", status: "completed" });
    expect(jsonFrom('[\n  { "id": "secure-input", "status": "running" }\n]')).toEqual([{ id: "secure-input", status: "running" }]);
    expect(() => jsonFrom("Started: PID 1")).toThrow("no JSON");
  });

  it("says why a command failed in one line", () => {
    const created = { code: 1, stdout: "", stderr: 'Tip: pass --workspace\n{\n  "error": {\n    "code": "AGENT_CREATE_FAILED",\n    "message": "Failed to create agent: Plugin secure-input before agent.session_open failed: [\\n  {}\\n]"\n  }\n}\n', timedOut: false };
    expect(failureOf(created)).toBe("Failed to create agent: Plugin secure-input before agent.session_open failed: [ {} ]");
    expect(
      failureOf({
        code: 1,
        stdout: "",
        stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @getpaseo/protocol@9.9.9.\nnpm error A complete log of this run can be found in: /home/runner/.npm/_logs/x.log\n",
        timedOut: false,
      }),
    ).toBe("npm error notarget No matching version found for @getpaseo/protocol@9.9.9.");
    expect(failureOf({ code: 1, stdout: "", stderr: "Error: Daemon failed to start\nsecond line\n", timedOut: false })).toBe("second line");
    expect(failureOf({ code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true })).toBe("timed out");
    expect(firstProblem("> tsc\nserver/x.ts(1,2): error TS2339: Property 'y' does not exist\n")).toBe("server/x.ts(1,2): error TS2339: Property 'y' does not exist");
    expect(firstProblem(" ✓ a\n FAIL  tests/mirrored-constants.test.ts > the most one Paseo RPC may carry\n")).toBe("FAIL tests/mirrored-constants.test.ts > the most one Paseo RPC may carry");
  });

  it("keeps an excerpt's indentation and drops terminal colours, which vitest prints when CI is set", () => {
    const esc = String.fromCharCode(0x1b);
    const coloured = `${esc}[31m FAIL ${esc}[39m tests/x.test.ts > y\n{\n  "error": {\n    "code": "X"   \n`;
    expect(firstProblem(coloured)).toBe("FAIL tests/x.test.ts > y");
    expect(excerptOf({ stdout: coloured, stderr: "" }, 3)).toBe('{\n  "error": {\n    "code": "X"');
  });
});

/** A runner's result as `--result` writes it. */
function leg(version: string, runner: string, status: "pass" | "fail" | "skip", failed?: { step: number; name: string; detail: string }, excerpt?: string) {
  return { plugin: "secure-input", version, runner, status, failed: failed ?? null, ...(excerpt ? { excerpt } : {}) };
}

describe("the report: one issue per failing version, closed by a pass", () => {
  const hookFailure = { step: 5, name: "hooks", detail: "the agent was not created: Plugin secure-input before agent.session_open failed | unrecognized key" };

  it("opens an issue for a new failure, updates the one already open, closes the one of a version that passed, and records the passes", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.14.0-beta.2", "0.15.0", "0.15.1"],
      runners: RUNNERS,
      results: [
        leg("0.14.0-beta.2", "macos-15", "pass"),
        leg("0.14.0-beta.2", "ubuntu-24.04", "pass"),
        leg("0.15.0", "macos-15", "fail", hookFailure, "~~~\nlog line"),
        leg("0.15.0", "ubuntu-24.04", "pass"),
        // 0.15.1: macOS wrote no result.
        leg("0.15.1", "ubuntu-24.04", "pass"),
      ],
      openIssues: [
        { number: 12, title: issueTitle("0.14.0-beta.2"), body: "<!-- paseo-compat version=0.14.0-beta.2 failing=macos-15:3 -->\n" },
        { number: 13, title: issueTitle("0.15.0"), body: "<!-- paseo-compat version=0.15.0 failing=macos-15:5 -->\n" },
        { number: 14, title: "Something else", body: "" },
      ],
      run: RUN,
    });
    expect(plan.verdicts.map(({ version, status }: { version: string; status: string }) => `${version} ${status}`)).toEqual(["0.14.0-beta.2 pass", "0.15.0 fail", "0.15.1 fail"]);
    expect(plan.actions.map(({ kind, version, number }: { kind: string; version: string; number?: number }) => [kind, version, number])).toEqual([
      ["close", "0.14.0-beta.2", 12],
      ["update", "0.15.0", 13],
      ["create", "0.15.1", undefined],
    ]);
    const [close, update, create] = plan.actions;
    expect(close.comment).toBe(`Paseo 0.14.0-beta.2 passed on macos-15 and ubuntu-24.04 in ${RUN.url} at f3a3cdf01234.\n`);
    // The same runner fails at the same step as the body says: the body is updated, and nobody is notified again.
    expect(update.comment).toBeUndefined();
    expect(update.body).toContain("| macos-15 | **fail** at step 5 (hooks): the agent was not created: Plugin secure-input before agent.session_open failed \\| unrecognized key |");
    expect(update.body).toContain("| ubuntu-24.04 | pass |");
    expect(create.title).toBe("Paseo 0.15.1 compatibility");
    expect(create.body).toContain("| macos-15 | **fail**: the job ended before the compatibility script wrote a result");
    expect(plan.record).toEqual([{ version: "0.14.0-beta.2", key: `paseo-compat-0.14.0-beta.2-${SHA}` }]);
  });

  it("writes an issue that names the failed step, the run and how to reproduce it", () => {
    const body = issueBody({ plugin: "secure-input", version: "0.15.0", legs: [{ runner: "macos-15", status: "fail", failed: hookFailure, excerpt: "a\n~~~\nb" }, { runner: "ubuntu-24.04", status: "pass", failed: null }], run: RUN });
    expect(body.split("\n")[0]).toBe("<!-- paseo-compat version=0.15.0 failing=macos-15:5 -->");
    expect(body).toContain(`secure-input failed its compatibility run against Paseo 0.15.0 at f3a3cdf01234.`);
    expect(body).toContain(`Run: ${RUN.url}`);
    expect(body).toContain("`npm run test:paseo -- 0.15.0`");
    // The excerpt sits in its own fence, which a line of the excerpt cannot close.
    expect(body).toContain("~~~\na\n~ ~ ~\nb\n~~~");
  });

  it("comments when what fails has changed, and finds its issue by the marker when the title was edited", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.15.0"],
      runners: RUNNERS,
      results: [leg("0.15.0", "macos-15", "fail", { step: 2, name: "sdk", detail: "npm run typecheck exited 2" }), leg("0.15.0", "ubuntu-24.04", "fail", hookFailure)],
      openIssues: [{ number: 13, title: "Paseo 0.15.0 breaks the hook", body: "<!-- paseo-compat version=0.15.0 failing=macos-15:5 -->\n" }],
      run: RUN,
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: "update", number: 13 });
    expect(plan.actions[0].comment).toContain(`What fails has changed, in ${RUN.url}:`);
    expect(plan.actions[0].body.split("\n")[0]).toBe("<!-- paseo-compat version=0.15.0 failing=macos-15:2,ubuntu-24.04:5 -->");
    expect(plan.record).toEqual([]);
  });

  it("does nothing for a version that passes with no issue open, or that the plugin does not claim", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.14.0", "0.13.2"],
      runners: RUNNERS,
      results: [
        leg("0.14.0", "macos-15", "pass"),
        leg("0.14.0", "ubuntu-24.04", "pass"),
        leg("0.13.2", "macos-15", "skip", { step: 1, name: "range", detail: "not claimed" }),
        leg("0.13.2", "ubuntu-24.04", "skip", { step: 1, name: "range", detail: "not claimed" }),
      ],
      openIssues: [{ number: 9, title: issueTitle("0.13.2"), body: "" }],
      run: RUN,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.verdicts.map(({ status }: { status: string }) => status)).toEqual(["pass", "skip"]);
    expect(plan.record.map(({ version }: { version: string }) => version)).toEqual(["0.14.0"]);
  });
});

describe("the plugin's part of the run", () => {
  it("names contracts that shared/contracts.ts defines", () => {
    for (const name of [...PLUGIN.rpc.map((call: { contract: string }) => call.contract), PLUGIN.diagnostics.contract]) {
      const contract = (contracts as Record<string, unknown>)[name] as { name?: string } | undefined;
      expect(contract?.name, name).toMatch(/^secure-input\./);
    }
    expect(PLUGIN.contracts).toBe("shared/contracts.ts");
  });

  it("expects the refusal the plugin gives for a request it does not know", () => {
    const call = PLUGIN.rpc.find((entry: { refusal?: string }) => entry.refusal);
    expect(() => buildView({ get: () => undefined }, call.input.requestId)).toThrow(call.refusal);
  });

  it("finds a problem in diagnostics that say one, and none in healthy ones", () => {
    const healthy: Diagnostics = contracts.DiagnosticsSchema.parse({
      attached: true,
      dataDir: "/tmp/home/secure-input",
      registry: { persistence: "ok", drop: "ok", stored: "ok", dropped: 0 },
      outbox: { persistence: "ok", unsaved: 0, dropped: 0 },
      requests: { pending: 0, delivered: 0, nextDeleteBy: null },
      startup: null,
      cardsOwed: 0,
      messagesHeld: false,
      lastHookFailure: null,
    });
    expect(PLUGIN.diagnostics.problems(healthy)).toEqual([]);
    expect(PLUGIN.diagnostics.problems({ ...healthy, lastHookFailure: "agent.turn_started: unexpected" })).toEqual(["a hook failed: agent.turn_started: unexpected"]);
    expect(PLUGIN.diagnostics.problems({ ...healthy, startup: { code: "write_failed", detail: "x" }, messagesHeld: true })).toEqual([
      "the plugin did not start: write_failed",
      "messages to agents are held back",
    ]);
  });
});
