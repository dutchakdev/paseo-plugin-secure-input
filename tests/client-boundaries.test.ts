import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const WEB = join(ROOT, "client", "web.ts");

/** The names of the browser's own objects. In the app, only `client/web.ts` may say them. */
const DOM = /\b(document|window|navigator|FileReader|DataTransfer|HTMLInputElement)\b/;

/** The source files below `directory`, links not followed. */
function sourcesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) found.push(...sourcesUnder(path));
    else if (info.isFile() && /\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** What ships to the app: the client, the modules it shares with the daemon, and its entry. */
function appSources(): string[] {
  return [...sourcesUnder(join(ROOT, "client")), ...sourcesUnder(join(ROOT, "shared")), join(ROOT, "index.client.tsx")];
}

/**
 * A module without its comments, and with every string (quoted or template) made empty unless `strings` is "kept".
 * What is left is the code itself: a name in it is a name the code reaches for, not one it hands over as text.
 */
function scanned(source: string, strings: "kept" | "emptied"): string {
  let code = "";
  for (let index = 0; index < source.length; ) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === "/" && next === "/") {
      while (index < source.length && source.charAt(index) !== "\n") index++;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source.charAt(end) !== char) end += source.charAt(end) === "\\" ? 2 : 1;
      code += strings === "kept" ? source.slice(index, end + 1) : `${char}${char}`;
      index = end + 1;
    } else {
      code += char;
      index++;
    }
  }
  return code;
}

const codeOnly = (source: string): string => scanned(source, "emptied");

interface Exported {
  name: string;
  kind: "function" | "const";
  /** For a function, its body from the first statement on; for a constant, what it is set to. */
  rest: string;
}

/** Every value a module exports, with what a check needs of it. A type or an interface is no value and is left out. */
function exportsOf(source: string): { exported: Exported[]; others: string[] } {
  const code = scanned(source, "kept");
  const exported: Exported[] = [];
  const others: string[] = [];
  for (const match of code.matchAll(/^export\s+(?!type\b|interface\b|default\b)(\w+)\s+(\w+)/gm)) {
    const [, keyword, name] = match as unknown as [string, string, string];
    const at = (match.index ?? 0) + match[0].length;
    if (keyword === "function") {
      // The body starts at the first brace after the parameters, whose parentheses are matched.
      let depth = 0;
      let index = code.indexOf("(", at);
      for (; index < code.length; index++) {
        if (code.charAt(index) === "(") depth++;
        else if (code.charAt(index) === ")" && --depth === 0) break;
      }
      exported.push({ name, kind: "function", rest: code.slice(code.indexOf("{", index) + 1).trimStart() });
    } else if (keyword === "const") {
      const value = /^[^=]*=\s*([^;]*);/.exec(code.slice(at));
      exported.push({ name, kind: "const", rest: value?.[1]?.trim() ?? "" });
    } else {
      others.push(`${keyword} ${name}`);
    }
  }
  for (const match of code.matchAll(/^export\s*(default\b|\{|\*)/gm)) others.push(match[1] ?? "");
  return { exported, others };
}

/** The first statement of every exported function, and every exported constant, is the platform's check. */
function ungated(source: string): string[] {
  const { exported, others } = exportsOf(source);
  return [
    ...others,
    ...exported.filter((item) => (item.kind === "function" ? !item.rest.startsWith('if (Platform.OS !== "web") return') : item.rest !== 'Platform.OS === "web"')).map((item) => item.name),
  ];
}

/** The `lib` a tsconfig asks for. Its comments are whole lines, which JSON does not have. */
function libOf(text: string): string[] {
  const json = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const parsed = JSON.parse(json) as { compilerOptions?: { lib?: string[] } };
  return parsed.compilerOptions?.lib ?? [];
}

describe("the boundary of the DOM in the app", () => {
  it("has checks that see what they look for, on sources written to have it", () => {
    expect(DOM.test("const input = document.createElement('input');")).toBe(true);
    expect(DOM.test("a dotenv documentation, a windowsill")).toBe(false);
    expect(codeOnly('const a = "document"; // window\n/* navigator */ const b = `FileReader`;')).toBe("const a = \"\"; \n const b = ``;");
    const gated = 'export const canPickFiles = Platform.OS === "web";\nexport function pickFile(): Promise<X> {\n  if (Platform.OS !== "web") return Promise.resolve(null);\n}\nexport type T = string;\n';
    expect(ungated(gated)).toEqual([]);
    const loose = 'export const canPickFiles = true;\nexport function pickFile(a: (b: number) => void): void {\n  doIt();\n}\nexport default 1;\nexport let x = 1;\n';
    expect(ungated(loose).sort()).toEqual(["canPickFiles", "default", "let x", "pickFile"].sort());
    expect(libOf('// a comment\n{ "compilerOptions": { "lib": ["ES2023", "DOM"] } }')).toEqual(["ES2023", "DOM"]);
  });

  it("touches the DOM in client/web.ts only, through globalThis, and gates every export on the web platform", () => {
    const sources = appSources();
    expect(sources).toContain(WEB);
    const offenders = sources.filter((path) => path !== WEB && DOM.test(readFileSync(path, "utf8"))).map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);

    // No project is checked against the DOM's types: what web.ts needs of the browser, it describes itself.
    const configs = readdirSync(ROOT).filter((name) => /^tsconfig.*\.json$/.test(name));
    expect(configs.sort()).toEqual(["tsconfig.base.json", "tsconfig.client-tests.json", "tsconfig.client.json", "tsconfig.json", "tsconfig.server.json"]);
    for (const name of configs) {
      const text = readFileSync(join(ROOT, name), "utf8");
      expect(libOf(text).filter((entry) => /^dom/i.test(entry)), name).toEqual([]);
      expect(text, name).not.toMatch(/"dom(\.[a-z]+)*"/i);
    }

    // In web.ts every name of the browser is a string handed to globalThis, never a global the code reaches for.
    const source = readFileSync(WEB, "utf8");
    expect(DOM.test(source)).toBe(true);
    expect(codeOnly(source)).not.toMatch(DOM);
    expect(codeOnly(source)).toMatch(/\bglobalThis\b/);
    expect(source).not.toMatch(/reference\s+lib/);

    const { exported } = exportsOf(source);
    expect(exported.map((item) => item.name).sort()).toEqual(["canPickFiles", "pickFile", "useFileDrop"]);
    expect(ungated(source)).toEqual([]);
  });

  it("draws the pill at one height, from the card's data and nothing of the form", () => {
    const card = readFileSync(join(ROOT, "client", "card.tsx"), "utf8");
    expect(card).toContain("height: PILL_HEIGHT");
    expect(card).toContain("borderRadius: PILL_HEIGHT / 2");
    expect(card).toMatch(/pill\(item\.data\)/);
    expect(card).not.toMatch(/minHeight|maxHeight|onLayout/);
    // Of the form's modules it mounts the form, and takes the font of keys from the rows; nothing that holds or decides anything.
    expect(card).not.toMatch(/from "\.\/(form-state|dialog-state|submit|outcome|file-entry|envelope-cache|sealing|web)"/);
  });

  it("gives every Text its colour, and shows no toast", () => {
    const views = appSources().filter((path) => path.endsWith(".tsx"));
    expect(views.length).toBeGreaterThanOrEqual(5);
    for (const path of views) {
      const source = readFileSync(path, "utf8");
      for (const tag of source.matchAll(/<Text\b[^>]*>/g)) expect(tag[0], relative(ROOT, path)).toMatch(/\bcolor\b/);
      expect(source, relative(ROOT, path)).not.toMatch(/useToast/);
    }
  });
});

/** The body of the `occurrence`-th function that begins with `signature` in code, braces matched; strings are already empty, so none is in the way. */
function bodyOf(code: string, signature: string, occurrence = 0): string {
  let from = -1;
  for (let found = 0; found <= occurrence; found++) {
    from = code.indexOf(signature, from + 1);
    if (from === -1) throw new Error(`no ${signature} number ${occurrence}`);
  }
  const open = code.indexOf("{", from + signature.length);
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code.charAt(index) === "{") depth++;
    else if (code.charAt(index) === "}" && --depth === 0) return code.slice(open + 1, index);
  }
  throw new Error(`${signature} is not closed`);
}

describe("the settings screen", () => {
  const code = codeOnly(readFileSync(join(ROOT, "client", "settings.tsx"), "utf8"));

  it("finds the bodies it is asked about, and nothing where there is no such function", () => {
    expect(bodyOf("function a() { if (b) { c(); } d(); } function e() { f(); }", "function a()")).toBe(" if (b) { c(); } d(); ");
    expect(bodyOf("function a() { x(); } function a() { y(); }", "function a()", 1)).toBe(" y(); ");
    expect(() => bodyOf("function a() { x(); }", "function b()")).toThrow("no function b() number 0");
  });

  it("runs the self-test from the press and nowhere else, never in the render", () => {
    expect(code.match(/runSelfTest\(/g)).toHaveLength(1);
    // The screen's first `run` is the self-test's: it says that a run has begun, and then waits for the run.
    const run = bodyOf(code, "async function run()", 0);
    expect(run.indexOf("setState(RUNNING)")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("setState(RUNNING)")).toBeLessThan(run.indexOf("runSelfTest("));
    expect(code).toContain("onPress={() => void run()}");
  });

  it("deletes, and then reads the state again, whatever the deletion came to", () => {
    const run = bodyOf(code, "async function run()", 1);
    const deleted = run.indexOf("await clear({})");
    const read = run.indexOf("await refresh()");
    expect(deleted).toBeGreaterThanOrEqual(0);
    // A deletion that fails is caught before the reading, so that the reading is made all the same.
    expect(run.slice(deleted, read)).toMatch(/catch \{/);
    expect(read).toBeGreaterThan(deleted);
    // Neither of the two calls leaves a rejection unhandled in the press, and the button is free again whatever happens.
    expect(run.slice(read)).toMatch(/catch \{[\s\S]*finally \{\s*setBusy\(false\)/);
    expect(run).toContain("setBusy(true)");
  });

  it("shows the button that deletes every file only by the rule that says when: a set is delivered, or the drop is failing", () => {
    expect(code).toMatch(/\{data !== undefined && canDeleteAll\(data\) \? <DeleteAll refresh=\{\(\) => query\.refetch\(\)\} \/> : null\}/);
    expect(code.match(/<DeleteAll\b/g)).toHaveLength(1);
  });

  it("puts the explanation of a row where only a red row has one, and colours a dot from the theme", () => {
    expect(code).toContain("<SettingsRow key={row.label} label={row.label} error={row.explanation}>");
    expect(code).toContain("backgroundColor: dotColor(row.dot, colors)");
  });
});

/** The files of a TypeScript project: the roots its config names, and every file the program reads for them, relative to the root. */
function projectOf(config: string): { roots: string[]; files: string[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, config), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (parsed === undefined) throw new Error(`${config} cannot be read`);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const local = (path: string): string => relative(ROOT, path);
  return { roots: parsed.fileNames.map(local), files: program.getSourceFiles().map((file) => local(file.fileName)) };
}

describe("the TypeScript projects", () => {
  // A module of `client/` brings React Native's global types with it (`fetch`, `__DEV__`, timers of its own). The daemon
  // half is checked without them, so that it cannot compile against a global the daemon's Node does not have. It builds
  // two TypeScript programs, which takes a few seconds and more on a slow runner: it has a timeout of its own, since
  // vitest's default is 5 seconds.
  it("check the daemon half without a module of the app or React Native's types, and every test in exactly one project", () => {
    const server = projectOf("tsconfig.server.json");
    const clientTests = projectOf("tsconfig.client-tests.json");
    const ofTheApp = (file: string): boolean => file.startsWith("client/") || file === "index.client.tsx" || file.includes("node_modules/react-native/");
    // The check sees what it looks for: the project of the tests that load the app reads both.
    expect(clientTests.files.some((file) => file.startsWith("client/"))).toBe(true);
    expect(clientTests.files.some((file) => file.includes("node_modules/react-native/"))).toBe(true);
    expect(server.files).toContain("server/paseo/plugin.ts");
    expect(server.files.filter(ofTheApp)).toEqual([]);
    const tests = readdirSync(join(ROOT, "tests"))
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => `tests/${name}`);
    expect(tests.length).toBeGreaterThan(30);
    for (const test of tests) expect([server.roots.includes(test), clientTests.roots.includes(test)].filter(Boolean), test).toHaveLength(1);
  }, 30_000);
});
