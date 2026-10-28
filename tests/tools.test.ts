import type { PluginRpcContract } from "@getpaseo/plugin";
import type { AgentToolContext, AgentToolDefinition, AgentToolResult, PluginHandlerContext } from "@getpaseo/plugin/server";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BUSY, CANCELED, Registry, type RequestRecord } from "../server/core/registry";
import { DropStore, filePath, setPath } from "../server/io/drop";
import { registerHooks, type SessionOpenRequest } from "../server/paseo/hooks";
import { assemble, startPlugin, type PluginHost, type PluginOptions } from "../server/paseo/plugin";
import type { DaemonPort, TimelineItem } from "../server/paseo/runtime";
import { NOT_HANDLED, NOT_STARTED, START_FAILED, TOOL_NAMES, identityOf, toolResult, type ToolAgent } from "../server/paseo/tools";
import { fromBase64Url } from "../shared/bytes";
import { SecureInputError } from "../shared/errors";
import { buildAad, encodeValues, seal, type PayloadEntry } from "../shared/seal";
import { promptly, tempDir } from "./helpers";

const SHORT = 50;
const NODE = { kind: "node", execPath: process.execPath } as const;
const CANARY = "CANARY-tool-5e1d9a";
const BIDI = String.fromCodePoint(0x202e);
const UNKNOWN_ID = `r_${"0".repeat(32)}`;
const asking = { reason: "why", fields: [{ key: "A" }] };

/** A refusal as a tool gives it: the code, and the plugin's own words after it. */
const refusal = (code: string, detail: string): string => JSON.stringify({ error: code, message: `${code}: ${detail}` });

// ---------------------------------------------------------------------------------------------------------------
// The Paseo side, by hand: the server context that records what the plugin registers, and the daemon API.
// ---------------------------------------------------------------------------------------------------------------

type Handler = (input: never, context: never) => unknown;

function fakeHost() {
  const rpc = new Map<string, { contract: PluginRpcContract; handler: Handler }>();
  const befores = new Map<string, Handler>();
  const host: PluginHost = {
    handle: (contract, handler) => void rpc.set(contract.name, { contract, handler }),
    before: (name, handler) => {
      befores.set(name, handler);
      return () => undefined;
    },
    on: () => () => undefined,
  };
  return {
    host,
    async before(name: string, request: unknown, port: DaemonPort): Promise<unknown> {
      const handler = befores.get(name) as ((input: { request: unknown }, context: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`no before hook for ${name}`);
      return handler({ request }, { paseo: port as unknown as PluginHandlerContext["paseo"], signal: new AbortController().signal });
    },
  };
}

function fakeDaemon() {
  const appended: Array<{ agentId: string; item: TimelineItem }> = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const port: DaemonPort = {
    agents: {
      ref(agentId) {
        const handle = {
          status: null as string | null,
          refresh: async (): Promise<unknown> => {
            handle.status = "running";
            return null;
          },
          send: async (text: string) => void sent.push({ agentId, text }),
          timeline: {
            append: async (item: TimelineItem): Promise<unknown> => {
              appended.push({ agentId, item });
              return { seq: appended.length, epoch: "e" };
            },
          },
        };
        return handle;
      },
    },
  };
  return { port, appended, sent };
}

// Commit e56b2c9's fixture of the request Paseo 0.14 sends. Its four members are spread in from a const that has no type,
// which is what lets one fixture type against the SDK before 0.14 and against 0.14's, where all four are required.
const since014 = {
  title: "Fix the build",
  labels: { task: "build" },
  tools: [],
  mcpServers: { other: { type: "stdio" as const, command: "other-mcp" } },
};
const sessionOpen: SessionOpenRequest = {
  ...since014,
  agentId: "agent-1",
  workspaceId: "ws-1",
  provider: "claude",
  cwd: "/work/a",
  reason: "create",
  purpose: "interactive",
  env: { REGION: "eu" },
};

/** The session the daemon opens for an agent. */
const sessionFor = (agent: ToolAgent): SessionOpenRequest => ({
  ...sessionOpen,
  agentId: agent.id,
  workspaceId: agent.workspaceId,
  provider: agent.provider,
  cwd: agent.cwd,
  title: agent.title,
});

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of running.splice(0)) await dispose();
  vi.restoreAllMocks();
});

function optionsFor(overrides: Partial<PluginOptions>, logs: string[]): PluginOptions {
  return {
    dataDir: tempDir(),
    runtime: NODE,
    log: (line) => void logs.push(line),
    daemonCallTimeoutMs: SHORT,
    ...overrides,
  };
}

/** The whole plugin, started the way the daemon starts it, against a fake host. */
async function started(overrides: Partial<PluginOptions> = {}, wait = true) {
  const logs: string[] = [];
  const hostFake = fakeHost();
  const plugin = startPlugin(hostFake.host, optionsFor(overrides, logs));
  running.push(plugin.dispose);
  if (wait) await plugin.ready;
  return { ...hostFake, ...plugin, logs };
}
type Started = Awaited<ReturnType<typeof started>>;

let daemon: ReturnType<typeof fakeDaemon>;
let plugin: Started;
let agentA: ToolAgent;
let childB: ToolAgent;

beforeEach(async () => {
  daemon = fakeDaemon();
  plugin = await started();
  agentA = { id: "agent-a", workspaceId: "ws-1", parentAgentId: null, provider: "claude", cwd: "/work/a", title: "Parent" };
  // A sub-agent of A, in a directory of its own.
  childB = { id: "agent-b", workspaceId: "ws-1", parentAgentId: "agent-a", provider: "codex", cwd: "/work/b", title: "Child" };
});

/**
 * A tool call as the daemon makes it: the tool is the one the session-open hook gave the agent, and the context names the
 * agent. The input goes in as the caller wrote it, without the check the daemon makes first: whatever that check lets
 * through, the tool holds to its own rules.
 */
async function call(on: Started, name: string, input: unknown, agent: ToolAgent, signal = new AbortController().signal): Promise<AgentToolResult & { text: string }> {
  const opened = (await on.before("agent.session_open", sessionFor(agent), daemon.port)) as SessionOpenRequest;
  const tool = opened.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the session was not given ${name}`);
  const result = await tool.execute(input, { agent, paseo: daemon.port as unknown as AgentToolContext["paseo"], signal });
  if (typeof result.text !== "string") throw new Error(`${name} answered with no text`);
  return result as AgentToolResult & { text: string };
}

/** What a tool answered, read back. */
const answerOf = (result: { text: string }): Record<string, unknown> => JSON.parse(result.text) as Record<string, unknown>;

/** Submits to a request as the app does: sealed to its key, bound to the request and to the digest of what it asked for. */
async function submit(on: Started, requestId: string, values: PayloadEntry[]) {
  const record = on.registry.get(requestId) as RequestRecord;
  return on.registry.fulfill(requestId, seal(fromBase64Url(record.publicKey), encodeValues(values), buildAad(record.id, record.requestDigest)));
}

const anyInput = new Map<string, unknown>([
  ["request_secret", asking],
  ["request_status", { requestId: UNKNOWN_ID }],
  ["cancel_request", { requestId: UNKNOWN_ID }],
  ["release_secret", { requestId: UNKNOWN_ID }],
]);

/** What `request_status` says of the files of a delivered request: the path of each, and when they go. */
function filesOf(on: Started, requestId: string): { files: Record<string, string>; deleteBy: string } {
  const record = on.registry.get(requestId) as RequestRecord;
  const keys = record.written ?? [];
  return { files: Object.fromEntries(keys.map((key) => [key, filePath(on.files.drop, requestId, key)])), deleteBy: new Date(record.deleteBy as number).toISOString() };
}

/** A start-up held where it reads the requests, as a slow disk would hold it, until `release`. */
function holdTheLoad() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = Registry.prototype.load;
  vi.spyOn(Registry.prototype, "load").mockImplementation(async function (this: Registry) {
    await held;
    return load.call(this);
  });
  return release;
}

describe("the tools an agent is given", () => {
  const otherTool: AgentToolDefinition = { name: "other_tool", description: "a tool of another kind", input: z.object({}), execute: () => ({ text: "other" }) };
  const staleOwn: AgentToolDefinition = { name: "request_secret", description: "an older request_secret", input: z.object({}), execute: () => ({ text: "stale" }) };

  it("hands every agent the plugin's tools, keeps other plugins' tools and replaces an older set of its own", async () => {
    // Paseo 0.14 hands each plugin's hook an empty list and merges what the plugins return afterwards: whatever is in the
    // list stays, and a tool under one of the plugin's own names can only be an older one of its own.
    const answer = (await plugin.before("agent.session_open", { ...sessionOpen, tools: [otherTool, staleOwn] }, daemon.port)) as SessionOpenRequest;
    expect(answer.tools.map((tool) => tool.name)).toEqual(["other_tool", ...TOOL_NAMES]);
    expect(answer.tools).not.toContain(staleOwn);
    expect({ ...answer, tools: sessionOpen.tools }).toEqual({ ...sessionOpen, tools: sessionOpen.tools });
    // The daemon's API is taken from the hook, as from every other.
    expect(plugin.runtime.attached).toBe(true);
  });

  it("names its four tools, and describes them in the words the agent is given", async () => {
    expect(TOOL_NAMES).toEqual(["request_secret", "request_status", "cancel_request", "release_secret"]);
    const { tools } = (await plugin.before("agent.session_open", sessionOpen, daemon.port)) as SessionOpenRequest;
    const described = new Map(tools.map((tool) => [tool.name, tool.description]));
    expect(described.get("request_secret")).toBe(
      "Ask the human for secret values (passwords, API keys, tokens, private keys, connection strings, whole credential files) through a secure form in the Paseo app. " +
        "Each value is written, exactly as typed or as the file was, to its own short-lived file that only your OS user can read; you receive the paths, never the values. " +
        "Use this instead of asking for a secret in chat or asking the user to edit a file. " +
        'It returns at once with status "pending": end your turn, and a message with the paths arrives when the user has submitted. Do not poll. ' +
        "Never read, print, open, compare or log a file or directory whose name starts with si-secret-. " +
        "Move each value where it belongs without reading it (`command < PATH`, `cp PATH DESTINATION`), then delete the directory or call release_secret. " +
        "The files are deleted at the end of the turn the message starts, and 15 minutes after they were written at the latest.",
    );
    expect(described.get("request_status")).toBe(
      "The state of one of your requests, its keys and whether a second submission reached it; while its files exist, the path of each file and when they are deleted. Never returns values. " +
        "Use it when the user says no form appeared or that they answered and you heard nothing; it is not for polling.",
    );
    expect(described.get("release_secret")).toBe(
      "Delete the files of one of your delivered requests now, once each value is where it belongs. The same as deleting its directory. " +
        "Without it the files go at the end of the turn the message started, or after 15 minutes.",
    );
    expect(described.get("cancel_request")).toBe(
      "Withdraw one of your own pending requests, when the values are no longer needed. " +
        "Never use it to clear request_already_pending for a request the user may be answering: wait for that request instead.",
    );
    // The input of request_secret is described member by member, in the schema the daemon hands on.
    const secret = tools.find((tool) => tool.name === "request_secret") as AgentToolDefinition;
    const wire = JSON.stringify(toJsonSchemaCompat(secret.input, { strictUnions: true, pipeStrategy: "input" }));
    for (const words of ["Why you need the values, in one sentence.", "each becomes a file named after it", "letters, digits and _", "a screen reader reads it", "it then gets no file", "it may be binary", "is checked in the app before it is sent"]) {
      expect(wire, words).toContain(words);
    }
    const said = JSON.stringify(tools.map(({ name, title, description }) => ({ name, title, description })));
    // Nothing the agent is told, of any tool, speaks of a destination of v1's any more, or of its tool for commands.
    expect(said).not.toMatch(/template|dotenv|sink|allowExtraRows|\.env|list_commands|written straight/i);
  });

  it("describes each input so that Paseo 0.14 can build its own check from it, and that check refuses a claim too", async () => {
    const { tools } = (await plugin.before("agent.session_open", sessionOpen, daemon.port)) as SessionOpenRequest;
    expect(tools).toHaveLength(TOOL_NAMES.length);
    for (const tool of tools) {
      // What the plugin process sends the daemon for a tool (server `plugins/agent-tools.ts`, `serializeAgentTool`), and
      // the check the daemon builds from it for the calls (`agent/tools/plugin-tools.ts`). A schema that fails either way
      // fails the opening of every agent's session.
      const wire = toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" });
      const daemonCheck = z.fromJSONSchema(wire as Parameters<typeof z.fromJSONSchema>[0]);
      const input = anyInput.get(tool.name) as Record<string, unknown>;
      expect(daemonCheck.safeParse(input).success, tool.name).toBe(true);
      expect(tool.input.safeParse(input).success, tool.name).toBe(true);
      // A claim of who is asking, and what v1 took: a destination, and the switch for rows of the human's.
      for (const claim of [{ agentId: "agent-a" }, { agent: { id: "agent-a" } }, { cwd: "/etc" }, { allowExtraRows: true }, { sink: { kind: "dotenv", path: ".env" } }]) {
        const claimed = { ...input, ...claim };
        expect(daemonCheck.safeParse(claimed).success, `${tool.name}, by the daemon: ${JSON.stringify(claim)}`).toBe(false);
        expect(tool.input.safeParse(claimed).success, `${tool.name}: ${JSON.stringify(claim)}`).toBe(false);
      }
    }
  });
});

describe("whose request it is", () => {
  it("makes a request as the agent the daemon names, and a sub-agent's as its own", async () => {
    const b = JSON.parse((await call(plugin, "request_secret", asking, childB)).text) as { requestId: string };
    expect(plugin.registry.get(b.requestId)).toMatchObject({ agentId: "agent-b", agentCwd: childB.cwd });
    await plugin.runtime.settled();
    expect(daemon.appended.map((entry) => entry.agentId)).toEqual(["agent-b"]);
    for (const name of ["request_status", "cancel_request", "release_secret"]) {
      expect(await call(plugin, name, { requestId: b.requestId }, agentA)).toEqual({ isError: true, text: JSON.stringify({ error: "invalid_request", message: "invalid_request: unknown request" }) });
    }

    // The parent's own request is the parent's, and the child does not reach it either.
    const a = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(plugin.registry.get(a.requestId)).toMatchObject({ agentId: "agent-a", agentCwd: agentA.cwd, agentTitle: "Parent" });
    for (const name of ["request_status", "cancel_request", "release_secret"]) {
      expect(await call(plugin, name, { requestId: a.requestId }, childB)).toEqual({ isError: true, text: refusal("invalid_request", "unknown request") });
    }
    // Each reaches its own.
    expect(answerOf(await call(plugin, "request_status", { requestId: b.requestId }, childB))).toMatchObject({ requestId: b.requestId, state: "pending" });
    expect(answerOf(await call(plugin, "cancel_request", { requestId: b.requestId }, childB))).toEqual({ requestId: b.requestId, state: "cancelled" });
    expect(plugin.registry.get(a.requestId)?.state).toBe("pending");
  });

  it("refuses release_secret and request_status from the parent of the sub-agent whose files they are, and leaves the files", async () => {
    // The daemon names the child for the child's calls, and its parent is another agent.
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, childB)) as { requestId: string };
    expect(await submit(plugin, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    const check = vi.spyOn(plugin.registry, "check");
    const release = vi.spyOn(plugin.registry, "release");
    // The child moved the value and deleted the directory: a look from the parent would release the request, and must not be made.
    rmSync(setPath(plugin.files.drop, requestId), { recursive: true });
    for (const name of ["release_secret", "request_status"]) {
      expect(await call(plugin, name, { requestId }, agentA), name).toEqual({ isError: true, text: refusal("invalid_request", "unknown request") });
    }
    expect(check).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(plugin.registry.get(requestId)?.state).toBe("delivered");
    // The child's own look finds the files gone.
    expect(answerOf(await call(plugin, "request_status", { requestId }, childB))).toMatchObject({ requestId, state: "released", files: null, deleteBy: null });
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });

    // And a set that is there: the parent cannot take it away, the child can.
    const second = answerOf(await call(plugin, "request_secret", asking, childB)) as { requestId: string };
    expect(await submit(plugin, second.requestId, [{ key: "A", value: `${CANARY}-2` }])).toEqual({ ok: true, state: "delivered" });
    expect(await call(plugin, "release_secret", { requestId: second.requestId }, agentA)).toEqual({ isError: true, text: refusal("invalid_request", "unknown request") });
    expect(existsSync(setPath(plugin.files.drop, second.requestId))).toBe(true);
    expect(answerOf(await call(plugin, "release_secret", { requestId: second.requestId }, childB))).toEqual({ requestId: second.requestId, state: "released" });
    expect(existsSync(setPath(plugin.files.drop, second.requestId))).toBe(false);
  });

  it("keeps two agents that call at once apart: each request, and each card, is its caller's", async () => {
    const agentC: ToolAgent = { id: "agent-c", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/work/c", title: null };
    const [fromA, fromC] = await Promise.all([call(plugin, "request_secret", asking, agentA), call(plugin, "request_secret", asking, agentC)]);
    const a = answerOf(fromA).requestId as string;
    const c = answerOf(fromC).requestId as string;
    expect(plugin.registry.get(a)).toMatchObject({ agentId: "agent-a", agentCwd: agentA.cwd });
    expect(plugin.registry.get(c)).toMatchObject({ agentId: "agent-c", agentCwd: agentC.cwd, agentTitle: null });
    await plugin.runtime.settled();
    expect(daemon.appended.map((entry) => `${entry.agentId}:${entry.item.id}`).sort()).toEqual([`agent-a:${a}`, `agent-c:${c}`].sort());
  });

  it("reads nothing the agent's process claims: an input that names an agent is refused and makes no request", async () => {
    const first = await call(plugin, "request_secret", { ...asking, agentId: "agent-a" }, childB);
    expect(first).toEqual({ isError: true, text: refusal("invalid_request", 'request: Unrecognized key: "agentId"') });
    for (const claim of [{ agent: { id: "agent-a" } }, { agentCwd: agentA.cwd }, { identity: { agentId: "agent-a" } }]) {
      const answer = await call(plugin, "request_secret", { ...asking, ...claim }, childB);
      expect(answer.isError, JSON.stringify(claim)).toBe(true);
      expect(answerOf(answer).error, JSON.stringify(claim)).toBe("invalid_request");
    }
    expect(readFileSync(join(plugin.dataDir, "requests.json"), "utf8")).toBe("[]");
    await plugin.runtime.settled();
    expect(daemon.appended).toEqual([]);
  });

  it("hands the registry the identity the daemon gave, and the agent the registry's refusal of it unchanged", async () => {
    expect(identityOf(agentA)).toEqual({ agentId: "agent-a", cwd: agentA.cwd, title: "Parent" });
    // What the registry says of an identity it cannot take is what the agent hears: nothing is rewritten here.
    const odd: ToolAgent = { ...agentA, id: `agent${BIDI}` };
    expect(await call(plugin, "request_secret", asking, odd)).toEqual({ isError: true, text: refusal("invalid_request", "the agent's identity cannot be stored") });
    const relative: ToolAgent = { ...agentA, id: "agent-r", cwd: "relative/dir" };
    expect(await call(plugin, "request_secret", asking, relative)).toEqual({ isError: true, text: refusal("invalid_request", "the agent's identity cannot be stored") });
    expect(readFileSync(join(plugin.dataDir, "requests.json"), "utf8")).toBe("[]");
  });
});

describe("what a tool answers", () => {
  it("answers a request with its id and what to do next, as text and as structured content alike", async () => {
    const created = await call(plugin, "request_secret", asking, agentA);
    const answer = answerOf(created);
    expect(answer).toEqual({ status: "pending", requestId: expect.stringMatching(/^r_[0-9a-f]{32}$/), next: "End your turn now. You will receive a message when the user has submitted. Do not poll." });
    expect(created.structuredContent).toEqual(answer);
    expect(created.isError).toBeUndefined();
    const status = await call(plugin, "request_status", { requestId: answer.requestId }, agentA);
    expect(answerOf(status)).toEqual({ requestId: answer.requestId, state: "pending", keys: ["A"], written: null, tamper: false, errorCode: null, files: null, deleteBy: null });
    expect(status.structuredContent).toEqual(answerOf(status));
  });

  it("refuses a request that names a destination or allowExtraRows, with the code of any other request it cannot take, and makes none", async () => {
    // v1 took both. A destination is no more, and the human may always add keys of their own.
    const destination = await call(plugin, "request_secret", { reason: "why", sink: { kind: "dotenv", path: ".env.local", dialect: "dotenv" }, fields: [{ key: "A" }] }, agentA);
    expect(destination).toEqual({ isError: true, text: refusal("invalid_request", 'request: Unrecognized key: "sink"') });
    expect(destination.structuredContent).toBeUndefined();
    expect(await call(plugin, "request_secret", { ...asking, allowExtraRows: true }, agentA)).toEqual({
      isError: true,
      text: refusal("invalid_request", 'request: Unrecognized key: "allowExtraRows"'),
    });
    expect(await call(plugin, "request_secret", { fields: [{ key: "API_KEY" }, { key: "api_key" }] }, agentA)).toEqual({
      isError: true,
      text: refusal("invalid_request", "request: field keys must differ in more than letter case"),
    });
    expect(readFileSync(join(plugin.dataDir, "requests.json"), "utf8")).toBe("[]");
    await plugin.runtime.settled();
    expect(daemon.appended).toEqual([]);
    // The agent has no open request for it: the next one it makes is taken.
    expect(answerOf(await call(plugin, "request_secret", asking, agentA)).status).toBe("pending");
  });

  it("tells the owner the state, the keys asked for, the keys written as files, the path of each and when they go, and no value", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", { fields: [{ key: "A" }, { key: "OPT", optional: true }, { key: "SA", kind: "file" }] }, agentA)) as { requestId: string };
    expect(await submit(plugin, requestId, [{ key: "A", value: CANARY }, { key: "SA", file: "e30" }, { key: "MINE", value: `${CANARY}-mine` }])).toEqual({ ok: true, state: "delivered" });
    const status = await call(plugin, "request_status", { requestId }, agentA);
    const record = plugin.registry.get(requestId) as RequestRecord;
    expect(answerOf(status)).toEqual({
      requestId,
      state: "delivered",
      keys: ["A", "OPT", "SA"],
      written: ["A", "SA", "MINE"],
      tamper: false,
      errorCode: null,
      files: { A: filePath(plugin.files.drop, requestId, "A"), SA: filePath(plugin.files.drop, requestId, "SA"), MINE: filePath(plugin.files.drop, requestId, "MINE") },
      deleteBy: new Date(record.deleteBy as number).toISOString(),
    });
    // In the order they were written, and when the set goes: the deadline the record keeps, 15 minutes after the write.
    expect(Object.keys(answerOf(status).files as object)).toEqual(["A", "SA", "MINE"]);
    expect(Date.parse(answerOf(status).deleteBy as string)).toBe(record.deleteBy);
    expect(status.structuredContent).toEqual(answerOf(status));
    expect(JSON.stringify(status)).not.toContain("CANARY");
  });

  it("says released, with no files and no deadline, once the agent deleted the set itself", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(await submit(plugin, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    rmSync(setPath(plugin.files.drop, requestId), { recursive: true });
    expect(answerOf(await call(plugin, "request_status", { requestId }, agentA))).toEqual({
      requestId,
      state: "released",
      keys: ["A"],
      written: ["A"],
      tamper: false,
      errorCode: null,
      files: null,
      deleteBy: null,
    });
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
    // Released at the agent's word is the same, and asking again changes nothing.
    expect(answerOf(await call(plugin, "release_secret", { requestId }, agentA))).toEqual({ requestId, state: "released" });
  });

  it("releases the owner's delivered files, and refuses a request with no files in the plugin's words", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(await call(plugin, "release_secret", { requestId }, agentA)).toEqual({ isError: true, text: refusal("invalid_request", "the request has no files to release") });
    expect(await submit(plugin, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    const released = await call(plugin, "release_secret", { requestId }, agentA);
    expect(answerOf(released)).toEqual({ requestId, state: "released" });
    expect(released.structuredContent).toEqual({ requestId, state: "released" });
    expect(existsSync(setPath(plugin.files.drop, requestId))).toBe(false);
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
  });

  it("tells the owner that a second, different submission reached a request whose values were delivered", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(await submit(plugin, requestId, [{ key: "A", value: "first-typed" }])).toMatchObject({ ok: true });
    expect(answerOf(await call(plugin, "request_status", { requestId }, agentA))).toMatchObject({ state: "delivered", tamper: false });
    expect(await submit(plugin, requestId, [{ key: "A", value: `${CANARY}-second` }])).toMatchObject({ ok: false, code: "request_closed" });
    const flagged = await call(plugin, "request_status", { requestId }, agentA);
    expect(answerOf(flagged)).toEqual({ requestId, state: "delivered", keys: ["A"], written: ["A"], tamper: true, errorCode: null, ...filesOf(plugin, requestId) });
    expect(JSON.stringify(flagged)).not.toContain(CANARY);
    expect(JSON.stringify(flagged)).not.toContain("first-typed");
  });

  it("tells the owner why a request was rejected, by its code", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(await submit(plugin, requestId, [{ key: "A", value: CANARY }, { key: "a", value: `${CANARY}-row` }])).toMatchObject({ ok: false, code: "invalid_request" });
    expect(answerOf(await call(plugin, "request_status", { requestId }, agentA))).toEqual({ requestId, state: "rejected", keys: ["A"], written: null, tamper: false, errorCode: "invalid_request", files: null, deleteBy: null });
  });

  it("answers a stranger and an unknown request alike, so a request id cannot be probed, and cancels, releases or looks at nothing for either", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    const cancel = vi.spyOn(plugin.registry, "cancel");
    const release = vi.spyOn(plugin.registry, "release");
    const check = vi.spyOn(plugin.registry, "check");
    const unknown = { isError: true, text: refusal("invalid_request", "unknown request") };
    for (const name of ["request_status", "cancel_request", "release_secret"]) {
      expect(await call(plugin, name, { requestId }, childB), name).toEqual(unknown);
      expect(await call(plugin, name, { requestId: UNKNOWN_ID }, agentA), name).toEqual(unknown);
    }
    expect(cancel).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(plugin.registry.get(requestId)?.state).toBe("pending");
  });

  it("gives the plugin's refusal with its words, and anything else as a fixed refusal with nothing of its message", async () => {
    expect(await toolResult(async () => Promise.reject(new SecureInputError("invalid_request", "A and a differ only in letter case")))).toEqual({
      isError: true,
      text: refusal("invalid_request", "A and a differ only in letter case"),
    });
    expect(await toolResult(async () => Promise.reject(new SecureInputError("request_closed")))).toEqual({ isError: true, text: JSON.stringify({ error: "request_closed", message: "request_closed" }) });
    const fixed = { isError: true, text: refusal("service_unavailable", NOT_HANDLED) };
    expect(await toolResult(async () => Promise.reject(new Error(`library said ${CANARY}`)))).toEqual(fixed);
    expect(
      await toolResult(() => {
        throw `thrown as it is: ${CANARY}`;
      }),
    ).toEqual(fixed);
    // An answer JSON cannot carry is no answer either.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await toolResult(async () => cyclic)).toEqual(fixed);
    expect(await toolResult(async () => () => CANARY)).toEqual(fixed);
    expect(await toolResult(async () => ({ requestId: "r_1", state: "pending" }))).toEqual({ text: '{"requestId":"r_1","state":"pending"}', structuredContent: { requestId: "r_1", state: "pending" } });

    // Through a tool: the registry's own refusals carry their words, and a library's failure in it carries none.
    const first = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(await call(plugin, "request_secret", asking, agentA)).toEqual({ isError: true, text: refusal("request_already_pending", first.requestId) });
    vi.spyOn(plugin.registry, "create").mockRejectedValue(new Error(`library said ${CANARY}`));
    const failed = await call(plugin, "request_secret", asking, childB);
    expect(failed).toEqual(fixed);
    expect(JSON.stringify(failed)).not.toContain("CANARY");
  });
});

describe("a call while the plugin starts, and after a start that failed", () => {
  it("waits for a start-up under way, and refuses in fixed words after one that failed", async () => {
    // Held where it reads the requests: the call waits for the start-up, within the bound, and is then made.
    const release = holdTheLoad();
    const waiting = await started({}, false);
    const asked = call(waiting, "request_secret", asking, agentA);
    expect(await promptly(asked, SHORT * 4)).toBe("hung");
    release();
    const made = answerOf(await asked) as { status: string; requestId: string };
    expect(made.status).toBe("pending");
    expect(waiting.registry.get(made.requestId)).toMatchObject({ agentId: "agent-a" });
    vi.restoreAllMocks();

    // Held past the bound: no tool waits for it longer, and each says so in fixed words.
    const releaseLater = holdTheLoad();
    const stuck = await started({ startupWaitMs: SHORT }, false);
    try {
      for (const name of TOOL_NAMES) {
        expect(await call(stuck, name, anyInput.get(name), agentA), name).toEqual({ isError: true, text: refusal("service_unavailable", NOT_STARTED) });
      }
      expect(stuck.registry.get(UNKNOWN_ID)).toBeUndefined();
    } finally {
      releaseLater();
      await stuck.ready;
    }
    vi.restoreAllMocks();

    // A start-up that failed: a data directory that is a link. Every tool refuses, in words that send the agent to the user.
    const parent = tempDir();
    mkdirSync(join(parent, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(parent, "elsewhere"), join(parent, "secure-input"));
    const failed = await started({ dataDir: join(parent, "secure-input") });
    expect(failed.status.problem).toEqual({ code: "service_unavailable", detail: "the data directory is not a private directory of this user" });
    for (const name of TOOL_NAMES) {
      expect(await call(failed, name, anyInput.get(name), agentA), name).toEqual({ isError: true, text: refusal("service_unavailable", START_FAILED("service_unavailable")) });
    }
    expect(START_FAILED("service_unavailable")).toBe("the plugin did not start (service_unavailable). Tell the user. Do not ask for the secret in chat instead.");
    // The daemon's API was taken all the same.
    expect(failed.runtime.attached).toBe(true);
  });
});

describe("a call that waits for its turn in the work queue", () => {
  /** Holds each call of `method` of every drop store where it begins, until `open`: a disk that stalls. */
  function holdTheStore(method: "write" | "release") {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const at = { reached: false };
    const original = DropStore.prototype[method] as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(DropStore.prototype, method).mockImplementation(async function (this: DropStore, ...args: unknown[]) {
      at.reached = true;
      await held;
      return original.apply(this, args);
    } as never);
    return { at, open };
  }

  /** The queue held by a submission of agent B's whose set is being written, until `open`. */
  async function busyQueue(on: Started) {
    const { requestId } = answerOf(await call(on, "request_secret", asking, childB)) as { requestId: string };
    const writes = holdTheStore("write");
    const submitted = submit(on, requestId, [{ key: "A", value: CANARY }]);
    await vi.waitFor(() => expect(writes.at.reached).toBe(true), { timeout: 5000 });
    return { requestId, submitted, open: writes.open };
  }

  /** The agents the saved requests belong to. */
  const owners = (on: Started) => (JSON.parse(readFileSync(join(on.dataDir, "requests.json"), "utf8")) as RequestRecord[]).map((record) => record.agentId);

  it("skips the operation of a call that was canceled while it waited: no key, no request, no card, later or ever", async () => {
    const busy = await busyQueue(plugin);
    const controller = new AbortController();
    const asked = call(plugin, "request_secret", asking, agentA, controller.signal);
    expect(await promptly(asked, SHORT)).toBe("hung");
    controller.abort();
    // Answered at once, in fixed words: the daemon drops what a canceled call answers, and the plugin does not wait for it.
    expect(await promptly(asked, SHORT * 4)).toEqual({ isError: true, text: refusal("service_unavailable", CANCELED) });
    // A call canceled before it was made waits for nothing.
    const before = new AbortController();
    before.abort();
    expect(await promptly(call(plugin, "request_secret", asking, agentA, before.signal), SHORT * 4)).toEqual({ isError: true, text: refusal("service_unavailable", CANCELED) });
    busy.open();
    expect(await busy.submitted).toEqual({ ok: true, state: "delivered" });
    // An operation queued after them: by the time it has its answer, the skipped ones had their turns.
    expect(answerOf(await call(plugin, "request_status", { requestId: busy.requestId }, childB))).toMatchObject({ state: "delivered" });
    expect(owners(plugin)).toEqual(["agent-b"]);
    expect((plugin.registry as unknown as { keys: Map<string, Uint8Array> }).keys.size).toBe(0);
    await plugin.runtime.settled();
    expect(daemon.appended.filter((entry) => entry.agentId === "agent-a")).toEqual([]);
    // Nothing holds the agent's one pending request: its next one is taken.
    expect(answerOf(await call(plugin, "request_secret", asking, agentA)).status).toBe("pending");
  });

  it("refuses in fixed words each call whose turn has not come within the bound, and does nothing of it later", async () => {
    const bounded = await started({ admissionWaitMs: SHORT });
    // Agent A's requests, as each tool would find them: a delivered set the agent deleted (a look would release it), a
    // delivered set that is there (a release would take it), and a request that waits (a cancel would end it).
    const deliver = async () => {
      const { requestId } = answerOf(await call(bounded, "request_secret", asking, agentA)) as { requestId: string };
      expect(await submit(bounded, requestId, [{ key: "A", value: `${CANARY}-${requestId}` }])).toEqual({ ok: true, state: "delivered" });
      return requestId;
    };
    const looked = await deliver();
    const kept = await deliver();
    const waiting = (answerOf(await call(bounded, "request_secret", asking, agentA)) as { requestId: string }).requestId;
    rmSync(setPath(bounded.files.drop, looked), { recursive: true });
    const agentC: ToolAgent = { ...agentA, id: "agent-c", title: null };
    const busy = await busyQueue(bounded);
    const BUSY_REFUSAL = { isError: true, text: refusal("service_unavailable", BUSY) };
    const calls: Array<[string, unknown, ToolAgent]> = [
      ["request_secret", asking, agentC],
      ["request_status", { requestId: looked }, agentA],
      ["cancel_request", { requestId: waiting }, agentA],
      ["release_secret", { requestId: kept }, agentA],
    ];
    for (const [name, input, agent] of calls) expect(await promptly(call(bounded, name, input, agent), SHORT * 20), name).toEqual(BUSY_REFUSAL);
    busy.open();
    expect(await busy.submitted).toEqual({ ok: true, state: "delivered" });
    expect(answerOf(await call(bounded, "request_status", { requestId: busy.requestId }, childB))).toMatchObject({ state: "delivered" });
    // Nothing of the four happened once the queue came to them.
    expect(owners(bounded)).not.toContain("agent-c");
    expect(bounded.registry.get(looked)?.state).toBe("delivered");
    expect(bounded.registry.get(waiting)?.state).toBe("pending");
    expect(bounded.registry.get(kept)?.state).toBe("delivered");
    expect(existsSync(setPath(bounded.files.drop, kept))).toBe(true);
    await bounded.runtime.settled();
    expect(daemon.appended.filter((entry) => entry.agentId === "agent-c")).toEqual([]);
  });

  it("waits to the end for an operation that had begun when its call was canceled, and its effect is whole", async () => {
    const { requestId } = answerOf(await call(plugin, "request_secret", asking, agentA)) as { requestId: string };
    expect(await submit(plugin, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    const removal = holdTheStore("release");
    const controller = new AbortController();
    const asked = call(plugin, "release_secret", { requestId }, agentA, controller.signal);
    await vi.waitFor(() => expect(removal.at.reached).toBe(true), { timeout: 5000 });
    controller.abort();
    // Begun: the call is not let go of while the removal it began goes on.
    expect(await promptly(asked, SHORT * 4)).toBe("hung");
    removal.open();
    expect(answerOf(await asked)).toEqual({ requestId, state: "released" });
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect((JSON.parse(readFileSync(join(plugin.dataDir, "requests.json"), "utf8")) as RequestRecord[]).find((record) => record.id === requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(existsSync(setPath(plugin.files.drop, requestId))).toBe(false);
  });
});

describe("the session-open hook", () => {
  it("answers at once while the start-up is held: the opening of an agent's session never waits for the plugin", async () => {
    const release = holdTheLoad();
    const waiting = await started({}, false);
    try {
      const opened = await promptly(waiting.before("agent.session_open", sessionFor(agentA), daemon.port), SHORT);
      expect(opened).not.toBe("hung");
      expect((opened as SessionOpenRequest).tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    } finally {
      release();
      await waiting.ready;
    }
  });

  it("never fails a session: tools that cannot be built leave the request as it came", async () => {
    const logs: string[] = [];
    const parts = assemble(optionsFor({}, logs));
    const hostFake = fakeHost();
    registerHooks(hostFake.host, {
      runtime: parts.runtime,
      turns: parts.registry,
      tools: () => {
        throw new Error(`cannot build ${CANARY}`);
      },
      failed: parts.failed,
    });
    const request = sessionFor(agentA);
    expect(await hostFake.before("agent.session_open", request, daemon.port)).toBe(request);
    expect(parts.status.lastHookFailure).toBe("agent.session_open: unexpected");
    expect(logs).toEqual(["secure-input: hook_failed agent.session_open unexpected"]);
    expect(parts.runtime.attached).toBe(true);

    // A request that is not what the SDK declares (no list of tools in it) goes back as it came, too.
    for (const payload of [{}, { ...request, tools: null }, { ...request, tools: "x" }, { ...request, tools: [null] }] as unknown[]) {
      expect(await plugin.before("agent.session_open", payload, daemon.port), JSON.stringify(payload)).toBe(payload);
    }
    expect(plugin.status.lastHookFailure).toBe("agent.session_open: unexpected");
    expect(plugin.logs).toEqual(Array.from({ length: 4 }, () => "secure-input: hook_failed agent.session_open unexpected"));
  });
});
