// One compatibility run of this plugin against one Paseo release, and the three parts of the Paseo compatibility
// workflow that decide what to test and report what broke. Node.js built-ins only, plus the packages of the Paseo
// release under test, which it installs into a temporary prefix. CONTRIBUTING.md ("Paseo compatibility") describes it.
//
//   node scripts/paseo-compat.mjs <version> [--with-sdk] [--verbose] [--result <file>]
//   node scripts/paseo-compat.mjs resolve      (workflow) the versions to test: VERSIONS, or npm's latest and beta
//   node scripts/paseo-compat.mjs select       (workflow) leaves out the versions that passed for this commit
//   node scripts/paseo-compat.mjs report <dir> (workflow) opens, updates and closes one issue per version
//
// It never reaches a daemon it did not start: every paseo command names the temporary home, the port is never 6767,
// and the variables of the agent session it may run in are removed from every process it starts.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * What is particular to this plugin; everything below is the same for every plugin. The plugin's id and the range of
 * Paseo it claims come from `paseo-plugin.json`, and the SDK packages step 2 replaces are its `@getpaseo/*` dependencies.
 */
export const PLUGIN = {
  /** The module that defines the RPC contracts. It is bundled with the esbuild of the Paseo under test, and every answer is parsed with the contract's own schema. */
  contracts: "shared/contracts.ts",
  /** Step 4: calls through the daemon, as the app makes them. A `refusal` is text the plugin's refusal must contain. */
  rpc: [
    { contract: "readDiagnostics", input: {} },
    { contract: "getRequest", input: { requestId: `r_${"0".repeat(32)}` }, refusal: "invalid_request: unknown request" },
  ],
  /** Step 5: read after an agent's session opened and its turn ended. Each entry `problems` returns is a failure. */
  diagnostics: {
    contract: "readDiagnostics",
    input: {},
    problems: (answer) =>
      [
        !answer.attached && "the plugin is not attached to the daemon",
        answer.startup !== null && `the plugin did not start: ${answer.startup.code}`,
        answer.lastHookFailure !== null && `a hook failed: ${answer.lastHookFailure}`,
        answer.messagesHeld && "messages to agents are held back",
      ].filter(Boolean),
    summary: "attached, no hook failure",
  },
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The owner's own daemon listens here. Nothing this script starts or calls may use it. */
export const RESERVED_PORT = 6767;
/** A release number as npm publishes Paseo's: no `v`, no range, no build metadata, so no other npm spec gets through. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const DIST_TAGS = ["latest", "beta"];
const LABEL = "paseo-compat";
const STEP_NAMES = { 1: "range", 2: "sdk", 3: "daemon", 4: "rpc", 5: "hooks", 6: "cleanup" };
/** How many cache lookups the workflow's resolve job makes: one for each dist-tag. */
const LOOKUPS = DIST_TAGS.length;
/** The prompt of the mock agent's one turn. The mock provider streams the same synthetic turn for any text. */
const PROMPT = "paseo-compat: one turn through the plugin's hooks";
/** How long the event handlers get after the turn ended before the diagnostics are read: the daemon does not wait for them. */
const EVENT_GRACE_MS = 2_000;

// --------------------------------------------------------------------------------------------------------------------
// Pure parts, exported for tests/paseo-compat.test.ts
// --------------------------------------------------------------------------------------------------------------------

export function isVersion(value) {
  return typeof value === "string" && VERSION.test(value);
}

/** The versions named in a workflow input or on the command line: separated by spaces or commas, each a release number. */
export function parseVersions(text) {
  const versions = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  const invalid = versions.filter((version) => !isVersion(version));
  if (invalid.length) throw new Error(`not a Paseo release number: ${invalid.join(", ")} (expected e.g. 0.14.0 or 0.14.0-beta.2)`);
  return [...new Set(versions)];
}

/**
 * What one run tests, before the claims and the cache: the versions it was given, or the CLI's `latest` and `beta`.
 * `fromTags` says where they came from: only those are looked up in the cache, since a version asked for is run anyway.
 */
export function candidates({ distTags, input }) {
  const given = parseVersions(input);
  if (given.length) return { fromTags: false, versions: given.map((version) => ({ version, tags: [] })) };
  const versions = [];
  for (const tag of DIST_TAGS) {
    const version = distTags?.[tag];
    if (version === undefined) continue;
    if (!isVersion(version)) throw new Error(`npm's ${tag} of @getpaseo/cli is ${JSON.stringify(version)}, not a release number`);
    const known = versions.find((entry) => entry.version === version);
    if (known) known.tags.push(tag);
    else versions.push({ version, tags: [tag] });
  }
  if (!versions.length) throw new Error("npm has neither a latest nor a beta of @getpaseo/cli");
  return { fromTags: true, versions };
}

/** The cache key that records that `version` passed on every runner for this commit of the plugin. */
export function cacheKey(version, sha) {
  if (!isVersion(version)) throw new Error(`not a release number: ${version}`);
  if (!/^[0-9a-f]{7,64}$/.test(String(sha))) throw new Error(`not a commit: ${sha}`);
  return `paseo-compat-${version}-${sha}`;
}

/** The versions left to test once those with a cache hit (`hits[i]` is the lookup of `versions[i]`) are taken out. */
export function select(versions, hits) {
  const tested = [];
  const cached = [];
  versions.forEach((version, index) => (hits[index] === "true" || hits[index] === true ? cached : tested).push(version));
  return { tested, cached };
}

/** Variable names of the agent session this may run in, and of secure-input's bridge, which no child may inherit. */
const SESSION_VARIABLES = ["PASEO_AGENT_ID", "PASEO_HOME", "PASEO_HOST", "PASEO_AGENT_CWD", "PASEO_PASSWORD", "SECURE_INPUT_BINDING", "SECURE_INPUT_CLI", "CLAUDECODE"];
const SESSION_PREFIXES = ["PASEO_", "SECURE_INPUT_", "CLAUDE_CODE_", "CODEX_COMPANION_"];
/** What `npm run` adds for its script, which would steer the npm commands this script runs. */
const NPM_RUN_VARIABLE = /^(npm_(config|lifecycle|package)_|npm_command$|npm_execpath$|npm_node_execpath$|INIT_CWD$)/;

/**
 * The environment of a process this script starts: without the session's variables (every `PASEO_*` among them), without
 * anything that points into the owner's Paseo home, and with `set` on top. PATH keeps its entries outside that home.
 */
export function childEnv(env, set = {}, ownerHome = join(homedir(), ".paseo")) {
  const inOwnerHome = (value) => value === ownerHome || value.includes(`${ownerHome}/`);
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SESSION_VARIABLES.includes(key) || SESSION_PREFIXES.some((prefix) => key.startsWith(prefix)) || NPM_RUN_VARIABLE.test(key)) continue;
    if (key === "PATH") result.PATH = value.split(delimiter).filter((entry) => !inOwnerHome(entry)).join(delimiter);
    else if (!inOwnerHome(value)) result[key] = value;
  }
  return { ...result, ...set };
}

/** Throws for the owner's port, and for anything that is not a TCP port. */
export function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  if (port === RESERVED_PORT) throw new Error(`refusing port ${RESERVED_PORT}: the owner's Paseo daemon listens there`);
  return port;
}

/** The JSON a `paseo … --json` command printed, from its first line that opens an object or an array. */
export function jsonFrom(text) {
  const start = String(text).search(/^[[{]/m);
  if (start === -1) throw new Error("no JSON in the output");
  return JSON.parse(String(text).slice(start));
}

/** What a failed command said: the message of the CLI's JSON error when there is one, else its last line of output. */
export function failureOf(result) {
  for (const text of [result.stderr, result.stdout]) {
    try {
      const message = jsonFrom(text)?.error?.message;
      if (message) return oneLine(message);
    } catch {
      // Not JSON: the last line below.
    }
  }
  const lines = plain(`${result.stderr}\n${result.stdout}`).split("\n").map((line) => line.trim()).filter(Boolean);
  // npm ends with where its log is; the line that says what went wrong comes before, after its code.
  const npm = lines.find((line) => /^npm (error|ERR!) /.test(line) && !/^npm (error|ERR!) (code |A complete log)/.test(line));
  const last = npm ?? lines.pop();
  if (result.timedOut) return `timed out${last ? `: ${oneLine(last)}` : ""}`;
  return last ? oneLine(last) : `exited ${result.code ?? result.signal}`;
}

/** Terminal colours (vitest colours its output when CI is set) and the other control characters but tab and line feed. */
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function plain(text) {
  return String(text).replace(CONTROL, "");
}

export function oneLine(text, max = 400) {
  const line = plain(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The line of a test or typecheck output that names what failed first. */
export function firstProblem(output) {
  const lines = plain(output).split("\n");
  const found = lines.find((line) => /error TS\d+/.test(line)) ?? lines.find((line) => /^\s*FAIL\s/.test(line)) ?? lines.find((line) => /\bnpm (error|ERR!)/.test(line));
  return found ? oneLine(found) : undefined;
}

export function formatStep({ step, name, status, detail }) {
  return `${step} ${name.padEnd(7)} ${status.padEnd(4)} ${detail}`;
}

export function issueTitle(version) {
  return `Paseo ${version} compatibility`;
}

/** The hidden first line of an issue body: which version it is for, and which runner failed at which step. */
const MARKER = /^<!-- paseo-compat version=(\S+) failing=(\S*) -->/;

function signatureOf(legs) {
  return legs
    .filter((leg) => leg.status === "fail")
    .map((leg) => `${leg.runner}:${leg.failed?.step ?? "none"}`)
    .sort()
    .join(",");
}

function cell(text) {
  return oneLine(text, 300).replace(/\|/g, "\\|");
}

function legResult(leg) {
  if (leg.status === "pass") return "pass";
  if (leg.status === "skip") return `skip: ${cell(leg.failed?.detail ?? "not claimed")}`;
  const where = leg.failed?.step ? ` at step ${leg.failed.step} (${leg.failed.name})` : "";
  return `**fail**${where}: ${cell(leg.failed?.detail ?? "")}`;
}

/** The body of the issue of a failing version. */
export function issueBody({ plugin, version, legs, run }) {
  const lines = [
    `<!-- paseo-compat version=${version} failing=${signatureOf(legs)} -->`,
    `${plugin} failed its compatibility run against Paseo ${version} at ${run.sha.slice(0, 12)}.`,
    "",
    "| Runner | Result |",
    "| --- | --- |",
    ...legs.map((leg) => `| ${leg.runner} | ${legResult(leg)} |`),
    "",
    `Run: ${run.url}`,
    "",
    `To reproduce: \`npm run test:paseo -- ${version}\` (steps 1 and 3 to 6; add \`--with-sdk\` for step 2, and run \`npm ci\` afterwards if it was interrupted). It uses a daemon of its own in a temporary home.`,
    "",
    "Each run that still fails updates this issue; the first run that passes on every runner closes it.",
  ];
  for (const leg of legs.filter((entry) => entry.status === "fail" && entry.excerpt)) {
    lines.push("", `<details><summary>${leg.runner}: output of the failed step</summary>`, "", "~~~", leg.excerpt.replace(/~~~/g, "~ ~ ~"), "~~~", "", "</details>");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What a report does, from the results of the runners and the open issues: one issue per failing version (opened,
 * or updated in place, with a comment when what fails has changed), the issue of a passing version closed, and the
 * versions that passed on every runner, to be recorded in the cache. A runner without a result is a failure.
 */
export function planReport({ plugin, versions, runners, results, openIssues, run }) {
  const verdicts = versions.map((version) => {
    const legs = runners.map((runner) => {
      const result = results.find((entry) => entry.version === version && entry.runner === runner);
      if (result) return { runner, status: result.status, failed: result.failed ?? null, excerpt: result.excerpt };
      return { runner, status: "fail", failed: { step: null, name: "result", detail: "the job ended before the compatibility script wrote a result (cancelled, timed out or crashed): see the run" } };
    });
    const status = legs.some((leg) => leg.status === "fail") ? "fail" : legs.every((leg) => leg.status === "pass") ? "pass" : "skip";
    return { version, status, legs };
  });
  const issueOf = (version) =>
    openIssues.find((issue) => issue.title === issueTitle(version)) ?? openIssues.find((issue) => MARKER.exec(issue.body ?? "")?.[1] === version);
  const actions = [];
  for (const { version, status, legs } of verdicts) {
    const issue = issueOf(version);
    if (status === "fail") {
      const body = issueBody({ plugin, version, legs, run });
      if (!issue) actions.push({ kind: "create", version, title: issueTitle(version), body });
      else {
        const before = MARKER.exec(issue.body ?? "")?.[2];
        const changed = before !== signatureOf(legs);
        const comment = changed ? `What fails has changed, in ${run.url}:\n\n${legs.map((leg) => `- ${leg.runner}: ${legResult(leg)}`).join("\n")}\n` : undefined;
        actions.push({ kind: "update", version, number: issue.number, body, ...(comment ? { comment } : {}) });
      }
    } else if (status === "pass" && issue) {
      actions.push({ kind: "close", version, number: issue.number, comment: `Paseo ${version} passed on ${runners.join(" and ")} in ${run.url} at ${run.sha.slice(0, 12)}.\n` });
    }
  }
  const record = verdicts.filter((verdict) => verdict.status === "pass").map(({ version }) => ({ version, key: cacheKey(version, run.sha) }));
  return { verdicts, actions, record };
}

// --------------------------------------------------------------------------------------------------------------------
// Processes
// --------------------------------------------------------------------------------------------------------------------

/** What is under way: the signal that interrupted the run, and the processes to stop when one comes. */
const state = { interrupted: null, cleaning: false, finished: false, children: new Set(), verbose: false };

/**
 * Runs a program without a shell. Output is kept (its last 8 MiB) and echoed with `--verbose`; stdin is /dev/null.
 * Once the run is interrupted nothing new starts, but for the cleanup's own commands (`always`).
 */
function run(command, args, { cwd = ROOT, env, timeoutMs = 120_000, echo = state.verbose, always = false } = {}) {
  return new Promise((resolvePromise) => {
    if (state.interrupted && !always) {
      resolvePromise({ code: null, signal: state.interrupted, stdout: "", stderr: "interrupted", timedOut: false });
      return;
    }
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    state.children.add(child);
    const output = { stdout: "", stderr: "" };
    const keep = (stream, target) =>
      child[stream].on("data", (chunk) => {
        output[stream] = (output[stream] + chunk).slice(-8 * 1024 * 1024);
        if (echo) target.write(chunk);
      });
    keep("stdout", process.stdout);
    keep("stderr", process.stderr);
    let timedOut = false;
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.children.delete(child);
      resolvePromise({ code, signal, ...output, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      output.stderr += `\n${command}: ${error.message}`;
      // A program that could not be started emits no close.
      if (child.pid === undefined) settle(null, null);
    });
    child.on("close", settle);
  });
}

function sleep(ms, { always = false } = {}) {
  return new Promise((resolvePromise) => {
    const until = Date.now() + ms;
    const tick = () => ((state.interrupted && !always) || Date.now() >= until ? resolvePromise() : setTimeout(tick, Math.min(100, until - Date.now())));
    tick();
  });
}

/** Asks `probe` until it returns something other than undefined, or throws after `timeoutMs`. */
async function waitFor(what, timeoutMs, probe) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (state.interrupted) throw new Error(`interrupted while waiting for ${what}`);
    if (Date.now() >= until) throw new Error(`no ${what} after ${Math.round(timeoutMs / 1000)} s`);
    await sleep(500);
  }
}

class StepFailure extends Error {
  constructor(message, excerpt) {
    super(message);
    this.excerpt = excerpt;
  }
}

class Skip extends Error {}

/** Environment and paths of the npm and paseo processes of one run. */
function processes(ctx) {
  // `env node` in the CLI's shebang, and npm, are the Node.js this script runs on.
  const path = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
  const base = childEnv({ ...process.env, PATH: path });
  return {
    npm: (args, options = {}) => run("npm", args, { ...options, env: { ...base, ...options.env } }),
    // The CLI and the daemon it starts get a home directory of their own: whatever a release writes under `~`
    // (agent skills, provider settings) lands in the temporary directory.
    paseo: (args, options = {}) => {
      if (!args.includes("--home") || args[args.indexOf("--home") + 1] !== ctx.home) throw new Error(`refusing a paseo command without --home ${ctx.home}`);
      return run(join(ctx.prefix, "node_modules", ".bin", "paseo"), args, {
        ...options,
        cwd: ctx.temp,
        env: childEnv(base, { HOME: ctx.userHome, ...options.env }),
      });
    },
  };
}

async function paseoJson(ctx, args, options) {
  const result = await ctx.proc.paseo([...args, "--home", ctx.home, "--json"], options);
  if (result.code !== 0) throw new StepFailure(`paseo ${args.slice(0, 2).join(" ")}: ${failureOf(result)}`, excerptOf(result));
  try {
    return jsonFrom(result.stdout);
  } catch {
    throw new StepFailure(`paseo ${args.slice(0, 2).join(" ")} printed no JSON: ${oneLine(result.stdout || result.stderr)}`);
  }
}

/** The last lines a command printed, indentation kept, for the console and the issue. */
export function excerptOf(result, lines = 40) {
  return plain(`${result.stdout}\n${result.stderr}`)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .map((line) => (line.length > 400 ? `${line.slice(0, 399)}…` : line))
    .join("\n");
}

/** Imports a package as the temporary prefix resolves it, or as `from`, a package in it, resolves it. */
async function importFrom(prefix, name, from) {
  let require = createRequire(join(prefix, "package.json"));
  if (from) require = createRequire(require.resolve(from));
  return import(pathToFileURL(require.resolve(name)).href);
}

function installedVersion(directory, name) {
  try {
    return JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** A port nothing listens on now, picked by the system, and never the owner's. */
async function freePort() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await new Promise((resolvePromise, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: picked } = server.address();
        server.close(() => resolvePromise(picked));
      });
    });
    if (port !== RESERVED_PORT) return checkPort(port);
  }
  throw new StepFailure("the system offered no free port but the owner's");
}

// --------------------------------------------------------------------------------------------------------------------
// The steps of one run
// --------------------------------------------------------------------------------------------------------------------

/** Step 1, also the resolve job's: whether the plugin claims `version`, by that release's own rule. */
async function claim(ctx, version, prefix) {
  const install = await ctx.proc.npm(["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", `@getpaseo/protocol@${version}`], { timeoutMs: 300_000 });
  if (install.code !== 0) throw new StepFailure(`npm could not install @getpaseo/protocol@${version}: ${failureOf(install)}`, excerptOf(install));
  const { assertPluginCompatibility } = await importFrom(prefix, "@getpaseo/protocol/plugin-requirements");
  if (typeof assertPluginCompatibility !== "function") throw new StepFailure(`@getpaseo/protocol@${version} has no assertPluginCompatibility`);
  const { id, requirements } = ctx.manifest;
  try {
    for (const runtime of ["daemon", "app"]) assertPluginCompatibility({ id, requirements, version, runtime });
  } catch (error) {
    throw new Skip(oneLine(error.message));
  }
  return `${requirements?.paseo} admits Paseo ${version} on the daemon and in the app, by @getpaseo/protocol@${version}`;
}

/** The `@getpaseo/*` packages the plugin depends on, with the exact versions its lock file installs. */
function sdkPackages() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith("@getpaseo/"))
    .sort()
    .map((name) => ({ name, locked: lock.packages?.[`node_modules/${name}`]?.version }));
}

/** Step 2: the plugin's typecheck and tests against the SDK of `version`, installed over the pinned one. */
async function sdk(ctx) {
  const packages = sdkPackages();
  ctx.sdkReplaced = packages;
  const install = await ctx.proc.npm(["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", ...packages.map(({ name }) => `${name}@${ctx.version}`)], { timeoutMs: 300_000 });
  if (install.code !== 0) throw new StepFailure(`npm could not install the SDK of ${ctx.version}: ${failureOf(install)}`, excerptOf(install));
  const stray = packages.filter(({ name }) => installedVersion(ROOT, name) !== ctx.version);
  if (stray.length) throw new StepFailure(`npm installed ${stray.map(({ name }) => `${name}@${installedVersion(ROOT, name)}`).join(", ")}, not ${ctx.version}`);
  const failures = [];
  let excerpt;
  for (const script of ["typecheck", "test"]) {
    // tests/mirrored-constants.test.ts holds the RPC limit to the installed protocol and relay, at this version.
    const result = await ctx.proc.npm(["run", script], { timeoutMs: 900_000, env: { PASEO_COMPAT_SDK: ctx.version } });
    if (result.code === 0) continue;
    const problem = firstProblem(`${result.stdout}\n${result.stderr}`);
    failures.push(`npm run ${script} exited ${result.code ?? result.signal}${problem ? `: ${problem}` : ""}`);
    excerpt ??= excerptOf(result, 60);
  }
  if (failures.length) throw new StepFailure(failures.join("; "), excerpt);
  return `${packages.map(({ name }) => name).join(", ")} at ${ctx.version}: npm run typecheck and npm test passed`;
}

/** Step 3: the CLI of `version`, an isolated daemon of it, and the plugin installed from this checkout and running. */
async function daemon(ctx) {
  const install = await ctx.proc.npm(
    ["install", "--prefix", ctx.prefix, "--no-audit", "--no-fund", "--loglevel=error", ...["cli", "client", "protocol"].map((name) => `@getpaseo/${name}@${ctx.version}`)],
    { timeoutMs: 900_000 },
  );
  if (install.code !== 0) throw new StepFailure(`npm could not install @getpaseo/cli@${ctx.version}: ${failureOf(install)}`, excerptOf(install));
  for (const name of ["@getpaseo/cli", "@getpaseo/server", "@getpaseo/client"]) {
    const found = installedVersion(ctx.prefix, name);
    if (found !== ctx.version) throw new StepFailure(`the prefix has ${name}@${found}, not ${ctx.version}`);
  }

  ctx.listen = `127.0.0.1:${await freePort()}`;
  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  mkdirSync(ctx.userHome, { recursive: true, mode: 0o700 });
  // All before the first start. The skills selection keeps a fresh home of 0.14 from rewriting the Paseo skills in
  // ~/.agents and ~/.claude (here the temporary home directory as well). `daemon start` drops PASEO_DICTATION_ENABLED
  // from the daemon's environment, so the setting is what keeps it from downloading a speech model; a release that
  // renamed it costs a download, not the run.
  const settings = [
    { path: "daemon.listen", value: ctx.listen, flags: ["--string"] },
    { path: "pluginsEnabled", value: "true" },
    { path: "daemon.mcp.injectIntoAgents", value: "true" },
    { path: "agents.skills.selection", value: JSON.stringify({ mode: "custom", skills: [] }) },
    { path: "features.dictation.enabled", value: "false", optional: true },
  ];
  const notes = [];
  for (const { path, value, flags = [], optional } of settings) {
    try {
      await paseoJson(ctx, ["daemon", "config", "set", path, value, ...flags]);
    } catch (error) {
      if (!optional) throw error;
      notes.push(`${path} not set (${error.message})`);
    }
  }

  // The mock provider exists only in a development daemon.
  const started = await paseoJson(ctx, ["daemon", "start", "--timeout", "150"], {
    timeoutMs: 180_000,
    env: { PASEO_NODE_ENV: "development", PASEO_DICTATION_ENABLED: "false" },
  });
  ctx.daemonPid = started.pid;
  if (started.listen !== ctx.listen) throw new StepFailure(`the daemon listens on ${started.listen}, not ${ctx.listen}`);

  // Trusting a plugin asks nothing when stdin is not a terminal; stdin is /dev/null.
  await paseoJson(ctx, ["plugin", "install", ROOT], { timeoutMs: 300_000 });
  const id = ctx.manifest.id;
  const entry = await waitFor(`${id} running`, 60_000, async () => {
    const plugin = (await paseoJson(ctx, ["plugin", "ls"])).find((item) => item.id === id);
    if (plugin?.status === "running") return plugin;
    if (plugin?.status === "failed") throw new StepFailure(`${id} failed to start: ${oneLine(plugin.error ?? "no reason given")}`);
    return undefined;
  });
  await waitFor(`"Plugin ready" in the plugin's log`, 30_000, async () => {
    const entries = await paseoJson(ctx, ["plugin", "logs", id]);
    const failed = entries.find((item) => /^\[paseo\] Plugin failed/.test(item.message));
    if (failed) throw new StepFailure(oneLine(failed.message));
    return entries.some((item) => item.message === "[paseo] Plugin ready") ? true : undefined;
  });
  return [`@getpaseo/cli ${ctx.version} on ${ctx.listen}; ${id} ${entry.status}, "Plugin ready" in its log`, ...notes].join("; ");
}

/** The client of `version`, connected to the daemon this run started and to no other. */
async function connect(ctx) {
  const { createHostClient } = await importFrom(ctx.prefix, "@getpaseo/client/node");
  const control = await importFrom(ctx.prefix, "@getpaseo/server/daemon-control");
  const instance = await control.readDaemonInstance(ctx.home);
  if (instance?.listen !== ctx.listen) throw new StepFailure(`the daemon of ${ctx.home} publishes ${instance?.listen ?? "no address"}, not ${ctx.listen}`);
  checkPort(Number(instance.listen.split(":").pop()));
  const client = createHostClient(instance.listen, {
    clientId: `paseo-compat-${randomUUID()}`,
    clientType: "cli",
    appVersion: ctx.version,
    localCredential: () => control.readLocalCredentialForTarget(ctx.home, instance.listen) ?? undefined,
    reconnect: { enabled: false },
  });
  ctx.opened = client;
  await client.connect();
  ctx.client = client;
  return client;
}

/** The plugin's contracts, bundled from this checkout with the esbuild the Paseo under test compiles plugins with. */
async function loadContracts(ctx) {
  const esbuild = await importFrom(ctx.prefix, "esbuild", "@getpaseo/server");
  const built = await esbuild.build({
    stdin: { contents: `export * from ${JSON.stringify(`./${PLUGIN.contracts}`)};`, resolveDir: ROOT, sourcefile: "paseo-compat-contracts.mjs", loader: "js" },
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const file = join(ctx.temp, "contracts.mjs");
  writeFileSync(file, built.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

function contractOf(ctx, name) {
  const contract = ctx.contracts[name];
  if (!contract?.name || !contract.input || !contract.output) throw new StepFailure(`${PLUGIN.contracts} has no RPC contract ${name}`);
  return contract;
}

/** Calls a contract through the daemon and parses the answer with the contract's own output schema. */
async function call(ctx, name, input) {
  const contract = contractOf(ctx, name);
  const answer = await ctx.client.invokePluginRpc(ctx.manifest.id, contract.name, contract.input.parse(input));
  const parsed = contract.output.safeParse(answer);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StepFailure(`${contract.name} answered outside its schema: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`, oneLine(JSON.stringify(answer), 2000));
  }
  return parsed.data;
}

/** Step 4: the plugin's RPCs through the daemon, with the client of `version`. */
async function rpc(ctx) {
  ctx.contracts = await loadContracts(ctx);
  await connect(ctx);
  const said = [];
  for (const entry of PLUGIN.rpc) {
    const contract = contractOf(ctx, entry.contract);
    if (!entry.refusal) {
      await call(ctx, entry.contract, entry.input);
      said.push(`${contract.name} answered and parsed with the plugin's schema`);
      continue;
    }
    let refusal;
    try {
      await ctx.client.invokePluginRpc(ctx.manifest.id, contract.name, contract.input.parse(entry.input));
    } catch (error) {
      refusal = String(error?.message ?? error);
    }
    if (refusal === undefined) throw new StepFailure(`${contract.name} answered where the plugin refuses with "${entry.refusal}"`);
    if (!refusal.includes(entry.refusal)) throw new StepFailure(`${contract.name} was refused, not with "${entry.refusal}": ${oneLine(refusal)}`);
    said.push(`${contract.name} refused: ${entry.refusal}`);
  }
  return said.join("; ");
}

/** Step 5: one agent of the built-in mock provider, its session opened through the plugin's hook, and one turn. */
async function hooks(ctx) {
  const id = ctx.manifest.id;
  let models;
  try {
    models = await paseoJson(ctx, ["provider", "models", "mock"]);
  } catch (error) {
    throw new StepFailure(`the mock provider of a development daemon is not available: ${error.message}`);
  }
  // The catalog says which of its models is for smoke checks; the first one stands in when none says so.
  const model = models.find((entry) => /smoke/i.test(entry.description ?? "")) ?? models[0];
  if (!model?.id) throw new StepFailure("the mock provider lists no model");
  mkdirSync(ctx.work, { recursive: true });
  const created = await ctx.proc.paseo(
    ["run", "--home", ctx.home, "--json", "--provider", `mock/${model.id}`, "--cwd", ctx.work, "--title", "paseo-compat", "--wait-timeout", "90s", PROMPT],
    { timeoutMs: 180_000 },
  );
  // A session_open hook whose answer the daemon rejects fails the creation here: "Plugin … before agent.session_open failed".
  if (created.code !== 0) throw new StepFailure(`the agent was not created: ${failureOf(created)}`, excerptOf(created));
  let agent;
  try {
    agent = jsonFrom(created.stdout);
  } catch {
    agent = undefined;
  }
  if (typeof agent?.agentId !== "string") throw new StepFailure(`paseo run named no agent: ${oneLine(created.stdout || created.stderr)}`, excerptOf(created));
  let turn = agent.status;
  if (turn === "permission") {
    await paseoJson(ctx, ["permit", "allow", agent.agentId, "--all"]);
    await paseoJson(ctx, ["agent", "wait", agent.agentId, "--timeout", "90"], { timeoutMs: 120_000 });
    turn = "completed after a permission";
  } else if (turn === "timeout") {
    // A turn that is interrupted ends too, with the outcome "canceled": the turn hooks run all the same.
    await paseoJson(ctx, ["agent", "stop", agent.agentId]);
    turn = "interrupted after 90 s";
  } else if (turn !== "completed") {
    throw new StepFailure(`the agent's turn ended with status ${turn}`);
  }

  await sleep(EVENT_GRACE_MS);
  const listed = (await paseoJson(ctx, ["ls", "--all", "--global"])).some((entry) => entry.id === agent.agentId);
  if (!listed) throw new StepFailure(`agent ${agent.agentId} is not listed after its turn`);
  const logs = await paseoJson(ctx, ["plugin", "logs", id]);
  const hookFailure = logs.find((entry) => /^Lifecycle hook \S+ failed/.test(entry.message));
  if (hookFailure) throw new StepFailure(`the daemon logged: ${oneLine(hookFailure.message)}`);
  const plugin = (await paseoJson(ctx, ["plugin", "ls"])).find((entry) => entry.id === id);
  if (plugin?.status !== "running") throw new StepFailure(`${id} is ${plugin?.status ?? "gone"} after the turn${plugin?.error ? `: ${oneLine(plugin.error)}` : ""}`);
  if (PLUGIN.diagnostics) {
    const problems = PLUGIN.diagnostics.problems(await call(ctx, PLUGIN.diagnostics.contract, PLUGIN.diagnostics.input));
    if (problems.length) throw new StepFailure(`diagnostics after the turn: ${problems.join("; ")}`);
  }
  return `mock/${model.id} agent ${agent.agentId.slice(0, 7)}: session opened, turn ${turn}, agent listed${PLUGIN.diagnostics ? `; diagnostics: ${PLUGIN.diagnostics.summary}` : ""}`;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Step 6: the daemon stopped, the SDK of the checkout restored, the temporary directory removed; whatever happened before. */
async function cleanup(ctx) {
  state.cleaning = true;
  const done = [];
  const problems = [];
  try {
    await ctx.opened?.close();
  } catch {
    // The daemon is stopped below either way.
  }
  const cli = join(ctx.prefix, "node_modules", ".bin", "paseo");
  let stopConfirmed = false;
  let stopProblem;
  if (existsSync(join(ctx.home, "config.json")) && existsSync(cli)) {
    const stopped = await ctx.proc.paseo(["daemon", "stop", "--home", ctx.home, "--json", "--force", "--timeout", "20", "--kill-timeout", "5"], { timeoutMs: 60_000, always: true });
    if (stopped.code !== 0) stopProblem = `paseo daemon stop: ${failureOf(stopped)}`;
    else {
      stopConfirmed = true;
      done.push(jsonFrom(stopped.stdout).action === "stopped" ? "daemon stopped" : "no daemon was running");
    }
  }
  // When `stop` did not confirm the exit: the supervisor leads a process group of its own (it was started detached),
  // which holds its worker and the plugin's process. A confirmed stop is left alone, so a reused pid is never hit.
  let pid = ctx.daemonPid;
  try {
    pid ??= JSON.parse(readFileSync(join(ctx.home, "paseo.pid"), "utf8")).pid;
  } catch {
    // No lock: no daemon was started.
  }
  if (!stopConfirmed && Number.isInteger(pid) && pid > 1) {
    if (processAlive(pid)) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Gone already, or not a group.
        }
      }
      await sleep(1_000, { always: true });
    }
    if (processAlive(pid)) problems.push(`${stopProblem ? `${stopProblem}; ` : ""}daemon pid ${pid} is still running`);
    else done.push(`daemon pid ${pid} not running${stopProblem ? ` (${stopProblem})` : ""}`);
  } else if (stopProblem) problems.push(stopProblem);
  if (ctx.sdkReplaced) {
    const unlocked = ctx.sdkReplaced.filter(({ locked }) => !locked);
    const restore = unlocked.length
      ? { code: 1, stdout: "", stderr: `package-lock.json has no ${unlocked.map(({ name }) => name).join(", ")}` }
      : await ctx.proc.npm(["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", ...ctx.sdkReplaced.map(({ name, locked }) => `${name}@${locked}`)], { timeoutMs: 300_000, echo: false, always: true });
    const stray = ctx.sdkReplaced.filter(({ name, locked }) => installedVersion(ROOT, name) !== locked);
    if (restore.code !== 0 || stray.length) problems.push(`node_modules keeps the SDK of ${ctx.version}, run npm ci: ${failureOf(restore)}`);
    else done.push("pinned SDK restored");
  }
  try {
    rmSync(ctx.temp, { recursive: true, force: true, maxRetries: 3 });
    if (existsSync(ctx.temp)) problems.push(`${ctx.temp} is still there`);
    else done.push("temporary files removed");
  } catch (error) {
    problems.push(`${ctx.temp} could not be removed: ${error.message}`);
  }
  if (problems.length) throw new StepFailure(problems.join("; "));
  return done.join(", ");
}

/** Prints and records one step. A step that throws is a failure, or a skip; the run goes on to what does not need it. */
async function step(ctx, number, body) {
  const record = { step: number, name: STEP_NAMES[number], status: "pass", detail: "" };
  try {
    record.detail = await body();
  } catch (error) {
    if (error instanceof Skip) record.status = "skip";
    else {
      record.status = "fail";
      if (error?.excerpt) record.excerpt = error.excerpt;
    }
    record.detail = state.interrupted && !(error instanceof Skip) ? `interrupted by ${state.interrupted}: ${oneLine(error?.message ?? error)}` : oneLine(error?.message ?? String(error), 1000);
  }
  ctx.steps.push(record);
  console.log(formatStep(record));
  if (record.status === "fail" && record.excerpt && !state.verbose) console.log(record.excerpt.replace(/^/gm, "    | "));
  return record.status === "pass";
}

function notRun(ctx, number, why) {
  const record = { step: number, name: STEP_NAMES[number], status: "skip", detail: `not run: ${why}` };
  ctx.steps.push(record);
  console.log(formatStep(record));
}

/** One compatibility run: steps 1, (2,) 3, 4, 5 and 6. Resolves with the result that `--result` writes. */
async function compat(version, { withSdk }) {
  const temp = mkdtempSync(join(tmpdir(), "paseo-compat-"));
  const ctx = {
    version,
    manifest: JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")),
    temp,
    prefix: join(temp, "prefix"),
    home: join(temp, "home"),
    userHome: join(temp, "user"),
    work: join(temp, "work"),
    steps: [],
  };
  ctx.proc = processes(ctx);
  const started = Date.now();
  console.log(`paseo-compat: ${ctx.manifest.id} against Paseo ${version} (Node.js ${process.version}, ${process.platform} ${process.arch}), in ${temp}`);
  try {
    if (await step(ctx, 1, () => claim(ctx, version, ctx.prefix))) {
      if (withSdk) await step(ctx, 2, () => sdk(ctx));
      if (await step(ctx, 3, () => daemon(ctx))) {
        await step(ctx, 4, () => rpc(ctx));
        if (ctx.client && ctx.contracts) await step(ctx, 5, () => hooks(ctx));
        else notRun(ctx, 5, ctx.contracts ? "the client did not connect" : `${PLUGIN.contracts} did not load`);
      } else {
        notRun(ctx, 4, "the daemon or the plugin did not start");
        notRun(ctx, 5, "the daemon or the plugin did not start");
      }
    }
  } finally {
    await step(ctx, 6, () => cleanup(ctx));
  }
  const skipped = ctx.steps[0]?.status === "skip";
  const failed = ctx.steps.find((entry) => entry.status === "fail");
  const status = failed ? "fail" : skipped ? "skip" : "pass";
  const seconds = Math.round((Date.now() - started) / 1000);
  const summary =
    state.interrupted ? `INTERRUPTED ${ctx.manifest.id} on Paseo ${version} by ${state.interrupted}${failed ? ` in step ${failed.step} (${failed.name})` : ""}; cleaned up` :
    status === "pass" ? `PASS ${ctx.manifest.id} on Paseo ${version} (${seconds} s)` :
    status === "skip" ? `SKIP ${ctx.manifest.id} on Paseo ${version}: the plugin does not claim this release` :
    `FAIL ${ctx.manifest.id} on Paseo ${version} at step ${failed.step} (${failed.name}) (${seconds} s)`;
  console.log(summary);
  return {
    plugin: ctx.manifest.id,
    version,
    runner: process.env.PASEO_COMPAT_RUNNER || `${process.platform}-${process.arch}`,
    status,
    failed: failed ? { step: failed.step, name: failed.name, detail: failed.detail } : skipped ? { step: 1, name: "range", detail: ctx.steps[0].detail } : null,
    excerpt: failed?.excerpt,
    steps: ctx.steps.map(({ excerpt, ...rest }) => rest),
    node: process.version,
    seconds,
    summary,
  };
}

// --------------------------------------------------------------------------------------------------------------------
// The workflow's commands
// --------------------------------------------------------------------------------------------------------------------

function setOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  for (const line of lines) console.log(`output ${line}`);
}

function summarize(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function runnersOf(env) {
  const runners = JSON.parse(env.RUNNERS ?? "[]");
  if (!Array.isArray(runners) || !runners.length || !runners.every((runner) => /^[\w.-]+$/.test(runner))) throw new Error("RUNNERS is not a JSON list of runner labels");
  return runners;
}

/** The resolve job: the versions to test, those the plugin does not claim, and the cache keys to look up. */
async function resolveCommand(env) {
  const ctx = { manifest: JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")) };
  ctx.proc = processes(ctx);
  let distTags;
  if (!parseVersions(env.VERSIONS).length) {
    const view = await ctx.proc.npm(["view", "@getpaseo/cli", "dist-tags", "--json"], { timeoutMs: 60_000 });
    if (view.code !== 0) throw new Error(`npm view @getpaseo/cli dist-tags: ${failureOf(view)}`);
    distTags = JSON.parse(view.stdout);
  }
  const { fromTags, versions } = candidates({ distTags, input: env.VERSIONS });
  const temp = mkdtempSync(join(tmpdir(), "paseo-compat-resolve-"));
  const claimed = [];
  const skipped = [];
  try {
    for (const [index, { version, tags }] of versions.entries()) {
      const from = tags.length ? ` (${tags.join(", ")})` : "";
      try {
        console.log(`${version}${from}: ${await claim(ctx, version, join(temp, String(index)))}`);
        claimed.push(version);
      } catch (error) {
        if (!(error instanceof Skip)) throw error;
        console.log(`${version}${from}: skipped: ${error.message}`);
        skipped.push({ version, reason: error.message });
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const sha = env.GITHUB_SHA;
  const keys = fromTags && sha ? claimed.map((version) => cacheKey(version, sha)) : [];
  if (keys.length > LOOKUPS) throw new Error(`the workflow looks up ${LOOKUPS} keys, not ${keys.length}`);
  setOutputs({ versions: claimed, skipped, runners: runnersOf(env), ...Object.fromEntries([...Array(LOOKUPS).keys()].map((index) => [`key${index}`, keys[index] ?? ""])) });
  summarize(
    [
      `### Paseo versions${fromTags ? ` on npm (${DIST_TAGS.join(", ")} of @getpaseo/cli)` : " asked for"}`,
      "",
      "| Version | Claimed by paseo-plugin.json |",
      "| --- | --- |",
      ...claimed.map((version) => `| ${version} | yes |`),
      ...skipped.map(({ version, reason }) => `| ${version} | no, skipped: ${cell(reason)} |`),
    ].join("\n"),
  );
}

/** The select step: what the resolve job found, without the versions that already passed for this commit. */
function selectCommand(env) {
  const versions = JSON.parse(env.VERSIONS ?? "[]");
  const { tested, cached } = select(versions, versions.map((_, index) => env[`HIT${index}`]));
  for (const version of cached) console.log(`${version}: passed for ${env.GITHUB_SHA ?? "this commit"} already, not tested again`);
  setOutputs({ versions: tested });
  if (cached.length) summarize(cached.map((version) => `- ${version} passed for this commit already.`).join("\n"));
}

/** `gh` with the job's token and repository (GH_TOKEN, GH_REPO), which `childEnv` keeps. */
function gh(args) {
  return run("gh", args, { env: childEnv(process.env), timeoutMs: 60_000, echo: false });
}

async function ghOrThrow(args) {
  const result = await gh(args);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${failureOf(result)}`);
  return result.stdout;
}

function readResults(directory) {
  const found = [];
  const walk = (path) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) found.push(JSON.parse(readFileSync(full, "utf8")));
    }
  };
  walk(directory);
  return found;
}

/** The report job: the issues, from the results the runners uploaded. DRY_RUN=true prints what it would do instead. */
async function reportCommand(directory, env) {
  if (!directory) throw new Error("report needs the directory of the downloaded results");
  const dryRun = env.DRY_RUN === "true";
  const manifest = JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8"));
  const sha = env.GITHUB_SHA;
  const run = { url: env.RUN_URL ?? "(no run)", sha: sha ?? "0000000" };
  const versions = JSON.parse(env.VERSIONS ?? "[]");
  const openIssues = env.ISSUES_FILE
    ? JSON.parse(readFileSync(env.ISSUES_FILE, "utf8"))
    : JSON.parse(await ghOrThrow(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "200", "--json", "number,title,body"]));
  const plan = planReport({ plugin: manifest.id, versions, runners: runnersOf(env), results: readResults(directory), openIssues, run });
  for (const { version, status, legs } of plan.verdicts) console.log(`${version}: ${status} (${legs.map((leg) => `${leg.runner} ${leg.status}`).join(", ")})`);

  const done = [];
  if (plan.actions.some((action) => action.kind === "create") && !dryRun) {
    const labels = JSON.parse(await ghOrThrow(["label", "list", "--limit", "500", "--json", "name"]));
    if (!labels.some((label) => label.name === LABEL)) await ghOrThrow(["label", "create", LABEL, "--color", "B60205", "--description", "A Paseo release this plugin failed against (Paseo compatibility workflow)"]);
  }
  const temp = mkdtempSync(join(tmpdir(), "paseo-compat-report-"));
  try {
    const bodyFile = (name, text) => {
      const file = join(temp, name);
      writeFileSync(file, text);
      return file;
    };
    for (const action of plan.actions) {
      const commands = [];
      if (action.kind === "create") commands.push(["issue", "create", "--title", action.title, "--label", LABEL, "--body-file", bodyFile(`${action.version}.md`, action.body)]);
      if (action.kind === "update") {
        commands.push(["issue", "edit", String(action.number), "--body-file", bodyFile(`${action.version}.md`, action.body)]);
        if (action.comment) commands.push(["issue", "comment", String(action.number), "--body-file", bodyFile(`${action.version}-comment.md`, action.comment)]);
      }
      if (action.kind === "close") commands.push(["issue", "close", String(action.number), "--reason", "completed", "--comment", action.comment]);
      for (const args of commands) {
        if (dryRun) console.log(`dry run: gh ${args.map((arg) => (arg.startsWith(temp) ? `<${arg.slice(temp.length + 1)}>` : JSON.stringify(arg))).join(" ")}`);
        else {
          const out = (await ghOrThrow(args)).trim();
          if (out) console.log(out);
        }
      }
      if (dryRun && action.body) console.log(action.body.replace(/^/gm, "    | "));
      done.push(`${action.kind} ${action.number ? `#${action.number} ` : ""}(Paseo ${action.version})${dryRun ? ", dry run" : ""}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  setOutputs({ record: { include: plan.record }, passed: String(plan.record.length) });
  summarize(
    [
      "### Paseo compatibility",
      "",
      "| Version | Result | Runners |",
      "| --- | --- | --- |",
      ...plan.verdicts.map(({ version, status, legs }) => `| ${version} | ${status} | ${legs.map((leg) => `${leg.runner}: ${legResult(leg)}`).join("<br>")} |`),
      "",
      done.length ? `Issues: ${done.join("; ")}.` : "No issue to open, update or close.",
    ].join("\n"),
  );
}

// --------------------------------------------------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/paseo-compat.mjs <version> [--with-sdk] [--verbose] [--result <file>]
  node scripts/paseo-compat.mjs resolve | select | report <directory>     (the Paseo compatibility workflow)`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "with-sdk": { type: "boolean" }, verbose: { type: "boolean" }, result: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, argument] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (command === "resolve") return resolveCommand(process.env).then(() => 0);
  if (command === "select") return (selectCommand(process.env), 0);
  if (command === "report") return reportCommand(argument, process.env).then(() => 0);
  if (!isVersion(command) || positionals.length > 1) {
    console.error(`${USAGE}\n\n${JSON.stringify(command)} is not a Paseo release number such as 0.14.0 or 0.14.0-beta.2.`);
    return 2;
  }
  state.verbose = values.verbose === true;
  // The first signal stops what runs and goes on to the cleanup, which is bounded by its own timeouts. A signal during
  // the cleanup cannot cut it short: a daemon left running is what this script must never leave behind.
  const interrupt = (signal) => {
    if (state.finished) return;
    if (state.interrupted || state.cleaning) {
      console.log(`${signal}: cleaning up, the daemon is stopped and the temporary files removed before this exits`);
      return;
    }
    state.interrupted = signal;
    console.log(`\n${signal}: stopping what runs, then cleaning up`);
    for (const child of state.children) child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const result = await compat(command, { withSdk: values["with-sdk"] === true });
  state.finished = true;
  if (values.result) {
    const file = resolve(values.result);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    summarize(["```", ...result.steps.map(formatStep), result.summary, "```"].join("\n"));
    // A workflow command's message is one line, with % escaped.
    if (result.status === "fail") console.log(`::error title=Paseo ${result.version} on ${result.runner}::step ${result.failed.step} (${result.failed.name}): ${result.failed.detail.replace(/%/g, "%25")}`);
  }
  if (state.interrupted) return 130;
  return result.status === "fail" ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Everything this started is stopped by the time `main` settles; a handle the Paseo client keeps open must not keep
  // the process alive, and the timer gives the output time to drain first.
  const leave = (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 1_000).unref();
  };
  main(process.argv.slice(2)).then(leave, (error) => {
    console.error(error?.message ?? error);
    leave(1);
  });
}
