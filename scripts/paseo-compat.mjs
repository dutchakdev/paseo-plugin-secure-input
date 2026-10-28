// One compatibility run of this plugin against one Paseo release, and the three parts of the Paseo compatibility
// workflow that decide what to test and report the outcome. Node.js built-ins only, plus the packages of the Paseo
// release under test, which it installs into a temporary prefix. CONTRIBUTING.md ("Paseo compatibility") describes it.
//
//   node scripts/paseo-compat.mjs <version> [--with-sdk] [--verbose] [--result <file>]
//   node scripts/paseo-compat.mjs resolve      (workflow) the versions to test: VERSIONS, or npm's latest and beta
//   node scripts/paseo-compat.mjs select       (workflow) leaves out the versions that passed for this commit
//   node scripts/paseo-compat.mjs report <dir> (workflow) opens, updates and closes the issues
//
// A run ends in pass, skip (the plugin does not claim the release), fail (the plugin does not work with it), or
// unverified (this check reached no verdict: the mock provider, a CLI option or a module it relies on is not what it
// was). It never reaches a daemon it did not start: every paseo command names the temporary home, the port is never
// 6767, and what it starts keeps only an allowlist of the environment, with a home directory of its own.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * What is particular to this plugin. Everything below it is the same for every plugin: the plugin's id and the Paseo
 * releases it claims come from `paseo-plugin.json`, the SDK packages step 2 replaces are its `@getpaseo/*`
 * dependencies in `package.json`, and the runners are the workflow's.
 */
export const PLUGIN = {
  /**
   * The module that defines the RPC contracts (`defineRpc`). It is bundled with the esbuild of the Paseo under test,
   * and every answer is parsed with the contract's own schema. `null` for a plugin without RPCs: step 4 is not run.
   */
  contracts: "shared/contracts.ts",
  /** Step 4: calls through the daemon, as the app makes them, by contract. A `refusal` is text the plugin's refusal must contain. */
  rpc: [
    { contract: "readDiagnostics", input: {} },
    { contract: "getRequest", input: { requestId: `r_${"0".repeat(32)}` }, refusal: "invalid_request: unknown request" },
  ],
  /** Step 5: an agent session and one turn through the plugin's hooks. `false` for a plugin that registers none: step 5 is not run. */
  hooks: true,
  /** Step 5, after the turn: a call whose answer says whether a hook failed, and the problems it names. `null` for none. */
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
  /** Variables beyond the allowlist of `childEnv` that the plugin's tests need in step 2. */
  env: [],
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The owner's own daemon listens here. Nothing this script starts or calls may use it. */
export const RESERVED_PORT = 6767;
/** A release number as npm publishes Paseo's: no `v`, no range, no build metadata, so no other npm spec gets through. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const DIST_TAGS = ["latest", "beta"];
/** One issue per version and kind: the plugin fails with the release, or this check could not reach a verdict on it. */
export const LABELS = { plugin: "paseo-compat", harness: "paseo-compat-harness" };
const STEP_NAMES = { 1: "range", 2: "sdk", 3: "daemon", 4: "rpc", 5: "hooks", 6: "cleanup" };
/** How many cache lookups the workflow's resolve job makes: one for each dist-tag. */
const LOOKUPS = DIST_TAGS.length;
/** The prompt of the mock agent's one turn. The mock provider streams the same synthetic turn for any text. */
const PROMPT = "paseo-compat: one turn through the plugin's hooks";
/** How long the event handlers get after the turn ended before the diagnostics are read: the daemon does not wait for them. */
const EVENT_GRACE_MS = 2_000;
/** How long a command that has exited may keep its output open through a process it left behind. */
const PIPE_GRACE_MS = 500;
/** How long the processes of a command that is asked to stop get before they are killed. */
const STOP_GRACE_MS = 2_000;
/** The signals that interrupt a run, which then cleans up. */
export const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// --------------------------------------------------------------------------------------------------------------------
// Outcomes
// --------------------------------------------------------------------------------------------------------------------

/** The plugin does not work with the release: a step fails. */
export class StepFailure extends Error {
  constructor(message, excerpt) {
    super(message);
    this.excerpt = excerpt;
  }
}

/**
 * This check reached no verdict: what failed is something the script relies on (the mock provider, a CLI option or
 * output, a module of the release, the network), not the plugin. It files no plugin issue and is never recorded as a pass.
 */
export class Unverified extends StepFailure {}

/** The plugin does not claim the release. */
export class Skip extends Error {}

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

/**
 * The variables a child keeps, by name: what finds programs and temporary files, the locale and the terminal, what CI,
 * a proxy or a private CA needs, and npm's own settings. Anything else stays behind: a provider's key or configuration
 * directory (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_*), an agent session's variables (PASEO_*), an SSH
 * agent, NODE_OPTIONS.
 */
const KEPT = /^(PATH|TMPDIR|TERM|CI|LANG|LANGUAGE|LC_[A-Z]+|GITHUB_[A-Z0-9_]+|RUNNER_[A-Z0-9_]+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|NPM_CONFIG_[A-Z0-9_]+)$/;
/** Of those, what no child gets: the job's token, and the files a step writes the job's environment and outputs to. */
const WITHHELD = new Set(["GITHUB_TOKEN", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"]);

function inside(path, directory) {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

/**
 * The environment of a process this script starts: the allowlisted variables of `env` and the plugin's own `keep`,
 * none whose value points into the owner's Paseo home (PATH keeps its other entries), and `set` on top, which is where
 * the home directory of a child comes from.
 */
export function childEnv(env, set = {}, { keep = PLUGIN.env, ownerHome = join(homedir(), ".paseo") } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || WITHHELD.has(key) || !(KEPT.test(key) || keep.includes(key))) continue;
    if (key === "PATH") result.PATH = value.split(delimiter).filter((entry) => !inside(entry, ownerHome)).join(delimiter);
    else if (!value.split(delimiter).some((part) => inside(part, ownerHome))) result[key] = value;
  }
  return { ...result, ...set };
}

/**
 * Throws unless a paseo command names `home` as its one `--home` and no `--host`, so that it cannot reach another
 * daemon. A refusal is a mistake of this script, never the plugin's.
 */
export function assertOwnHome(args, home) {
  const at = args.indexOf("--home");
  if (at === -1 || args[at + 1] !== home || args.lastIndexOf("--home") !== at) throw new Unverified(`refusing a paseo command that does not name the home ${home}: ${args.join(" ")}`);
  if (args.some((arg) => arg === "--host" || arg.startsWith("--host=") || arg.startsWith("--home="))) throw new Unverified(`refusing a paseo command with another target: ${args.join(" ")}`);
  return args;
}

/** Throws for the owner's port, and for anything that is not a TCP port. */
export function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  if (port === RESERVED_PORT) throw new Error(`refusing port ${RESERVED_PORT}: the owner's Paseo daemon listens there`);
  return port;
}

/** The address a daemon publishes, held to the one this run configured: loopback, never the owner's port. */
export function checkListen(published, expected) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(String(published));
  if (!match) throw new Unverified(`the daemon publishes ${published ?? "no address"}, not a loopback address`);
  if (Number(match[1]) === RESERVED_PORT) throw new Unverified(`refusing ${published}: the owner's Paseo daemon listens on port ${RESERVED_PORT}`);
  if (published !== expected) throw new Unverified(`the daemon publishes ${published}, not ${expected}`);
  return published;
}

/** The JSON a `paseo … --json` command printed, from its first line that opens an object or an array. */
export function jsonFrom(text) {
  const start = String(text).search(/^[[{]/m);
  if (start === -1) throw new Error("no JSON in the output");
  return JSON.parse(String(text).slice(start));
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

/** The error the Paseo CLI answers a command it ran with, `{ "error": { code, message } }`; undefined when it printed none. */
export function cliError(result) {
  for (const text of [result.stderr, result.stdout]) {
    let parsed;
    try {
      parsed = jsonFrom(text);
    } catch {
      continue;
    }
    const error = parsed?.error;
    if (error && typeof error === "object") return { code: error.code ?? null, message: oneLine(error.message ?? error.code ?? JSON.stringify(error)) };
  }
  return undefined;
}

/** What a failed command said, in one line: the CLI's error, npm's reason, or the last line it printed. */
export function failureOf(result) {
  const error = cliError(result);
  if (error) return error.message;
  const lines = plain(`${result.stderr}\n${result.stdout}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[[\]{}(),]+$/.test(line));
  // npm ends with where its log is; the line that says what went wrong comes before, after its code.
  const reason = lines.find((line) => /^npm (error|ERR!) /.test(line) && !/^npm (error|ERR!) (code |A complete log)/.test(line)) ?? lines.at(-1);
  if (result.timedOut) return `timed out${reason ? `: ${oneLine(reason)}` : ""}`;
  return reason ? oneLine(reason) : `exited ${result.code ?? result.signal}`;
}

/** The line of a test or typecheck output that names what failed first. */
export function firstProblem(output) {
  const lines = plain(output).split("\n");
  const found = lines.find((line) => /error TS\d+/.test(line)) ?? lines.find((line) => /^\s*FAIL\s/.test(line)) ?? lines.find((line) => /\bnpm (error|ERR!)/.test(line));
  return found ? oneLine(found) : undefined;
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

/** npm's error code (ETARGET, E404, …) in what it printed. */
function npmCode(result) {
  return /npm (?:error|ERR!) code (\S+)/.exec(plain(result.stderr))?.[1];
}

/** The refusal `assertPluginCompatibility` gives a release outside the range: the only outcome of it that is a skip. */
const OUT_OF_RANGE = /^Plugin ".+" requires Paseo .+\. Your (daemon|app) is .+\./;

/** Step 1's verdict, by the release's own `assertPluginCompatibility`, for the daemon and for the app. */
export function claimOf(assertPluginCompatibility, { id, requirements, version }) {
  for (const runtime of ["daemon", "app"]) {
    try {
      assertPluginCompatibility({ id, requirements, version, runtime });
    } catch (error) {
      const message = oneLine(error?.message ?? error);
      if (OUT_OF_RANGE.test(message)) return { status: "skip", detail: message };
      return { status: "fail", detail: `assertPluginCompatibility refused the manifest, not for the range: ${message}` };
    }
  }
  return { status: "pass", detail: `${requirements?.paseo} admits Paseo ${version} on the daemon and in the app` };
}

/**
 * The JSON a `paseo … --json` command printed. A command the CLI ran and that failed answers with its JSON error, which
 * becomes a `Failure` (the step decides whose failure that is). Anything else that is not JSON means that the CLI did not
 * run the command as this script asks it to (commander's "unknown option", a crash): this check is the one to fix.
 */
export function cliJson(result, what, Failure = Unverified) {
  if (result.code !== 0) {
    const error = cliError(result);
    if (!error) throw new Unverified(`${what} did not run as this script asks it to: ${failureOf(result)}`, excerptOf(result));
    throw new Failure(`${what}: ${error.message}`, excerptOf(result));
  }
  try {
    return jsonFrom(result.stdout);
  } catch {
    throw new Unverified(`${what} printed no JSON: ${oneLine(result.stdout || result.stderr)}`, excerptOf(result));
  }
}

function listOf(json, what) {
  if (!Array.isArray(json)) throw new Unverified(`${what} printed no list: ${oneLine(JSON.stringify(json))}`);
  return json;
}

/** `paseo daemon start --json`: the supervisor's pid and the address it published. */
export function startedDaemon(json) {
  if (!Number.isInteger(json?.pid) || typeof json?.listen !== "string") throw new Unverified(`paseo daemon start named no pid and address: ${oneLine(JSON.stringify(json))}`);
  return { pid: json.pid, listen: json.listen };
}

/** `paseo plugin ls --json`: the plugin's entry, or undefined while it is not listed. */
export function pluginEntry(json, id) {
  return listOf(json, "paseo plugin ls").find((entry) => entry?.id === id);
}

/** `paseo plugin logs --json`: "ready" once the daemon logged it, the daemon's failure message, or undefined for neither yet. */
export function loadState(json) {
  const entries = listOf(json, "paseo plugin logs");
  const failed = entries.find((entry) => /^\[paseo\] Plugin failed/.test(entry?.message ?? ""));
  if (failed) return { failed: oneLine(failed.message) };
  return entries.some((entry) => entry?.message === "[paseo] Plugin ready") ? "ready" : undefined;
}

/** `paseo plugin logs --json`: what the daemon logged when a lifecycle event of the plugin failed, or undefined. */
export function lifecycleFailure(json) {
  return listOf(json, "paseo plugin logs").find((entry) => /^Lifecycle hook \S+ failed/.test(entry?.message ?? ""))?.message;
}

/** `paseo provider ls --json`: whether the daemon has a provider of this id. */
export function hasProvider(json, id) {
  return listOf(json, "paseo provider ls").some((entry) => entry?.provider === id);
}

/** `paseo provider models mock --json`: the model the catalog says is for smoke checks, else its first one. */
export function smokeModel(json) {
  const models = listOf(json, "paseo provider models mock");
  const model = models.find((entry) => /smoke/i.test(entry?.description ?? "")) ?? models[0];
  if (typeof model?.id !== "string") throw new Unverified("the mock provider lists no model");
  return model.id;
}

/**
 * `paseo run --json`: the agent and how its turn ended. An error that names the plugin is the plugin's (the daemon
 * says "Plugin <id> before agent.session_open failed" when a hook's answer fails its schema); any other is this check's.
 */
export function runOutcome(result, pluginId) {
  if (result.code !== 0) {
    const error = cliError(result);
    if (!error) throw new Unverified(`paseo run did not run as this script asks it to: ${failureOf(result)}`, excerptOf(result));
    const named = new RegExp(`(^|[^\\w-])${pluginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(error.message);
    if (named) throw new StepFailure(`the agent was not created: ${error.message}`, excerptOf(result));
    throw new Unverified(`the agent was not created, for a reason that names no plugin: ${error.message}`, excerptOf(result));
  }
  let agent;
  try {
    agent = jsonFrom(result.stdout);
  } catch {
    agent = undefined;
  }
  if (typeof agent?.agentId !== "string" || typeof agent?.status !== "string") throw new Unverified(`paseo run named no agent: ${oneLine(result.stdout || result.stderr)}`, excerptOf(result));
  return { agentId: agent.agentId, status: agent.status };
}

/** `paseo ls --json`: whether the agent is listed. */
export function listsAgent(json, agentId) {
  return listOf(json, "paseo ls").some((entry) => entry?.id === agentId);
}

/** `paseo daemon stop --json`: whether the stop is confirmed (it exited 0), and what to say of it. */
export function stopOutcome(result) {
  if (result.code !== 0) return { confirmed: false, said: `paseo daemon stop: ${failureOf(result)}` };
  let action;
  try {
    action = jsonFrom(result.stdout)?.action;
  } catch {
    action = undefined;
  }
  return { confirmed: true, said: action === "stopped" ? "daemon stopped" : action === "not_running" ? "no daemon was running" : "paseo daemon stop exited 0" };
}

export function formatStep({ step, name, status, detail }) {
  return `${step} ${name.padEnd(7)} ${status.padEnd(4)} ${detail}`;
}

// --------------------------------------------------------------------------------------------------------------------
// Issues
// --------------------------------------------------------------------------------------------------------------------

export const TITLES = {
  plugin: (version) => `Paseo ${version} compatibility`,
  harness: (version) => `Paseo ${version} compatibility could not be checked`,
};

/** The hidden first line of an issue body: its kind, its version, and which runner ended so at which step. */
const MARKER = /^<!-- paseo-compat(?: kind=(plugin|harness))? version=(\S+) failing=(\S*) -->/;

function markerOf(body) {
  const match = MARKER.exec(body ?? "");
  return match ? { kind: match[1] ?? "plugin", version: match[2], signature: match[3] } : undefined;
}

/** The version an issue is about: its marker's, or its title's. */
function versionOfIssue(issue) {
  return markerOf(issue.body)?.version ?? /^Paseo (\S+) compatibility/.exec(issue.title ?? "")?.[1];
}

function signatureOf(legs, status) {
  return legs
    .filter((leg) => leg.status === status)
    .map((leg) => `${leg.runner}:${leg.failed?.step ?? "none"}`)
    .sort()
    .join(",");
}

/** Text for Markdown outside code: no HTML, no @-mention (a package scope such as `@getpaseo/cli` goes in a code span), no column break. */
export function markdownText(text, max = 300) {
  return oneLine(text, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/(^|[^\w`])(@[\w.-]+(?:\/[\w.-]+)?(?:@[\w.^~=*+-]+)?)/g, "$1`$2`")
    .replace(/\|/g, "\\|");
}

function legResult(leg) {
  if (leg.status === "pass") return "pass";
  if (leg.status === "skip") return `skip: ${markdownText(leg.failed?.detail ?? "not claimed")}`;
  const where = leg.failed?.step ? ` at step ${leg.failed.step} (${leg.failed.name})` : "";
  return `**${leg.status}**${where}: ${markdownText(leg.failed?.detail ?? "")}`;
}

/** The body of the issue of a version: `plugin` for a version the plugin fails with, `harness` for one this check could not judge. */
export function issueBody({ kind, plugin, version, legs, run }) {
  const status = kind === "plugin" ? "fail" : "unverified";
  const lead =
    kind === "plugin"
      ? `${plugin} failed its compatibility run against Paseo ${version} at ${run.sha.slice(0, 12)}.`
      : `The compatibility run of ${plugin} against Paseo ${version} at ${run.sha.slice(0, 12)} reached no verdict on a runner: what failed is the check itself (scripts/paseo-compat.mjs and what it relies on: the mock provider, the CLI, the network), not necessarily the plugin. No plugin issue was filed for it and no pass was recorded.`;
  const closes =
    kind === "plugin"
      ? "Each run that still fails updates this issue; the first run that passes on every runner closes it."
      : "Each run that still reaches no verdict updates this issue; the first run that reaches one on every runner closes it.";
  const lines = [
    `<!-- paseo-compat kind=${kind} version=${version} failing=${signatureOf(legs, status)} -->`,
    lead,
    "",
    "| Runner | Result |",
    "| --- | --- |",
    ...legs.map((leg) => `| ${leg.runner} | ${legResult(leg)} |`),
    "",
    `Run: ${run.url}`,
    "",
    `To reproduce: \`npm run test:paseo -- ${version}\` (steps 1 and 3 to 6; add \`--with-sdk\` for step 2). It uses a daemon of its own in a temporary home.`,
    "",
    `${closes} Once npm's \`latest\` and \`beta\` have both moved past a pre-release, a scheduled run closes its issue, since it tests that release no more.`,
  ];
  for (const leg of legs.filter((entry) => entry.status === status && entry.excerpt)) {
    lines.push("", `<details><summary>${leg.runner}: output of the step</summary>`, "", "~~~", leg.excerpt.replace(/~~~/g, "~ ~ ~"), "~~~", "", "</details>");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What a report does, from the results of the runners and the open issues (each with the `kind` of the label it was
 * found under). Per version: the plugin's issue is opened or updated while a runner fails and closed once every runner
 * passes; the check's issue is opened or updated while a runner reaches no verdict (a runner without a result among
 * them) and closed once every runner reaches one. An update comments only when what ends so has changed. The issues of
 * pre-releases that npm's dist-tags (`heads`) have moved past are closed, and the versions that passed on every
 * runner are the ones to record.
 */
export function planReport({ plugin, versions, runners, results, openIssues, run, heads = [] }) {
  const verdicts = versions.map((version) => {
    const legs = runners.map((runner) => {
      const result = results.find((entry) => entry.version === version && entry.runner === runner);
      if (result) return { runner, status: result.status, failed: result.failed ?? null, excerpt: result.excerpt };
      return { runner, status: "unverified", failed: { step: null, name: "result", detail: "no result: the job ended before the compatibility script wrote one (cancelled, timed out or crashed); see the run" } };
    });
    const status = legs.some((leg) => leg.status === "fail") ? "fail" : legs.some((leg) => leg.status === "unverified") ? "unverified" : legs.every((leg) => leg.status === "pass") ? "pass" : "skip";
    return { version, status, legs };
  });
  const issueOf = (kind, version) =>
    openIssues.find((issue) => issue.kind === kind && (issue.title === TITLES[kind](version) || (markerOf(issue.body)?.kind === kind && markerOf(issue.body)?.version === version)));
  const actions = [];
  const keep = (kind, version, legs, open, close) => {
    const issue = issueOf(kind, version);
    const status = kind === "plugin" ? "fail" : "unverified";
    if (open) {
      const body = issueBody({ kind, plugin, version, legs, run });
      if (!issue) {
        actions.push({ kind: "create", issueKind: kind, version, title: TITLES[kind](version), label: LABELS[kind], body });
        return;
      }
      const changed = markerOf(issue.body)?.signature !== signatureOf(legs, status);
      const comment = changed ? `What ends so has changed, in ${run.url}:\n\n${legs.map((leg) => `- ${leg.runner}: ${legResult(leg)}`).join("\n")}\n` : undefined;
      actions.push({ kind: "update", issueKind: kind, version, number: issue.number, body, ...(comment ? { comment } : {}) });
    } else if (close && issue) {
      const comment =
        kind === "plugin"
          ? `Paseo ${version} passed on ${runners.join(" and ")} in ${run.url} at ${run.sha.slice(0, 12)}.\n`
          : `The run of Paseo ${version} in ${run.url} reached a verdict on ${runners.join(" and ")}.\n`;
      actions.push({ kind: "close", issueKind: kind, version, number: issue.number, reason: "completed", comment });
    }
  };
  for (const { version, status, legs } of verdicts) {
    keep("plugin", version, legs, legs.some((leg) => leg.status === "fail"), status === "pass");
    keep("harness", version, legs, legs.some((leg) => leg.status === "unverified"), !legs.some((leg) => leg.status === "unverified"));
  }
  if (heads.length) {
    for (const issue of openIssues) {
      const version = versionOfIssue(issue);
      if (!version?.includes("-") || heads.includes(version) || versions.includes(version)) continue;
      const comment = `Paseo ${version} is a pre-release that npm's \`latest\` and \`beta\` of the CLI have moved past (now ${heads.join(" and ")}), so no scheduled run tests it again. To test it anyway, run the workflow with the version ${version}.\n`;
      actions.push({ kind: "close", issueKind: issue.kind, version, number: issue.number, reason: "not planned", comment });
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

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Gone already.
    }
  }
}

/** Stops every command under way, with what each of them started: asked first, killed after `STOP_GRACE_MS`. */
export function stopChildren(signal = "SIGTERM") {
  for (const child of state.children) {
    signalGroup(child, signal);
    setTimeout(() => signalGroup(child, "SIGKILL"), STOP_GRACE_MS);
  }
}

/**
 * Runs a program without a shell, in a process group of its own, so that a timeout or an interruption stops what it
 * started as well. Output is kept (its last 8 MiB) and echoed with `--verbose`; stdin is /dev/null. It settles once
 * the program has exited: a process it left behind with its output open is let go of after `PIPE_GRACE_MS`. Once the
 * run is interrupted nothing new starts, but for the cleanup's own commands (`always`).
 */
export function run(command, args, { cwd = ROOT, env, timeoutMs = 120_000, echo = state.verbose, always = false } = {}) {
  return new Promise((resolvePromise) => {
    if (state.interrupted && !always) {
      resolvePromise({ code: null, signal: state.interrupted, stdout: "", stderr: "interrupted", timedOut: false });
      return;
    }
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
      signalGroup(child, "SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      output.stderr += `\n${command}: ${error.message}`;
      // A program that could not be started emits no exit.
      if (child.pid === undefined) settle(null, null);
    });
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(code, signal);
      }, PIPE_GRACE_MS);
    });
    child.on("close", (code, signal) => settle(code, signal));
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
    if (Date.now() >= until) throw new StepFailure(`no ${what} after ${Math.round(timeoutMs / 1000)} s`);
    await sleep(500);
  }
}

/** Where npm keeps its cache: the developer's, so that a child's home directory of its own costs no download. */
function npmCache(env = process.env) {
  return env.NPM_CONFIG_CACHE ?? env.npm_config_cache ?? join(homedir(), ".npm");
}

/**
 * The npm and paseo commands of one run. Each gets the allowlisted environment and `ctx.userHome` as its home
 * directory, so that whatever a release or a test writes under `~` (agent skills, provider settings) lands in the
 * temporary directory; npm keeps the developer's cache. A paseo command must name the temporary home.
 */
export function processes(ctx) {
  // `env node` in the CLI's shebang, and npm, are the Node.js this script runs on.
  const path = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
  const base = childEnv({ ...process.env, PATH: path }, { HOME: ctx.userHome });
  return {
    npm: (args, options = {}) => run("npm", args, { ...options, env: { ...base, NPM_CONFIG_CACHE: npmCache(), ...options.env } }),
    paseo: (args, options = {}) => {
      assertOwnHome(args, ctx.home);
      return run(join(ctx.prefix, "node_modules", ".bin", "paseo"), args, { ...options, cwd: ctx.temp, env: { ...base, ...options.env } });
    },
  };
}

/** A paseo command's JSON; a JSON error of the CLI becomes a `failure` (by default this check's, not the plugin's). */
async function paseoJson(ctx, args, { failure = Unverified, ...options } = {}) {
  const what = `paseo ${args.slice(0, args[0] === "daemon" || args[0] === "plugin" || args[0] === "provider" || args[0] === "agent" ? 2 : 1).join(" ")}`;
  return cliJson(await ctx.proc.paseo([...args, "--home", ctx.home, "--json"], options), what, failure);
}

/** Imports a package as the temporary prefix resolves it, or as `from`, a package in it, resolves it. */
async function importFrom(prefix, name, from) {
  try {
    let require = createRequire(join(prefix, "package.json"));
    if (from) require = createRequire(require.resolve(from));
    return await import(pathToFileURL(require.resolve(name)).href);
  } catch (error) {
    throw new Unverified(`${name}${from ? ` (as ${from} resolves it)` : ""} could not be loaded: ${oneLine(error?.message ?? error)}`);
  }
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
  throw new Unverified("the system offered no free port but the owner's");
}

// --------------------------------------------------------------------------------------------------------------------
// The steps of one run
// --------------------------------------------------------------------------------------------------------------------

/** Step 1, also the resolve job's: whether the plugin claims `version`, by that release's own rule. */
async function claim(ctx, version, prefix) {
  const install = await ctx.proc.npm(["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", `@getpaseo/protocol@${version}`], { timeoutMs: 300_000 });
  if (install.code !== 0) throw new Unverified(`npm could not install @getpaseo/protocol@${version}: ${failureOf(install)}`, excerptOf(install));
  const { assertPluginCompatibility } = await importFrom(prefix, "@getpaseo/protocol/plugin-requirements");
  if (typeof assertPluginCompatibility !== "function") throw new Unverified(`@getpaseo/protocol@${version} has no assertPluginCompatibility`);
  const verdict = claimOf(assertPluginCompatibility, { id: ctx.manifest.id, requirements: ctx.manifest.requirements, version });
  if (verdict.status === "skip") throw new Skip(verdict.detail);
  if (verdict.status === "fail") throw new StepFailure(verdict.detail);
  return `${verdict.detail}, by @getpaseo/protocol@${version}`;
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
  if (install.code !== 0) {
    // A package the plugin depends on that the release does not publish is the plugin's to deal with; anything else is npm's.
    const Failure = ["ETARGET", "E404"].includes(npmCode(install)) ? StepFailure : Unverified;
    throw new Failure(`npm could not install the SDK of ${ctx.version}: ${failureOf(install)}`, excerptOf(install));
  }
  const stray = packages.filter(({ name }) => installedVersion(ROOT, name) !== ctx.version);
  if (stray.length) throw new Unverified(`npm installed ${stray.map(({ name }) => `${name}@${installedVersion(ROOT, name)}`).join(", ")}, not ${ctx.version}`);
  const failures = [];
  let excerpt;
  for (const script of ["typecheck", "test"]) {
    // tests/mirrored-constants.test.ts holds the RPC limit to the installed protocol and relay, at this version.
    const result = await ctx.proc.npm(["run", script], { timeoutMs: 900_000, env: { PASEO_COMPAT_SDK: ctx.version } });
    if (result.code === 0) continue;
    const problem = firstProblem(`${result.stdout}\n${result.stderr}`);
    failures.push(`npm run ${script} ${result.timedOut ? "timed out" : `exited ${result.code ?? result.signal}`}${problem ? `: ${problem}` : ""}`);
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
  if (install.code !== 0) throw new Unverified(`npm could not install @getpaseo/cli@${ctx.version}: ${failureOf(install)}`, excerptOf(install));
  for (const name of ["@getpaseo/cli", "@getpaseo/server", "@getpaseo/client"]) {
    const found = installedVersion(ctx.prefix, name);
    if (found !== ctx.version) throw new Unverified(`the prefix has ${name}@${found}, not ${ctx.version}`);
  }

  ctx.listen = `127.0.0.1:${await freePort()}`;
  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  // All before the first start. The skills selection keeps a fresh home of 0.14 from rewriting the Paseo skills under
  // ~/.agents and ~/.claude (the temporary home directory's, besides). `daemon start` drops PASEO_DICTATION_ENABLED
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
  const started = startedDaemon(
    await paseoJson(ctx, ["daemon", "start", "--timeout", "150"], { timeoutMs: 180_000, env: { PASEO_NODE_ENV: "development", PASEO_DICTATION_ENABLED: "false" } }),
  );
  ctx.daemonPid = started.pid;
  checkListen(started.listen, ctx.listen);

  // The install is where the daemon first compiles and loads the plugin: what fails there is the plugin's.
  // Trusting a plugin asks nothing when stdin is not a terminal; stdin is /dev/null.
  await paseoJson(ctx, ["plugin", "install", ROOT], { timeoutMs: 300_000, failure: StepFailure });
  const id = ctx.manifest.id;
  const entry = await waitFor(`${id} running`, 60_000, async () => {
    const plugin = pluginEntry(await paseoJson(ctx, ["plugin", "ls"]), id);
    if (plugin?.status === "failed") throw new StepFailure(`${id} failed to start: ${oneLine(plugin.error ?? "no reason given")}`);
    return plugin?.status === "running" ? plugin : undefined;
  });
  await waitFor(`"Plugin ready" in the plugin's log`, 30_000, async () => {
    const loaded = loadState(await paseoJson(ctx, ["plugin", "logs", id]));
    if (loaded?.failed) throw new StepFailure(loaded.failed);
    return loaded;
  });
  return [`@getpaseo/cli ${ctx.version} on ${ctx.listen}; ${id} ${entry.status}, "Plugin ready" in its log`, ...notes].join("; ");
}

/** The client of `version`, connected to the daemon this run started and to no other. */
async function connect(ctx) {
  const { createHostClient } = await importFrom(ctx.prefix, "@getpaseo/client/node");
  const control = await importFrom(ctx.prefix, "@getpaseo/server/daemon-control");
  if (typeof createHostClient !== "function" || typeof control.readDaemonInstance !== "function" || typeof control.readLocalCredentialForTarget !== "function") {
    throw new Unverified("the client or daemon-control of this release lacks createHostClient, readDaemonInstance or readLocalCredentialForTarget");
  }
  const listen = checkListen((await control.readDaemonInstance(ctx.home))?.listen, ctx.listen);
  const client = createHostClient(listen, {
    clientId: `paseo-compat-${randomUUID()}`,
    clientType: "cli",
    appVersion: ctx.version,
    localCredential: () => control.readLocalCredentialForTarget(ctx.home, listen) ?? undefined,
    reconnect: { enabled: false },
  });
  ctx.opened = client;
  try {
    await client.connect();
  } catch (error) {
    throw new Unverified(`the client of ${ctx.version} could not connect to ${listen}: ${oneLine(error?.message ?? error)}`);
  }
  ctx.client = client;
  return client;
}

/** The plugin's contracts, bundled from this checkout with the esbuild the Paseo under test compiles plugins with. */
async function loadContracts(ctx) {
  const esbuild = await importFrom(ctx.prefix, "esbuild", "@getpaseo/server");
  try {
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
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Unverified(`${PLUGIN.contracts} could not be bundled for the check: ${oneLine(error?.message ?? error)}`);
  }
}

function contractOf(ctx, name) {
  const contract = ctx.contracts[name];
  if (!contract?.name || !contract.input || !contract.output) throw new Unverified(`${PLUGIN.contracts} has no RPC contract ${name}`);
  return contract;
}

function inputOf(contract, input) {
  try {
    return contract.input.parse(input);
  } catch (error) {
    throw new Unverified(`PLUGIN's input for ${contract.name} does not fit its contract: ${oneLine(error?.message ?? error)}`);
  }
}

/** Calls a contract through the daemon and parses the answer with the contract's own output schema. */
async function call(ctx, name, input) {
  const contract = contractOf(ctx, name);
  const answer = await ctx.client.invokePluginRpc(ctx.manifest.id, contract.name, inputOf(contract, input));
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
      await ctx.client.invokePluginRpc(ctx.manifest.id, contract.name, inputOf(contract, entry.input));
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
  if (!hasProvider(await paseoJson(ctx, ["provider", "ls"]), "mock")) {
    throw new Unverified("the daemon has no mock provider (a development daemon's, PASEO_NODE_ENV=development): no agent session can be opened without a key");
  }
  const model = smokeModel(await paseoJson(ctx, ["provider", "models", "mock"]));
  mkdirSync(ctx.work, { recursive: true });
  const agent = runOutcome(
    await ctx.proc.paseo(["run", "--home", ctx.home, "--json", "--provider", `mock/${model}`, "--cwd", ctx.work, "--title", "paseo-compat", "--wait-timeout", "90s", PROMPT], { timeoutMs: 180_000 }),
    id,
  );
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
    throw new Unverified(`the mock agent's turn ended with status ${turn}`);
  }

  await sleep(EVENT_GRACE_MS);
  if (!listsAgent(await paseoJson(ctx, ["ls", "--all", "--global"]), agent.agentId)) throw new Unverified(`agent ${agent.agentId} is not listed after its turn`);
  const failure = lifecycleFailure(await paseoJson(ctx, ["plugin", "logs", id]));
  if (failure) throw new StepFailure(`the daemon logged: ${oneLine(failure)}`);
  const plugin = pluginEntry(await paseoJson(ctx, ["plugin", "ls"]), id);
  if (plugin?.status !== "running") throw new StepFailure(`${id} is ${plugin?.status ?? "gone"} after the turn${plugin?.error ? `: ${oneLine(plugin.error)}` : ""}`);
  if (PLUGIN.diagnostics && ctx.client) {
    const problems = PLUGIN.diagnostics.problems(await call(ctx, PLUGIN.diagnostics.contract, PLUGIN.diagnostics.input));
    if (problems.length) throw new StepFailure(`diagnostics after the turn: ${problems.join("; ")}`);
  }
  return `mock/${model} agent ${agent.agentId.slice(0, 7)}: session opened, turn ${turn}, agent listed${PLUGIN.diagnostics && ctx.client ? `; diagnostics: ${PLUGIN.diagnostics.summary}` : ""}`;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The daemon of the run stopped: by `paseo daemon stop`, and when that cannot confirm it, by killing its process group. */
async function stopDaemon(ctx) {
  let stop = { confirmed: false, said: "" };
  if (existsSync(join(ctx.home, "config.json")) && existsSync(join(ctx.prefix, "node_modules", ".bin", "paseo"))) {
    stop = stopOutcome(await ctx.proc.paseo(["daemon", "stop", "--home", ctx.home, "--json", "--force", "--timeout", "20", "--kill-timeout", "5"], { timeoutMs: 60_000, always: true }));
    if (stop.confirmed) return stop.said;
  }
  // The supervisor leads a process group of its own (it was started detached), which holds its worker and the
  // plugin's process. Only a stop that was not confirmed gets here, so a pid reused since is never hit.
  let pid = ctx.daemonPid;
  try {
    pid ??= JSON.parse(readFileSync(join(ctx.home, "paseo.pid"), "utf8")).pid;
  } catch {
    // No lock: no daemon was started.
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    if (stop.said) throw new Error(stop.said);
    return undefined;
  }
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
  if (processAlive(pid)) throw new Error(`${stop.said ? `${stop.said}; ` : ""}daemon pid ${pid} is still running`);
  return `daemon pid ${pid} not running${stop.said ? ` (${stop.said})` : ""}`;
}

/** The SDK of the checkout put back to what its lock file installs, after step 2. */
async function restoreSdk(ctx) {
  if (!ctx.sdkReplaced) return undefined;
  const unlocked = ctx.sdkReplaced.filter(({ locked }) => !locked);
  if (unlocked.length) throw new Error(`package-lock.json has no ${unlocked.map(({ name }) => name).join(", ")}: run npm ci`);
  const restore = await ctx.proc.npm(["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", ...ctx.sdkReplaced.map(({ name, locked }) => `${name}@${locked}`)], {
    timeoutMs: 300_000,
    echo: false,
    always: true,
  });
  const stray = ctx.sdkReplaced.filter(({ name, locked }) => installedVersion(ROOT, name) !== locked);
  if (restore.code !== 0 || stray.length) throw new Error(`node_modules keeps the SDK of ${ctx.version}, run npm ci: ${failureOf(restore)}`);
  return "pinned SDK restored";
}

/** Step 6: the client closed, the daemon stopped, the SDK of the checkout restored, the temporary directory removed. Each part runs whatever the others did. */
async function cleanup(ctx) {
  state.cleaning = true;
  const done = [];
  const problems = [];
  const part = async (name, body) => {
    try {
      const said = await body();
      if (said) done.push(said);
    } catch (error) {
      problems.push(`${name}: ${oneLine(error?.message ?? error)}`);
    }
  };
  await part("client", () => ctx.opened?.close());
  await part("daemon", () => stopDaemon(ctx));
  await part("sdk", () => restoreSdk(ctx));
  await part("temporary files", () => {
    rmSync(ctx.temp, { recursive: true, force: true, maxRetries: 3 });
    if (existsSync(ctx.temp)) throw new Error(`${ctx.temp} is still there`);
    return "temporary files removed";
  });
  if (problems.length) throw new Unverified([...problems, ...done].join("; "));
  return done.join(", ");
}

/** Prints and records one step. A step that throws is a failure, an unverified step, or a skip. */
async function step(ctx, number, body) {
  const record = { step: number, name: STEP_NAMES[number], status: "pass", detail: "" };
  try {
    record.detail = await body();
  } catch (error) {
    if (error instanceof Skip) record.status = "skip";
    else {
      record.status = error instanceof Unverified ? "unverified" : "fail";
      if (error?.excerpt) record.excerpt = error.excerpt;
    }
    record.detail = state.interrupted && !(error instanceof Skip) ? `interrupted by ${state.interrupted}: ${oneLine(error?.message ?? error)}` : oneLine(error?.message ?? String(error), 1000);
  }
  ctx.steps.push(record);
  console.log(formatStep(record));
  if (record.status !== "pass" && record.status !== "skip" && record.excerpt && !state.verbose) console.log(record.excerpt.replace(/^/gm, "    | "));
  return record.status === "pass";
}

function notRun(ctx, number, why) {
  const record = { step: number, name: STEP_NAMES[number], status: "skip", detail: `not run: ${why}` };
  ctx.steps.push(record);
  console.log(formatStep(record));
}

/** The outcome of a run from its steps: a failure is the plugin's, an unverified step makes no verdict, a refused claim is a skip. */
export function outcomeOf(steps) {
  const failed = steps.find((entry) => entry.status === "fail");
  const unverified = steps.find((entry) => entry.status === "unverified");
  if (failed) return { status: "fail", failed };
  if (unverified) return { status: "unverified", failed: unverified };
  if (steps[0]?.status === "skip") return { status: "skip", failed: steps[0] };
  return { status: "pass", failed: null };
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
  mkdirSync(ctx.userHome, { recursive: true, mode: 0o700 });
  ctx.proc = processes(ctx);
  const started = Date.now();
  console.log(`paseo-compat: ${ctx.manifest.id} against Paseo ${version} (Node.js ${process.version}, ${process.platform} ${process.arch}), in ${temp}`);
  try {
    if (inside(temp, join(homedir(), ".paseo"))) throw new Error(`refusing ${temp}: it is inside the owner's Paseo home`);
    if (await step(ctx, 1, () => claim(ctx, version, ctx.prefix))) {
      if (withSdk) await step(ctx, 2, () => sdk(ctx));
      if (await step(ctx, 3, () => daemon(ctx))) {
        if (PLUGIN.contracts) await step(ctx, 4, () => rpc(ctx));
        else notRun(ctx, 4, "the plugin has no RPC contracts (PLUGIN.contracts)");
        if (!PLUGIN.hooks) notRun(ctx, 5, "the plugin registers no hook (PLUGIN.hooks)");
        else if (PLUGIN.contracts && PLUGIN.diagnostics && !ctx.client) notRun(ctx, 5, "its diagnostics need the client of step 4");
        else await step(ctx, 5, () => hooks(ctx));
      } else {
        notRun(ctx, 4, "the daemon or the plugin did not start");
        notRun(ctx, 5, "the daemon or the plugin did not start");
      }
    }
  } finally {
    await step(ctx, 6, () => cleanup(ctx));
  }
  const { status, failed } = outcomeOf(ctx.steps);
  const seconds = Math.round((Date.now() - started) / 1000);
  const summary =
    state.interrupted ? `INTERRUPTED ${ctx.manifest.id} on Paseo ${version} by ${state.interrupted}${failed ? ` in step ${failed.step} (${failed.name})` : ""}; cleaned up` :
    status === "pass" ? `PASS ${ctx.manifest.id} on Paseo ${version} (${seconds} s)` :
    status === "skip" ? `SKIP ${ctx.manifest.id} on Paseo ${version}: the plugin does not claim this release` :
    status === "fail" ? `FAIL ${ctx.manifest.id} on Paseo ${version} at step ${failed.step} (${failed.name}) (${seconds} s)` :
    `UNVERIFIED ${ctx.manifest.id} on Paseo ${version}: the check itself failed at step ${failed.step} (${failed.name}), so there is no verdict on the plugin (${seconds} s)`;
  console.log(summary);
  return {
    plugin: ctx.manifest.id,
    version,
    runner: process.env.PASEO_COMPAT_RUNNER || `${process.platform}-${process.arch}`,
    status,
    failed: failed ? { step: failed.step, name: failed.name, detail: failed.detail } : null,
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

/** The resolve job: the versions to test, those the plugin does not claim, npm's dist-tag heads, and the cache keys to look up. */
async function resolveCommand(env) {
  const temp = mkdtempSync(join(tmpdir(), "paseo-compat-resolve-"));
  const ctx = { manifest: JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")), userHome: join(temp, "user") };
  mkdirSync(ctx.userHome, { recursive: true, mode: 0o700 });
  ctx.proc = processes(ctx);
  const claimed = [];
  const skipped = [];
  let fromTags;
  let heads = [];
  try {
    let distTags;
    if (!parseVersions(env.VERSIONS).length) {
      const view = await ctx.proc.npm(["view", "@getpaseo/cli", "dist-tags", "--json"], { timeoutMs: 60_000 });
      if (view.code !== 0) throw new Error(`npm view @getpaseo/cli dist-tags: ${failureOf(view)}`);
      distTags = JSON.parse(view.stdout);
    }
    const found = candidates({ distTags, input: env.VERSIONS });
    fromTags = found.fromTags;
    if (fromTags) heads = found.versions.map(({ version }) => version);
    for (const [index, { version, tags }] of found.versions.entries()) {
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
  setOutputs({ versions: claimed, skipped, heads, runners: runnersOf(env), ...Object.fromEntries([...Array(LOOKUPS).keys()].map((index) => [`key${index}`, keys[index] ?? ""])) });
  summarize(
    [
      `### Paseo versions${fromTags ? ` on npm (${DIST_TAGS.join(", ")} of @getpaseo/cli)` : " asked for"}`,
      "",
      "| Version | Claimed by paseo-plugin.json |",
      "| --- | --- |",
      ...claimed.map((version) => `| ${version} | yes |`),
      ...skipped.map(({ version, reason }) => `| ${version} | no, skipped: ${markdownText(reason)} |`),
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

/** `gh` with the job's token and repository; it talks to GitHub only, so it keeps the real home directory for a local login. */
function gh(args) {
  const set = { HOME: homedir() };
  for (const key of ["GH_TOKEN", "GH_REPO", "GH_HOST"]) if (process.env[key]) set[key] = process.env[key];
  return run("gh", args, { env: childEnv(process.env, set), timeoutMs: 60_000, echo: false });
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
  const run = { url: env.RUN_URL ?? "(no run)", sha: env.GITHUB_SHA ?? "0000000" };
  const versions = JSON.parse(env.VERSIONS ?? "[]");
  const heads = JSON.parse(env.HEADS || "[]");
  const listIssues = async (kind) =>
    JSON.parse(await ghOrThrow(["issue", "list", "--label", LABELS[kind], "--state", "open", "--limit", "200", "--json", "number,title,body"])).map((issue) => ({ ...issue, kind }));
  const openIssues = env.ISSUES_FILE ? JSON.parse(readFileSync(env.ISSUES_FILE, "utf8")) : [...(await listIssues("plugin")), ...(await listIssues("harness"))];
  const plan = planReport({ plugin: manifest.id, versions, runners: runnersOf(env), results: readResults(directory), openIssues, run, heads });
  for (const { version, status, legs } of plan.verdicts) console.log(`${version}: ${status} (${legs.map((leg) => `${leg.runner} ${leg.status}`).join(", ")})`);

  const done = [];
  if (!dryRun) {
    const needed = [...new Set(plan.actions.filter((action) => action.kind === "create").map((action) => action.label))];
    if (needed.length) {
      const labels = JSON.parse(await ghOrThrow(["label", "list", "--limit", "500", "--json", "name"]));
      const about = { [LABELS.plugin]: "A Paseo release this plugin fails with (Paseo compatibility workflow)", [LABELS.harness]: "A Paseo release the compatibility check could not judge (Paseo compatibility workflow)" };
      for (const label of needed) if (!labels.some((entry) => entry.name === label)) await ghOrThrow(["label", "create", label, "--color", label === LABELS.plugin ? "B60205" : "FBCA04", "--description", about[label]]);
    }
  }
  const temp = mkdtempSync(join(tmpdir(), "paseo-compat-report-"));
  try {
    const bodyFile = (name, text) => {
      const file = join(temp, name);
      writeFileSync(file, text);
      return file;
    };
    for (const action of plan.actions) {
      const name = `${action.issueKind}-${action.version}`;
      const commands = [];
      if (action.kind === "create") commands.push(["issue", "create", "--title", action.title, "--label", action.label, "--body-file", bodyFile(`${name}.md`, action.body)]);
      if (action.kind === "update") {
        commands.push(["issue", "edit", String(action.number), "--body-file", bodyFile(`${name}.md`, action.body)]);
        if (action.comment) commands.push(["issue", "comment", String(action.number), "--body-file", bodyFile(`${name}-comment.md`, action.comment)]);
      }
      if (action.kind === "close") commands.push(["issue", "close", String(action.number), "--reason", action.reason, "--comment", action.comment]);
      for (const args of commands) {
        if (dryRun) console.log(`dry run: gh ${args.map((arg) => (arg.startsWith(temp) ? `<${arg.slice(temp.length + 1)}>` : JSON.stringify(arg))).join(" ")}`);
        else {
          const out = (await ghOrThrow(args)).trim();
          if (out) console.log(out);
        }
      }
      if (dryRun && action.body) console.log(action.body.replace(/^/gm, "    | "));
      done.push(`${action.kind} ${action.number ? `#${action.number} ` : ""}(${action.issueKind}, Paseo ${action.version})${dryRun ? ", dry run" : ""}`);
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

/** The exit code of a run: 0 for a pass or a skip, 1 for a failure of the plugin, 3 when the check reached no verdict. */
export const EXIT = { pass: 0, skip: 0, fail: 1, unverified: 3, interrupted: 130 };

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
  // The first signal stops what runs (each command in its own process group, with what it started) and goes on to the
  // cleanup, which is bounded by its own timeouts. A signal during the cleanup cannot cut it short: a daemon left
  // running is what this script must never leave behind.
  const interrupt = (signal) => {
    if (state.finished) return;
    if (state.interrupted || state.cleaning) {
      console.log(`${signal}: cleaning up, the daemon is stopped and the temporary files removed before this exits`);
      return;
    }
    state.interrupted = signal;
    console.log(`\n${signal}: stopping what runs, then cleaning up`);
    stopChildren("SIGTERM");
  };
  for (const signal of SIGNALS) process.on(signal, interrupt);
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
    const annotation = { fail: "error", unverified: "warning" }[result.status];
    if (annotation) console.log(`::${annotation} title=Paseo ${result.version} on ${result.runner}::${result.status} at step ${result.failed.step} (${result.failed.name}): ${result.failed.detail.replace(/%/g, "%25")}`);
  }
  if (state.interrupted) return EXIT.interrupted;
  return EXIT[result.status];
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
