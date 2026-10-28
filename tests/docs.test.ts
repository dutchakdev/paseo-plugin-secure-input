import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// The parser of TypeScript 5: TypeScript 7, which type-checks the project, has no stable JavaScript API.
import ts from "typescript-5";
import { describe, expect, it } from "vitest";
import { addRow, type FormRow, type FormState } from "../client/form-state";
import { continuationText, shellPath, tamperText } from "../server/core/continuation";
import { FLUSH_BUDGET_MS, MAX_OUTBOX_AGE_MS, MAX_OUTBOX_ITEMS, OUTBOX_CLOCK_SKEW_MS, PORT_FLOOR_MS, PORT_TIMEOUT_MS } from "../server/core/outbox";
import { ADMISSION_WAIT_MS, DROP_SWEEP_BOUND_MS, HISTORY, MAX_RETRIES, SHUTDOWN_BOUND_MS, TTL_MS, requestDigestOf } from "../server/core/registry";
import { EXPIRED_BY, MAX_REQUESTS_BYTES, RELEASED_BY, parseRecord, type RequestRecord } from "../server/core/registry-store";
import { DIRECTORY_MODE, DROP_MAX_DEPTH, FILE_MODE, filePath } from "../server/io/drop";
import { EXPIRY_INTERVAL_MS, PASEO_STOP_WINDOW_MS, STARTUP_WAIT_MS } from "../server/paseo/plugin";
import { MAX_UNSETTLED_APPENDS, SLOW_RETRY_TICKS } from "../server/paseo/runtime";
import { TOOL_NAMES } from "../server/paseo/tools";
import { ERROR_CODES } from "../shared/errors";
import { DROP_TTL_MS, LIMITS } from "../shared/limits";
import { InputRequestSchema, REQUEST_STATES, type InputRequest, type RequestState } from "../shared/request";
import { PAD_BLOCK } from "../shared/seal";
import { tempDir } from "./helpers";

// ---------------------------------------------------------------------------------------------------------------
// The documents are read from disk and held to the code. A failure here is drift between a document and the code,
// not a leak: it means that either a document or the code must change. (The leak search is `canary.test.ts`.)
// ---------------------------------------------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");
const SKILL = "skills/secure-input/SKILL.md";
const README = "README.md";
const SECURITY = "SECURITY.md";
/** The listing text of the Paseo plugin directory, which the package ships. */
const OVERVIEW = "OVERVIEW.md";
const DOCUMENTS = [SKILL, README, SECURITY, OVERVIEW] as const;
/** Documents read for their links and tool names only: a changelog says what was true of a release, and CONTRIBUTING.md's claims of the release flow are reviewed by hand. */
const NOTES = ["CHANGELOG.md", "CONTRIBUTING.md"] as const;
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, each space a hyphen. */
const slugOf = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** The headings of a Markdown file, outside its fenced blocks: each with its level, its anchor and where it stands. */
function headingsOf(file: string): Array<{ level: number; slug: string; at: number }> {
  const found: Array<{ level: number; slug: string; at: number }> = [];
  let fenced = false;
  let at = 0;
  for (const line of read(file).split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (heading) found.push({ level: (heading[1] as string).length, slug: slugOf(heading[2] as string), at });
    at += line.length + 1;
  }
  return found;
}

/** The text of a file under the heading with this anchor, up to the next heading of the same level or above. */
function sectionOf(file: string, slug: string): string {
  const headings = headingsOf(file);
  const index = headings.findIndex((heading) => heading.slug === slug);
  if (index === -1) throw new Error(`${file} has no heading #${slug}`);
  const { level, at } = headings[index] as { level: number; at: number };
  const next = headings.slice(index + 1).find((heading) => heading.level <= level);
  return read(file).slice(at, next?.at);
}

/** Every code span of a text, as written between its backticks. */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((span) => span[1] as string);

/**
 * The rows of the first table under a heading. The table must belong to that heading: no other heading may stand
 * between the two, or a table further down would be read in its place.
 */
function tableUnder(file: string, heading: string): string[] {
  const text = read(file);
  const at = text.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`${file} has no heading "${heading}"`);
  const lines = text.slice(at + 1).split("\n");
  const start = lines.findIndex((line) => line.startsWith("|"));
  if (start === -1 || lines.slice(1, start).some((line) => line.startsWith("#"))) throw new Error(`${file} has no table under "${heading}"`);
  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(line);
  }
  return rows;
}

function jsonExamples(file: string): unknown[] {
  return [...read(file).matchAll(/```json\n([\s\S]*?)\n```/g)].map((block) => JSON.parse(block[1] as string));
}

/**
 * Every string a module spells, read from its syntax tree: string literals, the fixed parts of template literals, and
 * JSX text. A comment is not a string, so a word that only a comment still says is no word of the module.
 */
function stringsOf(file: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push(node.text);
    } else if (ts.isJsxText(node)) {
      found.push(node.text.trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter((text) => text !== "");
}

/**
 * Whether `strings` say `quotation`. An ellipsis stands for what a module fills in (a key, a count, a time), so a
 * quotation with one is said when each piece around the ellipses is part of one of the strings; one without is said when
 * it is part of one of them as it stands.
 */
function says(strings: readonly string[], quotation: string): boolean {
  const pieces = quotation.includes("…") ? quotation.split("…").map((piece) => piece.trim()).filter((piece) => piece !== "") : [quotation];
  return pieces.length > 0 && pieces.every((piece) => strings.some((text) => text.includes(piece)));
}

/** A quotation of the plugin's words without the code a document puts in front of them (`invalid_request: unknown request`). */
const wordsOf = (span: string): string => span.replace(/^[a-z]+(?:_[a-z]+)+: /, "");

// ---------------------------------------------------------------------------------------------------------------
// What the documents are, as files: the README's banner, the links, the skills directory, the catalog entry.
// ---------------------------------------------------------------------------------------------------------------

describe("the documents as files", () => {
  it("start the README with the banner, and the banner is there", () => {
    expect(read(README).split("\n")[0]).toBe("![secure-input](docs/preview.png)");
    expect(existsSync(join(ROOT, "docs/preview.png"))).toBe(true);
  });

  // `docs/superpowers/` is not published, so nothing in the documents may lead there.
  it("link only to files that exist, and to headings they have, and never into docs/superpowers", () => {
    // The anchors are made as GitHub makes them, and found where the documents link.
    expect(slugOf("Crashes, stops and restarts")).toBe("crashes-stops-and-restarts");
    expect(slugOf("A hostile process that runs as you")).toBe("a-hostile-process-that-runs-as-you");
    expect(headingsOf(SECURITY).map((heading) => heading.slug)).toContain("reporting");
    let anchors = 0;
    for (const file of [...DOCUMENTS, ...NOTES]) {
      const text = read(file);
      expect(text, file).not.toContain("docs/superpowers");
      for (const link of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = link[1] as string;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split("#") as [string, string | undefined];
        const linked = path === "" ? file : join(dirname(file), path);
        expect(existsSync(join(ROOT, linked)), `${file} links to ${target}, which is not there`).toBe(true);
        if (anchor === undefined || !linked.endsWith(".md")) continue;
        anchors += 1;
        expect(headingsOf(linked).map((heading) => heading.slug), `${file} links to ${target}, a heading ${linked} does not have`).toContain(anchor);
      }
    }
    expect(anchors, "no document links to a heading any more").toBeGreaterThanOrEqual(5);
  });

  // v1 had a second skill, `secure-input-setup`, for its command templates; it went with them.
  it("are one skill, with its name and a description an agent can be matched on", () => {
    expect(readdirSync(join(ROOT, "skills"))).toEqual(["secure-input"]);
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(read(SKILL));
    expect(front?.[1]).toBe("secure-input");
    // The description is what an agent is matched on, and harnesses cut a longer one.
    expect((front?.[2] ?? "").length).toBeGreaterThan(0);
    expect((front?.[2] ?? "").length).toBeLessThanOrEqual(1024);
  });

  it("name, in the manifest, a 512 by 512 PNG icon that the package ships", () => {
    const manifest = JSON.parse(read("paseo-plugin.json")) as { icon?: unknown };
    expect(manifest.icon).toBe("assets/icon.png");
    const icon = manifest.icon as string;
    const bytes = readFileSync(join(ROOT, icon));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([512, 512]);
    const files = (JSON.parse(read("package.json")) as { files: string[] }).files;
    expect(files.some((entry) => entry === icon || (entry.endsWith("/") && icon.startsWith(entry))), `"files" in package.json does not cover ${icon}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The examples and the names.
// ---------------------------------------------------------------------------------------------------------------

describe("the examples in the documents", () => {
  it("are JSON wherever a document has a json block", () => {
    for (const file of DOCUMENTS) expect(() => jsonExamples(file), file).not.toThrow();
  });

  it("are, in the skill, four requests the request schema takes: one key, several with an optional one, a file of a format, and none", () => {
    const requests = jsonExamples(SKILL).map((example) => InputRequestSchema.parse(example));
    expect(requests).toHaveLength(4);
    const [one, several, file, none] = requests as [InputRequest, InputRequest, InputRequest, InputRequest];
    expect(one.fields).toHaveLength(1);
    expect(one.fields[0]?.kind ?? "text").toBe("text");
    expect(several.fields.length).toBeGreaterThan(1);
    expect(several.fields.filter((field) => field.optional === true).length).toBeGreaterThan(0);
    expect(several.fields.filter((field) => field.optional !== true).length).toBeGreaterThan(0);
    expect(file.fields.some((field) => field.kind === "file" && field.format === "json")).toBe(true);
    expect(none.fields).toEqual([]);
    for (const request of requests) expect(request.reason, "every example says why").not.toBe("");
  });
});

/** A code span that is one name in snake_case: a code, a state, a tool. */
const SNAKE = /`([a-z]+(?:_[a-z]+)+)`/g;
const snakeNames = (text: string): string[] => [...text.matchAll(SNAKE)].map((match) => match[1] as string);
const NOT_TOOLS = new Set<string>([...ERROR_CODES, ...REQUEST_STATES, ...RELEASED_BY]);

describe("the names in the documents", () => {
  it("are codes, states, ways a set goes and tools that exist", () => {
    const known = new Set<string>([...NOT_TOOLS, ...TOOL_NAMES]);
    for (const file of DOCUMENTS) expect(snakeNames(read(file)).filter((name) => !known.has(name)), file).toEqual([]);
  });

  it("are, for the tools in the skill, exactly the tools the plugin gives, each in a code span", () => {
    const told = ["request_secret", "request_status", "cancel_request", "release_secret"];
    expect([...TOOL_NAMES]).toEqual(told);
    const skill = read(SKILL);
    for (const tool of told) expect(skill, tool).toContain(`\`${tool}\``);
    expect([...new Set(snakeNames(skill).filter((name) => !NOT_TOOLS.has(name)))].sort()).toEqual([...told].sort());
  });

  // Checked on Paseo 0.14.0-beta.1 with real agents, an agent sees a tool as `mcp__paseo__<tool>` in Claude Code and in
  // Codex, and Paseo's timeline calls a call `paseo.<tool>`. A document may give no other.
  it("give a tool only the names an agent sees it by, and the README gives all four", () => {
    for (const file of [...DOCUMENTS, ...NOTES]) {
      const text = read(file);
      const named = [...text.matchAll(/\bmcp__paseo__([A-Za-z0-9_]+)/g), ...text.matchAll(/\bpaseo\.([a-z]+(?:_[a-z]+)+)\b/g)].map((match) => match[1] as string);
      expect(named.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name)), file).toEqual([]);
    }
    const inReadme = new Set([...read(README).matchAll(/\bmcp__paseo__([a-z_]+)/g)].map((match) => match[1] as string));
    expect([...inReadme].sort()).toEqual([...TOOL_NAMES].sort());
  });

  // The list names no `releasedBy` code, which only `requests.json` holds: its entries stand in the registry's order, and
  // each is known by its event. What the agent is told of each way is the skill's, under "What comes back".
  it("list, in the README, every way a set goes, in the registry's order", () => {
    // The words that name each event, as the entry says it: who acts, or what happens.
    const EVENT: Record<(typeof RELEASED_BY)[number], string> = {
      agent: "The agent calls `release_secret`, or deletes the directory itself",
      turn: "The end, with any outcome, of the agent's turn",
      time: "minutes after the write",
      restart: "The plugin starts",
      stop: "The plugin stops",
      human: "You press «Видалити всі файли секретів зараз»",
    };
    expect(Object.keys(EVENT)).toEqual([...RELEASED_BY]);
    const section = sectionOf(README, "when-files-go");
    expect(section.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(RELEASED_BY.length);
    let after = -1;
    for (const way of RELEASED_BY) {
      const at = section.indexOf(EVENT[way]);
      expect(at, way).toBeGreaterThan(after);
      after = at;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The skill's recipes. Each sh block is something an agent runs with a real path in place of `PATH`: the path may stand
// only where the skill's own rule lets it (after `<`, as the source of `cp`, after `rm -r`), never as an argument and
// never inside `$(…)`. The recipe that writes into an .env file and the one that writes a token file on a server are
// run here, with a value in a real file, as an agent would run them.
// ---------------------------------------------------------------------------------------------------------------

/** The sh blocks of a document. */
const shBlocks = (file: string): string[] => [...read(file).matchAll(/```sh\n([\s\S]*?)\n```/g)].map((block) => block[1] as string);

/** Where `PATH` may stand in a recipe: read by a command from its stdin, copied as a file, or removed. */
const BLIND = /<\s*PATH\b|\bcp PATH\b|\brm -r PATH\b/g;

/** The places `PATH` stands in a recipe that the rule does not let it: each with the line it is on. */
function unblind(recipe: string): string[] {
  const allowed = [...recipe.matchAll(BLIND)].map((match) => (match.index as number) + match[0].indexOf("PATH"));
  const lines: string[] = [];
  for (const match of recipe.matchAll(/\bPATH\b/g)) {
    if (!allowed.includes(match.index as number)) lines.push(recipe.slice(recipe.lastIndexOf("\n", match.index) + 1, recipe.indexOf("\n", match.index) === -1 ? undefined : recipe.indexOf("\n", match.index)));
  }
  if (recipe.includes("$(")) lines.push("$(");
  return lines;
}

/** A path as the skill's recipes are given one: shell-quoted, the way the delivery message gives it. */
const shellQuoted = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

/** Runs a recipe with `sh`, in `cwd`, under the umask a daemon commonly has; what it printed and how it ended. */
function runRecipe(recipe: string, cwd: string, env: Record<string, string> = {}): { status: number | null; output: string } {
  const result = spawnSync("/bin/sh", ["-c", `umask 022\n${recipe}`], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("the skill's recipes", () => {
  it("are found, and hold every path where the skill's rule lets it stand, and nowhere else", () => {
    const recipes = shBlocks(SKILL);
    expect(recipes.length).toBeGreaterThanOrEqual(4);
    for (const recipe of recipes) expect(unblind(recipe), recipe).toEqual([]);
    // The check finds what it looks for: a path as an argument, read by `cat`, and inside `$(…)`.
    expect(unblind("cat PATH")).toEqual(["cat PATH"]);
    expect(unblind('tool --password "$(cat < PATH)"')).toEqual(["$("]);
    expect(unblind("cp PATH dest && cat PATH")).toEqual(["cp PATH dest && cat PATH"]);
    expect(unblind("tool < PATH\ncp PATH dest\nrm -r PATH")).toEqual([]);
  });

  it("write a value into an .env file that git ignores and only this user can read, printing nothing", () => {
    expect(spawnSync("git", ["--version"]).status, "these recipes need git").toBe(0);
    const recipe = shBlocks(SKILL).find((block) => block.includes(".env.local")) as string;
    expect(recipe).toBeDefined();
    const value = "sk_test_CANARY-into-the-env-file";
    const secret = join(tempDir("si recipe'value-"), "STRIPE_KEY");
    writeFileSync(secret, value, { mode: 0o600 });
    const withPath = recipe.replaceAll("PATH", shellQuoted(secret));
    const repository = () => {
      const dir = tempDir("si-repo-");
      expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
      return dir;
    };

    // A repository that ignores the file, a file that is not there yet.
    const ignored = repository();
    writeFileSync(join(ignored, ".gitignore"), ".env.local\n");
    expect(runRecipe(withPath, ignored)).toEqual({ status: 0, output: "" });
    expect(readFileSync(join(ignored, ".env.local"), "utf8")).toBe(`\nSTRIPE_KEY=${value}\n`);
    expect(mode(join(ignored, ".env.local"))).toBe(0o600);

    // A file that is there already, readable by others: it is made private, and the line is added to what it holds.
    const existing = repository();
    writeFileSync(join(existing, ".gitignore"), ".env*\n");
    writeFileSync(join(existing, ".env.local"), "OTHER=1\n");
    chmodSync(join(existing, ".env.local"), 0o644);
    expect(runRecipe(withPath, existing)).toEqual({ status: 0, output: "" });
    expect(readFileSync(join(existing, ".env.local"), "utf8")).toBe(`OTHER=1\n\nSTRIPE_KEY=${value}\n`);
    expect(mode(join(existing, ".env.local"))).toBe(0o600);

    // A repository that would track the file: the recipe stops before it writes anything, and says nothing.
    const tracked = repository();
    const stopped = runRecipe(withPath, tracked);
    expect(stopped.status).not.toBe(0);
    expect(stopped.output).toBe("");
    expect(existsSync(join(tracked, ".env.local"))).toBe(false);

    // No repository at all: there is nothing to track the file, and it is written as in an ignored one.
    const plain = tempDir("si-plain-");
    mkdirSync(join(plain, "work"));
    expect(runRecipe(withPath, join(plain, "work"), { GIT_CEILING_DIRECTORIES: plain })).toEqual({ status: 0, output: "" });
    expect(mode(join(plain, "work", ".env.local"))).toBe(0o600);
  });

  it("copy a whole file into a destination made private before any byte is copied, a file that was there already included", () => {
    expect(spawnSync("git", ["--version"]).status, "these recipes need git").toBe(0);
    const recipe = shBlocks(SKILL).find((block) => block.includes("cp PATH")) as string;
    expect(recipe).toBeDefined();
    const value = "CANARY-a-service-account-file";
    const secret = join(tempDir("si file'value-"), "GCP_SA");
    writeFileSync(secret, value, { mode: 0o600 });
    const withPath = recipe.replaceAll("PATH", shellQuoted(secret));
    const repository = (ignore: string | null) => {
      const dir = tempDir("si-copy-");
      expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
      mkdirSync(join(dir, "config"));
      if (ignore !== null) writeFileSync(join(dir, ".gitignore"), ignore);
      return dir;
    };
    const destination = (dir: string): string => join(dir, "config", "gcp-sa.json");

    // A repository that ignores the file, a file that is not there yet.
    const ignored = repository("config/\n");
    expect(runRecipe(withPath, ignored)).toEqual({ status: 0, output: "" });
    expect([readFileSync(destination(ignored), "utf8"), mode(destination(ignored))]).toEqual([value, 0o600]);

    // A file that is there already, readable by others. A source that cannot be copied shows the order: the destination
    // is private by then, and still holds what it held. Then the real copy replaces it.
    const existing = repository("config/\n");
    writeFileSync(destination(existing), "old");
    chmodSync(destination(existing), 0o644);
    const failed = runRecipe(recipe.replaceAll("PATH", shellQuoted(join(dirname(secret), "MISSING"))), existing);
    expect(failed.status).not.toBe(0);
    expect([readFileSync(destination(existing), "utf8"), mode(destination(existing))]).toEqual(["old", 0o600]);
    expect(runRecipe(withPath, existing)).toEqual({ status: 0, output: "" });
    expect([readFileSync(destination(existing), "utf8"), mode(destination(existing))]).toEqual([value, 0o600]);

    // A repository that would track the file: the recipe stops before it touches anything, and says nothing.
    const tracked = repository(null);
    const stopped = runRecipe(withPath, tracked);
    expect(stopped.status).not.toBe(0);
    expect(stopped.output).toBe("");
    expect(existsSync(destination(tracked))).toBe(false);
  });

  it("write a token file on a server that only its user can read, a file that was there already included", () => {
    const recipe = shBlocks(SKILL).find((block) => block.startsWith("ssh ")) as string;
    expect(recipe).toBeDefined();
    // What runs on the server is the quoted command after the host; here it runs on this machine, with a home of its own.
    const remote = /^ssh HOST '([^']*)' < PATH$/.exec(recipe)?.[1];
    expect(remote, recipe).toBeDefined();
    const value = "CANARY-a-token-for-the-server";
    const secret = join(tempDir("si-token-"), "TOKEN");
    writeFileSync(secret, value, { mode: 0o600 });
    const home = tempDir("si-home-");
    const run = () => runRecipe(`${remote as string} < ${shellQuoted(secret)}`, home, { HOME: home });
    expect(run()).toEqual({ status: 0, output: "" });
    const token = join(home, ".config", "app", "token");
    expect([readFileSync(token, "utf8"), mode(token)]).toEqual([value, 0o600]);
    // A token file that was there, readable by others, is made private and replaced.
    writeFileSync(token, "old");
    chmodSync(token, 0o644);
    expect(run()).toEqual({ status: 0, output: "" });
    expect([readFileSync(token, "utf8"), mode(token)]).toEqual([value, 0o600]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The app's strings. Everything a document quotes in «…» is something the app says: a string of a client module, with
// an ellipsis where the app fills in a key, a count or a time.
// ---------------------------------------------------------------------------------------------------------------

const CLIENT_MODULES = [
  ...readdirSync(join(ROOT, "client"))
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => `client/${name}`),
  "index.client.tsx",
];

/** The quotations of a text in «…», outermost only: «Натисни «→» ще раз.» is one quotation. Throws on unbalanced marks. */
function guillemets(file: string): string[] {
  const text = read(file);
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "«") {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (char === "»") {
      if (depth === 0) throw new Error(`${file}: a » with no « before it, at ${index}`);
      depth -= 1;
      if (depth === 0) found.push(text.slice(start, index));
    }
  }
  if (depth !== 0) throw new Error(`${file}: a « that is never closed`);
  return found;
}

describe("the app's words in the documents", () => {
  it("are strings of the app, as its modules spell them or build them", () => {
    const strings = CLIENT_MODULES.flatMap(stringsOf);
    const quoted = DOCUMENTS.flatMap((file) => guillemets(file).map((text) => [file, text] as const));
    expect(quoted.length).toBeGreaterThanOrEqual(25);
    for (const [file, text] of quoted) expect(says(strings, text), `${file} quotes «${text}», which the app does not say`).toBe(true);
  });

  it("are checked against strings, not comments: the reader finds what it should and nothing it should not", () => {
    const strings = stringsOf("client/outcome.ts");
    expect(strings).toContain("Плагін зараз недоступний. Натисни «→» ще раз.");
    expect(says(strings, "Плагін зараз недоступний.")).toBe(true);
    // «✕» is only ever in a comment of that module.
    expect(read("client/outcome.ts")).toContain("«✕»");
    expect(says(strings, "✕")).toBe(false);
    expect(says(stringsOf("client/diagnostics-rows.ts"), "… · найближчий зникне о …")).toBe(true);
    expect(says(stringsOf("client/diagnostics-rows.ts"), "… · найближче зникне о …")).toBe(false);
  });

  // The README and the listing tell the reader that the app is in Ukrainian only. That holds while no string of the app
  // is an English phrase (a word of three Latin letters or more, a space, and another word of Latin letters). The one
  // there is, "Secure input", is the name the settings screen is listed under; the README calls the screen by it.
  it("are in Ukrainian only, as the README and the listing say: the app spells no English phrase but the name of its settings screen", () => {
    for (const file of [README, OVERVIEW]) {
      expect(read(file), file).toContain("The texts of the pill, the form and the settings screen are in Ukrainian only.");
    }
    const englishIn = (strings: readonly string[]): string[] => strings.filter((text) => /[A-Za-z]{3,} [A-Za-z]{2,}/.test(text));
    // The check finds what it looks for, and passes what the app spells that is no phrase: a key, a style, the cipher.
    expect(englishIn(["Show the value", "Секрет для агента", "KEY_NAME", "flex-start", "X25519 · ChaCha20-Poly1305", "вставлено · 54 байти · json ✗"])).toEqual(["Show the value"]);
    expect(englishIn(CLIENT_MODULES.flatMap(stringsOf))).toEqual(["Secure input"]);
    expect(read(README)).toContain("**Secure input**");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The plugin's own words where a document quotes them outside the table of messages. A code span that holds one of
// these phrases is a quotation of the module that says it, wherever it stands and however often; the code in front of
// it is the document's, and an ellipsis stands for what the module fills in.
// ---------------------------------------------------------------------------------------------------------------

const PHRASES: Array<[phrase: string, source: string]> = [
  ["has not finished starting", "server/paseo/tools.ts"],
  ["did not start", "server/paseo/tools.ts"],
  ["could not be handled", "server/paseo/tools.ts"],
  ["unknown request", "server/paseo/tools.ts"],
  ["no files to release", "server/core/registry.ts"],
  ["could not be deleted", "server/core/registry.ts"],
  ["is shutting down", "server/core/registry.ts"],
  ["is busy", "server/core/registry.ts"],
  ["End your turn now", "server/core/registry.ts"],
];

describe("the plugin's words in the documents", () => {
  it("quote, in the skill's table of refusals, only words that the tools or the registry say", () => {
    const spans = tableUnder(SKILL, "## When a request is refused at once")
      .flatMap(codeSpans)
      .filter((span) => span.includes(" "));
    expect(spans.length).toBeGreaterThanOrEqual(6);
    const said = ["server/paseo/tools.ts", "server/core/registry.ts"].flatMap(stringsOf);
    for (const span of spans) expect(says(said, wordsOf(span)), `the skill quotes \`${span}\`, which neither module says`).toBe(true);
  });

  it("quote the fixed words of a refusal or a reply, wherever a document quotes them, as the module that says them has them", () => {
    const spans = DOCUMENTS.flatMap((file) => codeSpans(read(file)).map((span) => [file, span] as const));
    for (const [phrase, source] of PHRASES) {
      const quoting = spans.filter(([, span]) => span.includes(phrase));
      expect(quoting.length, `no document quotes "${phrase}" any more`).toBeGreaterThan(0);
      const said = stringsOf(source);
      for (const [file, span] of quoting) expect(says(said, wordsOf(span)), `${file} quotes \`${span}\`, which ${source} does not say`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What an agent is told. The table "What comes back" in the skill quotes the beginnings of the messages the plugin
// sends; each quotation must be what `continuationText` and `tamperText` really return for a record the registry would
// store, each kind of message must be quoted, and two kinds the agent must act on differently must be told apart.
// ---------------------------------------------------------------------------------------------------------------

/** Where the files of a set are, as the message says it. */
const DROP = "/Users/you/.paseo/secure-input/drop";
const request: InputRequest = InputRequestSchema.parse({
  reason: "Stripe test keys for the checkout tests",
  fields: [{ key: "STRIPE_KEY" }, { key: "STRIPE_WEBHOOK_SECRET", optional: true }],
});
const delivery = { fulfilledDigest: "1".repeat(64), written: ["STRIPE_KEY", "STRIPE_WEBHOOK_SECRET"], deleteBy: Date.UTC(2026, 9, 28, 12, 15) };

/** A record as the registry stores it: it has to pass the registry's own schema. */
function stored(state: RequestState, overrides: Partial<RequestRecord> = {}): RequestRecord {
  const delivered = state === "delivered" || state === "released";
  const record = parseRecord({
    id: `r_${"7f3a".repeat(8)}`,
    agentId: "agent-1",
    agentCwd: "/work",
    agentTitle: null,
    request,
    state,
    publicKey: "A".repeat(43),
    requestDigest: requestDigestOf(request),
    retries: 0,
    tamper: false,
    errorCode: null,
    ...(delivered ? delivery : { fulfilledDigest: null, written: null, deleteBy: null }),
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
  if (record === null) throw new Error(`the registry would not store this ${state} record`);
  return record;
}

function told(record: RequestRecord): string {
  const text = continuationText(record, DROP);
  if (text === null) throw new Error(`the plugin says nothing of a ${record.state} record`);
  return text;
}

/**
 * The kinds of message. A variant is another kind with one line added (`variantOf` names that kind): it has to be told
 * from that kind by a quotation of its own, while that kind has nothing of its own to tell it from its variant.
 */
const MESSAGES: ReadonlyArray<{ kind: string; text: string; variantOf?: string }> = [
  { kind: "delivered", text: told(stored("delivered")) },
  { kind: "delivered, an optional key left empty", text: told(stored("delivered", { written: ["STRIPE_KEY"] })), variantOf: "delivered" },
  { kind: "deleted at its time", text: told(stored("released", { releasedBy: "time" })) },
  { kind: "deleted when the plugin restarted", text: told(stored("released", { releasedBy: "restart" })) },
  { kind: "deleted when the plugin stopped", text: told(stored("released", { releasedBy: "stop" })) },
  { kind: "deleted by the user", text: told(stored("released", { releasedBy: "human" })) },
  { kind: "rejected, the agent can fix it", text: told(stored("rejected", { errorCode: "request_closed" })) },
  { kind: "rejected, only the user can", text: told(stored("rejected", { errorCode: "write_failed" })) },
  { kind: "declined", text: told(stored("declined")) },
  { kind: "expired at its time", text: told(stored("expired", { expiredBy: "time" })) },
  { kind: "expired at a restart", text: told(stored("expired", { expiredBy: "restart" })) },
  { kind: "tamper", text: tamperText(stored("delivered", { tamper: true })) },
];

const PLACEHOLDERS = /(…|<path>|\bN\b|\bKEY\b|\(code\))/;
const AS_REGEX: ReadonlyMap<string, string> = new Map([
  ["…", ".*"],
  ["<path>", "\\S+"],
  ["N", "\\d+"],
  ["KEY", "[A-Za-z_][A-Za-z0-9_]*"],
  ["(code)", "\\([a-z_]+\\)"],
]);
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A quotation from the table as a pattern: the words must be there as written, the placeholders stand for whatever fills them. */
function quotationAsPattern(quotation: string): RegExp {
  return new RegExp(
    quotation
      .split(PLACEHOLDERS)
      .map((piece) => AS_REGEX.get(piece) ?? escaped(piece))
      .join(""),
  );
}

/** The quotations in the table under "What comes back": the code spans that hold more than one word. */
function quotations(): string[] {
  return tableUnder(SKILL, "## What comes back")
    .flatMap(codeSpans)
    .filter((span) => span.includes(" "));
}

/** The quotations of the table that a message matches, as one text: what tells this message from the others. */
function quotedBy(text: string): string {
  return quotations()
    .filter((span) => !span.startsWith('"status"') && quotationAsPattern(span).test(text))
    .join("\n");
}

describe("what comes back, in the skill", () => {
  it("quotes only what the plugin says, and quotes every kind of message", () => {
    const spans = quotations();
    expect(spans.length).toBeGreaterThanOrEqual(14);
    // The answer to a request is a JSON object with a state; it is quoted as such.
    const reply = spans.filter((span) => span.startsWith('"status"'));
    expect(reply).toEqual(['"status": "pending"']);
    expect(JSON.parse(`{${reply[0]}}`)).toEqual({ status: "pending" });
    expect(REQUEST_STATES).toContain("pending");

    for (const span of spans.filter((quoted) => !quoted.startsWith('"status"'))) {
      const pattern = quotationAsPattern(span);
      expect(MESSAGES.some((message) => pattern.test(message.text)), `the skill quotes \`${span}\`, which no message of the plugin contains`).toBe(true);
    }
    for (const message of MESSAGES) expect(quotedBy(message.text), `the skill quotes nothing of the "${message.kind}" message: ${message.text}`).not.toBe("");
  });

  // Each kind asks for something else of the agent, so the table must let it tell any two apart by what it quotes.
  it("tells every two kinds apart: each has a quotation that the other does not match", () => {
    const patterns = quotations()
      .filter((span) => !span.startsWith('"status"'))
      .map((span) => quotationAsPattern(span));
    const tells = (one: string, from: string): boolean => patterns.some((pattern) => pattern.test(one) && !pattern.test(from));
    expect(patterns.length).toBeGreaterThanOrEqual(MESSAGES.length);
    for (const one of MESSAGES) {
      for (const other of MESSAGES) {
        if (one === other || other.variantOf === one.kind) continue;
        expect(tells(one.text, other.text), `nothing the skill quotes tells the "${one.kind}" message from the "${other.kind}" one`).toBe(true);
      }
    }
  });

  it("has a row for every way a set goes that the agent is told of, every way a request expires, and every code it is rejected with", () => {
    // The list above is written by hand: this holds it to the ways the registry knows, so a new one cannot be left out.
    const listed = MESSAGES.map((message) => message.text);
    const silent: string[] = [];
    for (const by of RELEASED_BY) {
      const text = continuationText(stored("released", { releasedBy: by }), DROP);
      if (text === null) silent.push(by);
      else expect(listed, `files deleted by ${by}`).toContain(text);
    }
    // The agent took the files, or was told of them and had its turn.
    expect(silent).toEqual(["agent", "turn"]);
    for (const expiredBy of [undefined, ...EXPIRED_BY]) {
      expect(listed, `expired by ${expiredBy ?? "a version that did not say"}`).toContain(told(stored("expired", expiredBy === undefined ? {} : { expiredBy })));
    }
    const rejections = MESSAGES.filter((message) => message.kind.startsWith("rejected")).map((message) => quotedBy(message.text));
    // Two ways of being rejected, each quoted: one the agent can fix, one only the user can.
    expect(rejections).toHaveLength(2);
    for (const quoted of rejections) expect(quoted).not.toBe("");
    for (const code of ERROR_CODES) expect(rejections, `rejected with ${code}`).toContain(quotedBy(told(stored("rejected", { errorCode: code }))));
  });

  it("gives the rule of the delivery message in the same words as the skill's hard rule: no content reaches the agent, a value moves by redirection or by copy", () => {
    const text = told(stored("delivered"));
    const skill = read(SKILL);
    for (const words of ["Never let the content of a file or directory whose name starts with si-secret- reach you", "do not pass it as an argument", "only by redirection or by copy"]) {
      expect(text, words).toContain(words);
    }
    expect(skill).toContain("Never let a `si-secret-` file's content reach you.");
    expect(skill).toContain("never pass its content as an argument");
    expect(skill).toContain("a value moves by redirection or by copy");
    // The message names no command it forbids that a recipe of the skill runs blind (`cat`, read from its stdin).
    expect(text).not.toMatch(/\bno cat\b/);
  });

  it("says that the paths of the message are quoted for a shell and those of request_status are not, as the code gives them", () => {
    // A path with a space and an apostrophe, as a data directory may have.
    const drop = "/Users/you/Paseo's data/secure-input/drop";
    const record = stored("delivered");
    const raw = filePath(drop, record.id, "STRIPE_KEY");
    // The message never holds the path bare, apostrophe and all; it holds it quoted.
    expect(continuationText(record, drop)).not.toContain(raw);
    expect(continuationText(record, drop)).toContain(shellPath(raw));
    expect(shellPath(raw)).toBe(`'${raw.replaceAll("'", "'\\''")}'`);
    const skill = read(SKILL);
    expect(skill).toContain("Each path in the delivery message is already quoted for a shell");
    expect(skill).toContain("A path from `request_status` (`files`) is not");
    expect(skill).toContain("each `'` in it written as `'\\''`");
  });

  it("says that a request the agent cancels ends without a message, and the plugin sends none, nor while one waits", () => {
    expect(read(SKILL)).toContain("A request you cancel ends without a message.");
    expect(continuationText(stored("cancelled"), DROP)).toBeNull();
    expect(continuationText(stored("pending"), DROP)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// How a message to an agent can be lost is one list, said in SECURITY.md alone, with the bounds of the queue in a table
// under it; the README's troubleshooting row sends its reader there. A second copy would let a case be added to one and
// not the other.
// ---------------------------------------------------------------------------------------------------------------

describe("how a message to an agent can be lost", () => {
  const LOSS = /Each send is attempted at most once; a message can be lost when [^|]*? the plugin did not write\./;
  const said = (file: string): string[] => [...read(file).matchAll(new RegExp(LOSS, "g"))].map((match) => match[0]);

  it("is said once, in SECURITY.md, and names each way out of the two files a message depends on", () => {
    const security = said(SECURITY);
    expect(security).toHaveLength(1);
    expect(said(README)).toHaveLength(0);
    for (const words of ["`outbox.json`", "`requests.json`", "at most once", "archived", "evicted", "a stop ran out of its time"]) expect(security[0], words).toContain(words);
  });

  // The README's row leaves how a message waits and how it is lost to SECURITY.md: the section it links to must say both.
  it("is, in the README, the row that sends its reader to the section of SECURITY.md that says how a message waits and how it is lost", () => {
    const row = tableUnder(README, "## When something is wrong").find((line) => line.startsWith("| The agent never continued")) as string;
    expect(row).toBeDefined();
    const anchor = /\]\(SECURITY\.md#([a-z-]+)\)/.exec(row)?.[1];
    expect(anchor, row).toBeDefined();
    const section = sectionOf(SECURITY, anchor as string);
    for (const claim of BOUNDS) expect(section, String(claim.pattern)).toMatch(claim.pattern);
    expect(section).toContain(said(SECURITY)[0]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The numbers. Each limit a document states is read out of the Markdown and compared with the constant that makes it
// true, so that changing either side fails here. A number with a unit that no claim covers also fails, so a limit
// cannot be added to a document without being tied to the code.
// ---------------------------------------------------------------------------------------------------------------

/** The number words a document may use for a quantity, one to twelve. */
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"] as const;
const WORDS: ReadonlyMap<string, number> = new Map(NUMBER_WORDS.map((word, index) => [word, index + 1] as const));
const KIB = 1024;
const MIB = KIB * KIB;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function numberOf(text: string): number | string {
  if (/^\d+$/.test(text)) return Number(text);
  return WORDS.get(text) ?? text;
}

function requirement(file: string, pick: (json: Record<string, unknown>) => string): string {
  return pick(JSON.parse(read(file)) as Record<string, unknown>).replace(/^>=/, "");
}

/**
 * A duration that the documents say as one unit, in their words: "a day", "a minute". The claim captures the article
 * with the unit, so that "a minute" where the code has a day is a mismatch (the number alone is one for both).
 */
function oneUnit(ms: number): string {
  const units: Array<[number, string]> = [
    [DAY, "a day"],
    [HOUR, "an hour"],
    [MINUTE, "a minute"],
    [1000, "a second"],
  ];
  return units.find(([length]) => length === ms)?.[1] ?? `${ms} ms`;
}

interface Claim {
  file: string;
  /** What the document says, with one group for each number. */
  pattern: RegExp;
  /** What the code says, in the order of the groups. */
  expected: Array<number | string>;
}

/** Every match of a claim's pattern, with the pattern's own flags kept: `new RegExp(pattern, "g")` would drop an `i`. */
function matchesOf(claim: Claim, text: string): RegExpExecArray[] {
  const { source, flags } = claim.pattern;
  return [...text.matchAll(new RegExp(source, flags.includes("g") ? flags : `${flags}g`))];
}

const paseo = requirement("paseo-plugin.json", (json) => (json.requirements as { paseo: string }).paseo);
const node = requirement("package.json", (json) => (json.engines as { node: string }).node)
  .split(".")
  .slice(0, 2)
  .join(".");
/**
 * The release of Paseo on which the observations in the documents were made, with real agents. It is the requirement
 * today, and it stays what it is when the requirement moves: the observations were made on it.
 */
const CHECKED_ON = "0.14.0-beta.1";

// Said in the same words wherever it is said, so one pattern holds each of them to the code in every document.
/** How long a set stays at the most: the deadline from the write. */
const DEADLINE: Omit<Claim, "file"> = { pattern: /(?:at most )?(\d+) minutes after the write/, expected: [DROP_TTL_MS / MINUTE] };
/** The minute tick, for a machine that slept through the deadline. */
const WAKING: Omit<Claim, "file"> = { pattern: /within (an? \w+) of waking/, expected: [oneUnit(EXPIRY_INTERVAL_MS)] };
/**
 * The bounds of the message queue, as the table under "Crashes, stops and restarts" in SECURITY.md gives them: how long
 * a message waits and how many wait, the clock skew that drops one, how long a request is remembered, and what the idle
 * check and the send may take. The README's troubleshooting row sends the reader there.
 */
const BOUNDS: Array<Omit<Claim, "file">> = [
  { pattern: /up to (an? \w+); the outbox holds (\d+) messages/, expected: [oneUnit(MAX_OUTBOX_AGE_MS), MAX_OUTBOX_ITEMS] },
  { pattern: /by more than (an? \w+): the message goes/, expected: [oneUnit(OUTBOX_CLOCK_SKEW_MS)] },
  { pattern: /the last (\d+) closed requests, or fewer when `requests\.json` would exceed (\d+) MiB/, expected: [HISTORY, MAX_REQUESTS_BYTES / MIB] },
  {
    pattern: /asks once (an? \w+); one call may take (\d+) seconds, one round (\d+) seconds, and (\d+) second once/,
    expected: [oneUnit(EXPIRY_INTERVAL_MS), PORT_TIMEOUT_MS / 1000, FLUSH_BUDGET_MS / 1000, PORT_FLOOR_MS / 1000],
  },
];
/** How often what did not land or could not be removed (a pill, an entry of `drop/`) is tried again: at the plugin's tick. */
const TICK: Omit<Claim, "file"> = { pattern: /tried again once (an? \w+)/, expected: [oneUnit(EXPIRY_INTERVAL_MS)] };
/** How seldom a pill is tried once the daemon has left appends of it unanswered: SECURITY.md alone says it. */
const SLOW_PILL: Omit<Claim, "file"> = {
  pattern: /once in (\w+) minutes while the daemon has left (\w+) appends of it unanswered/,
  expected: [(SLOW_RETRY_TICKS * EXPIRY_INTERVAL_MS) / MINUTE, MAX_UNSETTLED_APPENDS],
};
/** The limits of a request, as the skill says them; the README gives only the two sizes and the row cap a human meets. */
const REQUEST_LIMITS: Array<Omit<Claim, "file">> = [
  { pattern: /`reason`[^\n]*?at most (\d+) characters/i, expected: [LIMITS.reason] },
  { pattern: /`label`[^\n]*?at most (\d+) characters/i, expected: [LIMITS.label] },
  { pattern: /at most (\d+) fields/i, expected: [LIMITS.fields] },
  { pattern: /`\[A-Za-z_\]\[A-Za-z0-9_\]\*`, at most (\d+) characters/, expected: [LIMITS.key] },
  { pattern: /one line[^\n]*?at most (\d+) KiB/, expected: [LIMITS.valueBytes / KIB] },
  { pattern: /a whole file[^\n]*?at most (\d+) KiB/, expected: [LIMITS.fileBytes / KIB] },
];

const CLAIMS: Claim[] = [
  // The skill
  ...REQUEST_LIMITS.map((claim) => ({ file: SKILL, ...claim })),
  { file: SKILL, pattern: /deleted (\d+) minutes after they were written/, expected: [DROP_TTL_MS / MINUTE] },
  { file: SKILL, pattern: /Nobody answered in (\d+) hours/, expected: [TTL_MS / HOUR] },
  // The README
  { file: README, pattern: /Paseo \*\*(\S+) or later\*\*/, expected: [paseo] },
  // Said of the release the manifest requires: once it requires a release that is not a pre-release, the sentence goes.
  { file: README, pattern: /Paseo (\S+) is a pre-release/, expected: [paseo] },
  { file: README, pattern: /Node\.js (\d+\.\d+) or later/, expected: [node] },
  { file: README, pattern: /home of Paseo (\S+) has that off/, expected: [CHECKED_ON] },
  { file: README, pattern: /has (\w+) tools beside Paseo's own/, expected: [TOOL_NAMES.length] },
  { file: README, pattern: /one line of at most (\d+) KiB/, expected: [LIMITS.valueBytes / KIB] },
  { file: README, pattern: /a file is at most (\d+) KiB/, expected: [LIMITS.fileBytes / KIB] },
  { file: README, pattern: /expires after (\d+) hours/, expected: [TTL_MS / HOUR] },
  // The cap on a form's rows, which `addRow` holds «+» to (below).
  { file: README, pattern: /holds at most (\d+) rows/, expected: [LIMITS.fields] },
  { file: README, ...DEADLINE },
  { file: README, ...WAKING },
  { file: README, pattern: /busy for more than (\d+) minutes/, expected: [DROP_TTL_MS / MINUTE] },
  // SECURITY.md
  { file: SECURITY, ...DEADLINE },
  { file: SECURITY, ...WAKING },
  { file: SECURITY, pattern: /Of the (\w+) tools/, expected: [TOOL_NAMES.length] },
  { file: SECURITY, pattern: /a file of mode `(\d+)` in a directory of mode `(\d+)`/, expected: [Number(FILE_MODE.toString(8)), Number(DIRECTORY_MODE.toString(8))] },
  { file: SECURITY, pattern: /padded to a multiple of (\d+) KiB/, expected: [PAD_BLOCK / KIB] },
  { file: SECURITY, pattern: /send (\w+) submissions/, expected: [MAX_RETRIES] },
  { file: SECURITY, pattern: /at most (\d+) levels deep/, expected: [DROP_MAX_DEPTH] },
  { file: SECURITY, pattern: /gives a stopping plugin (\d+) seconds/, expected: [PASEO_STOP_WINDOW_MS / 1000] },
  {
    file: SECURITY,
    pattern: /get at most (\d+) seconds?, and the sweep after them at most (\d+) milliseconds/,
    expected: [SHUTDOWN_BOUND_MS / 1000, DROP_SWEEP_BOUND_MS],
  },
  { file: SECURITY, pattern: /waits up to (\d+) seconds for the start-up/, expected: [STARTUP_WAIT_MS / 1000] },
  { file: SECURITY, pattern: /waits there for its turn for at most (\d+) seconds/, expected: [ADMISSION_WAIT_MS / 1000] },
  { file: SECURITY, pattern: /longer than the (\d+) seconds Paseo gives/, expected: [PASEO_STOP_WINDOW_MS / 1000] },
  // A delivered set that would not go waits for its deadline, and is then tried at every tick; what a start or a failed
  // write left is tried at every tick (`TICK`).
  { file: SECURITY, pattern: /tried again at its deadline, and after that once (an? \w+)/, expected: [oneUnit(EXPIRY_INTERVAL_MS)] },
  ...BOUNDS.map((claim) => ({ file: SECURITY, ...claim })),
  { file: SECURITY, ...TICK },
  { file: SECURITY, ...SLOW_PILL },
  { file: SECURITY, pattern: /older than the plugin requires \((\S+)\)/, expected: [paseo] },
  // The listing text
  { file: OVERVIEW, pattern: /The agent has (\w+) tools, which Paseo serves/, expected: [TOOL_NAMES.length] },
  { file: OVERVIEW, pattern: /a whole file of up to (\d+) KiB/, expected: [LIMITS.fileBytes / KIB] },
  {
    file: OVERVIEW,
    pattern: /directories of mode (\d+) with files of mode (\d+)/,
    expected: [Number(DIRECTORY_MODE.toString(8)), Number(FILE_MODE.toString(8))],
  },
  { file: OVERVIEW, ...DEADLINE },
  { file: OVERVIEW, pattern: /Paseo (\S+) or later on the daemon and in the app/, expected: [paseo] },
  { file: OVERVIEW, pattern: /with Node\.js (\d+\.\d+) or later/, expected: [node] },
];

/** How many quantities the scanner found in the four documents when the count was last taken. */
const QUANTITIES_TODAY = 48;

/** Numbers that are not limits of the code: a measurement of a machine, or a count in an example. */
const NOT_A_LIMIT: ReadonlyArray<readonly [string, string]> = [];

/** The units a number may be given in. A number with one of them is a limit, and has to be tied to the code by a claim. */
const UNITS = [
  "KiB", "MiB", "GiB", "bytes?", "characters?", "milliseconds?", "seconds?", "minutes?", "hours?", "days?", "weeks?",
  // Things that are counted are in the plural: "one file per key" is a rule of the plugin, "32 fields" is a limit.
  "fields", "keys", "files", "values", "attempts", "submissions", "tools", "messages", "appends", "levels", "rows",
];
const NUMBER = `(?:\\d+(?:\\.\\d+)?|${NUMBER_WORDS.join("|")})`;
const QUANTITY = new RegExp(
  `\\b${NUMBER} (?:${UNITS.join("|")})\\b|\\b(?:[Uu]p to|[Aa]t most|more than|over|under|shorter than|above) (?:a )?(?:${NUMBER}|day)\\b|\\ban? (?:day|hour|minute)\\b`,
  "g",
);

describe("the numbers in the documents", () => {
  it("are the numbers of the code", () => {
    // Read from the manifest, the package and the app; if that failed, say so here and not as a mismatch.
    expect(paseo).toMatch(/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/);
    expect(node).toMatch(/^\d+\.\d+$/);
    // A pattern that ignores case is matched ignoring case: the flags are the claim's own.
    expect(matchesOf({ file: README, pattern: /at most (\d+) fields/i, expected: [] }, "At most 32 fields").length).toBe(1);
    for (const claim of CLAIMS) {
      const matches = matchesOf(claim, read(claim.file));
      expect(matches.length, `${claim.file} no longer says ${claim.pattern}`).toBeGreaterThan(0);
      for (const match of matches) {
        expect(match.slice(1).map(numberOf), `${claim.file}: "${match[0]}" against the code`).toEqual(claim.expected);
      }
    }
  });

  // The README's cap on a form's rows is the form's own: «+» adds nothing to a full form, and one row to a form one short of it.
  it("give, in the README, the row cap the form holds «+» to", () => {
    const row = (n: number): FormRow => ({ id: `x${n}`, key: "", declared: false, optional: false, format: "any", value: { kind: "text", text: "" } });
    const full: FormState = { rows: Array.from({ length: LIMITS.fields }, (_, n) => row(n)) };
    expect(addRow(full, 999).rows).toHaveLength(LIMITS.fields);
    expect(addRow({ rows: full.rows.slice(1) }, 999).rows).toHaveLength(LIMITS.fields);
  });

  // A scanner that finds nothing passes every document. So it is held to what it finds today, and to a table of sentences.
  const quantitiesIn = (text: string): string[] => [...text.matchAll(QUANTITY)].map((match) => match[0]);

  it("is a scanner that finds quantities: all the documents hold today, and each kind of sentence in a table", () => {
    const found = DOCUMENTS.flatMap((file) => quantitiesIn(read(file)));
    expect(found.length, "the scanner finds fewer quantities than the documents held when this was written: it no longer scans").toBeGreaterThanOrEqual(QUANTITIES_TODAY);
    const table: Array<[string, string[]]> = [
      ["at most 128 characters", ["at most 128"]],
      ["64 KiB of output", ["64 KiB"]],
      ["kept for ten minutes", ["ten minutes"]],
      ["waits twelve seconds", ["twelve seconds"]],
      ["the last seven days", ["seven days"]],
      ["one day, 1 hour and 2 weeks", ["one day", "1 hour", "2 weeks"]],
      ["a limit of 250 milliseconds or 9 bytes", ["250 milliseconds", "9 bytes"]],
      ["not more than eleven", ["more than eleven"]],
      ["once a day", ["a day"]],
      ["once a minute, or within an hour", ["a minute", "an hour"]],
      ["8 levels deep, and three appends of 32 keys in four rows", ["8 levels", "three appends", "32 keys", "four rows"]],
      // An ordinal is no quantity: "a second" is never read as a duration.
      ["a second, different submission", []],
      ["nothing to count here, thirteen dogs", []],
    ];
    for (const [sentence, expected] of table) expect(quantitiesIn(sentence), sentence).toEqual(expected);
    // Every number word there is, with a unit the scanner knows, and the one past the last it knows is not a number word of its own.
    for (const word of NUMBER_WORDS) expect(quantitiesIn(`${word} minutes`), word).toEqual([`${word} minutes`]);
    expect(NUMBER_WORDS).toHaveLength(12);
  });

  // The scanner knows the units in UNITS. A number given in a unit it does not know would pass untied, so the units a limit
  // could be given in that no document uses today are listed here: the first document to use one fails until the unit is
  // added to UNITS (and its numbers tied by a claim), or the sentence is changed.
  const NOT_YET_KNOWN = [
    "kB", "KB", "MB", "GB", "kilobytes?", "megabytes?", "bits?", "ms", "µs", "s", "secs?", "mins?", "hrs?", "years?", "months?",
    "retries", "tries", "times", "percent",
  ];
  it("have no number, in digits or in words up to twelve, given in a unit the scanner does not know", () => {
    const unknown = new RegExp(`\\b${NUMBER} (?:${NOT_YET_KNOWN.join("|")})(?![\\p{L}\\d])`, "gu");
    expect([..."50 ms and nine retries, 3 times, 2 s and 15 min".matchAll(unknown)].map((match) => match[0]), "the check finds what it looks for").toEqual([
      "50 ms",
      "nine retries",
      "3 times",
      "2 s",
      "15 min",
    ]);
    for (const file of DOCUMENTS) {
      expect([...read(file).matchAll(unknown)].map((match) => match[0]), `${file} gives a number in a unit that the scanner does not know`).toEqual([]);
    }
  });

  it("are all tied: no number with a unit is left to say what it likes", () => {
    for (const file of DOCUMENTS) {
      const text = read(file);
      const covered = CLAIMS.filter((claim) => claim.file === file).flatMap((claim) =>
        matchesOf(claim, text).map((match) => [match.index, match.index + match[0].length] as const),
      );
      const loose = [...text.matchAll(QUANTITY)]
        .filter((match) => !covered.some(([from, to]) => match.index >= from && match.index + match[0].length <= to))
        .filter((match) => !NOT_A_LIMIT.some(([name, phrase]) => name === file && phrase === match[0]))
        .map((match) => match[0]);
      expect(loose, `${file} states numbers that no claim ties to the code`).toEqual([]);
    }
  });
});
