import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_STUB_SOURCE, LEGACY_TEXT, replaceLegacyBridge } from "../server/io/legacy-shim";
import { rejectionOf, tempDir } from "./helpers";

// ---------------------------------------------------------------------------------------------------------------
// An agent created under v1 keeps, in its stored configuration, the MCP server `secure-input` =
// `{ type: "stdio", command: "<data>/bin/secure-input", args: ["mcp", "--binding", <id>] }`, and its shell may still call
// the same shim as a CLI. The start-up puts a stub where v1's bridge was, so that such an agent meets a server with no
// tools and no error. Every process here is real: the shim, the stub and Node.
// ---------------------------------------------------------------------------------------------------------------

const NODE = { kind: "node", execPath: process.execPath } as const;
const ELECTRON = { kind: "electron", execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo" } as const;
/** What v1's bridge held stands for here: anything but the stub. */
const OLD_BRIDGE = "// the bridge v1 installed\n";
const REFUSAL_LINE = `${JSON.stringify({ error: "service_unavailable", message: LEGACY_TEXT })}\n`;
const BIN_UNSAFE = { code: "service_unavailable", message: "service_unavailable: the bridge directory is not a private directory of this user" };
const BIN_FAILED = { code: "service_unavailable", message: "service_unavailable: the bridge directory cannot be created" };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** How v1's install quoted a path for `/bin/sh`. */
const quoted = (text: string): string => `'${text.split("'").join("'\\''")}'`;

/** `<data>/bin/` as v1 left it: its bridge, and the shim that runs the bridge with the Node of that day. */
function v1Data(dataDir: string = tempDir(), node: string = process.execPath) {
  const bin = join(dataDir, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const bridge = join(bin, "bridge.cjs");
  const shim = join(bin, "secure-input");
  writeFileSync(bridge, OLD_BRIDGE, { mode: 0o700 });
  writeFileSync(shim, `#!/bin/sh\nexec ${quoted(node)} ${quoted(bridge)} "$@"\n`, { mode: 0o700 });
  return { dataDir, bin, bridge, shim };
}

/** Runs the shim the way an agent's shell does. */
function run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { PATH: process.env.PATH ?? "" } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number((error as { code?: unknown }).code ?? 1), stdout, stderr });
    });
  });
}

/** The stub's MCP face driven with raw lines, as a client that is not the reference one may send them. */
function mcpSession(shim: string) {
  const child = spawn(shim, ["mcp", "--binding", "b-1"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const replies: Array<Record<string, unknown>> = [];
  const waiting: Array<() => void> = [];
  createInterface({ input: child.stdout }).on("line", (text) => {
    replies.push(JSON.parse(text) as Record<string, unknown>);
    for (const wake of waiting.splice(0)) wake();
  });
  // "close", not "exit": it comes after the last of the output has been read.
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  closers.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    replies,
    exited,
    stderr: () => stderr,
    send: (text: string) => void child.stdin.write(`${text}\n`),
    end: () => void child.stdin.end(),
    /** Waits for the reply to request `id`. The stub answers in order, so everything before it has arrived too. */
    async untilId(id: string | number): Promise<void> {
      while (!replies.some((reply) => reply.id === id)) await new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
}

describe("replaceLegacyBridge", () => {
  it("answers an agent created under v1 with no tools and no error, through the reference MCP client", async () => {
    // A data directory and a Node whose paths need quoting for /bin/sh: a space and a single quote in each.
    const root = tempDir();
    const nodeDirectory = join(root, "it's node");
    mkdirSync(nodeDirectory);
    const node = join(nodeDirectory, "no'de x");
    symlinkSync(process.execPath, node);
    const { dataDir, bin, bridge, shim } = v1Data(join(root, "da'ta dir"), "/old/node");

    expect(await replaceLegacyBridge(dataDir, { kind: "node", execPath: node })).toBe("replaced");
    expect(readFileSync(bridge, "utf8")).toBe(LEGACY_STUB_SOURCE);
    // The shim now names the daemon's own Node, so it runs whatever became of the Node v1 wrote down.
    expect(readFileSync(shim, "utf8")).toBe(`#!/bin/sh\nexec ${quoted(node)} ${quoted(bridge)} "$@"\n`);
    for (const file of [bridge, shim]) expect(statSync(file).mode & 0o777, file).toBe(0o700);
    expect(readdirSync(bin).sort()).toEqual(["bridge.cjs", "secure-input"]);

    // The stored entry of a v1 agent, as its provider starts it.
    const transport = new StdioClientTransport({ command: shim, args: ["mcp", "--binding", "b-1"], stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: "secure-input", version: "0.2.0" });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.callTool({ name: "request_input", arguments: {} })).toEqual({ content: [{ type: "text", text: LEGACY_TEXT }], isError: true });
    await client.close();
    expect(stderr).toBe("");
  });

  it("answers the old CLI with the same words and exit code 1", async () => {
    const { dataDir, shim } = v1Data();
    expect(await replaceLegacyBridge(dataDir, NODE)).toBe("replaced");
    for (const args of [["request", "--json", '{"sink":{"kind":"file","path":"x"}}'], ["status", `r_${"0".repeat(32)}`], ["cancel", "r_1"], ["commands"], ["pin", "store"], ["doctor"], []]) {
      expect(await run(shim, args), args.join(" ")).toEqual({ code: 1, stdout: REFUSAL_LINE, stderr: "" });
    }
  });

  it("answers every message as the table says, and nothing to a notification or to a line that is not a request", async () => {
    const { dataDir, shim } = v1Data();
    await replaceLegacyBridge(dataDir, NODE);
    const session = mcpSession(shim);
    const lines = [
      // Not JSON, or JSON that is no message: nothing.
      "not json",
      "",
      "{",
      "null",
      "[]",
      "42",
      // Notifications: nothing, whatever they name.
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"request_input","arguments":{}}}',
      // An id that cannot be sent back as it came is no id: JSON reads 1e400 as Infinity. Nor is null.
      '{"jsonrpc":"2.0","id":1e400,"method":"ping"}',
      '{"jsonrpc":"2.0","id":null,"method":"ping"}',
      '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
      // What carries no method is no request: a reply, or nothing at all.
      '{"jsonrpc":"2.0","id":20,"result":{}}',
      '{"jsonrpc":"2.0","id":21}',
      // The table.
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}',
      '{"jsonrpc":"2.0","id":3,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":"p-4","method":"ping"}',
      '{"jsonrpc":"2.0","id":5,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_commands"}}',
      '{"jsonrpc":"2.0","id":7,"method":"resources/list"}',
      '{"jsonrpc":"2.0","id":8,"method":"ping"}',
    ];
    for (const text of lines) session.send(text);
    await session.untilId(8);
    const server = { protocolVersion: "", capabilities: { tools: {} }, serverInfo: { name: "secure-input", version: "0.2.0" } };
    expect(session.replies).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ...server, protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, result: { ...server, protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", id: 3, result: { ...server, protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", id: "p-4", result: {} },
      { jsonrpc: "2.0", id: 5, result: { tools: [] } },
      { jsonrpc: "2.0", id: 6, result: { content: [{ type: "text", text: LEGACY_TEXT }], isError: true } },
      { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 8, result: {} },
    ]);
    // It ends with its input, and without a word on stderr.
    session.end();
    expect(await session.exited).toBe(0);
    expect(session.stderr()).toBe("");
  });

  it("writes nothing where v1 never installed", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "requests.json"), "[]", { mode: 0o600 });
    expect(await replaceLegacyBridge(dataDir, NODE)).toBe("absent");
    expect(await replaceLegacyBridge(dataDir, ELECTRON)).toBe("absent");
    expect(readdirSync(dataDir)).toEqual(["requests.json"]);
  });

  it("under Electron replaces only the bridge, and leaves the v1 shim", async () => {
    // Electron's binary runs no script as Node, so the shim keeps the Node v1 wrote down (here one that still exists).
    const { dataDir, bridge, shim } = v1Data();
    const before = readFileSync(shim, "utf8");
    expect(await replaceLegacyBridge(dataDir, ELECTRON)).toBe("replaced");
    expect(readFileSync(bridge, "utf8")).toBe(LEGACY_STUB_SOURCE);
    expect(statSync(bridge).mode & 0o777).toBe(0o700);
    expect(readFileSync(shim, "utf8")).toBe(before);
    // And that shim runs the stub.
    expect(await run(shim, ["doctor"])).toEqual({ code: 1, stdout: REFUSAL_LINE, stderr: "" });
  });

  it("refuses a bin/ that is a link and writes nothing through it", async () => {
    const root = tempDir();
    const dataDir = join(root, "data");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(dataDir, { mode: 0o700 });
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(dataDir, "bin"));
    for (const runtime of [NODE, ELECTRON]) expect(await rejectionOf(replaceLegacyBridge(dataDir, runtime), "refusal")).toEqual(BIN_UNSAFE);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);

    // A link to a place that does not exist yet: the place is not made.
    const planned = join(root, "planned");
    const other = join(root, "other");
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(planned, join(other, "bin"));
    expect(await rejectionOf(replaceLegacyBridge(other, NODE), "refusal")).toEqual(BIN_FAILED);
    expect(existsSync(planned)).toBe(false);

    // A file in its place is no directory to write into either.
    const third = join(root, "third");
    mkdirSync(third, { mode: 0o700 });
    writeFileSync(join(third, "bin"), "a file");
    expect(await rejectionOf(replaceLegacyBridge(third, NODE), "refusal")).toEqual(BIN_FAILED);
    expect(readFileSync(join(third, "bin"), "utf8")).toBe("a file");
  });

  it("refuses a relative data directory and a relative node path, before it looks at the disk", async () => {
    const relative = `si-legacy-relative-${process.pid}`;
    expect(await rejectionOf(replaceLegacyBridge(relative, NODE), "refusal")).toEqual({ code: "service_unavailable", message: "service_unavailable: the data directory must be an absolute path" });
    const { dataDir, bridge, shim } = v1Data();
    expect(await rejectionOf(replaceLegacyBridge(dataDir, { kind: "node", execPath: "node" }), "refusal")).toEqual({
      code: "service_unavailable",
      message: "service_unavailable: the node path must be an absolute path",
    });
    expect(readFileSync(bridge, "utf8")).toBe(OLD_BRIDGE);
    expect(readFileSync(shim, "utf8")).toContain(process.execPath);
    // Under Electron the node path is not used, and it is not looked at.
    expect(await replaceLegacyBridge(dataDir, { kind: "electron", execPath: "Paseo" })).toBe("replaced");
  });

  // The replacement is a step of the start-up. Its question is asked twice for each file: before anything of the file is
  // written, and right before it is put in place; the stub first, then (under Node) the shim.
  describe("writes nothing once it is no longer wanted", () => {
    function asking(answers: readonly boolean[]) {
      const data = v1Data();
      const asked: string[][] = [];
      const stillWanted = (): boolean => {
        asked.push(
          readdirSync(data.bin)
            .map((name) => {
              const staged = /^(bridge\.cjs|secure-input)\.[0-9a-f]{16}\.tmp$/.exec(name);
              return staged === null ? name : `<${staged[1]} staged>`;
            })
            .sort(),
        );
        return answers[asked.length - 1] as boolean;
      };
      return { ...data, asked, stillWanted };
    }
    const THEIRS = ["bridge.cjs", "secure-input"];
    const STUB_STAGED = ["<bridge.cjs staged>", "bridge.cjs", "secure-input"];
    const SHIM_STAGED = ["<secure-input staged>", "bridge.cjs", "secure-input"];

    it.each([
      ["before anything is written", [false], [THEIRS], false],
      ["before the stub is put in place", [true, false], [THEIRS, STUB_STAGED], false],
      ["before anything of the shim is written", [true, true, false], [THEIRS, STUB_STAGED, THEIRS], true],
      ["before the shim is put in place", [true, true, true, false], [THEIRS, STUB_STAGED, THEIRS, SHIM_STAGED], true],
    ] as const)("from the answer no on, %s: what was there stays, and the answer is not_wanted", async (_name, answers, found, stubWritten) => {
      const { dataDir, bin, bridge, shim, asked, stillWanted } = asking(answers);
      const shimBefore = readFileSync(shim, "utf8");
      expect(await replaceLegacyBridge(dataDir, NODE, stillWanted)).toBe("not_wanted");
      expect(asked).toEqual(found);
      expect(readdirSync(bin).sort()).toEqual(THEIRS);
      expect(readFileSync(bridge, "utf8")).toBe(stubWritten ? LEGACY_STUB_SOURCE : OLD_BRIDGE);
      expect(readFileSync(shim, "utf8")).toBe(shimBefore);
    });

    it("replaces both when all four answers are yes, and under Electron asks only for the stub", async () => {
      const node = asking([true, true, true, true]);
      expect(await replaceLegacyBridge(node.dataDir, NODE, node.stillWanted)).toBe("replaced");
      expect(node.asked).toEqual([THEIRS, STUB_STAGED, THEIRS, SHIM_STAGED]);

      const electron = asking([true, false]);
      expect(await replaceLegacyBridge(electron.dataDir, ELECTRON, electron.stillWanted)).toBe("not_wanted");
      expect(readFileSync(electron.bridge, "utf8")).toBe(OLD_BRIDGE);
      const yes = asking([true, true]);
      expect(await replaceLegacyBridge(yes.dataDir, ELECTRON, yes.stillWanted)).toBe("replaced");
      expect(yes.asked).toEqual([THEIRS, STUB_STAGED]);
    });
  });
});
