import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildView } from "../server/core/view";
import * as contracts from "../shared/contracts";
import type { Diagnostics } from "../shared/contracts";
// @ts-expect-error The compatibility script is plain ESM without declarations.
import * as compat from "../scripts/paseo-compat.mjs";

// scripts/paseo-compat.mjs runs the plugin against a real daemon of each new Paseo release; that part is checked by
// running it (CONTRIBUTING.md, "Paseo compatibility"). These hold the parts it decides with to what they are meant to
// do: which releases a run tests, what keeps it away from the owner's daemon, what it reads in the CLI's output (on
// output captured from Paseo 0.14.0-beta.1, which 0.14.0-beta.2 printed in the same shapes), and what the report does.

const {
  PLUGIN,
  RESERVED_PORT,
  SIGNALS,
  StepFailure,
  Unverified,
  assertOwnHome,
  cacheKey,
  candidates,
  checkListen,
  checkPort,
  childEnv,
  claimOf,
  cliError,
  cliJson,
  excerptOf,
  failureOf,
  firstProblem,
  hasProvider,
  issueBody,
  lifecycleFailure,
  listsAgent,
  loadState,
  markdownText,
  outcomeOf,
  parseVersions,
  planReport,
  pluginEntry,
  processes,
  run,
  runOutcome,
  select,
  smokeModel,
  startedDaemon,
  stopChildren,
  stopOutcome,
  TITLES,
  LABELS,
} = compat;

const ROOT = join(import.meta.dirname, "..");
const SHA = "f3a3cdf0123456789abcdef0123456789abcdef0";
const RUN = { url: "https://github.com/dutchakdev/paseo-plugin-secure-input/actions/runs/1", sha: SHA };
const RUNNERS = ["macos-15", "ubuntu-24.04"];

/** What a step's code throws, as the run records it. */
function outcome(subject: () => unknown): string {
  try {
    subject();
  } catch (error) {
    if (error instanceof Unverified) return "unverified";
    if (error instanceof StepFailure) return "fail";
    return `error: ${(error as Error).message}`;
  }
  return "pass";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

describe("step 1: the plugin's claim, by the release's own rule", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")) as { id: string; requirements: { paseo: string } };
  const claim = (requirements: unknown, version: string | null) => claimOf(assertPluginCompatibility, { id: manifest.id, requirements, version });

  it("passes a release the range admits, and skips one it does not", () => {
    expect(claim(manifest.requirements, "0.14.0-beta.2").status).toBe("pass");
    expect(claim(manifest.requirements, "0.15.0").status).toBe("pass");
    expect(claim(manifest.requirements, "0.13.2")).toEqual({
      status: "skip",
      detail: 'Plugin "secure-input" requires Paseo >=0.14.0-beta.1. Your daemon is 0.13.2. Use a compatible plugin version or update the daemon.',
    });
  });

  it("fails, and never skips, a manifest the rule refuses for anything but the range", () => {
    // A skip exits 0, and a workflow whose every version is skipped goes green with nothing tested.
    expect(claim({ paseo: "not a range" }, "0.14.0-beta.2")).toMatchObject({ status: "fail", detail: expect.stringContaining("Invalid requirements.paseo") });
    expect(claim({ paseo: " " }, "0.14.0-beta.2").status).toBe("fail");
    expect(claim(manifest.requirements, null)).toMatchObject({ status: "fail", detail: expect.stringContaining("version is unknown") });
    const broken = () => {
      throw new TypeError("Cannot read properties of undefined");
    };
    expect(claimOf(broken, { id: manifest.id, requirements: manifest.requirements, version: "0.15.0" }).status).toBe("fail");
  });
});

describe("what keeps a run away from the owner's daemon", () => {
  it("refuses the owner's port", () => {
    expect(RESERVED_PORT).toBe(6767);
    expect(() => checkPort(6767)).toThrow("refusing port 6767");
    for (const bad of [0, 65536, 1.5, Number.NaN]) expect(() => checkPort(bad)).toThrow("not a port");
    expect(checkPort(63017)).toBe(63017);
  });

  it("talks only to the loopback address it configured, and never to the owner's port", () => {
    expect(checkListen("127.0.0.1:63017", "127.0.0.1:63017")).toBe("127.0.0.1:63017");
    expect(outcome(() => checkListen("127.0.0.1:6767", "127.0.0.1:6767"))).toBe("unverified");
    expect(() => checkListen("127.0.0.1:6767", "127.0.0.1:6767")).toThrow("refusing 127.0.0.1:6767");
    expect(() => checkListen("127.0.0.1:63018", "127.0.0.1:63017")).toThrow("not 127.0.0.1:63017");
    expect(() => checkListen("0.0.0.0:63017", "0.0.0.0:63017")).toThrow("not a loopback address");
    expect(() => checkListen(undefined, "127.0.0.1:63017")).toThrow("no address");
  });

  it("starts no paseo command that does not name the temporary home, or that names another target", () => {
    const home = "/tmp/paseo-compat-x/home";
    expect(assertOwnHome(["plugin", "ls", "--home", home, "--json"], home)).toEqual(["plugin", "ls", "--home", home, "--json"]);
    for (const args of [
      ["plugin", "ls", "--json"],
      ["plugin", "ls", "--home", "/Users/someone/.paseo", "--json"],
      ["plugin", "ls", "--home", home, "--home", "/Users/someone/.paseo"],
      ["plugin", "ls", "--home", home, "--host", "127.0.0.1:6767"],
      ["plugin", "ls", "--home", home, "--host=127.0.0.1:6767"],
      ["plugin", "ls", `--home=${home}`],
    ]) {
      expect(outcome(() => assertOwnHome(args, home)), args.join(" ")).toBe("unverified");
    }
    // The command runner checks before it starts anything.
    const proc = processes({ home, prefix: "/nonexistent", temp: "/tmp", userHome: "/tmp/paseo-compat-x/user" });
    expect(() => proc.paseo(["plugin", "ls", "--json"])).toThrow("does not name the home");
    expect(() => proc.paseo(["daemon", "stop", "--home", "/Users/someone/.paseo", "--json"])).toThrow("does not name the home");
  });

  it("gives a child only an allowlist of the environment, and a home directory of its own", () => {
    const owner = "/Users/someone/.paseo";
    const env = childEnv(
      {
        PATH: `/usr/bin:${owner}/bin:/opt/homebrew/bin`,
        HOME: "/Users/someone",
        TMPDIR: "/var/folders/x/T/",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        TERM: "xterm-256color",
        CI: "true",
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: SHA,
        RUNNER_TEMP: "/home/runner/work/_temp",
        HTTPS_PROXY: "http://proxy:3128",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        NPM_CONFIG_REGISTRY: "https://registry.example/",
        // What stays behind: the job's token and step files, a provider's keys and configuration, an agent session's variables, an SSH agent.
        GITHUB_TOKEN: "ghs_token",
        GITHUB_ENV: "/home/runner/env",
        GITHUB_OUTPUT: "/home/runner/output",
        GITHUB_STEP_SUMMARY: "/home/runner/summary",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-openai",
        GEMINI_API_KEY: "gemini",
        CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
        CODEX_HOME: "/Users/someone/.codex",
        OPENCODE_CONFIG: "/Users/someone/.opencode.json",
        XDG_CONFIG_HOME: "/Users/someone/.config",
        XDG_DATA_HOME: "/Users/someone/.local/share",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        NODE_OPTIONS: "--require /tmp/x.js",
        PASEO_AGENT_ID: "agent",
        PASEO_HOME: owner,
        PASEO_HOST: "127.0.0.1:6767",
        PASEO_AGENT_CWD: "/work",
        PASEO_PASSWORD: "password",
        SECURE_INPUT_BINDING: "binding",
        SECURE_INPUT_CLI: `${owner}/secure-input/bin/cli`,
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/socket",
        npm_config_prefix: "/elsewhere",
        npm_lifecycle_event: "test:paseo",
        USER: "someone",
        SHELL: "/bin/zsh",
        // Allowlisted, but pointing into the owner's Paseo home.
        NPM_CONFIG_CACHE: `${owner}/npm-cache`,
      },
      { HOME: "/tmp/run/user" },
      { keep: [], ownerHome: owner },
    );
    expect(env).toEqual({
      PATH: "/usr/bin:/opt/homebrew/bin",
      TMPDIR: "/var/folders/x/T/",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm-256color",
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: SHA,
      RUNNER_TEMP: "/home/runner/work/_temp",
      HTTPS_PROXY: "http://proxy:3128",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      NPM_CONFIG_REGISTRY: "https://registry.example/",
      HOME: "/tmp/run/user",
    });
    // A plugin whose tests need one more variable names it in PLUGIN.env.
    expect(childEnv({ SPECIAL: "1", OTHER: "2" }, {}, { keep: ["SPECIAL"], ownerHome: owner })).toEqual({ SPECIAL: "1" });
    expect(PLUGIN.env).toEqual([]);
  });
});

describe("the commands a run starts", () => {
  it("stops what a command started when it times out, and does not wait for the output a leftover process holds", async () => {
    const started = Date.now();
    const result = await run("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 1_000, echo: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    const sleeper = Number(result.stdout.trim());
    expect(sleeper).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(sleeper)).toBe(false);
  }, 20_000);

  it("settles once a command exits, even while a process it left behind keeps its output open", async () => {
    const started = Date.now();
    const result = await run("sh", ["-c", "sleep 3 & echo $!"], { timeoutMs: 20_000, echo: false });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result.code).toBe(0);
    process.kill(Number(result.stdout.trim()), "SIGKILL");
  }, 20_000);

  it("stops every command under way, with what it started, on an interruption", async () => {
    const running = run("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 60_000, echo: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    stopChildren("SIGTERM");
    const result = await running;
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(Number(result.stdout.trim()))).toBe(false);
  }, 20_000);

  it("is interrupted by a hangup as by Ctrl-C or a stop", () => {
    expect(SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });
});

/** A paseo command as it ran against Paseo 0.14.0-beta.1, in the shape `run` returns. */
function captured(name: string): { argv: string[]; code: number; stdout: string; stderr: string; timedOut: boolean } {
  const file = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "paseo-cli", "0.14.0-beta.1", `${name}.json`), "utf8")) as {
    argv: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  return { argv: file.argv, code: file.exitCode, stdout: file.stdout, stderr: file.stderr, timedOut: false };
}

describe("reading what the Paseo CLI printed (captured from 0.14.0-beta.1)", () => {
  it("reads a daemon's start and its stop, and the stop of a daemon that was not running", () => {
    const started = startedDaemon(cliJson(captured("daemon-start"), "paseo daemon start"));
    expect(started.pid).toBeGreaterThan(1);
    expect(checkListen(started.listen, started.listen)).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(stopOutcome(captured("daemon-stop"))).toEqual({ confirmed: true, said: "daemon stopped" });
    expect(stopOutcome(captured("daemon-stop-not-running"))).toEqual({ confirmed: true, said: "no daemon was running" });
    expect(cliJson(captured("config-set"), "paseo daemon config")).toMatchObject({ action: "saved" });
  });

  it("reads the plugin's install, its entry and its log", () => {
    // The install prints the trust notice on stderr and the plugin on stdout.
    expect(cliJson(captured("plugin-install"), "paseo plugin install", StepFailure)).toMatchObject({ id: "secure-input", status: "running" });
    expect(pluginEntry(cliJson(captured("plugin-ls"), "paseo plugin ls"), "secure-input")).toMatchObject({ status: "running" });
    expect(pluginEntry(cliJson(captured("plugin-ls"), "paseo plugin ls"), "another")).toBeUndefined();
    expect(loadState(cliJson(captured("plugin-logs"), "paseo plugin logs"))).toBe("ready");
    expect(lifecycleFailure(cliJson(captured("plugin-logs-after-turn"), "paseo plugin logs"))).toBeUndefined();
    expect(loadState([{ message: "[paseo] Loading plugin" }])).toBeUndefined();
    expect(loadState([{ message: "[paseo] Loading plugin" }, { message: "[paseo] Plugin failed to load: x" }])).toEqual({ failed: "[paseo] Plugin failed to load: x" });
    expect(lifecycleFailure([{ message: "Lifecycle hook agent.turn_ended failed: boom" }])).toBe("Lifecycle hook agent.turn_ended failed: boom");
  });

  it("finds the mock provider only in a development daemon, and its model for smoke checks", () => {
    expect(hasProvider(cliJson(captured("provider-ls"), "paseo provider ls"), "mock")).toBe(true);
    expect(hasProvider(cliJson(captured("provider-ls-production"), "paseo provider ls"), "mock")).toBe(false);
    expect(smokeModel(cliJson(captured("provider-models-mock"), "paseo provider models"))).toBe("ten-second-stream");
    // A daemon without it answers with a JSON error: the check's, never the plugin's.
    expect(outcome(() => cliJson(captured("provider-models-mock-missing"), "paseo provider models"))).toBe("unverified");
    expect(outcome(() => smokeModel([]))).toBe("unverified");
  });

  it("reads the agent of a turn, and tells the plugin's failure to open a session from any other", () => {
    const agent = runOutcome(captured("run"), "secure-input");
    expect(agent).toEqual({ agentId: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "completed" });
    expect(listsAgent(cliJson(captured("ls"), "paseo ls"), agent.agentId)).toBe(true);
    expect(listsAgent(cliJson(captured("ls"), "paseo ls"), "another")).toBe(false);
    const broken = captured("run-broken-session-open");
    expect(outcome(() => runOutcome(broken, "secure-input"))).toBe("fail");
    expect(() => runOutcome(broken, "secure-input")).toThrow('the agent was not created: Failed to create agent: Plugin secure-input before agent.session_open failed: [ { "code": "unrecognized_keys"');
    // The same failure of another plugin, or an error that names none, is not this plugin's.
    expect(outcome(() => runOutcome(broken, "secure"))).toBe("unverified");
    expect(outcome(() => runOutcome({ ...captured("provider-models-mock-missing") }, "secure-input"))).toBe("unverified");
  });

  it("takes an error the CLI did not answer in JSON, such as an option it does not know, for the check's", () => {
    const usage = captured("usage-error");
    expect(usage.stderr).toBe("error: unknown option '--no-such-option'\n");
    expect(outcome(() => cliJson(usage, "paseo plugin ls"))).toBe("unverified");
    // Even where a JSON error of the CLI would be the plugin's.
    expect(outcome(() => cliJson(usage, "paseo plugin install", StepFailure))).toBe("unverified");
    expect(outcome(() => runOutcome(usage, "secure-input"))).toBe("unverified");
    expect(outcome(() => cliJson({ code: 0, stdout: "Started: PID 1\n", stderr: "", timedOut: false }, "paseo daemon start"))).toBe("unverified");
    expect(outcome(() => pluginEntry({ plugins: [] }, "secure-input"))).toBe("unverified");
  });

  it("says why a command failed in one line, also when its JSON error has no message", () => {
    expect(failureOf(captured("run-broken-session-open"))).toMatch(/^Failed to create agent: Plugin secure-input before agent\.session_open failed: \[ \{ "code": "unrecognized_keys"/);
    expect(failureOf(captured("usage-error"))).toBe("error: unknown option '--no-such-option'");
    expect(failureOf({ code: 1, stdout: "", stderr: '{\n  "error": {\n    "code": "DAEMON_UNREACHABLE"\n  }\n}\n', timedOut: false })).toBe("DAEMON_UNREACHABLE");
    expect(cliError({ code: 1, stdout: "", stderr: '{\n  "error": {}\n}\n', timedOut: false })).toEqual({ code: null, message: "{}" });
    expect(failureOf({ code: 1, stdout: '{\n  "unexpected": true\n}\n', stderr: "", timedOut: false })).toBe('"unexpected": true');
    expect(
      failureOf({
        code: 1,
        stdout: "",
        stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @getpaseo/protocol@9.9.9.\nnpm error A complete log of this run can be found in: /home/runner/.npm/_logs/x.log\n",
        timedOut: false,
      }),
    ).toBe("npm error notarget No matching version found for @getpaseo/protocol@9.9.9.");
    expect(failureOf({ code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true })).toBe("timed out");
    // The stop of a daemon is read even when what it printed is not JSON, so the cleanup goes on.
    expect(stopOutcome({ code: 0, stdout: "stopped\n", stderr: "", timedOut: false })).toEqual({ confirmed: true, said: "paseo daemon stop exited 0" });
    expect(stopOutcome({ code: 1, stdout: "", stderr: '{\n  "error": {\n    "code": "STOP_NOT_CONFIRMED",\n    "message": "Timed out waiting for supervisor PID 9"\n  }\n}\n', timedOut: false })).toEqual({
      confirmed: false,
      said: "paseo daemon stop: Timed out waiting for supervisor PID 9",
    });
  });

  it("names the first problem of a test or typecheck output, and keeps an excerpt's indentation without colours", () => {
    expect(firstProblem("> tsc\nserver/x.ts(1,2): error TS2339: Property 'y' does not exist\n")).toBe("server/x.ts(1,2): error TS2339: Property 'y' does not exist");
    const esc = String.fromCharCode(0x1b);
    const coloured = `${esc}[31m FAIL ${esc}[39m tests/x.test.ts > y\n{\n  "error": {\n    "code": "X"   \n`;
    expect(firstProblem(coloured)).toBe("FAIL tests/x.test.ts > y");
    expect(excerptOf({ stdout: coloured, stderr: "" }, 3)).toBe('{\n  "error": {\n    "code": "X"');
  });
});

describe("the outcome of a run", () => {
  const ran = (status: string, step = 1) => ({ step, name: "x", status, detail: status });
  it("is a failure when a step fails, unverified when a step reached no verdict, a skip when the claim is refused", () => {
    expect(outcomeOf([ran("pass"), ran("pass", 3), ran("pass", 6)]).status).toBe("pass");
    expect(outcomeOf([ran("skip"), ran("pass", 6)]).status).toBe("skip");
    expect(outcomeOf([ran("pass"), ran("unverified", 5), ran("pass", 6)])).toMatchObject({ status: "unverified", failed: { step: 5 } });
    expect(outcomeOf([ran("pass"), ran("fail", 4), ran("unverified", 5), ran("unverified", 6)])).toMatchObject({ status: "fail", failed: { step: 4 } });
    expect(compat.EXIT).toMatchObject({ pass: 0, skip: 0, fail: 1, unverified: 3 });
  });
});

/** A runner's result as `--result` writes it. */
function leg(version: string, runner: string, status: "pass" | "fail" | "skip" | "unverified", failed?: { step: number; name: string; detail: string }, excerpt?: string) {
  return { plugin: "secure-input", version, runner, status, failed: failed ?? null, ...(excerpt ? { excerpt } : {}) };
}

interface Action {
  kind: string;
  issueKind: string;
  version: string;
  number?: number;
  title?: string;
  label?: string;
  body?: string;
  comment?: string;
  reason?: string;
}

describe("the report: one issue per version and kind", () => {
  const hookFailure = { step: 5, name: "hooks", detail: "the agent was not created: Plugin secure-input before agent.session_open failed | unrecognized key" };
  const noMock = { step: 5, name: "hooks", detail: "the daemon has no mock provider (a development daemon's, PASEO_NODE_ENV=development)" };
  const summary = (actions: Action[]) => actions.map(({ kind, issueKind, version, number }) => [kind, issueKind, version, number]);

  it("opens the plugin's issue for a failure, updates the open one, closes the one of a version that passed, and records the passes", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.14.0-beta.2", "0.15.0"],
      runners: RUNNERS,
      results: [
        leg("0.14.0-beta.2", "macos-15", "pass"),
        leg("0.14.0-beta.2", "ubuntu-24.04", "pass"),
        leg("0.15.0", "macos-15", "fail", hookFailure, "~~~\nlog line"),
        leg("0.15.0", "ubuntu-24.04", "pass"),
      ],
      openIssues: [
        { number: 12, kind: "plugin", title: TITLES.plugin("0.14.0-beta.2"), body: "<!-- paseo-compat kind=plugin version=0.14.0-beta.2 failing=macos-15:3 -->\n" },
        { number: 13, kind: "plugin", title: TITLES.plugin("0.15.0"), body: "<!-- paseo-compat kind=plugin version=0.15.0 failing=macos-15:5 -->\n" },
        { number: 14, kind: "plugin", title: "Something else", body: "" },
      ],
      run: RUN,
    });
    expect(plan.verdicts.map(({ version, status }: { version: string; status: string }) => `${version} ${status}`)).toEqual(["0.14.0-beta.2 pass", "0.15.0 fail"]);
    expect(summary(plan.actions)).toEqual([
      ["close", "plugin", "0.14.0-beta.2", 12],
      ["update", "plugin", "0.15.0", 13],
    ]);
    const [close, update] = plan.actions as Action[];
    expect(close).toMatchObject({ reason: "completed", comment: `Paseo 0.14.0-beta.2 passed on macos-15 and ubuntu-24.04 in ${RUN.url} at f3a3cdf01234.\n` });
    // The same runner fails at the same step as the body says: the body is updated, and nobody is notified again.
    expect(update?.comment).toBeUndefined();
    expect(update?.body).toContain("| macos-15 | **fail** at step 5 (hooks): the agent was not created: Plugin secure-input before agent.session_open failed \\| unrecognized key |");
    expect(update?.body).toContain("| ubuntu-24.04 | pass |");
    expect(plan.record).toEqual([{ version: "0.14.0-beta.2", key: `paseo-compat-0.14.0-beta.2-${SHA}` }]);
  });

  it("files no plugin issue for a run that reached no verdict: the check's issue, under its own label, and nothing recorded", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.15.0", "0.15.1"],
      runners: RUNNERS,
      // 0.15.0 lost its mock provider; 0.15.1's macOS runner wrote no result.
      results: [leg("0.15.0", "macos-15", "unverified", noMock), leg("0.15.0", "ubuntu-24.04", "unverified", noMock), leg("0.15.1", "ubuntu-24.04", "pass")],
      openIssues: [],
      run: RUN,
    });
    expect(plan.verdicts.map(({ status }: { status: string }) => status)).toEqual(["unverified", "unverified"]);
    expect(summary(plan.actions)).toEqual([
      ["create", "harness", "0.15.0", undefined],
      ["create", "harness", "0.15.1", undefined],
    ]);
    const [noMockIssue, noResultIssue] = plan.actions as Action[];
    expect(noMockIssue).toMatchObject({ title: "Paseo 0.15.0 compatibility could not be checked", label: LABELS.harness });
    expect(noMockIssue?.body).toContain("the check itself");
    expect(noMockIssue?.body).toContain("| macos-15 | **unverified** at step 5 (hooks): the daemon has no mock provider");
    expect(noResultIssue?.body).toContain("| macos-15 | **unverified**: no result: the job ended before the compatibility script wrote one");
    expect(LABELS).toEqual({ plugin: "paseo-compat", harness: "paseo-compat-harness" });
    expect(plan.record).toEqual([]);
  });

  it("keeps the plugin's issue open through runs without a verdict, and closes the check's once every runner reaches one", () => {
    const open = [
      { number: 20, kind: "plugin", title: TITLES.plugin("0.15.0"), body: "<!-- paseo-compat kind=plugin version=0.15.0 failing=macos-15:5 -->\n" },
      { number: 21, kind: "harness", title: TITLES.harness("0.15.0"), body: "<!-- paseo-compat kind=harness version=0.15.0 failing=ubuntu-24.04:5 -->\n" },
    ];
    const plan = (results: unknown[]) => summary(planReport({ plugin: "secure-input", versions: ["0.15.0"], runners: RUNNERS, results, openIssues: open, run: RUN }).actions);
    // No verdict anywhere: the plugin's issue stays as it is.
    expect(plan([leg("0.15.0", "macos-15", "unverified", noMock), leg("0.15.0", "ubuntu-24.04", "unverified", noMock)])).toEqual([["update", "harness", "0.15.0", 21]]);
    // A verdict everywhere, a failing one: the plugin's issue is updated, the check's closed.
    expect(plan([leg("0.15.0", "macos-15", "fail", hookFailure), leg("0.15.0", "ubuntu-24.04", "pass")])).toEqual([
      ["update", "plugin", "0.15.0", 20],
      ["close", "harness", "0.15.0", 21],
    ]);
    // A pass everywhere closes both.
    expect(plan([leg("0.15.0", "macos-15", "pass"), leg("0.15.0", "ubuntu-24.04", "pass")])).toEqual([
      ["close", "plugin", "0.15.0", 20],
      ["close", "harness", "0.15.0", 21],
    ]);
  });

  it("comments when what fails has changed, and finds its issue by the marker when the title was edited", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.15.0"],
      runners: RUNNERS,
      results: [leg("0.15.0", "macos-15", "fail", { step: 2, name: "sdk", detail: "npm run typecheck exited 2" }), leg("0.15.0", "ubuntu-24.04", "fail", hookFailure)],
      openIssues: [{ number: 13, kind: "plugin", title: "Paseo 0.15.0 breaks the hook", body: "<!-- paseo-compat kind=plugin version=0.15.0 failing=macos-15:5 -->\n" }],
      run: RUN,
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: "update", number: 13 });
    expect(plan.actions[0].comment).toContain(`What ends so has changed, in ${RUN.url}:`);
    expect(plan.actions[0].body.split("\n")[0]).toBe("<!-- paseo-compat kind=plugin version=0.15.0 failing=macos-15:2,ubuntu-24.04:5 -->");
  });

  it("closes the issues of pre-releases that npm's latest and beta have moved past, and of no other version", () => {
    const plan = planReport({
      plugin: "secure-input",
      versions: ["0.15.0-beta.2"],
      runners: RUNNERS,
      results: [leg("0.15.0-beta.2", "macos-15", "pass"), leg("0.15.0-beta.2", "ubuntu-24.04", "pass")],
      openIssues: [
        { number: 30, kind: "plugin", title: TITLES.plugin("0.15.0-beta.1"), body: "<!-- paseo-compat kind=plugin version=0.15.0-beta.1 failing=macos-15:5 -->\n" },
        { number: 31, kind: "harness", title: TITLES.harness("0.15.0-beta.1"), body: "" },
        { number: 32, kind: "plugin", title: TITLES.plugin("0.14.0"), body: "" },
        { number: 33, kind: "plugin", title: TITLES.plugin("0.14.1-beta.1"), body: "" },
      ],
      run: RUN,
      heads: ["0.14.1-beta.1", "0.15.0-beta.2"],
    });
    expect(summary(plan.actions)).toEqual([
      ["close", "plugin", "0.15.0-beta.1", 30],
      ["close", "harness", "0.15.0-beta.1", 31],
    ]);
    expect(plan.actions[0]).toMatchObject({ reason: "not planned", comment: expect.stringContaining("moved past (now 0.14.1-beta.1 and 0.15.0-beta.2)") });
    // Without the heads (versions asked for by name), nothing is closed for it.
    expect(planReport({ plugin: "secure-input", versions: [], runners: RUNNERS, results: [], openIssues: [{ number: 30, kind: "plugin", title: TITLES.plugin("0.15.0-beta.1"), body: "" }], run: RUN }).actions).toEqual([]);
  });
});

describe("what an issue says", () => {
  it("names the failed step, the run and how to reproduce it, in its own fence for the output", () => {
    const body = issueBody({
      kind: "plugin",
      plugin: "secure-input",
      version: "0.15.0",
      legs: [
        { runner: "macos-15", status: "fail", failed: { step: 5, name: "hooks", detail: "x" }, excerpt: "a\n~~~\nb" },
        { runner: "ubuntu-24.04", status: "pass", failed: null },
      ],
      run: RUN,
    });
    expect(body.split("\n")[0]).toBe("<!-- paseo-compat kind=plugin version=0.15.0 failing=macos-15:5 -->");
    expect(body).toContain("secure-input failed its compatibility run against Paseo 0.15.0 at f3a3cdf01234.");
    expect(body).toContain(`Run: ${RUN.url}`);
    expect(body).toContain("`npm run test:paseo -- 0.15.0`");
    expect(body).toContain("a scheduled run closes its issue");
    expect(body).toContain("~~~\na\n~ ~ ~\nb\n~~~");
  });

  it("carries no HTML and mentions no one: a package scope goes in a code span, and the table keeps its columns", () => {
    expect(markdownText("npm could not install @getpaseo/cli@0.15.0 and @getpaseo/protocol: <script> | x & y")).toBe(
      "npm could not install `@getpaseo/cli@0.15.0` and `@getpaseo/protocol`: &lt;script> \\| x &amp; y",
    );
    expect(markdownText("mail noreply@example.com")).toBe("mail noreply@example.com");
    const body = issueBody({
      kind: "harness",
      plugin: "secure-input",
      version: "0.15.0",
      legs: [{ runner: "macos-15", status: "unverified", failed: { step: 3, name: "daemon", detail: "npm could not install @getpaseo/cli@0.15.0: <timeout>" } }],
      run: RUN,
    });
    expect(body).toContain("`@getpaseo/cli@0.15.0`: &lt;timeout>");
    // Outside code spans, no @ starts a word: GitHub would read it as a mention of the getpaseo organisation.
    const prose = body.replace(/`[^`]*`/g, "").replace(/<!--[^>]*-->/g, "");
    expect(prose).not.toMatch(/(^|[^\w])@\w/m);
  });
});

describe("the plugin's part of the run", () => {
  it("names contracts that shared/contracts.ts defines", () => {
    for (const name of [...PLUGIN.rpc.map((call: { contract: string }) => call.contract), PLUGIN.diagnostics.contract]) {
      const contract = (contracts as Record<string, unknown>)[name] as { name?: string } | undefined;
      expect(contract?.name, name).toMatch(/^secure-input\./);
    }
    expect(PLUGIN.contracts).toBe("shared/contracts.ts");
    expect(PLUGIN.hooks).toBe(true);
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

describe("the workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "paseo-compat.yml"), "utf8");

  it("pins every action to a commit, uses no secret, and lets only the report write issues", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(8);
    for (const [line, action, comment] of uses) expect(`${action}${comment}`, line).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    expect(workflow).not.toContain("secrets.");
    expect(workflow.match(/issues: write/g)).toHaveLength(1);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(JSON.parse(/RUNNERS: '(.+)'/.exec(workflow)?.[1] ?? "")).toEqual(RUNNERS);
  });

  it("replaces a runner's result when its job runs again, and gives the report npm's heads", () => {
    const upload = /uses: actions\/upload-artifact@[\s\S]*?(?=\n {6}- |\n {2}\w)/.exec(workflow)?.[0] ?? "";
    expect(upload).toContain("overwrite: true");
    expect(workflow).toContain("HEADS: ${{ needs.resolve.outputs.heads }}");
    expect(workflow).toContain("heads: ${{ steps.resolve.outputs.heads }}");
  });
});
