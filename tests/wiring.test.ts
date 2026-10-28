import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { AgentToolContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { continuationText, shellPath, tamperText } from "../server/core/continuation";
import { FLUSH_BUDGET_MS, PORT_TIMEOUT_MS } from "../server/core/outbox";
import { DROP_SWEEP_BOUND_MS, HISTORY, Registry, SHUTDOWN_BOUND_MS, type RequestRecord } from "../server/core/registry";
import { canDeleteAll, statusRows } from "../client/diagnostics-rows";
import { buildView } from "../server/core/view";
import { filePath, setPath } from "../server/io/drop";
import { LEGACY_STUB_SOURCE } from "../server/io/legacy-shim";
import { TIMED_OUT, within } from "../server/paseo/bounded";
import { registerHandlers } from "../server/paseo/handlers";
import { RELEASE_WAIT_MS, registerHooks, type SessionOpenRequest } from "../server/paseo/hooks";
import {
  DISPOSE_BOUND_MS,
  EXPIRY_INTERVAL_MS,
  PASEO_STOP_WINDOW_MS,
  STARTUP_WAIT_MS,
  assemble,
  defaultOptions,
  describeRuntime,
  startPlugin,
  type PluginHost,
  type PluginOptions,
} from "../server/paseo/plugin";
import { MAX_UNSETTLED_APPENDS, Runtime, SETTLE_BOUND_MS, SLOW_RETRY_TICKS, type DaemonPort, type TimelineItem } from "../server/paseo/runtime";
import { TOOL_NAMES, type ToolAgent } from "../server/paseo/tools";
import { fromBase64Url, toBase64Url } from "../shared/bytes";
import { CARD_KIND, CARD_VERSION, CardDataSchema } from "../shared/card";
import {
  DiagnosticsSchema,
  ENVELOPE_CT_MAX,
  clearDrop,
  declineRequest,
  fulfillRequest,
  getRequest,
  readDiagnostics,
  selfTestBegin,
  selfTestFinish,
} from "../shared/contracts";
import { ERROR_CODES, SecureInputError } from "../shared/errors";
import { LIMITS, type InputRequest } from "../shared/request";
import { buildAad, digestHex, encodeValues, generateRequestKeyPair, seal, type PayloadEntry } from "../shared/seal";
import { RequestViewSchema, type RequestView } from "../shared/view";
import { codeOfAsync, leaksOf, promptly, rejectionOf, searchable, tempDir } from "./helpers";

const CANARY = "CANARY-sk_live_4242";
const BIDI = String.fromCodePoint(0x202e);
const NUL = String.fromCharCode(0);
const NODE = { kind: "node", execPath: process.execPath } as const;
const SHORT = 50;
/** The tests that seal a 12 MB payload, with room for a loaded machine. */
const LONG = 30_000;

// ---------------------------------------------------------------------------------------------------------------
// The external boundary: the Paseo daemon API, the server context and the hook context. Small hand-written fakes,
// typed against what the SDK declares (the daemon port is the part of `PaseoApi` the plugin calls, and the real API
// is checked against it where a handler passes its context on).
// ---------------------------------------------------------------------------------------------------------------

/** An agent as the daemon's API shows it to the plugin: its status. Who an agent is, and where it works, comes with a tool call. */
interface FakeAgent {
  status: string;
}

interface FakeDaemonBehaviour {
  refresh?: (agentId: string) => Promise<unknown>;
  append?: (agentId: string, item: TimelineItem) => Promise<unknown>;
}

function fakeDaemon(agents: Record<string, FakeAgent | undefined>, behaviour: FakeDaemonBehaviour = {}) {
  const appended: Array<{ agentId: string; item: TimelineItem }> = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  // Cards and messages: whatever the plugin appended or sent is searched for what the test typed, when the test is over.
  said.push(() => [...appended.map((entry) => JSON.stringify(entry)), ...sent.map((entry) => JSON.stringify(entry))]);
  const port: DaemonPort = {
    agents: {
      ref(agentId) {
        const handle = {
          status: null as string | null,
          refresh: async (): Promise<unknown> => {
            if (behaviour.refresh) return behaviour.refresh(agentId);
            const agent = agents[agentId];
            if (agent === undefined) throw new Error("no such agent");
            handle.status = agent.status;
            return null;
          },
          send: async (text: string) => void sent.push({ agentId, text }),
          timeline: {
            append: async (item: TimelineItem): Promise<unknown> => {
              if (behaviour.append) return behaviour.append(agentId, item);
              appended.push({ agentId, item });
              return { seq: appended.length, epoch: "e" };
            },
          },
        };
        return handle;
      },
    },
  };
  return { port, appended, sent, agents };
}

type Handler = (input: never, context: never) => unknown;

/** The server context the daemon gives a plugin: it records what is registered and lets a test invoke it the way the daemon does. */
function fakeHost() {
  const rpc = new Map<string, { contract: PluginRpcContract; handler: Handler }>();
  const befores = new Map<string, Handler>();
  const events = new Map<string, Handler>();
  const host: PluginHost = {
    handle: (contract, handler) => void rpc.set(contract.name, { contract, handler }),
    before: (name, handler) => {
      befores.set(name, handler);
      return () => undefined;
    },
    on: (name, handler) => {
      events.set(name, handler);
      return () => undefined;
    },
  };
  // The one cast: the SDK's context holds the whole client API, of which the plugin uses what DaemonPort lists.
  const context = (port: DaemonPort) => ({ paseo: port as unknown as PluginHandlerContext["paseo"], signal: new AbortController().signal });
  return {
    host,
    rpcNames: () => [...rpc.keys()].sort(),
    /** The round trip a real call makes: the input through the contract, the handler, the output through the contract. */
    async call(name: string, input: unknown, port: DaemonPort): Promise<unknown> {
      const entry = rpc.get(name);
      if (!entry) throw new Error(`no handler registered for ${name}`);
      const handler = entry.handler as (input: unknown, context: PluginHandlerContext) => unknown;
      // An answer is searched for what the test typed, and so is the text of a refusal.
      const answers: string[] = [];
      said.push(() => answers);
      try {
        const answer = entry.contract.output.parse(await handler(entry.contract.input.parse(input), context(port)));
        answers.push(JSON.stringify(answer));
        return answer;
      } catch (error) {
        answers.push(String((error as Error).message));
        throw error;
      }
    },
    async before(name: string, request: unknown, port: DaemonPort): Promise<unknown> {
      const handler = befores.get(name) as ((input: { request: unknown }, context: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`no before hook for ${name}`);
      return handler({ request }, context(port));
    },
    async emit(name: string, event: unknown, port: DaemonPort): Promise<void> {
      const handler = events.get(name) as ((event: unknown, context: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`no handler for ${name}`);
      await handler(event, context(port));
    },
    hasEvent: (name: string) => events.has(name),
    hasBefore: (name: string) => befores.has(name),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const running: Array<() => Promise<void>> = [];

// ---------------------------------------------------------------------------------------------------------------
// No typed value in anything the plugin says. A test types a value by sealing it (`sealFor`, which `submit` uses): that is
// where it is registered, so no test has to remember. When the test is over, everything the plugin put into a card, sent to
// an agent, logged or answered to a call is searched for each value, as typed and as JSON spells it.
// ---------------------------------------------------------------------------------------------------------------

/** What this test typed, and where to look for it: each source gives what its owner has said so far. */
const typed = new Set<string>();
const said: Array<() => readonly string[]> = [];

afterEach(async () => {
  for (const dispose of running.splice(0)) await dispose();
  const values = [...typed];
  const payloads = said.splice(0).flatMap((source) => source());
  typed.clear();
  expect(leaksOf(values, payloads)).toEqual([]);
});

function optionsFor(overrides: Partial<PluginOptions> = {}, logs: string[] = []): PluginOptions {
  said.push(() => logs);
  return {
    dataDir: tempDir(),
    runtime: NODE,
    log: (line) => void logs.push(line),
    daemonCallTimeoutMs: SHORT,
    ...overrides,
  };
}

/** The parts of the plugin, assembled and not started. */
function world(overrides: Partial<PluginOptions> = {}) {
  const logs: string[] = [];
  return { ...assemble(optionsFor(overrides, logs)), logs };
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

const asking = { reason: "why", fields: [{ key: "A" }] };

/** What a submission is sealed to: the request and the digest of what it asked for, from the form's view or from the record. */
type SealTarget = { id: string; publicKey: string; requestDigest: string };

/** Seals the way the dialog does, and registers what is typed to be searched for. */
const sealFor = (target: SealTarget, values: PayloadEntry[]) => {
  for (const entry of values) {
    if ("value" in entry) typed.add(searchable(entry.value));
    else if (entry.file.length >= 6) typed.add(entry.file);
  }
  return seal(fromBase64Url(target.publicKey), encodeValues(values), buildAad(target.id, target.requestDigest));
};

/** Submits the way the dialog does: the request as it is now, then the sealed values. */
async function submit(registry: Registry, requestId: string, values: PayloadEntry[]) {
  return registry.fulfill(requestId, sealFor(registry.get(requestId) as RequestRecord, values));
}

function plant(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
}

/** An outbox that takes everything and does nothing, for the tests that watch what the runtime asks of it. */
const inertOutbox = {
  attach: () => undefined,
  enqueue: async () => undefined,
  flush: async () => undefined,
  drop: async () => undefined,
  retire: () => undefined,
  stop: () => undefined,
};
/** The request the daemon sends the session-open hook when it opens an agent's session (Paseo 0.14). */
const opening = (agentId: string, cwd: string): SessionOpenRequest => ({
  agentId,
  workspaceId: null,
  provider: "claude",
  cwd,
  reason: "create",
  purpose: "interactive",
  title: null,
  labels: {},
  tools: [],
  env: {},
  mcpServers: {},
});

/** The agent the daemon names for a tool call. */
const agentNamed = (id: string, cwd: string, title: string | null = null): ToolAgent => ({ id, workspaceId: null, parentAgentId: null, provider: "claude", cwd, title });

/**
 * Opens the agent's session the way the daemon does, and gives back a way to call the tools it was given the way the
 * daemon calls them: with the agent it names. What a tool answers is searched for what the test typed.
 */
async function toolsOf(plugin: { before(name: string, request: unknown, port: DaemonPort): Promise<unknown> }, agent: ToolAgent, port: DaemonPort) {
  const opened = (await plugin.before("agent.session_open", { ...opening(agent.id, agent.cwd), provider: agent.provider, title: agent.title }, port)) as SessionOpenRequest;
  const answers: string[] = [];
  said.push(() => answers);
  return async (name: string, input: unknown): Promise<{ text: string; isError?: boolean; structuredContent?: unknown }> => {
    const tool = opened.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`the session was not given ${name}`);
    const result = await tool.execute(input, { agent, paseo: port as unknown as AgentToolContext["paseo"], signal: new AbortController().signal });
    answers.push(JSON.stringify(result));
    return { ...result, text: result.text ?? "" };
  };
}

/** What v1's bridge held, as far as these tests care: anything but the stub. */
const V1_BRIDGE = "// the bridge v1 installed\n";

/** `<data>/bin/` as v1 left it: its bridge, and the shim that runs it with the Node of that day. */
function plantV1(dataDir: string, node: string = process.execPath): void {
  const bin = join(dataDir, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, "bridge.cjs"), V1_BRIDGE, { mode: 0o700 });
  writeFileSync(join(bin, "secure-input"), `#!/bin/sh\nexec '${node}' '${join(bin, "bridge.cjs")}' "$@"\n`, { mode: 0o700 });
}

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: `r_${"7f3a".repeat(8)}`,
    agentId: "agent-1",
    agentCwd: "/work",
    agentTitle: null,
    request: { reason: "", fields: [{ key: "A" }] } satisfies InputRequest,
    state: "declined",
    publicKey: "A".repeat(43),
    requestDigest: "0".repeat(64),
    retries: 0,
    tamper: false,
    errorCode: null,
    fulfilledDigest: null,
    written: null,
    deleteBy: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------------------------------------------

describe("Runtime", () => {
  describe("the daemon API", () => {
    it("flushes the outbox once when the same API is handed over again, and again for another one", async () => {
      let flushes = 0;
      const outbox = { ...inertOutbox, flush: async () => void (flushes += 1) };
      const runtime = new Runtime(outbox, { callTimeoutMs: SHORT });
      const port = fakeDaemon({}).port;
      runtime.attach(port);
      runtime.attach(port);
      runtime.attach(port);
      await runtime.settled();
      expect(flushes).toBe(1);
      runtime.attach(fakeDaemon({}).port);
      await runtime.settled();
      expect(flushes).toBe(2);
    });

    it("waits for what is under way until it is stopped, and then for 300 milliseconds at most", async () => {
      expect(SETTLE_BOUND_MS).toBe(300);
      // The save of a message never ends, as on a disk that stalls.
      const stalled = { ...inertOutbox, enqueue: () => new Promise<void>(() => undefined) };
      const runtime = new Runtime(stalled, { callTimeoutMs: SHORT });
      runtime.publish(record({ state: "declined" }), "state");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let ended = false;
        const settled = runtime.settled().then(() => {
          ended = true;
        });
        await vi.advanceTimersByTimeAsync(10 * SETTLE_BOUND_MS);
        expect(ended).toBe(false); // not stopped: it waits for the work to end, as the tests of this file rely on

        runtime.stop();
        let endedAfterStop = false;
        const afterStop = runtime.settled().then(() => {
          endedAfterStop = true;
        });
        await vi.advanceTimersByTimeAsync(SETTLE_BOUND_MS - 1);
        expect(endedAfterStop).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await afterStop;
        expect(endedAfterStop).toBe(true);
        void settled;
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes the outbox on request, tells the caller when that fails, and goes on", async () => {
      let flushes = 0;
      let failing = true;
      const outbox = {
        ...inertOutbox,
        flush: async () => {
          flushes += 1;
          if (failing) throw new Error("flush failed");
        },
      };
      const runtime = new Runtime(outbox, { callTimeoutMs: SHORT });
      await expect(runtime.flushAll()).rejects.toThrow("flush failed");
      await expect(runtime.settled()).resolves.toBeUndefined();
      failing = false;
      await expect(runtime.flushAll()).resolves.toBeUndefined();
      expect(flushes).toBe(2);
    });

    it("calls an agent idle only when the daemon says so, and refuses to answer for one it cannot reach", async () => {
      const { runtime } = world();
      expect((await rejectionOf(runtime.isIdle("agent-1"))).code).toBe("unknown_agent");
      for (const [status, idle] of [["idle", true], ["running", false], ["initializing", false], ["error", false], ["closed", false]] as const) {
        runtime.attach(fakeDaemon({ "agent-1": { status } }).port);
        expect(await runtime.isIdle("agent-1"), status).toBe(idle);
      }
      runtime.attach(fakeDaemon({}).port);
      // The daemon's own refusal is passed on. The outbox takes it for no answer, and keeps what waits for the agent.
      expect((await rejectionOf(runtime.isIdle("agent-1"))).message).toBe("no such agent");
    });
  });

  describe("cards", () => {
    it("defers the card until the daemon API is captured, then shows the latest state once", async () => {
      const { runtime, registry } = world();
      const cwd = tempDir();
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await registry.decline(requestId);
      const daemon = fakeDaemon({ "agent-1": { status: "running" } });
      expect(daemon.appended).toEqual([]);
      runtime.attach(daemon.port);
      await runtime.settled();
      expect(daemon.appended).toHaveLength(1);
      expect(daemon.appended[0]).toMatchObject({ agentId: "agent-1", item: { type: "plugin", id: requestId, kind: CARD_KIND, version: CARD_VERSION, data: { state: "declined" } } });
    });

    it("carries no field a value could hide in", async () => {
      const { registry, runtime } = world();
      const cwd = tempDir();
      const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      const data = daemon.appended[0]?.item.data;
      expect(Object.keys(data as object).sort()).toEqual(["keys", "requestId", "state", "tamper", "updatedAt"]);
      expect(CardDataSchema.parse(data)).toMatchObject({ requestId, state: "pending", keys: ["A"] });
      expect(Object.keys(registry.get(requestId) as object)).not.toContain("values");
    });

    it("is version 2 of the card, and names the keys asked for and then the keys that were written", async () => {
      const { registry, runtime } = world();
      const daemon = fakeDaemon({ "agent-1": { status: "running" } });
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, { fields: [{ key: "A" }, { key: "OPT", optional: true }] });
      await runtime.settled();
      expect(await submit(registry, requestId, [{ key: "A", value: CANARY }, { key: "MINE", value: `${CANARY}-mine` }])).toEqual({ ok: true, state: "delivered" });
      await runtime.settled();
      expect(daemon.appended.map((entry) => [entry.item.kind, entry.item.version, CardDataSchema.parse(entry.item.data).state, CardDataSchema.parse(entry.item.data).keys])).toEqual([
        [CARD_KIND, 2, "pending", ["A", "OPT"]],
        [CARD_KIND, 2, "delivered", ["A", "MINE"]],
      ]);
      expect(CARD_VERSION).toBe(2);
    });

    it("gives up on an append that never settles and goes on with the next card", async () => {
      const { runtime, registry, logs } = world();
      const cwd = tempDir();
      let calls = 0;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            calls += 1;
            if (calls === 1) return new Promise(() => undefined);
            daemon.appended.push({ agentId, item });
            return Promise.resolve({ seq: calls, epoch: "e" });
          },
        },
      );
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      expect(daemon.appended).toEqual([]);
      await registry.decline(requestId);
      await runtime.settled();
      expect(daemon.appended).toHaveLength(1);
      expect(daemon.appended[0]?.item.data).toMatchObject({ state: "declined" });
      expect(logs).toContain("secure-input: daemon_timeout");
    });

    it("goes on after an append that fails", async () => {
      const { runtime, registry, logs } = world();
      const cwd = tempDir();
      let calls = 0;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            calls += 1;
            if (calls === 1) return Promise.reject(new Error("agent is gone"));
            daemon.appended.push({ agentId, item });
            return Promise.resolve({ seq: calls, epoch: "e" });
          },
        },
      );
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await registry.decline(requestId);
      await runtime.settled();
      expect(daemon.appended).toHaveLength(1);
      expect(logs).toContain("secure-input: card_failed");
    });
  });

  describe("a card that could not be appended", () => {
    const states = (rows: Array<{ item: TimelineItem }>) => rows.map((row) => (row.item.data as { state: string }).state);
    const failedCards = (logs: string[]) => logs.filter((line) => line === "secure-input: card_failed").length;

    it("is still owed, and is appended on a later tick though nothing else about the request changes", async () => {
      const { runtime, registry, logs } = world();
      const cwd = tempDir();
      let failing = 2;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            if (failing > 0) {
              failing -= 1;
              return Promise.reject(new Error("the daemon could not take it just now"));
            }
            daemon.appended.push({ agentId, item });
            return Promise.resolve({ seq: 1, epoch: "e" });
          },
        },
      );
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      // The human has no card: the form cannot be reached, and the request is open.
      expect(daemon.appended).toEqual([]);
      expect(runtime.cardsOwed).toBe(1);
      expect(registry.get(requestId)?.state).toBe("pending");

      await runtime.flushAll(); // the tick; the daemon still refuses
      await runtime.settled();
      expect(daemon.appended).toEqual([]);
      expect(runtime.cardsOwed).toBe(1);

      await runtime.flushAll(); // the next tick
      await runtime.settled();
      expect(states(daemon.appended)).toEqual(["pending"]);
      expect(daemon.appended[0]?.item.id).toBe(requestId);
      expect(runtime.cardsOwed).toBe(0);
      // Said once for the state, not once for every try.
      expect(failedCards(logs)).toBe(1);
      // Nothing is owed, so nothing is appended again.
      await runtime.flushAll();
      await runtime.settled();
      expect(daemon.appended).toHaveLength(1);
    });

    it("is tried again when the daemon next calls in, for anything", async () => {
      const { runtime, registry } = world();
      const cwd = tempDir();
      let failing = 2;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            if (failing > 0) {
              failing -= 1;
              return Promise.reject(new Error("no"));
            }
            daemon.appended.push({ agentId, item });
            return Promise.resolve({ seq: 1, epoch: "e" });
          },
        },
      );
      runtime.attach(daemon.port);
      await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      runtime.attach(daemon.port); // any hook, event or RPC begins with this; the daemon API is the one already known
      await runtime.settled();
      expect(daemon.appended).toEqual([]);
      runtime.turnEnded("agent-9"); // somebody's turn ended
      await runtime.settled();
      expect(states(daemon.appended)).toEqual(["pending"]);
    });

    it("ends with the closed state only, when the request closed while its first card was owed", async () => {
      const { runtime, registry } = world();
      const cwd = tempDir();
      let failing = 1;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            if (failing > 0) {
              failing -= 1;
              return Promise.reject(new Error("no"));
            }
            daemon.appended.push({ agentId, item });
            return Promise.resolve({ seq: 1, epoch: "e" });
          },
        },
      );
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      expect(runtime.cardsOwed).toBe(1);
      await registry.decline(requestId);
      await runtime.settled();
      await runtime.flushAll();
      await runtime.settled();
      // The pending card is not owed any more: only the latest state of a request is kept.
      expect(states(daemon.appended)).toEqual(["declined"]);
      expect(runtime.cardsOwed).toBe(0);
    });

    it("appends the latest state again after an older append that was given up on lands late, so the newer state is the last row", async () => {
      const { runtime, registry, logs } = world();
      const cwd = tempDir();
      // The first append is answered when the test says so, and lands on the timeline then; the others at once.
      let land!: () => void;
      let calls = 0;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            calls += 1;
            if (calls > 1) {
              daemon.appended.push({ agentId, item });
              return Promise.resolve({ seq: calls, epoch: "e" });
            }
            return new Promise((resolve) => {
              land = () => {
                daemon.appended.push({ agentId, item });
                resolve({ seq: calls, epoch: "e" });
              };
            });
          },
        },
      );
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled(); // the bound passed: the pending card is given up on, and still owed
      expect(logs).toContain("secure-input: daemon_timeout");
      expect(runtime.cardsOwed).toBe(1);

      await registry.decline(requestId);
      await runtime.settled();
      expect(states(daemon.appended)).toEqual(["declined"]);
      expect(runtime.cardsOwed).toBe(0);

      land(); // the pending card lands after all, behind the declined one
      await vi.waitFor(() => expect(daemon.appended.length).toBeGreaterThan(2), { timeout: 5000 });
      await runtime.settled();
      expect(states(daemon.appended)).toEqual(["declined", "pending", "declined"]);
      expect(runtime.cardsOwed).toBe(0);
      // And that is the end of it.
      await runtime.flushAll();
      await runtime.settled();
      expect(daemon.appended).toHaveLength(3);
    });

    it("owes nothing more when the append that was given up on lands late and is the latest state", async () => {
      const { runtime, registry } = world();
      const cwd = tempDir();
      let land!: () => void;
      let calls = 0;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            calls += 1;
            return new Promise((resolve) => {
              if (calls > 1) return; // a retry that never answers either
              land = () => {
                daemon.appended.push({ agentId, item });
                resolve({ seq: 1, epoch: "e" });
              };
            });
          },
        },
      );
      runtime.attach(daemon.port);
      await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      expect(runtime.cardsOwed).toBe(1);
      land();
      await vi.waitFor(() => expect(runtime.cardsOwed).toBe(0), { timeout: 5000 });
      expect(states(daemon.appended)).toEqual(["pending"]);
      await runtime.flushAll();
      await runtime.settled();
      expect(calls).toBe(1);
    });

    it("slows down for a daemon that never answers, and does not stop: three appends at the pace of the tick, then one for every few ticks", async () => {
      const { runtime, registry } = world();
      const cwd = tempDir();
      let calls = 0;
      const daemon = fakeDaemon({ "agent-1": { status: "running" } }, { append: () => ((calls += 1), new Promise(() => undefined)) });
      runtime.attach(daemon.port);
      await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      const seen: number[] = [];
      for (let tick = 0; tick < 2 + 3 * SLOW_RETRY_TICKS; tick++) {
        await runtime.flushAll();
        // Whatever else the daemon calls in for is no tick: it brings no append while three are out.
        runtime.attach(daemon.port);
        runtime.turnEnded("agent-9");
        await runtime.settled();
        seen.push(calls);
      }
      expect([MAX_UNSETTLED_APPENDS, SLOW_RETRY_TICKS]).toEqual([3, 5]);
      // The first append came with the request, the second with the first tick and the third with the daemon calling
      // in right after it: until three are out every occasion is taken. From then on one more with every fifth tick,
      // however often the daemon calls in between.
      expect(seen).toEqual([3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6]);
      expect(runtime.cardsOwed).toBe(1);
    });

    it("lands the card on a later tick when a daemon that left three appends unanswered answers again", async () => {
      const { runtime, registry } = world();
      const cwd = tempDir();
      let calls = 0;
      let answering = false;
      const daemon = fakeDaemon(
        { "agent-1": { status: "running" } },
        {
          append: (agentId, item) => {
            calls += 1;
            // The three it took while it was stuck are never answered, also not later.
            if (!answering) return new Promise(() => undefined);
            daemon.appended.push({ agentId, item });
            return Promise.resolve({ seq: calls, epoch: "e" });
          },
        },
      );
      const tick = async (): Promise<void> => {
        await runtime.flushAll();
        await runtime.settled();
      };
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      await tick();
      await tick();
      expect(calls).toBe(MAX_UNSETTLED_APPENDS);
      expect(runtime.cardsOwed).toBe(1);
      expect(registry.get(requestId)?.state).toBe("pending"); // open, and nobody can reach its form

      answering = true;
      for (let waited = 1; waited < SLOW_RETRY_TICKS; waited++) await tick();
      expect(daemon.appended).toEqual([]); // not yet: three are out, and the tries are few
      await tick();
      expect(states(daemon.appended)).toEqual(["pending"]);
      expect(daemon.appended[0]?.item.id).toBe(requestId);
      expect(runtime.cardsOwed).toBe(0);
      // Nothing is owed, so nothing more is appended, at any pace.
      for (let later = 0; later < 2 * SLOW_RETRY_TICKS; later++) await tick();
      expect(calls).toBe(MAX_UNSETTLED_APPENDS + 1);
    });

    it("is not waited for, and none is started, once the runtime was stopped", async () => {
      let appends = 0;
      const hanging = fakeDaemon({}, { append: () => ((appends += 1), new Promise(() => undefined)) });
      const reports: string[] = [];
      // A bound far beyond the test's own: what ends the wait below is the stop, not the bound.
      const runtime = new Runtime(inertOutbox, { callTimeoutMs: 60_000, report: (code) => void reports.push(code) });
      runtime.attach(hanging.port);
      runtime.publish(record({ id: `r_${"1".repeat(32)}`, state: "pending" }), "state");
      runtime.publish(record({ id: `r_${"2".repeat(32)}`, state: "pending" }), "state");
      expect(appends).toBe(1); // the first card's append is out, and the second waits for it
      runtime.stop();
      await runtime.settled();
      expect(appends).toBe(1);
      runtime.publish(record({ id: `r_${"3".repeat(32)}`, state: "pending" }), "state");
      await runtime.flushAll();
      runtime.attach(fakeDaemon({}).port);
      await runtime.settled();
      expect(appends).toBe(1);
      expect(runtime.cardsOwed).toBe(3); // owed still, and said so
      // The daemon was not slow: the plugin stopped. Nothing is reported for it.
      expect(reports).toEqual([]);
    });

    it("appends no further card when the stop comes between the answer to one append and the next", async () => {
      let answer!: () => void;
      const appended: string[] = [];
      const first = new Promise<unknown>((resolve) => {
        answer = () => resolve({ seq: 1, epoch: "e" });
      });
      // A port of the test's own: the promise the runtime waits for is the very one the test settles.
      const daemon = fakeDaemon({});
      const port: DaemonPort = {
        ...daemon.port,
        agents: {
          ref: (agentId) => ({
            ...daemon.port.agents.ref(agentId),
            timeline: { append: (item) => (appended.push(item.id as string), appended.length === 1 ? first : Promise.resolve({ seq: 2, epoch: "e" })) },
          }),
        },
      };
      const runtime = new Runtime(inertOutbox, { callTimeoutMs: 60_000 });
      const one = record({ id: `r_${"1".repeat(32)}`, state: "pending" });
      const two = record({ id: `r_${"2".repeat(32)}`, state: "pending" });
      // Both are owed before the daemon API is there, so one drain has both to do.
      runtime.publish(one, "state");
      runtime.publish(two, "state");
      runtime.attach(port);
      expect(appended).toEqual([one.id]);
      // The stop comes when the first append has been answered, and before the drain has gone on.
      void first.then(() => runtime.stop());
      answer();
      await runtime.settled();
      expect(appended).toEqual([one.id]);
      expect(runtime.cardsOwed).toBe(1); // the first landed; the second is owed still
    });

    it("keeps a newer state owed when the append of an older one is answered", async () => {
      let answer!: () => void;
      let calls = 0;
      const daemon = fakeDaemon(
        {},
        {
          append: (agentId, item) => {
            calls += 1;
            const landed = (): unknown => (daemon.appended.push({ agentId, item }), { seq: calls, epoch: "e" });
            if (calls > 1) return Promise.resolve(landed());
            return new Promise((resolve) => {
              answer = () => resolve(landed());
            });
          },
        },
      );
      // A bound the first append stays well within: it is slow, not given up on.
      const runtime = new Runtime(inertOutbox, { callTimeoutMs: 60_000 });
      runtime.attach(daemon.port);
      runtime.publish(record({ state: "pending" }), "state"); // its append is out
      runtime.publish(record({ state: "declined" }), "state"); // the request closed meanwhile
      expect(daemon.appended).toEqual([]);
      answer();
      await runtime.settled();
      expect(states(daemon.appended)).toEqual(["pending", "declined"]);
      expect(runtime.cardsOwed).toBe(0);
    });

    it("keeps an entry for a request only while a card is owed or an append is out for it", async () => {
      const kept = (runtime: Runtime): number => (runtime as unknown as { cards: Map<string, unknown> }).cards.size;
      let land!: () => void;
      let calls = 0;
      const daemon = fakeDaemon(
        {},
        {
          append: () => {
            calls += 1;
            if (calls === 2) return Promise.resolve({ seq: 2, epoch: "e" });
            return new Promise((resolve) => {
              land = () => resolve({ seq: 1, epoch: "e" });
            });
          },
        },
      );
      const runtime = new Runtime(inertOutbox, { callTimeoutMs: SHORT });
      runtime.attach(daemon.port);
      const made = record({ id: `r_${"1".repeat(32)}`, state: "pending" });
      runtime.publish(made, "state");
      await runtime.settled(); // given up on: owed, and one append out
      expect([runtime.cardsOwed, kept(runtime)]).toEqual([1, 1]);
      await runtime.flushAll(); // the retry lands
      await runtime.settled();
      // Nothing is owed, and the entry stays: the first append is still out and may yet land.
      expect([runtime.cardsOwed, kept(runtime)]).toEqual([0, 1]);
      land();
      await vi.waitFor(() => expect(kept(runtime)).toBe(0), { timeout: 5000 });
      expect(runtime.cardsOwed).toBe(0);
      expect(calls).toBe(2);

      // One that lands at the first try leaves nothing behind.
      const plain = fakeDaemon({});
      const direct = new Runtime(inertOutbox, { callTimeoutMs: SHORT });
      direct.attach(plain.port);
      direct.publish(made, "state");
      await direct.settled();
      expect(plain.appended).toHaveLength(1);
      expect(kept(direct)).toBe(0);
    });

    it("is forgotten with its request, and with an agent that was archived", async () => {
      const { runtime, logs } = world();
      const failing = fakeDaemon({}, { append: () => Promise.reject(new Error("no")) });
      runtime.attach(failing.port);
      const one = record({ id: `r_${"1".repeat(32)}`, agentId: "agent-1", state: "pending" });
      const two = record({ id: `r_${"2".repeat(32)}`, agentId: "agent-2", state: "pending" });
      const three = record({ id: `r_${"3".repeat(32)}`, agentId: "agent-2", state: "pending" });
      for (const made of [one, two, three]) runtime.publish(made, "state");
      await runtime.settled();
      expect(runtime.cardsOwed).toBe(3);
      runtime.forget(one.id); // the registry dropped it from its history
      expect(runtime.cardsOwed).toBe(2);
      runtime.agentArchived("agent-2");
      await runtime.settled();
      expect(runtime.cardsOwed).toBe(0);
      const tried = failedCards(logs);
      await runtime.flushAll();
      await runtime.settled();
      expect(failedCards(logs)).toBe(tried); // nothing is tried for them any more
    });
  });

  describe("messages to the agent", () => {
    it("tells an idle agent the outcome once, with exactly the fixed text, and waits for a busy one to finish its turn", async () => {
      const { runtime, registry, files } = world();
      const cwd = tempDir();
      const daemon = fakeDaemon({ "agent-1": { status: "running" } });
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await registry.decline(requestId);
      await runtime.settled();
      expect(daemon.sent).toEqual([]);

      (daemon.agents["agent-1"] as FakeAgent).status = "idle";
      runtime.turnEnded("agent-1");
      await runtime.settled();
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(registry.get(requestId) as RequestRecord, files.drop) as string }]);
      expect(daemon.sent[0]?.text).toContain(`Request ${requestId}: the user declined`);
      runtime.turnEnded("agent-1");
      await runtime.settled();
      expect(daemon.sent).toHaveLength(1);
    });

    it("sends at once to an agent that is idle when the request ends, to nobody else, and nothing for a request the agent withdrew", async () => {
      const { runtime, registry, files } = world();
      const cwd = tempDir();
      const daemon = fakeDaemon({ "agent-1": { status: "idle" }, "agent-2": { status: "idle" } });
      runtime.attach(daemon.port);
      const withdrawn = await registry.create({ agentId: "agent-2", cwd, title: null }, asking);
      await registry.cancel("agent-2", withdrawn.requestId);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      expect(daemon.sent).toEqual([]); // a pending request has nothing to say, and neither has one its own agent cancelled
      await registry.decline(requestId);
      await runtime.settled();
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(registry.get(requestId) as RequestRecord, files.drop) as string }]);
    });

    it("queues nothing when a request is released: a message that still waits for it says so when it is sent", async () => {
      const { runtime, outbox } = world(); // not attached: what is queued stays queued
      for (const by of ["agent", "turn", "time", "restart", "stop", "human"] as const) {
        runtime.publish(record({ state: "released", releasedBy: by, fulfilledDigest: "c".repeat(64), written: ["A"], deleteBy: 1 }), "state");
      }
      await runtime.settled();
      expect(await outbox.pending()).toBe(0);
      // A delivery is announced as any other end.
      runtime.publish(record({ id: `r_${"1".repeat(32)}`, state: "delivered", fulfilledDigest: "c".repeat(64), written: ["A"], deleteBy: 1 }), "state");
      await runtime.settled();
      expect(await outbox.pending()).toBe(1);
    });

    it("queues a reference for what a request ends with, and for nothing else", async () => {
      const { runtime, registry, outbox, files } = world(); // not attached: what is queued stays queued
      const cwd = tempDir();
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      expect(await outbox.pending()).toBe(0); // a pending request has nothing to say
      await registry.decline(requestId);
      await runtime.settled();
      expect(await outbox.pending()).toBe(1); // the continuation; no warning, as nothing was tampered with
      expect(JSON.parse(readFileSync(files.outbox, "utf8"))).toMatchObject([{ agentId: "agent-1", requestId, kind: "continuation" }]);
      // The state is announced when it is reached and at no other change: not for a change of something else, and not a
      // second time for the same state. The warning is announced when the flag is raised.
      runtime.publish(registry.get(requestId) as RequestRecord, "other");
      runtime.publish({ ...(registry.get(requestId) as RequestRecord), tamper: true }, "other");
      await runtime.settled();
      expect(JSON.parse(readFileSync(files.outbox, "utf8")).map((item: { kind: string }) => item.kind)).toEqual(["continuation"]);
      runtime.publish({ ...(registry.get(requestId) as RequestRecord), tamper: true }, "tamper");
      await runtime.settled();
      expect(JSON.parse(readFileSync(files.outbox, "utf8")).map((item: { kind: string }) => item.kind)).toEqual(["continuation", "tamper"]);
    });

    it("does not enqueue a pending request, and sends the tamper warning, once, when a second different submission arrives", async () => {
      const { runtime, registry, outbox, files } = world();
      const cwd = tempDir();
      const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await runtime.settled();
      expect(await outbox.pending()).toBe(0);

      expect(await submit(registry, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
      await runtime.settled();
      const delivered = registry.get(requestId) as RequestRecord;
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(delivered, files.drop) as string }]);
      expect(daemon.sent[0]?.text).toContain(`  A → ${filePath(files.drop, requestId, "A")}`);

      expect(await submit(registry, requestId, [{ key: "A", value: `${CANARY}-other` }])).toMatchObject({ ok: false, code: "request_closed" });
      await runtime.settled();
      const tampered = registry.get(requestId) as RequestRecord;
      expect(tampered.tamper).toBe(true);
      expect(daemon.sent).toEqual([
        { agentId: "agent-1", text: continuationText(delivered, files.drop) as string },
        { agentId: "agent-1", text: tamperText(tampered) },
      ]);

      // A third attempt changes nothing: the warning was sent once.
      expect(await submit(registry, requestId, [{ key: "A", value: `${CANARY}-third` }])).toMatchObject({ ok: false, code: "request_closed" });
      runtime.turnEnded("agent-1");
      await runtime.settled();
      expect(daemon.sent).toHaveLength(2);
      expect(readFileSync(files.outbox, "utf8")).toBe("[]");
    });

    it("says each way a request ends once, and nothing for a change that is not the end of it", async () => {
      // The delivered set's deadline lies beyond the nine hours the clock is moved below: what is said is the subject here.
      const { runtime, registry, files } = world({ dropTtlMs: 10 * 60 * 60 * 1000 });
      const clock = vi.spyOn(Date, "now");
      try {
        const daemon = fakeDaemon(Object.fromEntries(["declined", "cancelled", "rejected", "expired", "delivered"].map((name) => [name, { status: "idle" }])));
        runtime.attach(daemon.port);
        const ask = async (agentId: string) => (await registry.create({ agentId, cwd: tempDir(), title: null }, asking)).requestId;

        const declined = await ask("declined");
        await registry.decline(declined);
        const cancelled = await ask("cancelled");
        await registry.cancel("cancelled", cancelled);
        const rejected = await ask("rejected");
        // The key that was asked for is not there: the request is rejected, with its own message.
        await submit(registry, rejected, [{ key: "OTHER", value: CANARY }]);
        const delivered = await ask("delivered");
        // A submission that cannot be opened: the attempt is counted, the card is appended again, and nothing is said.
        const open = registry.get(delivered) as RequestRecord;
        expect(await registry.fulfill(delivered, sealFor({ ...open, requestDigest: "0".repeat(64) }, [{ key: "A", value: CANARY }]))).toMatchObject({ code: "decrypt_failed" });
        await runtime.settled();
        expect(daemon.sent.filter((message) => message.agentId === "delivered")).toEqual([]);
        expect(await submit(registry, delivered, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
        const expired = await ask("expired");
        const now = Date.now();
        clock.mockImplementation(() => now + 9 * 60 * 60 * 1000);
        await registry.expire();
        await runtime.settled();

        const said = (id: string) => continuationText(registry.get(id) as RequestRecord, files.drop) as string;
        expect([...daemon.sent].sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual([
          { agentId: "declined", text: said(declined) },
          { agentId: "delivered", text: said(delivered) },
          { agentId: "expired", text: said(expired) },
          { agentId: "rejected", text: said(rejected) },
        ]);
        expect(said(expired)).toBe(`[secure-input] Request ${expired} expired before the user answered. If the values are still needed, make a new request.`);
        // The cards followed every change, the counted attempt included.
        expect(daemon.appended.filter((entry) => entry.item.id === delivered).map((entry) => (entry.item.data as { state: string }).state)).toEqual(["pending", "pending", "delivered"]);
        // Nothing is said twice, whatever asks.
        for (const agentId of ["declined", "cancelled", "rejected", "expired", "delivered"]) runtime.turnEnded(agentId);
        await runtime.flushAll();
        await runtime.settled();
        expect(daemon.sent).toHaveLength(4);
      } finally {
        clock.mockRestore();
      }
    });

    it("keeps a message for an agent whose idle check fails, sends nothing meanwhile, and sends it when the daemon answers again", async () => {
      const { runtime, registry, files } = world();
      const cwd = tempDir();
      let failing = true;
      const daemon = fakeDaemon(
        { "agent-1": { status: "idle" } },
        {
          refresh: async (agentId) => {
            if (failing) throw new Error("the daemon could not answer just now");
            return agentId;
          },
        },
      );
      // `refresh` is all the fake changes: the status the handle shows is read after it, so it is set here.
      const port: DaemonPort = {
        ...daemon.port,
        agents: {
          ref: (agentId) => {
            const handle = daemon.port.agents.ref(agentId);
            return {
              ...handle,
              get status() {
                return failing ? null : "idle";
              },
              get cwd() {
                return cwd;
              },
            };
          },
        },
      };
      runtime.attach(port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await registry.decline(requestId);
      await runtime.settled();
      await runtime.flushAll();
      await runtime.settled();
      // The send would have worked: it is not tried, because nobody said the agent is idle.
      expect(daemon.sent).toEqual([]);
      expect(JSON.parse(readFileSync(files.outbox, "utf8"))).toMatchObject([{ agentId: "agent-1", requestId, kind: "continuation" }]);

      failing = false;
      await runtime.flushAll();
      await runtime.settled();
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(registry.get(requestId) as RequestRecord, files.drop) as string }]);
      expect(readFileSync(files.outbox, "utf8")).toBe("[]");
    });

    it("saves a message at once while a flush hangs on other agents, and sends it within the flushes their silence costs", async () => {
      const { runtime, registry, outbox, files } = world();
      const silent = new Set(["silent-1", "silent-2", "silent-3"]);
      const asked: string[] = [];
      // What the test waits for is what the daemon was asked or sent, told by the calls themselves: the timers are
      // faked here, and a poll would move the faked clock along with the real one.
      let watching: Array<() => void> = [];
      const told = (): void => {
        const due = watching;
        watching = [];
        for (const check of due) check();
      };
      const until = (reached: () => boolean): Promise<void> =>
        new Promise((resolve) => {
          const check = (): void => (reached() ? resolve() : void watching.push(check));
          check();
        });
      const daemon = fakeDaemon(Object.fromEntries([...silent, "healthy"].map((agentId) => [agentId, { status: "idle" }])), {
        refresh: (agentId) => {
          asked.push(agentId);
          told();
          return silent.has(agentId) ? new Promise(() => undefined) : Promise.resolve(null);
        },
      });
      // The status a handle shows is set by the fake's own `refresh`, which this test replaces: every agent here is idle.
      const port: DaemonPort = {
        ...daemon.port,
        agents: {
          ref: (agentId) => {
            const handle = daemon.port.agents.ref(agentId);
            return {
              ...handle,
              status: "idle",
              send: async (text) => {
                await handle.send(text);
                told();
              },
            };
          },
        },
      };
      const end = async (agentId: string): Promise<string> => {
        const { requestId } = await registry.create({ agentId, cwd: tempDir(), title: null }, asking);
        await registry.decline(requestId);
        return requestId;
      };
      const waiting = () => (JSON.parse(readFileSync(files.outbox, "utf8")) as Array<{ agentId: string }>).map((entry) => entry.agentId);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        runtime.attach(port);
        for (const agentId of silent) await end(agentId);
        // The flush that the first of them asked for hangs on that agent's idle check, which has half a minute.
        expect(await outbox.pending()).toBe(3);
        expect(asked).toEqual(["silent-1"]);

        const requestId = await end("healthy");
        // Its message is in the file as soon as the file's turn comes: it does not wait for the agent that hangs.
        expect(await outbox.pending()).toBe(4);
        expect(waiting()).toEqual(["silent-1", "silent-2", "silent-3", "healthy"]);
        expect(asked).toEqual(["silent-1"]);
        expect(daemon.sent).toEqual([]);

        // The flush under way ends with its first agent. The one that follows is for the agents named meanwhile, in the
        // order they were named: the two other silent ones use up its budget.
        await vi.advanceTimersByTimeAsync(PORT_TIMEOUT_MS);
        await until(() => asked.length >= 2);
        expect(asked).toEqual(["silent-1", "silent-2"]);
        await vi.advanceTimersByTimeAsync(PORT_TIMEOUT_MS);
        await until(() => asked.length >= 3);
        expect(asked).toEqual(["silent-1", "silent-2", "silent-3"]);
        await vi.advanceTimersByTimeAsync(FLUSH_BUDGET_MS - PORT_TIMEOUT_MS);
        expect(daemon.sent).toEqual([]);
        // The next tick. By now the three are known not to answer, and the one that does is served before them.
        void runtime.flushAll();
        await until(() => daemon.sent.length >= 1);
        expect(daemon.sent).toEqual([{ agentId: "healthy", text: continuationText(registry.get(requestId) as RequestRecord, files.drop) as string }]);
        expect(asked.slice(3, 4)).toEqual(["healthy"]);
      } finally {
        vi.useRealTimers();
        runtime.stop();
      }
    });

    it("keeps no message text in the outbox file", async () => {
      const { runtime, registry, files } = world();
      const cwd = tempDir();
      const daemon = fakeDaemon({ "agent-1": { status: "running" } });
      runtime.attach(daemon.port);
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await registry.decline(requestId);
      await runtime.settled();
      const text = readFileSync(files.outbox, "utf8");
      const stored = JSON.parse(text) as Array<Record<string, unknown>>;
      expect(stored).toHaveLength(1);
      expect(Object.keys(stored[0] as object).sort()).toEqual(["agentId", "enqueuedAt", "kind", "requestId"]);
      expect(stored[0]).toMatchObject({ agentId: "agent-1", requestId, kind: "continuation" });
      expect(text).not.toContain("secure-input");
      expect(text).not.toContain("declined");
      expect(text).not.toContain(continuationText(registry.get(requestId) as RequestRecord, files.drop) as string);
    });

    it("sends nothing for a planted item: an unknown request, another agent's request, a warning for an untampered request", async () => {
      const { runtime, registry, files, outbox } = world();
      const cwd = tempDir();
      const daemon = fakeDaemon({ "agent-1": { status: "idle" }, "agent-2": { status: "idle" } });
      const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await registry.decline(requestId);
      await runtime.settled();
      const now = Date.now();
      const genuine = JSON.parse(readFileSync(files.outbox, "utf8")) as unknown[];
      expect(genuine).toHaveLength(1);
      plant(
        files.outbox,
        JSON.stringify([
          { agentId: "agent-1", requestId: `r_${"0".repeat(32)}`, kind: "continuation", enqueuedAt: now },
          { agentId: "agent-2", requestId, kind: "continuation", enqueuedAt: now },
          { agentId: "agent-2", requestId, kind: "tamper", enqueuedAt: now },
          { agentId: "agent-1", requestId, kind: "tamper", enqueuedAt: now },
          ...genuine,
        ]),
      );
      runtime.attach(daemon.port);
      await runtime.settled();
      runtime.turnEnded("agent-2");
      await runtime.settled();
      // The genuine message of the declined request is the only one; the planted items were looked at and dropped.
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(registry.get(requestId) as RequestRecord, files.drop) as string }]);
      expect(await outbox.pending()).toBe(0);
    });

    it("catches a rejection of the outbox, whether from enqueue or from flush", async () => {
      const reports: string[] = [];
      const broken = {
        ...inertOutbox,
        enqueue: () => Promise.reject(new Error("enqueue failed")),
        flush: () => Promise.reject(new Error("flush failed")),
      };
      const runtime = new Runtime(broken, { callTimeoutMs: SHORT, report: (code) => void reports.push(code) });
      runtime.publish(record(), "state");
      runtime.attach(fakeDaemon({}).port);
      runtime.turnEnded("agent-1");
      await runtime.settled();
      expect(reports).toContain("outbox_enqueue_failed");
      expect(reports).toContain("outbox_flush_failed");
    });

    it("catches an item the outbox will not take", async () => {
      const { runtime, logs, outbox } = world();
      runtime.attach(fakeDaemon({}).port);
      runtime.publish(record({ agentId: `agent${BIDI}` }), "state");
      await runtime.settled();
      expect(logs).toContain("secure-input: outbox_enqueue_failed");
      expect(await outbox.pending()).toBe(0);
    });
  });
});

describe("the bounds of delivery, against each other", () => {
  it("lets one silent agent use up neither a flush nor the time to the next tick", () => {
    // A flush is longer than one call to the port may take, so the agents behind a silent one are still served in it;
    // and shorter than the time between two ticks, so a flush that used all of it has ended when the next is asked for.
    expect(FLUSH_BUDGET_MS).toBeGreaterThan(PORT_TIMEOUT_MS);
    expect(FLUSH_BUDGET_MS).toBeLessThan(EXPIRY_INTERVAL_MS);
  });
});

describe("what is kept per request goes when the registry forgets the request", () => {
  /** The requests the outbox remembers a delivery for. Private, so this looks inside: the only way to see that a mark is gone. */
  const marked = (outbox: unknown): string[] => [...(outbox as { delivered: Map<string, Set<string>> }).delivered.keys()];

  it("drops the mark of a delivered message and an owed card with the oldest request, when a newer one pushes it out of the history", async () => {
    const dataDir = tempDir();
    const old = Date.now() - 24 * 60 * 60 * 1000;
    // A full history, as an earlier run left it: closed requests, the first of them the oldest.
    const history = Array.from({ length: HISTORY }, (_, index) =>
      record({ id: `r_${index.toString(16).padStart(32, "0")}`, agentId: index === 0 ? "old-agent" : "other", state: "declined", createdAt: old + index, updatedAt: old + index }),
    );
    plant(join(dataDir, "requests.json"), JSON.stringify(history));
    const { registry, runtime, outbox, files } = world({ dataDir });
    await registry.load();
    const oldest = (history[0] as RequestRecord).id;
    expect(registry.get(oldest)?.state).toBe("declined");

    const cwd = tempDir();
    const daemon = fakeDaemon(
      { "old-agent": { status: "idle" }, "agent-1": { status: "idle" } },
      {
        // The old agent's timeline takes no card; everybody else's does.
        append: (agentId, item) => (agentId === "old-agent" ? Promise.reject(new Error("no")) : (daemon.appended.push({ agentId, item }), Promise.resolve({ seq: 1, epoch: "e" }))),
      },
    );
    runtime.attach(daemon.port);
    // Something is still owed for the oldest request: a message that waited in the file, and a card.
    plant(files.outbox, JSON.stringify([{ agentId: "old-agent", requestId: oldest, kind: "continuation", enqueuedAt: Date.now() }]));
    runtime.publish(registry.get(oldest) as RequestRecord, "other");
    await runtime.flushAll();
    await runtime.settled();
    expect(daemon.sent.map((message) => message.agentId)).toEqual(["old-agent"]);
    expect(marked(outbox)).toEqual([oldest]);
    expect(runtime.cardsOwed).toBe(1);

    // One more request ends: the history is over its size, and the oldest request leaves it.
    const { requestId } = await registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    await registry.decline(requestId);
    await runtime.settled();
    expect(registry.get(oldest)).toBeUndefined();
    expect(registry.get(requestId)?.state).toBe("declined");
    // With it went what was kept for it; what is kept now is for the request that is still there.
    expect(marked(outbox)).toEqual([requestId]);
    expect(runtime.cardsOwed).toBe(0);
    expect(daemon.sent.map((message) => message.agentId)).toEqual(["old-agent", "agent-1"]);
  });
});

describe("within", () => {
  it("gives the result, the call's own failure, or TIMED_OUT, and leaves no timer", async () => {
    expect(await within(1000, async () => 7)).toBe(7);
    expect(await within(1000, () => 8)).toBe(8);
    expect(await rejectionOf(within(1000, () => Promise.reject(new Error("boom"))))).toMatchObject({ message: "boom" });
    expect(await rejectionOf(within(1000, () => { throw new Error("sync"); }))).toMatchObject({ message: "sync" });
    expect(await within(10, () => new Promise(() => undefined))).toBe(TIMED_OUT);
    expect(await within(10, () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 40)))).toBe(TIMED_OUT);
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------------

describe("within, and the timers it leaves", () => {
  it("clears its timer on every way out", async () => {
    vi.useFakeTimers();
    try {
      expect(await within(1000, async () => 1)).toBe(1);
      expect((await rejectionOf(within(1000, async () => Promise.reject(new Error("x"))))).message).toBe("x");
      expect((await rejectionOf(within(1000, () => { throw new Error("sync"); }))).message).toBe("sync");
      expect(vi.getTimerCount()).toBe(0);
      const timedOut = within(1000, () => new Promise(() => undefined));
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await timedOut).toBe(TIMED_OUT);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildView", () => {
  it("returns the fields with their kind and format, scrubbed labels and the digest to seal to, and nothing else the agent wrote", async () => {
    const { registry } = world();
    const cwd = tempDir();
    const { requestId } = await registry.create(
      { agentId: "agent-1", cwd, title: `Deploy${BIDI} helper` },
      {
        reason: `need${BIDI} keys\nnow`,
        fields: [
          { key: "A", label: `from${NUL} the dashboard` },
          { key: "SA", kind: "file", format: "json", optional: true },
          { key: "P12", kind: "file" },
          { key: "B", kind: "text" },
        ],
      },
    );
    const view = RequestViewSchema.parse(buildView(registry, requestId));
    expect(view).toEqual({
      id: requestId,
      state: "pending",
      tamper: false,
      errorCode: null,
      fields: [
        { key: "A", label: "from the dashboard", optional: false, kind: "text", format: null },
        { key: "SA", label: "", optional: true, kind: "file", format: "json" },
        { key: "P12", label: "", optional: false, kind: "file", format: "any" },
        { key: "B", label: "", optional: false, kind: "text", format: null },
      ],
      publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      requestDigest: (registry.get(requestId) as RequestRecord).requestDigest,
      createdAt: expect.any(Number),
    });
    // The reason is kept with the request and shown nowhere, and so is the agent's title.
    const { publicKey: _key, ...words } = view;
    expect(JSON.stringify(words)).not.toMatch(/need|now|Deploy|helper/);
  });

  it("gives the view of a delivered request the digest of what was asked for, and no value", async () => {
    const { registry } = world();
    const { requestId } = await registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, asking);
    expect(await submit(registry, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    const view = RequestViewSchema.parse(buildView(registry, requestId));
    expect(view).toMatchObject({ state: "delivered", tamper: false, errorCode: null });
    expect(view.requestDigest).toBe((registry.get(requestId) as RequestRecord).requestDigest);
    expect(JSON.stringify(view)).not.toContain(CANARY);
  });

  it("scrubs the agent's labels itself, whatever the registry holds", () => {
    const dirty = record({ state: "pending", request: { reason: "", fields: [{ key: "A", label: `from${NUL} the${BIDI} dashboard` }] } });
    const view = RequestViewSchema.parse(buildView({ get: () => dirty }, dirty.id));
    expect(view.fields).toEqual([{ key: "A", label: "from the dashboard", optional: false, kind: "text", format: null }]);
  });

  it("refuses a request it does not know, in the plugin's own words", () => {
    expect(() => buildView({ get: () => undefined }, `r_${"0".repeat(32)}`)).toThrow("invalid_request: unknown request");
  });

  it("is refused by its schema when it has a member the schema does not list, or one that is not what it says", async () => {
    const { registry } = world();
    const { requestId } = await registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, asking);
    const view = buildView(registry, requestId);
    expect(RequestViewSchema.safeParse(view).success).toBe(true);
    expect(RequestViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(RequestViewSchema.safeParse({ ...view, id: "r_nope" }).success).toBe(false);
    for (const [name, change] of Object.entries({
      requestDigest: { requestDigest: "abc" },
      publicKey: { publicKey: "short" },
      state: { state: "bogus" },
      written: { state: "written" },
      errorCode: { errorCode: "made_up" },
      "a code of v1": { errorCode: "target_changed" },
      createdAt: { createdAt: -1 },
      "too many fields": { fields: Array.from({ length: LIMITS.fields + 1 }, (_, index) => ({ key: `K${index}`, label: "", optional: false, kind: "text", format: null })) },
    })) {
      expect(RequestViewSchema.safeParse({ ...view, ...change }).success, name).toBe(false);
    }
  });

  describe("view bounds", () => {
    it("takes a field as it is built, and refuses one that is not what it says", () => {
      const text = { key: "A", label: "from the dashboard", optional: false, kind: "text", format: null };
      const file = { key: "SA", label: "", optional: true, kind: "file", format: "json" };
      const of = (field: unknown) => RequestViewSchema.safeParse({ ...viewOfRecord(), fields: [field] }).success;
      for (const good of [text, file, { ...file, format: "pem" }, { ...file, format: "any" }, { ...text, label: "l".repeat(LIMITS.label) }]) expect(of(good), JSON.stringify(good)).toBe(true);
      const bad: Array<[string, unknown]> = [
        ["a key that is not one", { ...text, key: "1A" }],
        ["a label over its bound", { ...text, label: "l".repeat(LIMITS.label + 1) }],
        ["a label that hides text", { ...text, label: `a${BIDI}b` }],
        ["a kind there is not", { ...text, kind: "command" }],
        ["a format there is not", { ...file, format: "yaml" }],
        ["a text field with a format", { ...text, format: "json" }],
        ["a file field with none", { ...file, format: null }],
        ["no kind", { key: "A", label: "", optional: false, format: null }],
        ["a member more", { ...text, sink: "dotenv" }],
      ];
      for (const [name, candidate] of bad) expect(of(candidate), name).toBe(false);
    });

    /** The view of a pending request as the daemon builds it, from a record of the registry's own shape. */
    function viewOfRecord(): RequestView {
      return buildView({ get: () => record({ state: "pending" }) }, `r_${"7f3a".repeat(8)}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------------------------------------------

describe("contracts", () => {
  const requestId = `r_${"ab12".repeat(8)}`;
  const envelope = { v: 1, epk: "A".repeat(43), nonce: "B".repeat(16), ct: "C".repeat(1400) };
  const input = { requestId, envelope };

  it("accepts a well-formed submission, which makes every refusal below about the one thing it changes", () => {
    expect(fulfillRequest.input.safeParse(input).success).toBe(true);
  });

  it("takes the request id and the envelope, and refuses what v1's form sent besides them", () => {
    expect(fulfillRequest.input.safeParse({ ...input, factsDigest: "0".repeat(64) }).success).toBe(false);
    expect(fulfillRequest.input.safeParse({ ...input, factsDigest: "" }).success).toBe(false);
    expect(fulfillRequest.input.safeParse({ ...input, confirmOverwrite: false }).success).toBe(false);
    expect(fulfillRequest.input.safeParse({ ...input, factsDigest: "", confirmOverwrite: false }).success).toBe(false);
    expect(fulfillRequest.input.safeParse({ requestId }).success).toBe(false);
    expect(fulfillRequest.input.safeParse({ envelope }).success).toBe(false);
  });

  it("parses the view of a pending request with exactly its members", async () => {
    const { registry } = world();
    const { requestId: id } = await registry.create({ agentId: "agent-1", cwd: tempDir(), title: "Deploy helper" }, { reason: "why", fields: [{ key: "A" }, { key: "SA", kind: "file" }] });
    const view = getRequest.output.parse(buildView(registry, id));
    expect(Object.keys(view).sort()).toEqual(["createdAt", "errorCode", "fields", "id", "publicKey", "requestDigest", "state", "tamper"]);
    expect(view.fields.map((field) => Object.keys(field).sort())).toEqual([
      ["format", "key", "kind", "label", "optional"],
      ["format", "key", "kind", "label", "optional"],
    ]);
  });

  it("refuses an envelope that is not the one the app makes", () => {
    const refused: Array<[string, unknown]> = [
      ["ct one over the cap", { ...input, envelope: { ...envelope, ct: "C".repeat(ENVELOPE_CT_MAX + 1) } }],
      ["epk too short", { ...input, envelope: { ...envelope, epk: "A".repeat(42) } }],
      ["epk too long", { ...input, envelope: { ...envelope, epk: "A".repeat(44) } }],
      ["nonce too short", { ...input, envelope: { ...envelope, nonce: "B".repeat(15) } }],
      ["nonce too long", { ...input, envelope: { ...envelope, nonce: "B".repeat(17) } }],
      ["epk not base64url", { ...input, envelope: { ...envelope, epk: `${"A".repeat(42)}+` } }],
      ["nonce not base64url", { ...input, envelope: { ...envelope, nonce: `${"B".repeat(15)}=` } }],
      ["ct not base64url", { ...input, envelope: { ...envelope, ct: `${"C".repeat(1399)}/` } }],
      ["empty ct", { ...input, envelope: { ...envelope, ct: "" } }],
      ["other version", { ...input, envelope: { ...envelope, v: 2 } }],
      ["unknown envelope property", { ...input, envelope: { ...envelope, extra: 1 } }],
      ["unknown input property", { ...input, extra: 1 }],
      ["a request id of another shape", { ...input, requestId: "r_xyz" }],
      ["an upper-case request id", { ...input, requestId: `r_${"AB12".repeat(8)}` }],
      ["a request id with a tail", { ...input, requestId: `${requestId}\n` }],
      ["a request id that is a list", { ...input, requestId: [requestId] }],
    ];
    for (const [name, candidate] of refused) expect(fulfillRequest.input.safeParse(candidate).success, name).toBe(false);
  });

  it("takes a ct exactly as long as the largest allowed payload makes it, and no longer", () => {
    // The largest payload: the most fields, each with the longest key and the most bytes in its value, every byte a
    // control character that the canonical JSON writes as six (\u0001). Padded to a block, plus the 16-byte tag, as
    // base64url: that is what ENVELOPE_CT_MAX is computed to be.
    const key = (index: number) => `${"K".repeat(LIMITS.key - 2)}${String(index).padStart(2, "0")}`;
    const entries: PayloadEntry[] = Array.from({ length: LIMITS.fields }, (_, index) => ({ key: key(index), value: String.fromCharCode(1).repeat(LIMITS.valueBytes) }));
    const recipient = generateRequestKeyPair().publicKey;
    const worst = seal(recipient, encodeValues(entries), buildAad(requestId, "0".repeat(64)));
    expect(worst.ct.length).toBe(ENVELOPE_CT_MAX);
    expect(fulfillRequest.input.safeParse({ ...input, envelope: worst }).success).toBe(true);
    expect(fulfillRequest.input.safeParse({ ...input, envelope: { ...worst, ct: `${worst.ct}A` } }).success).toBe(false);
    // Files are smaller at their worst: as many files of fileBytes, as base64url, take less than texts of six bytes a byte.
    const files: PayloadEntry[] = Array.from({ length: LIMITS.fields }, (_, index) => ({ key: key(index), file: "A".repeat(Math.ceil((LIMITS.fileBytes * 4) / 3)) }));
    const file = seal(recipient, encodeValues(files), buildAad(requestId, "0".repeat(64)));
    expect(file.ct.length).toBeLessThan(ENVELOPE_CT_MAX);
  }, LONG);

  it("refuses a malformed request id in every request contract", () => {
    for (const contract of [getRequest, declineRequest]) {
      expect(contract.input.safeParse({ requestId }).success).toBe(true);
      expect(contract.input.safeParse({ requestId: "r_xyz" }).success).toBe(false);
      expect(contract.input.safeParse({ requestId, extra: 1 }).success).toBe(false);
    }
  });

  it("keeps the self-test names and bounds its input", () => {
    expect([selfTestBegin.name, selfTestFinish.name]).toEqual(["secure-input.selftest.begin", "secure-input.selftest.finish"]);
    const finish = { probeId: `p_${"0a".repeat(8)}`, envelope, digest: "0".repeat(64) };
    expect(selfTestFinish.input.safeParse(finish).success).toBe(true);
    expect(selfTestFinish.input.safeParse({ ...finish, probeId: "p_zz" }).success).toBe(false);
    expect(selfTestFinish.input.safeParse({ ...finish, digest: "zz" }).success).toBe(false);
    expect(selfTestFinish.input.safeParse({ ...finish, envelope: { ...envelope, nonce: "B" } }).success).toBe(false);
  });

  it("lets nothing ride along in what a handler answers", () => {
    const answers: Array<[string, { output: { safeParse(value: unknown): { success: boolean } } }, unknown]> = [
      ["decline", declineRequest, { state: "declined" }],
      ["selftest begin", selfTestBegin, { probeId: `p_${"0a".repeat(8)}`, publicKey: "A".repeat(43) }],
      ["selftest finish", selfTestFinish, { ok: true, bytes: 64 }],
    ];
    for (const [name, contract, answer] of answers) {
      expect(contract.output.safeParse(answer).success, name).toBe(true);
      expect(contract.output.safeParse({ ...(answer as object), extra: "x" }).success, name).toBe(false);
    }
    expect(selfTestBegin.output.safeParse({ probeId: "p_zz", publicKey: "A".repeat(43) }).success).toBe(false);
    expect(selfTestBegin.output.safeParse({ probeId: `p_${"0a".repeat(8)}`, publicKey: "A".repeat(42) }).success).toBe(false);
    expect(selfTestFinish.output.safeParse({ ok: true, bytes: -1 }).success).toBe(false);
  });

  it("describes a fulfil refusal with its detail, capped, and nothing else", () => {
    const refusal = { ok: false, code: "write_failed", retryable: true };
    expect(fulfillRequest.output.safeParse(refusal).success).toBe(true);
    expect(fulfillRequest.output.safeParse({ ...refusal, detail: "ENOSPC" }).success).toBe(true);
    expect(fulfillRequest.output.safeParse({ ...refusal, detail: "d".repeat(1024) }).success).toBe(true);
    expect(fulfillRequest.output.safeParse({ ...refusal, detail: "d".repeat(1025) }).success).toBe(false);
    expect(fulfillRequest.output.safeParse({ ...refusal, code: "not_a_code" }).success).toBe(false);
    // A code of v1's destinations is no code any more.
    expect(fulfillRequest.output.safeParse({ ...refusal, code: "target_changed" }).success).toBe(false);
    expect(fulfillRequest.output.safeParse({ ...refusal, extra: 1 }).success).toBe(false);
    expect(fulfillRequest.output.safeParse({ ok: true, state: "delivered" }).success).toBe(true);
    expect(fulfillRequest.output.safeParse({ ok: true, state: "delivered", receipt: {} }).success).toBe(false);
    // The state v1 ended a request in is no state any more.
    expect(fulfillRequest.output.safeParse({ ok: true, state: "written" }).success).toBe(false);
    for (const code of ERROR_CODES) expect(fulfillRequest.output.safeParse({ ...refusal, code }).success, code).toBe(true);
  });

  it("bounds the diagnostics and lets nothing ride along", () => {
    const healthy = {
      attached: false,
      dataDir: "/data",
      registry: { persistence: "ok", drop: "ok", stored: "ok", dropped: 0 },
      outbox: { persistence: "ok", unsaved: 0, dropped: 0 },
      requests: { pending: 0, delivered: 0, nextDeleteBy: null },
      startup: { code: "service_unavailable", detail: "the drop directory is not a private directory of this user" },
      cardsOwed: 0,
      messagesHeld: false,
      lastHookFailure: "agent.session_open: unexpected",
    };
    expect(DiagnosticsSchema.safeParse(healthy).success).toBe(true);
    expect(DiagnosticsSchema.safeParse({ ...healthy, startup: null, lastHookFailure: null }).success).toBe(true);
    expect(DiagnosticsSchema.safeParse({ ...healthy, requests: { pending: 2, delivered: 1, nextDeleteBy: 1_700_000_900_000 } }).success).toBe(true);
    // Each member must be said: an answer without one is refused.
    for (const name of Object.keys(healthy)) {
      const { [name]: _left, ...without } = healthy as Record<string, unknown>;
      expect(DiagnosticsSchema.safeParse(without).success, name).toBe(false);
    }
    const refused: Array<[string, unknown]> = [
      ["extra property", { ...healthy, token: "x" }],
      // What v1's bridge, socket and bindings were described by, and its templates and workspaces, is no member any more.
      ...["listening", "runtime", "shim", "socket", "socketBytes", "mcpProviders", "bindings", "bindingsLoaded", "identityDisagreements", "templates", "problems", "unresolvedRoots", "workspaceListing"].map(
        (name): [string, unknown] => [`v1's ${name}`, { ...healthy, [name]: name === "runtime" ? "node" : 0 }],
      ),
      ["unknown startup code", { ...healthy, startup: { code: "made_up", detail: "" } }],
      ["long startup detail", { ...healthy, startup: { code: "unexpected", detail: "d".repeat(301) } }],
      ["extra startup property", { ...healthy, startup: { code: "unexpected", detail: "", env: "x" } }],
      ["long hook failure", { ...healthy, lastHookFailure: "h".repeat(129) }],
      ["negative count of owed cards", { ...healthy, cardsOwed: -1 }],
      ["fractional count of owed cards", { ...healthy, cardsOwed: 0.5 }],
      ["a held flag that is no boolean", { ...healthy, messagesHeld: "yes" }],
      ["registry health with a property more", { ...healthy, registry: { ...healthy.registry, path: "/x" } }],
      ["registry health as v1 had it, with the sweep of its journal", { ...healthy, registry: { ...healthy.registry, journalSweep: "ok" } }],
      ["a drop that is neither ok nor failing", { ...healthy, registry: { ...healthy.registry, drop: "full" } }],
      ["unknown persistence", { ...healthy, outbox: { ...healthy.outbox, persistence: "maybe" } }],
      ["requests with a property more", { ...healthy, requests: { ...healthy.requests, ids: [] } }],
      ["a negative count of requests that wait", { ...healthy, requests: { ...healthy.requests, pending: -1 } }],
      ["a fractional count of sets", { ...healthy, requests: { ...healthy.requests, delivered: 0.5 } }],
      ["a deadline before the epoch", { ...healthy, requests: { ...healthy.requests, nextDeleteBy: -1 } }],
      ["a fractional deadline", { ...healthy, requests: { ...healthy.requests, nextDeleteBy: 1.5 } }],
      ["a deadline that is no number", { ...healthy, requests: { ...healthy.requests, nextDeleteBy: "14:32" } }],
      ["a deadline left out", { ...healthy, requests: { pending: 0, delivered: 0 } }],
      ["long path", { ...healthy, dataDir: "d".repeat(4161) }],
    ];
    for (const [name, candidate] of refused) expect(DiagnosticsSchema.safeParse(candidate).success, name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The app's side
// ---------------------------------------------------------------------------------------------------------------

describe("RPC handlers", () => {
  it("accept their own contract's input and return what their own output schema accepts", async () => {
    const w = world();
    const cwd = tempDir();
    const fake = fakeHost();
    registerHandlers(fake.host, { registry: w.registry, runtime: w.runtime, diagnostics: w.diagnostics, report: () => undefined });
    const daemon = fakeDaemon({ "agent-1": { status: "idle" } });

    const { requestId } = await w.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    const view = (await fake.call(getRequest.name, { requestId }, daemon.port)) as RequestView;
    expect(w.runtime.attached).toBe(true);
    // Sealed to what the view says, as the form seals. What v1's form sent besides is refused by the contract.
    const envelope = sealFor(view, [{ key: "A", value: "typed-v" }]);
    await expect(fake.call(fulfillRequest.name, { requestId, envelope, factsDigest: "stale", confirmOverwrite: true }, daemon.port)).rejects.toThrow();
    expect(w.registry.get(requestId)?.state).toBe("pending");
    expect(await fake.call(fulfillRequest.name, { requestId, envelope }, daemon.port)).toEqual({ ok: true, state: "delivered" });
    expect(readFileSync(filePath(w.files.drop, requestId, "A"), "utf8")).toBe("typed-v");
    expect(await fake.call(readDiagnostics.name, {}, daemon.port)).toMatchObject({
      attached: true,
      startup: null,
      requests: { pending: 0, delivered: 1, nextDeleteBy: w.registry.get(requestId)?.deleteBy },
    });

    const second = await w.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    expect(await fake.call(declineRequest.name, { requestId: second.requestId }, daemon.port)).toEqual({ state: "declined" });

    const probe = (await fake.call(selfTestBegin.name, {}, daemon.port)) as { probeId: string; publicKey: string };
    const payload = new Uint8Array(64).fill(7);
    const sealedProbe = seal(fromBase64Url(probe.publicKey), payload, buildAad(probe.probeId, "selftest"));
    expect(await fake.call(selfTestFinish.name, { probeId: probe.probeId, envelope: sealedProbe, digest: digestHex(payload) }, daemon.port)).toEqual({ ok: true, bytes: 64 });

    await expect(fake.call(getRequest.name, { requestId, extra: 1 }, daemon.port)).rejects.toThrow();

    // The human's word to delete every file: nothing in, the counts out, and the set of the first request is gone.
    await expect(fake.call(clearDrop.name, { extra: 1 }, daemon.port)).rejects.toThrow();
    expect(existsSync(setPath(w.files.drop, requestId))).toBe(true);
    expect(await fake.call(clearDrop.name, {}, daemon.port)).toEqual({ released: 1, stuck: 0 });
    expect(existsSync(setPath(w.files.drop, requestId))).toBe(false);
    expect(w.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(await fake.call(readDiagnostics.name, {}, daemon.port)).toMatchObject({ requests: { pending: 0, delivered: 0, nextDeleteBy: null } });

    expect(fake.rpcNames()).toEqual([
      "secure-input.diagnostics.read",
      "secure-input.drop.clear",
      "secure-input.request.decline",
      "secure-input.request.fulfill",
      "secure-input.request.get",
      "secure-input.selftest.begin",
      "secure-input.selftest.finish",
    ]);
  });

  it("answers the begin of a self-test on a host without usable randomness with a fixed refusal, through the contract's own door", async () => {
    const w = world();
    const fake = fakeHost();
    registerHandlers(fake.host, { registry: w.registry, runtime: w.runtime, diagnostics: w.diagnostics, report: () => undefined });
    const daemon = fakeDaemon({});
    const broken = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new TypeError(`crypto.getRandomValues is not a function: ${CANARY}`);
    });
    try {
      expect(await rejectionOf(fake.call(selfTestBegin.name, {}, daemon.port))).toEqual({ code: "service_unavailable", message: "service_unavailable: the self-test cannot be started" });
    } finally {
      broken.mockRestore();
    }
    // With randomness back, a self-test begins.
    expect(await fake.call(selfTestBegin.name, {}, daemon.port)).toMatchObject({ probeId: expect.stringMatching(/^p_[0-9a-f]{16}$/) });
  });

  it("captures the daemon API on whichever call comes first", async () => {
    const w = world();
    const fake = fakeHost();
    registerHandlers(fake.host, { registry: w.registry, runtime: w.runtime, diagnostics: w.diagnostics, report: () => undefined });
    const daemon = fakeDaemon({});
    expect(w.runtime.attached).toBe(false);
    await fake.call(selfTestBegin.name, {}, daemon.port);
    expect(w.runtime.attached).toBe(true);
  });

  it("captures the daemon API in every handler", async () => {
    const id = `r_${"0".repeat(32)}`;
    const envelope = { v: 1, epk: "A".repeat(43), nonce: "B".repeat(16), ct: "C".repeat(40) };
    const probe = { probeId: `p_${"0".repeat(16)}`, envelope, digest: "0".repeat(64) };
    const calls: Array<[string, unknown]> = [
      [selfTestBegin.name, {}],
      [selfTestFinish.name, probe],
      [getRequest.name, { requestId: id }],
      [fulfillRequest.name, { requestId: id, envelope }],
      [declineRequest.name, { requestId: id }],
      [readDiagnostics.name, {}],
      [clearDrop.name, {}],
    ];
    for (const [name, input] of calls) {
      const w = world();
      const fake = fakeHost();
      registerHandlers(fake.host, { registry: w.registry, runtime: w.runtime, diagnostics: w.diagnostics, report: () => undefined });
      expect(w.runtime.attached).toBe(false);
      await codeOfAsync(fake.call(name, input, fakeDaemon({}).port)); // some of these are refused, which is not what is looked at
      expect(w.runtime.attached, name).toBe(true);
    }
  });

  it("lets a refusal carry its detail to the caller, the names of keys and nothing of a value", async () => {
    const w = world();
    const fake = fakeHost();
    registerHandlers(fake.host, { registry: w.registry, runtime: w.runtime, diagnostics: w.diagnostics, report: () => undefined });
    const daemon = fakeDaemon({});
    const { requestId } = await w.registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, { fields: [{ key: "A" }, { key: "SA", kind: "file" }] });
    const view = (await fake.call(getRequest.name, { requestId }, daemon.port)) as RequestView;
    const envelope = sealFor(view, [{ key: "A", value: CANARY }, { key: "SA", value: `${CANARY}-not-a-file` }]);
    const refused = await fake.call(fulfillRequest.name, { requestId, envelope }, daemon.port);
    expect(refused).toEqual({ ok: false, code: "invalid_request", retryable: false, detail: "SA must be a file" });
    expect(JSON.stringify(refused)).not.toContain("CANARY");
    expect(w.registry.get(requestId)).toMatchObject({ state: "rejected", errorCode: "invalid_request" });
    expect(existsSync(setPath(w.files.drop, requestId))).toBe(false);
  });

  describe("check their own output before it goes out", () => {
    function withRegistry(registry: Record<string, unknown>, diagnostics = async () => ({}) as never) {
      const reports: string[] = [];
      const fake = fakeHost();
      registerHandlers(fake.host, { registry: registry as never, runtime: { attach: () => undefined }, diagnostics, report: (code) => void reports.push(code) });
      return { fake, reports, port: fakeDaemon({}).port };
    }
    const pendingRecord = (overrides: Partial<RequestRecord> = {}) => record({ state: "pending", publicKey: "A".repeat(43), requestDigest: "0".repeat(64), ...overrides });

    // The fixed answer does not say that the request is closed, because the handler does not know that it is: it is a
    // refusal the dialog may try again (`retryable`), and the dialog keeps the form and sends the same envelope.
    it("answers a fulfil result the contract cannot carry with a fixed refusal that keeps the request open, and logs a code", async () => {
      const { fake, reports, port } = withRegistry({ fulfill: async () => ({ ok: false, code: "made_up_code", retryable: true, detail: CANARY }) });
      const envelope = { v: 1, epk: "A".repeat(43), nonce: "B".repeat(16), ct: "C".repeat(40) };
      const answer = await fake.call(fulfillRequest.name, { requestId: `r_${"0".repeat(32)}`, envelope }, port);
      expect(answer).toEqual({ ok: false, code: "service_unavailable", retryable: true });
      expect(reports).toEqual(["fulfill_invalid"]);
      expect(JSON.stringify(answer)).not.toContain("CANARY");
    });

    it("answers a fulfil that fails unexpectedly with the same fixed refusal, whatever the error says", async () => {
      const { fake, reports, port } = withRegistry({ fulfill: async () => Promise.reject(new Error(`disk said ${CANARY}`)) });
      const envelope = { v: 1, epk: "A".repeat(43), nonce: "B".repeat(16), ct: "C".repeat(40) };
      const answer = await fake.call(fulfillRequest.name, { requestId: `r_${"0".repeat(32)}`, envelope }, port);
      expect(answer).toEqual({ ok: false, code: "service_unavailable", retryable: true });
      expect(reports).toEqual(["fulfill_failed"]);
    });

    it("closes no request with that answer: one whose submission failed before anything was done is still open, and takes the same envelope", async () => {
      const w = world();
      const cwd = tempDir();
      const reports: string[] = [];
      const fake = fakeHost();
      let failing = true;
      const registry = {
        get: (id: string) => w.registry.get(id),
        decline: (id: string) => w.registry.decline(id),
        clearDrop: () => w.registry.clearDrop(),
        fulfill: (...args: Parameters<Registry["fulfill"]>) => (failing ? Promise.reject(new Error("unexpected")) : w.registry.fulfill(...args)),
      };
      registerHandlers(fake.host, { registry, runtime: w.runtime, diagnostics: w.diagnostics, report: (code) => void reports.push(code) });
      const daemon = fakeDaemon({});
      const { requestId } = await w.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      const view = (await fake.call(getRequest.name, { requestId }, daemon.port)) as RequestView;
      const submission = { requestId, envelope: sealFor(view, [{ key: "A", value: CANARY }]) };
      expect(await fake.call(fulfillRequest.name, submission, daemon.port)).toEqual({ ok: false, code: "service_unavailable", retryable: true });
      expect(reports).toEqual(["fulfill_failed"]);
      // Open, as the answer said: not rejected, not counted as an attempt, and nothing written.
      expect(w.registry.get(requestId)).toMatchObject({ state: "pending", retries: 0, errorCode: null });
      expect(((await fake.call(getRequest.name, { requestId }, daemon.port)) as RequestView).state).toBe("pending");
      expect(existsSync(setPath(w.files.drop, requestId))).toBe(false);
      failing = false;
      expect(await fake.call(fulfillRequest.name, submission, daemon.port)).toEqual({ ok: true, state: "delivered" });
      expect(readFileSync(filePath(w.files.drop, requestId, "A"), "utf8")).toBe(CANARY);
    });

    it("lets the same envelope be sent again after that answer when the submission had in fact been taken: it is answered as taken, not as a second one", async () => {
      const w = world();
      const cwd = tempDir();
      const reports: string[] = [];
      const fake = fakeHost();
      let garbled = true;
      const registry = {
        get: (id: string) => w.registry.get(id),
        decline: (id: string) => w.registry.decline(id),
        clearDrop: () => w.registry.clearDrop(),
        // The registry does its work, and what comes back of it is something the contract cannot carry.
        fulfill: async (...args: Parameters<Registry["fulfill"]>) => {
          const result = await w.registry.fulfill(...args);
          return garbled ? ({ ok: true, state: "made_up_state" } as never) : result;
        },
      };
      registerHandlers(fake.host, { registry, runtime: w.runtime, diagnostics: w.diagnostics, report: (code) => void reports.push(code) });
      const daemon = fakeDaemon({});
      const { requestId } = await w.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      const view = (await fake.call(getRequest.name, { requestId }, daemon.port)) as RequestView;
      const submission = { requestId, envelope: sealFor(view, [{ key: "A", value: CANARY }]) };
      expect(await fake.call(fulfillRequest.name, submission, daemon.port)).toEqual({ ok: false, code: "service_unavailable", retryable: true });
      expect(reports).toEqual(["fulfill_invalid"]);
      expect(readFileSync(filePath(w.files.drop, requestId, "A"), "utf8")).toBe(CANARY);
      garbled = false;
      // The same envelope: the same submission, answered with what became of it, and no tampering is flagged.
      expect(await fake.call(fulfillRequest.name, submission, daemon.port)).toEqual({ ok: true, state: "delivered" });
      expect(w.registry.get(requestId)).toMatchObject({ state: "delivered", tamper: false });
    });

    it("refuses a view that does not satisfy its schema, with a fixed text", async () => {
      const bad = { get: () => pendingRecord({ publicKey: "short" }) };
      const { fake, reports, port } = withRegistry(bad);
      const failed = await rejectionOf(fake.call(getRequest.name, { requestId: `r_${"7f3a".repeat(8)}` }, port));
      expect(failed).toEqual({ code: "service_unavailable", message: "service_unavailable: the request cannot be shown" });
      expect(reports).toEqual(["view_invalid"]);
      const good = { get: () => pendingRecord() };
      const ok = withRegistry(good);
      expect(await ok.fake.call(getRequest.name, { requestId: `r_${"7f3a".repeat(8)}` }, ok.port)).toMatchObject({ id: `r_${"7f3a".repeat(8)}` });
      expect(ok.reports).toEqual([]);
    });

    it("refuses diagnostics that do not satisfy their schema", async () => {
      const { fake, reports, port } = withRegistry({}, async () => ({ attached: "yes" }) as never);
      expect((await rejectionOf(fake.call(readDiagnostics.name, {}, port))).message).toBe("service_unavailable: the diagnostics cannot be shown");
      expect(reports).toEqual(["diagnostics_invalid"]);
    });

    it("refuses the result of a deletion it cannot describe, with a fixed text, and logs a code", async () => {
      const { fake, reports, port } = withRegistry({ clearDrop: async () => ({ released: -1, stuck: 0 }) });
      expect(await rejectionOf(fake.call(clearDrop.name, {}, port))).toEqual({ code: "service_unavailable", message: "service_unavailable: the deletion cannot be shown" });
      expect(reports).toEqual(["clear_invalid"]);
      const good = withRegistry({ clearDrop: async () => ({ released: 2, stuck: 1 }) });
      expect(await good.fake.call(clearDrop.name, {}, good.port)).toEqual({ released: 2, stuck: 1 });
      expect(good.reports).toEqual([]);
    });

    it("lets the registry's refusal of a deletion through as it is: the screen has to know it did not happen", async () => {
      const refusal = new SecureInputError("service_unavailable", "the plugin is shutting down");
      const { fake, reports, port } = withRegistry({ clearDrop: async () => Promise.reject(refusal) });
      expect(await rejectionOf(fake.call(clearDrop.name, {}, port))).toEqual({ code: "service_unavailable", message: "service_unavailable: the plugin is shutting down" });
      expect(reports).toEqual([]);
    });

    it("refuses a decision it cannot describe, with a fixed text", async () => {
      const { fake, reports, port } = withRegistry({ decline: async () => ({ state: "made_up" }) });
      expect(await rejectionOf(fake.call(declineRequest.name, { requestId: `r_${"7f3a".repeat(8)}` }, port))).toEqual({
        code: "service_unavailable",
        message: "service_unavailable: the decision cannot be shown",
      });
      expect(reports).toEqual(["decline_invalid"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hooks must never break the host
// ---------------------------------------------------------------------------------------------------------------

describe("hooks on the host", () => {
  it("registers the hooks and the events the plugin needs", async () => {
    const plugin = await started();
    expect(plugin.hasBefore("agent.session_open")).toBe(true);
    // The tools come with the session: nothing is put into an agent's configuration as it is created.
    expect(plugin.hasBefore("agent.create")).toBe(false);
    expect(plugin.hasEvent("agent.turn_started")).toBe(true);
    expect(plugin.hasEvent("agent.turn_ended")).toBe(true);
    expect(plugin.hasEvent("agent.archived")).toBe(true);
    // Deliberately not: what "closed" means for an agent that can be opened again is not known.
    expect(plugin.hasEvent("agent.closed")).toBe(false);
  });

  it("drops what waits for an agent that is archived, and keeps what waits for another", async () => {
    const plugin = await started();
    const cwd = tempDir();
    const daemon = fakeDaemon({ "agent-1": { status: "running" }, "agent-2": { status: "running" } });
    await plugin.before("agent.session_open", opening("agent-1", cwd), daemon.port);
    const ended: Record<string, string> = {};
    for (const agentId of ["agent-1", "agent-2"]) {
      const { requestId } = await plugin.registry.create({ agentId, cwd: tempDir(), title: null }, asking);
      await plugin.registry.decline(requestId);
      ended[agentId] = requestId;
    }
    await plugin.runtime.settled();
    const waiting = () => (JSON.parse(readFileSync(plugin.files.outbox, "utf8")) as Array<{ agentId: string }>).map((item) => item.agentId);
    expect(waiting()).toEqual(["agent-1", "agent-2"]);

    await plugin.emit("agent.archived", { agent: { id: "agent-1" }, archivedAt: "2026-10-11T00:00:00Z" }, daemon.port);
    await plugin.runtime.settled();
    expect(waiting()).toEqual(["agent-2"]);

    for (const agentId of ["agent-1", "agent-2"]) (daemon.agents[agentId] as FakeAgent).status = "idle";
    await plugin.runtime.flushAll();
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([{ agentId: "agent-2", text: continuationText(plugin.registry.get(ended["agent-2"] as string) as RequestRecord, plugin.files.drop) as string }]);
  });

  it("returns the original request for a payload that lacks what the hook reads", async () => {
    const plugin = await started();
    const daemon = fakeDaemon({});
    for (const payload of [{}, { env: null }, { agentId: "a" }] as unknown[]) {
      expect(await plugin.before("agent.session_open", payload, daemon.port), JSON.stringify(payload)).toBe(payload);
    }
    expect((await plugin.diagnostics()).lastHookFailure).toBe("agent.session_open: unexpected");
    await expect(plugin.emit("agent.turn_ended", {}, daemon.port)).resolves.toBeUndefined();
    await expect(plugin.emit("agent.turn_started", undefined, daemon.port)).resolves.toBeUndefined();
    expect(plugin.runtime.attached).toBe(true);
  });

  it("captures the daemon API from the first hook or event", async () => {
    const first: Array<[string, (plugin: Awaited<ReturnType<typeof started>>, port: DaemonPort) => Promise<unknown>]> = [
      ["agent.session_open", (plugin, port) => plugin.before("agent.session_open", opening("a", "/work/a"), port)],
      ["agent.turn_started", (plugin, port) => plugin.emit("agent.turn_started", { agent: { id: "a" } }, port)],
      ["agent.turn_ended", (plugin, port) => plugin.emit("agent.turn_ended", { agent: { id: "a" } }, port)],
      ["agent.archived", (plugin, port) => plugin.emit("agent.archived", { agent: { id: "a" }, archivedAt: "2026-10-11T00:00:00Z" }, port)],
    ];
    for (const [name, trigger] of first) {
      const plugin = await started();
      const daemon = fakeDaemon({});
      expect(plugin.runtime.attached).toBe(false);
      await trigger(plugin, daemon.port);
      expect(plugin.runtime.attached, name).toBe(true);
    }
  });

  it("tells an agent that was busy when its request ended as soon as its turn ends", async () => {
    const plugin = await started();
    const cwd = tempDir();
    const daemon = fakeDaemon({ "agent-1": { status: "running" } });
    await plugin.emit("agent.turn_started", { agent: { id: "agent-1" }, turnId: "t-1" }, daemon.port);
    const { requestId } = await plugin.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    await plugin.registry.decline(requestId);
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([]);
    (daemon.agents["agent-1"] as FakeAgent).status = "idle";
    await plugin.emit("agent.turn_ended", { agent: { id: "agent-1" }, turnId: "t-1", outcome: { kind: "completed" }, timeline: [] }, daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(plugin.registry.get(requestId) as RequestRecord, plugin.files.drop) as string }]);
    await plugin.emit("agent.turn_ended", { agent: { id: "agent-1" }, turnId: "t-2", outcome: { kind: "completed" }, timeline: [] }, daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toHaveLength(1);
  });

  it("offers the tools before the start-up is done, and in an Electron runtime as well", async () => {
    const early = await started({}, false);
    const daemon = fakeDaemon({});
    const opened = (await early.before("agent.session_open", opening("agent-1", "/work/a"), daemon.port)) as SessionOpenRequest;
    expect(opened.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    await early.ready;
    const electron = await started({ runtime: { kind: "electron", execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo" } });
    expect(electron.status.problem).toBeNull();
    expect(((await electron.before("agent.session_open", opening("agent-1", "/work/a"), daemon.port)) as SessionOpenRequest).tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });
});

describe("the guard of the hooks", () => {
  it("lets nothing out of a hook or an event handler when the work in it throws", async () => {
    const fake = fakeHost();
    const failures: string[] = [];
    const broken = () => {
      throw new Error(`boom ${CANARY}`);
    };
    registerHooks(fake.host, {
      runtime: { attach: broken, turnEnded: broken, agentArchived: broken },
      turns: { turnStarted: broken, turnEnded: broken },
      tools: () => [],
      failed: (hook, code) => void failures.push(`${hook}:${code}`),
    });
    const port = fakeDaemon({}).port;
    const open = opening("agent-1", "/work/a");
    expect(await fake.before("agent.session_open", open, port)).toBe(open);
    await expect(fake.emit("agent.turn_started", { agent: { id: "agent-1" } }, port)).resolves.toBeUndefined();
    await expect(fake.emit("agent.turn_ended", { agent: { id: "agent-1" } }, port)).resolves.toBeUndefined();
    await expect(fake.emit("agent.archived", { agent: { id: "agent-1" }, archivedAt: "2026-10-11T00:00:00Z" }, port)).resolves.toBeUndefined();
    // A code, never the error's words.
    expect(failures).toEqual(["agent.session_open:unexpected", "agent.turn_started:unexpected", "agent.turn_ended:unexpected", "agent.archived:unexpected"]);
  });

  it("tells the plugin's own failure by its code, and goes on with the request as it came", async () => {
    const fake = fakeHost();
    const failures: string[] = [];
    registerHooks(fake.host, {
      runtime: { attach: () => undefined, turnEnded: () => undefined, agentArchived: () => undefined },
      turns: { turnStarted: () => undefined, turnEnded: async () => undefined },
      tools: () => {
        throw new SecureInputError("service_unavailable", "the tools cannot be built");
      },
      failed: (hook, code) => void failures.push(`${hook}:${code}`),
    });
    const open = opening("agent-1", "/work/a");
    expect(await fake.before("agent.session_open", open, fakeDaemon({}).port)).toBe(open);
    expect(failures).toEqual(["agent.session_open:service_unavailable"]);
  });

  it("tells a failure of the turn's deletions by its code, and still asks for what waits for the agent", async () => {
    const fake = fakeHost();
    const failures: string[] = [];
    const flushed: string[] = [];
    registerHooks(fake.host, {
      runtime: { attach: () => undefined, turnEnded: (agentId) => void flushed.push(agentId), agentArchived: () => undefined },
      turns: {
        turnStarted: () => undefined,
        turnEnded: async () => {
          throw new SecureInputError("write_failed", "the files could not be deleted");
        },
      },
      tools: () => [],
      failed: (hook, code) => void failures.push(`${hook}:${code}`),
    });
    await expect(fake.emit("agent.turn_ended", { agent: { id: "agent-1" }, turnId: "t-1", outcome: { kind: "completed" }, timeline: [] }, fakeDaemon({}).port)).resolves.toBeUndefined();
    expect(failures).toEqual(["agent.turn_ended:write_failed"]);
    expect(flushed).toEqual(["agent-1"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The lifetime of a set, through the hooks the daemon calls
// ---------------------------------------------------------------------------------------------------------------

describe("lifetimes through the hooks", () => {
  const turnEnded = (turnId: string, outcome: unknown = { kind: "completed" }) => ({ agent: { id: "agent-1" }, turnId, outcome, timeline: [] });

  /** The plugin, an agent of the daemon's and one request of that agent's delivered: the set, and what the agent was sent. */
  async function delivered(overrides: Partial<PluginOptions> = {}, status = "idle") {
    const plugin = await started(overrides);
    const daemon = fakeDaemon({ "agent-1": { status } });
    const tool = await toolsOf(plugin, agentNamed("agent-1", tempDir()), daemon.port);
    const { requestId } = JSON.parse((await tool("request_secret", asking)).text) as { requestId: string };
    expect(await submit(plugin.registry, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    await plugin.runtime.settled();
    return { plugin, daemon, tool, requestId, set: setPath(plugin.files.drop, requestId) };
  }

  it("deletes the files at the end of the turn the message started, not at a late end of the turn before", async () => {
    const { plugin, daemon, requestId, set } = await delivered();
    // The agent was idle: the message was handed over, and it starts the agent's next turn.
    expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(plugin.registry.get(requestId) as RequestRecord, plugin.files.drop) as string }]);

    // The end of the turn before the message, told late.
    await plugin.emit("agent.turn_ended", turnEnded("t-0"), daemon.port);
    expect(plugin.registry.get(requestId)?.state).toBe("delivered");
    expect(existsSync(join(set, "A"))).toBe(true);

    await plugin.emit("agent.turn_started", { agent: { id: "agent-1" }, turnId: "t-1" }, daemon.port);
    expect(existsSync(join(set, "A"))).toBe(true);
    // The turn the message started fails: its end takes the files all the same.
    await plugin.emit("agent.turn_ended", turnEnded("t-1", { kind: "failed", error: { message: "the model gave up" } }), daemon.port);
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "turn" });
    expect(existsSync(set)).toBe(false);
    await plugin.runtime.settled();
    // Released is not announced.
    expect(daemon.sent).toHaveLength(1);
    expect(plugin.status.lastHookFailure).toBeNull();
  });

  it("turns a message that waited past the deadline for a busy agent into the 'deleted after 15 minutes' message, sent once", async () => {
    const { plugin, daemon, requestId, set } = await delivered({ dropTtlMs: 40 }, "running");
    expect(daemon.sent).toEqual([]);
    await vi.waitFor(() => expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "time" }), { timeout: 5000 });
    expect(existsSync(set)).toBe(false);

    (daemon.agents["agent-1"] as FakeAgent).status = "idle";
    await plugin.emit("agent.turn_ended", turnEnded("t-1"), daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([
      {
        agentId: "agent-1",
        text: `[secure-input] Request ${requestId} was delivered, but its files were deleted 15 minutes after they were written, before this message reached you. Nothing is left to move. If the values are still needed, make a new request.`,
      },
    ]);
    await plugin.runtime.flushAll();
    await plugin.emit("agent.turn_ended", turnEnded("t-2"), daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(plugin.files.outbox, "utf8"))).toEqual([]);
  });

  it("drops a waiting message when the agent released the files itself, and sends nothing", async () => {
    const { plugin, daemon, tool, requestId, set } = await delivered({}, "running");
    expect(daemon.sent).toEqual([]);
    expect(JSON.parse((await tool("release_secret", { requestId })).text)).toEqual({ requestId, state: "released" });
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(existsSync(set)).toBe(false);

    (daemon.agents["agent-1"] as FakeAgent).status = "idle";
    await plugin.emit("agent.turn_ended", turnEnded("t-1"), daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([]);
    expect(JSON.parse(readFileSync(plugin.files.outbox, "utf8"))).toEqual([]);
  });

  it("turns a message that waits for a busy agent into the 'deleted by the user' message when the human deletes every file, sent once", async () => {
    const { plugin, daemon, requestId, set } = await delivered({}, "running");
    expect(daemon.sent).toEqual([]);
    // The human presses the button of the settings screen: the call it makes.
    expect(await plugin.call(clearDrop.name, {}, daemon.port)).toEqual({ released: 1, stuck: 0 });
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(existsSync(set)).toBe(false);
    await plugin.runtime.settled();
    // The pill in the chat follows.
    expect((daemon.appended.at(-1)?.item.data as { state: string }).state).toBe("released");

    (daemon.agents["agent-1"] as FakeAgent).status = "idle";
    await plugin.emit("agent.turn_ended", turnEnded("t-1"), daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([
      {
        agentId: "agent-1",
        text: `[secure-input] Request ${requestId} was delivered, but its files were deleted by the user, before this message reached you. Nothing is left to move. If the values are still needed, make a new request.`,
      },
    ]);
    await plugin.runtime.flushAll();
    await plugin.emit("agent.turn_ended", turnEnded("t-2"), daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(plugin.files.outbox, "utf8"))).toEqual([]);
  });

  it("tells the agent nothing more when the human deletes the files after the agent was told of them, and the end of its turn finds nothing to take", async () => {
    const { plugin, daemon, requestId } = await delivered();
    expect(daemon.sent).toHaveLength(1);
    await plugin.emit("agent.turn_started", { agent: { id: "agent-1" }, turnId: "t-1" }, daemon.port);
    expect(await plugin.call(clearDrop.name, {}, daemon.port)).toEqual({ released: 1, stuck: 0 });
    await plugin.runtime.settled();
    await plugin.runtime.flushAll();
    await expect(plugin.emit("agent.turn_ended", turnEnded("t-1"), daemon.port)).resolves.toBeUndefined();
    await plugin.runtime.settled();
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(daemon.sent).toHaveLength(1);
    expect(plugin.status.lastHookFailure).toBeNull();
    expect(plugin.logs).toEqual([]);
  });

  it("does not fail a turn's end when the agent deleted the directory itself mid-turn", async () => {
    const { plugin, daemon, requestId, set } = await delivered();
    expect(daemon.sent).toHaveLength(1);
    await plugin.emit("agent.turn_started", { agent: { id: "agent-1" }, turnId: "t-1" }, daemon.port);
    rmSync(set, { recursive: true });
    await expect(plugin.emit("agent.turn_ended", turnEnded("t-1"), daemon.port)).resolves.toBeUndefined();
    expect(plugin.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(plugin.status.lastHookFailure).toBeNull();
    expect(plugin.registry.health().drop).toBe("ok");
    await plugin.runtime.settled();
    expect(daemon.sent).toHaveLength(1);
    expect(plugin.logs).toEqual([]);
  });

  it("takes no set at the end of a turn that only a tamper warning started: the warning names no file", async () => {
    const { plugin, daemon, requestId, set } = await delivered({}, "running");
    expect(await submit(plugin.registry, requestId, [{ key: "A", value: `${CANARY}-second` }])).toMatchObject({ ok: false, code: "request_closed" });
    await plugin.runtime.settled();
    // The delivery message is gone from the file (the agent can write it): the warning is all that waits.
    const waiting = JSON.parse(readFileSync(plugin.files.outbox, "utf8")) as Array<{ kind: string }>;
    expect(waiting.map((item) => item.kind)).toEqual(["continuation", "tamper"]);
    plant(plugin.files.outbox, JSON.stringify(waiting.filter((item) => item.kind === "tamper")));

    (daemon.agents["agent-1"] as FakeAgent).status = "idle";
    await plugin.emit("agent.turn_ended", turnEnded("t-0"), daemon.port);
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([{ agentId: "agent-1", text: tamperText(plugin.registry.get(requestId) as RequestRecord) }]);
    await plugin.emit("agent.turn_started", { agent: { id: "agent-1" }, turnId: "t-1" }, daemon.port);
    await plugin.emit("agent.turn_ended", turnEnded("t-1"), daemon.port);
    expect(plugin.registry.get(requestId)?.state).toBe("delivered");
    expect(existsSync(join(set, "A"))).toBe(true);
  });

  it("never lets a turn's end that cannot finish hold the hook beyond its bound", async () => {
    expect(RELEASE_WAIT_MS).toBe(5_000);
    const hooked = (releaseWaitMs?: number) => {
      const fake = fakeHost();
      const flushed: string[] = [];
      const failures: string[] = [];
      registerHooks(fake.host, {
        runtime: { attach: () => undefined, turnEnded: (agentId) => void flushed.push(agentId), agentArchived: () => undefined },
        // A turn's end whose deletions never end, as on a disk that stalls.
        turns: { turnStarted: () => undefined, turnEnded: () => new Promise<void>(() => undefined) },
        tools: () => [],
        failed: (hook, code) => void failures.push(`${hook}:${code}`),
        releaseWaitMs,
      });
      return { fake, flushed, failures };
    };

    const quick = hooked(SHORT);
    expect(await promptly(quick.fake.emit("agent.turn_ended", turnEnded("t-1"), fakeDaemon({}).port), 1000)).toBeUndefined();
    // What waits for the agent is asked for all the same, and a wait that ran out is no failure: the deletions go on.
    expect(quick.flushed).toEqual(["agent-1"]);
    expect(quick.failures).toEqual([]);

    // Its own bound, unless a test gives one: five seconds, and not a millisecond less.
    const own = hooked();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let ended = false;
      const emitted = own.fake.emit("agent.turn_ended", turnEnded("t-1"), fakeDaemon({}).port).then(() => {
        ended = true;
      });
      await vi.advanceTimersByTimeAsync(RELEASE_WAIT_MS - 1);
      expect(ended).toBe(false);
      expect(own.flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await emitted;
      expect(ended).toBe(true);
      expect(own.flushed).toEqual(["agent-1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Through the whole plugin
// ---------------------------------------------------------------------------------------------------------------

describe("end to end", () => {
  function leaks(observed: string[]): string[] {
    return observed.filter((text) => text.includes("CANARY"));
  }

  it("takes a request from the agent to its set of files and tells the agent the paths, with no value anywhere on the way", async () => {
    const plugin = await started();
    const cwd = tempDir();
    const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
    const observed: string[] = [];
    const rpc = async (name: string, input: unknown): Promise<unknown> => {
      const out = await plugin.call(name, input, daemon.port);
      observed.push(JSON.stringify(out));
      return out;
    };

    // The agent's session opens, and the agent asks through the tool it was given: as the agent the daemon names.
    const tool = await toolsOf(plugin, agentNamed("agent-1", cwd, "Deploy helper"), daemon.port);
    const asked = await tool("request_secret", { reason: "need the key", fields: [{ key: "STRIPE_KEY", label: "from the dashboard" }, { key: "PEM", optional: true }] });
    observed.push(JSON.stringify(asked));
    expect(asked.isError).toBeUndefined();
    const { requestId, status } = JSON.parse(asked.text) as { requestId: string; status: string };
    expect(status).toBe("pending");
    expect(plugin.registry.get(requestId)).toMatchObject({ agentId: "agent-1", agentCwd: cwd, agentTitle: "Deploy helper" });

    // The app opens the dialog, seals and submits: the key that was asked for, and one of the human's.
    const view = RequestViewSchema.parse(await rpc(getRequest.name, { requestId }));
    expect(view).toMatchObject({
      state: "pending",
      fields: [
        { key: "STRIPE_KEY", label: "from the dashboard", optional: false, kind: "text", format: null },
        { key: "PEM", label: "", optional: true, kind: "text", format: null },
      ],
    });
    const envelope = sealFor(view, [{ key: "STRIPE_KEY", value: CANARY }, { key: "WEBHOOK", value: `${CANARY}-hook` }]);
    expect(await rpc(fulfillRequest.name, { requestId, envelope })).toEqual({ ok: true, state: "delivered" });
    expect(readFileSync(filePath(plugin.files.drop, requestId, "STRIPE_KEY"), "utf8")).toBe(CANARY);
    expect(readFileSync(filePath(plugin.files.drop, requestId, "WEBHOOK"), "utf8")).toBe(`${CANARY}-hook`);

    // The agent sees the keys, and the message that ends its wait names the files.
    const status1 = await tool("request_status", { requestId });
    observed.push(JSON.stringify(status1));
    expect(JSON.parse(status1.text)).toEqual({
      requestId,
      state: "delivered",
      keys: ["STRIPE_KEY", "PEM"],
      written: ["STRIPE_KEY", "WEBHOOK"],
      tamper: false,
      errorCode: null,
      files: { STRIPE_KEY: filePath(plugin.files.drop, requestId, "STRIPE_KEY"), WEBHOOK: filePath(plugin.files.drop, requestId, "WEBHOOK") },
      deleteBy: new Date((plugin.registry.get(requestId) as RequestRecord).deleteBy as number).toISOString(),
    });
    await plugin.runtime.settled();
    const delivered = plugin.registry.get(requestId) as RequestRecord;
    const deliveredText = continuationText(delivered, plugin.files.drop) as string;
    expect(daemon.sent).toEqual([{ agentId: "agent-1", text: deliveredText }]);
    expect(deliveredText.split("\n").slice(0, 3)).toEqual([
      `[secure-input] Request ${requestId} delivered 2 value(s) as files only your OS user can read:`,
      `  STRIPE_KEY → ${shellPath(filePath(plugin.files.drop, requestId, "STRIPE_KEY"))}`,
      `  WEBHOOK → ${shellPath(filePath(plugin.files.drop, requestId, "WEBHOOK"))}`,
    ]);
    expect(deliveredText).toContain("Left empty by the user, so no file: PEM.");

    // A second, different submission is refused, flagged, and reported to the agent.
    const again = sealFor(view, [{ key: "STRIPE_KEY", value: `${CANARY}-other` }]);
    expect(await rpc(fulfillRequest.name, { requestId, envelope: again })).toEqual({ ok: false, code: "request_closed", retryable: false });
    await plugin.runtime.settled();
    expect(daemon.sent).toEqual([
      { agentId: "agent-1", text: deliveredText },
      { agentId: "agent-1", text: tamperText(plugin.registry.get(requestId) as RequestRecord) },
    ]);
    expect(readFileSync(filePath(plugin.files.drop, requestId, "STRIPE_KEY"), "utf8")).toBe(CANARY);
    const after = RequestViewSchema.parse(await rpc(getRequest.name, { requestId }));
    expect(after).toMatchObject({ state: "delivered", tamper: true });

    // Nothing the plugin said, wrote or showed holds the value, except the files the value was meant for.
    observed.push(JSON.stringify(await plugin.call(readDiagnostics.name, {}, daemon.port)));
    observed.push(...daemon.appended.map((entry) => JSON.stringify(entry)), ...daemon.sent.map((entry) => entry.text), ...plugin.logs);
    for (const file of [plugin.files.outbox, join(plugin.dataDir, "requests.json")]) observed.push(readFileSync(file, "utf8"));
    expect(observed.length).toBeGreaterThan(10);
    expect(leaks(observed)).toEqual([]);

    // The card on the timeline followed the request to its end, and names the keys that were written.
    const cards = daemon.appended.filter((entry) => entry.item.id === requestId).map((entry) => CardDataSchema.parse(entry.item.data));
    expect(cards.map((card) => card.state)).toContain("pending");
    expect(cards.at(-1)).toMatchObject({ state: "delivered", tamper: true, keys: ["STRIPE_KEY", "WEBHOOK"] });
    expect(daemon.appended.every((entry) => entry.item.version === CARD_VERSION)).toBe(true);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------
// Start-up, diagnostics, shutdown
// ---------------------------------------------------------------------------------------------------------------

describe("start-up", () => {
  it("creates the data directory and holds it, and makes nothing where v1 never installed", async () => {
    const parent = tempDir();
    const plugin = await started({ dataDir: join(parent, "nested", "secure-input") });
    expect(lstatSync(plugin.dataDir).mode & 0o777).toBe(0o700);
    expect(existsSync(plugin.files.bin)).toBe(false);
    expect(plugin.status).toEqual({ problem: null, lastHookFailure: null });
    const diagnostics = DiagnosticsSchema.parse(await plugin.diagnostics());
    expect(diagnostics).toMatchObject({ attached: false, dataDir: plugin.dataDir, startup: null, lastHookFailure: null });
    expect(plugin.logs).toEqual([]);
  });

  it("puts the stub where v1 left its bridge, and points v1's shim at the daemon's own Node", async () => {
    const dataDir = tempDir();
    plantV1(dataDir, "/old/node");
    const plugin = await started({ dataDir });
    expect(plugin.status.problem).toBeNull();
    expect(readFileSync(join(plugin.files.bin, "bridge.cjs"), "utf8")).toBe(LEGACY_STUB_SOURCE);
    expect(readFileSync(join(plugin.files.bin, "secure-input"), "utf8")).toBe(`#!/bin/sh\nexec '${process.execPath}' '${join(plugin.files.bin, "bridge.cjs")}' "$@"\n`);
    expect(plugin.logs).toEqual([]);
  });

  it("uses the real path of the data directory for everything it derives, and tightens a directory that is too open", async () => {
    const parent = tempDir();
    const real = join(parent, "real");
    mkdirSync(real, { mode: 0o755 });
    symlinkSync(real, join(parent, "link"));
    plantV1(join(real, "secure-input"));
    const plugin = await started({ dataDir: join(parent, "link", "secure-input") });
    expect(plugin.dataDir).toBe(join(real, "secure-input"));
    expect(plugin.files.bin).toBe(join(real, "secure-input", "bin"));
    expect(plugin.files.outbox).toBe(join(real, "secure-input", "outbox.json"));
    // The shim names the stub by its real path, which is what it is run from.
    expect(readFileSync(join(plugin.files.bin, "secure-input"), "utf8")).toContain(`'${join(real, "secure-input", "bin", "bridge.cjs")}'`);
    expect(await plugin.diagnostics()).toMatchObject({ dataDir: plugin.dataDir });

    const loose = join(parent, "loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    const second = await started({ dataDir: loose });
    expect(lstatSync(second.dataDir).mode & 0o777).toBe(0o700);
  });

  it("refuses a data directory that is a link, and writes nothing through it", async () => {
    const parent = tempDir();
    const elsewhere = join(parent, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    plantV1(elsewhere);
    symlinkSync(elsewhere, join(parent, "secure-input"));
    const plugin = await started({ dataDir: join(parent, "secure-input") });
    expect(plugin.status.problem).toEqual({ code: "service_unavailable", detail: "the data directory is not a private directory of this user" });
    expect(plugin.logs).toEqual(["secure-input failed to start: service_unavailable: the data directory is not a private directory of this user"]);
    expect(readFileSync(join(elsewhere, "bin", "bridge.cjs"), "utf8")).toBe(V1_BRIDGE);
    expect(readdirSync(elsewhere)).toEqual(["bin"]);
  });

  it("keeps a start-up that fails as a code and a fixed phrase, and goes on answering what it can", async () => {
    // A bin/ that is a link: the stub is not written through it, and the start-up ends there.
    const dataDir = tempDir();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(dataDir, "bin"));
    const plugin = await started({ dataDir });
    const problem = { code: "service_unavailable", detail: "the bridge directory is not a private directory of this user" };
    expect(plugin.status.problem).toEqual(problem);
    expect(plugin.logs).toEqual(["secure-input failed to start: service_unavailable: the bridge directory is not a private directory of this user"]);
    expect(readdirSync(elsewhere)).toEqual([]);

    const daemon = fakeDaemon({});
    expect(await plugin.call(readDiagnostics.name, {}, daemon.port)).toMatchObject({ startup: problem, messagesHeld: true });
    // The handlers are there: a request that does not exist is refused by the registry, not by a missing handler.
    expect((await rejectionOf(plugin.call(getRequest.name, { requestId: `r_${"0".repeat(32)}` }, daemon.port))).message).toBe("invalid_request: unknown request");
    expect(await plugin.call(selfTestBegin.name, {}, daemon.port)).toMatchObject({ probeId: expect.stringMatching(/^p_/) });
    await expect(plugin.dispose()).resolves.toBeUndefined();
  });

  it("starts in an Electron runtime too, and there replaces v1's bridge and leaves its shim", async () => {
    const dataDir = tempDir();
    plantV1(dataDir);
    const shim = readFileSync(join(dataDir, "bin", "secure-input"), "utf8");
    const plugin = await started({ dataDir, runtime: { kind: "electron", execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo" } });
    expect(plugin.status.problem).toBeNull();
    expect(readFileSync(join(plugin.files.bin, "bridge.cjs"), "utf8")).toBe(LEGACY_STUB_SOURCE);
    expect(readFileSync(join(plugin.files.bin, "secure-input"), "utf8")).toBe(shim);
    expect(DiagnosticsSchema.parse(await plugin.diagnostics()).startup).toBeNull();
  });

  it("tells the agent about what a restart ended, and about nothing else it already heard of", async () => {
    const dataDir = tempDir();
    const cwd = tempDir();
    const first = await started({ dataDir });
    const before = fakeDaemon({ "agent-1": { status: "idle" } });
    first.runtime.attach(before.port);
    const done = await first.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    await first.registry.decline(done.requestId);
    const open = await first.registry.create({ agentId: "agent-2", cwd, title: null }, asking);
    await first.runtime.settled();
    expect(before.sent).toHaveLength(1); // agent-1 heard of its declined request before the restart
    await first.dispose();
    expect(first.registry.get(open.requestId)?.state).toBe("pending");

    const second = await started({ dataDir });
    const daemon = fakeDaemon({ "agent-1": { status: "idle" }, "agent-2": { status: "idle" } });
    second.runtime.attach(daemon.port);
    await second.runtime.settled();
    expect(second.registry.get(open.requestId)?.state).toBe("expired");
    expect(second.registry.get(done.requestId)?.state).toBe("declined");
    // One message, for the request the restart expired. The declined request's message was delivered before the restart and is not made again.
    expect(daemon.sent).toEqual([{ agentId: "agent-2", text: continuationText(second.registry.get(open.requestId) as RequestRecord, second.files.drop) as string }]);
    expect(daemon.appended.map((entry) => `${entry.item.id}:${(entry.item.data as { state: string }).state}`).sort()).toEqual([`${open.requestId}:expired`]);
  });

  describe("a message that waited across a restart", () => {
    type Second = Awaited<ReturnType<typeof started>>;
    const early: Array<[string, (plugin: Second, port: DaemonPort) => Promise<unknown>]> = [
      ["the end of a turn", (plugin, port) => plugin.emit("agent.turn_ended", { agent: { id: "agent-1" }, turnId: "t-1", outcome: { kind: "completed" }, timeline: [] }, port)],
      [
        "a session that opens",
        (plugin, port) => plugin.before("agent.session_open", { ...opening("agent-1", "/work/a"), reason: "resume" }, port),
      ],
      ["a diagnostics call", (plugin, port) => plugin.call(readDiagnostics.name, {}, port)],
    ];

    it.each(early)("is not looked at before the registry has loaded, and is sent once after: %s comes first", async (_name, trigger) => {
      const dataDir = tempDir();
      const cwd = tempDir();
      const first = await started({ dataDir });
      const before = fakeDaemon({ "agent-1": { status: "running" } });
      first.runtime.attach(before.port);
      const { requestId } = await first.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await first.registry.decline(requestId);
      await first.runtime.settled();
      expect(before.sent).toEqual([]); // the agent is busy: its message waits in the file
      await first.dispose();
      const waiting = JSON.parse(readFileSync(first.files.outbox, "utf8")) as unknown[];
      expect(waiting).toMatchObject([{ agentId: "agent-1", requestId, kind: "continuation" }]);

      // The second process is held at the point where it reads its requests, as a slow disk would hold it.
      const load = Registry.prototype.load;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = vi.spyOn(Registry.prototype, "load").mockImplementation(async function (this: Registry) {
        await held;
        return load.call(this);
      });
      try {
        const second = await started({ dataDir, startupWaitMs: SHORT }, false);
        const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
        await trigger(second, daemon.port);
        await second.runtime.settled();
        expect(second.runtime.attached).toBe(true);
        expect(second.registry.get(requestId)).toBeUndefined(); // nothing is loaded yet
        expect(JSON.parse(readFileSync(second.files.outbox, "utf8"))).toEqual(waiting);
        expect(daemon.sent).toEqual([]);

        release();
        await second.ready;
        await second.runtime.settled();
        expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(second.registry.get(requestId) as RequestRecord, second.files.drop) as string }]);
        expect(readFileSync(second.files.outbox, "utf8")).toBe("[]");
        // Nothing sends it a second time.
        await second.emit("agent.turn_ended", { agent: { id: "agent-1" }, turnId: "t-2", outcome: { kind: "completed" }, timeline: [] }, daemon.port);
        await second.runtime.flushAll();
        await second.runtime.settled();
        expect(daemon.sent).toHaveLength(1);
      } finally {
        release();
        slow.mockRestore();
      }
    });
  });

  it("after a restart, says a second, different submission once, and does not say where the files are a second time", async () => {
    const dataDir = tempDir();
    const first = await started({ dataDir });
    const before = fakeDaemon({ "agent-1": { status: "idle" } });
    first.runtime.attach(before.port);
    const { requestId } = await first.registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, asking);
    const asked = first.registry.get(requestId) as RequestRecord;
    expect(await submit(first.registry, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    await first.runtime.settled();
    const deliveredText = continuationText(first.registry.get(requestId) as RequestRecord, first.files.drop) as string;
    expect(before.sent).toEqual([{ agentId: "agent-1", text: deliveredText }]); // delivered, and told, before the restart
    await first.dispose();
    expect(readFileSync(first.files.outbox, "utf8")).toBe("[]");
    // The stop took the set away, and the record says so; released is never announced.
    expect(first.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(readdirSync(first.files.drop)).toEqual([]);
    expect(before.sent).toHaveLength(1);

    const second = await started({ dataDir });
    const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
    second.runtime.attach(daemon.port);
    await second.runtime.settled();
    // A record that was closed when it was saved is not announced by the load: no message, no card.
    expect(daemon.sent).toEqual([]);
    expect(daemon.appended).toEqual([]);

    // Somebody submits other values to the request whose values were delivered before the restart.
    const forged = sealFor(asked, [{ key: "A", value: `${CANARY}-other` }]);
    expect(await second.registry.fulfill(requestId, forged)).toEqual({ ok: false, code: "request_closed", retryable: false });
    await second.runtime.settled();
    const flagged = second.registry.get(requestId) as RequestRecord;
    expect(flagged).toMatchObject({ state: "released", releasedBy: "stop", tamper: true });
    // Exactly one message: the warning. Not where the files are again, and not before it.
    expect(daemon.sent).toEqual([{ agentId: "agent-1", text: tamperText(flagged) }]);
    expect(daemon.sent.map((message) => message.text)).not.toContain(deliveredText);
    expect(daemon.appended.map((entry) => entry.item.data)).toMatchObject([{ state: "released", tamper: true }]);
    await second.runtime.flushAll();
    await second.runtime.settled();
    expect(daemon.sent).toHaveLength(1);
    expect(readdirSync(second.files.drop)).toEqual([]);
  });

  describe("what the agent is told about a request that was open when the plugin restarted", () => {
    const EXPIRED = (id: string) => `[secure-input] Request ${id} expired when the plugin restarted. Nothing was delivered. If the values are still needed, make a new request.`;

    it("says that it expired when the plugin restarted, and that nothing was delivered", async () => {
      const dataDir = tempDir();
      const first = await started({ dataDir });
      const { requestId } = await first.registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, asking);
      await first.dispose();
      const second = await started({ dataDir });
      const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
      second.runtime.attach(daemon.port);
      await second.runtime.settled();
      expect(second.registry.get(requestId)).toMatchObject({ state: "expired", expiredBy: "restart" });
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: EXPIRED(requestId) }]);
    });

    it("says it of a set that was written before the plugin died and never saved as delivered: the start takes the set away", async () => {
      const dataDir = tempDir();
      const first = await started({ dataDir });
      const { requestId } = await first.registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, asking);
      await first.dispose();
      // What a write that landed leaves, when the plugin was killed before it saved the request: the set, and a pending record.
      const set = setPath(first.files.drop, requestId);
      mkdirSync(set, { mode: 0o700 });
      writeFileSync(join(set, "A"), CANARY, { mode: 0o600 });
      expect((JSON.parse(readFileSync(join(dataDir, "requests.json"), "utf8")) as RequestRecord[])[0]?.state).toBe("pending");

      const restarted = await started({ dataDir });
      const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
      restarted.runtime.attach(daemon.port);
      await restarted.runtime.settled();
      expect(existsSync(set)).toBe(false);
      expect(readdirSync(restarted.files.drop)).toEqual([]);
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: EXPIRED(requestId) }]);
      expect(daemon.sent[0]?.text).not.toContain("CANARY");
    });
  });

  describe("a record somebody planted in requests.json", () => {
    const ID = `r_${"ab12".repeat(8)}`;
    /** A record the schema takes, with a key that is a real one, as a planter would make it. */
    const planted = (changes: Partial<RequestRecord>): RequestRecord =>
      record({
        id: ID,
        agentId: "victim",
        agentCwd: "/work/victim",
        state: "pending",
        publicKey: toBase64Url(generateRequestKeyPair().publicKey),
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...changes,
      });

    async function startedOn(records: readonly unknown[]) {
      const dataDir = tempDir();
      plant(join(dataDir, "requests.json"), JSON.stringify(records));
      const plugin = await started({ dataDir });
      const daemon = fakeDaemon({ victim: { status: "idle" } });
      plugin.runtime.attach(daemon.port);
      await plugin.runtime.settled();
      await plugin.runtime.flushAll();
      await plugin.runtime.settled();
      return { plugin, daemon };
    }

    it("is announced by nothing when it is closed: no message and no card", async () => {
      const { plugin, daemon } = await startedOn([planted({ state: "declined" })]);
      // It is a record the schema takes: it was loaded, and would have had a message to give.
      expect(plugin.registry.get(ID)).toMatchObject({ state: "declined", agentId: "victim" });
      expect(continuationText(plugin.registry.get(ID) as RequestRecord, plugin.files.drop)).toContain("the user declined");
      expect(daemon.sent).toEqual([]);
      expect(daemon.appended).toEqual([]);
      expect(existsSync(plugin.files.outbox)).toBe(false); // nothing was ever put in it
    });

    it("gets exactly the restart message and the expired card when it is open, and nothing else", async () => {
      const { plugin, daemon } = await startedOn([planted({ state: "pending" })]);
      expect(plugin.registry.get(ID)).toMatchObject({ state: "expired", expiredBy: "restart" });
      expect(daemon.sent).toEqual([
        { agentId: "victim", text: `[secure-input] Request ${ID} expired when the plugin restarted. Nothing was delivered. If the values are still needed, make a new request.` },
      ]);
      expect(daemon.appended.map((entry) => [entry.agentId, entry.item.id, (entry.item.data as { state: string }).state])).toEqual([["victim", ID, "expired"]]);
      // It cannot be opened or written anywhere: there is no key for it.
      const envelope = sealFor(plugin.registry.get(ID) as RequestRecord, [{ key: "A", value: CANARY }]);
      expect(await plugin.registry.fulfill(ID, envelope)).toEqual({ ok: false, code: "request_closed", retryable: false });
      await plugin.runtime.settled();
      expect(daemon.sent).toHaveLength(1);
    });

    it("gets the released card and no message when it says its values were delivered, since the start took its files away", async () => {
      const { plugin, daemon } = await startedOn([planted({ state: "delivered", fulfilledDigest: "c".repeat(64), written: ["A"], deleteBy: 1_700_000_900_000 })]);
      expect(plugin.registry.get(ID)).toMatchObject({ state: "released", releasedBy: "restart" });
      expect(daemon.sent).toEqual([]);
      expect(daemon.appended.map((entry) => [entry.agentId, (entry.item.data as { state: string }).state])).toEqual([["victim", "released"]]);
    });

    it("is not loaded when it is v1's, which this version has no destination for: it is counted, and no word is said of it", async () => {
      const v1Id = `r_${"cd34".repeat(8)}`;
      const { requestDigest: _digest, written: _written, deleteBy: _deleteBy, ...shared } = planted({ id: v1Id });
      const v1 = {
        ...shared,
        state: "written",
        sinkDigest: "c".repeat(64),
        fulfilledDigest: "c".repeat(64),
        receipt: { kind: "dotenv", relativePath: ".env.local", written: ["A"], skipped: [], added: ["A"], overwritten: [] },
        request: { reason: "", sink: { kind: "dotenv", path: ".env.local", dialect: "dotenv" }, fields: [{ key: "A" }], allowExtraRows: false },
      };
      const { plugin, daemon } = await startedOn([v1, planted({ state: "pending" })]);
      expect(plugin.registry.get(v1Id)).toBeUndefined();
      expect((await plugin.diagnostics()).registry).toEqual({ persistence: "ok", drop: "ok", stored: "ok", dropped: 1 });
      // The record next to it is loaded as it would have been: it is the restart message of that one alone that is sent.
      expect(plugin.registry.get(ID)).toMatchObject({ state: "expired", expiredBy: "restart" });
      expect(daemon.sent.map((message) => message.text)).toEqual([expect.stringContaining(`Request ${ID} expired when the plugin restarted`)]);
      expect(daemon.appended.map((entry) => entry.item.id)).toEqual([ID]);
    });
  });

  it("removes what a killed run left in drop/ though the start goes on to fail: with a bin/ the stub cannot be written into", async () => {
    const failures: Array<[string, (dataDir: string) => void]> = [
      // A file where v1's directory was: the stub cannot be put in it.
      ["a file in place of bin/", (dataDir) => writeFileSync(join(dataDir, "bin"), "not a directory")],
      // A link in its place: nothing is written through it.
      ["a link in place of bin/", (dataDir) => symlinkSync(tempDir(), join(dataDir, "bin"))],
    ];
    for (const [name, breakIt] of failures) {
      const dataDir = tempDir();
      // A set a run that was killed left, with a value in it, and what a write killed half-way left beside it.
      const set = join(dataDir, "drop", `si-secret-r_${"9".repeat(32)}`);
      mkdirSync(set, { recursive: true, mode: 0o700 });
      writeFileSync(join(set, "SECRET"), CANARY, { mode: 0o600 });
      mkdirSync(join(dataDir, "drop", `si-secret-r_${"8".repeat(32)}.0123456789abcdef.tmp`));
      breakIt(dataDir);

      const plugin = await started({ dataDir });
      expect(plugin.status.problem?.code, name).toBe("service_unavailable");
      expect(readdirSync(join(dataDir, "drop")), name).toEqual([]);
      expect((await plugin.diagnostics()).registry.drop, name).toBe("ok");
    }
  });

  it("does not start, and touches nothing behind it, when drop/ is a link", async () => {
    const dataDir = tempDir();
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "keep"), "KEEP", { mode: 0o600 });
    mkdirSync(join(elsewhere, `si-secret-r_${"9".repeat(32)}`));
    symlinkSync(elsewhere, join(dataDir, "drop"));
    plantV1(dataDir);
    const plugin = await started({ dataDir });
    expect(plugin.status.problem).toEqual({ code: "service_unavailable", detail: "the drop directory is not a private directory of this user" });
    expect(plugin.logs).toEqual(["secure-input failed to start: service_unavailable: the drop directory is not a private directory of this user"]);
    expect(readdirSync(elsewhere).sort()).toEqual(["keep", `si-secret-r_${"9".repeat(32)}`]);
    // The start-up ended at the sweep: v1's bridge was not replaced, and no request was loaded.
    expect(readFileSync(join(dataDir, "bin", "bridge.cjs"), "utf8")).toBe(V1_BRIDGE);
    expect(plugin.runtime.messagesHeld).toBe(true);
    const daemon = fakeDaemon({});
    const tool = await toolsOf(plugin, agentNamed("agent-1", tempDir()), daemon.port);
    expect(await tool("request_secret", asking)).toEqual({
      isError: true,
      text: JSON.stringify({ error: "service_unavailable", message: "service_unavailable: the plugin did not start (service_unavailable). Tell the user. Do not ask for the secret in chat instead." }),
    });
  });

  it("sweeps before it replaces v1's bridge, and once", async () => {
    const dataDir = tempDir();
    plantV1(dataDir);
    const bridge = (): string => (readFileSync(join(dataDir, "bin", "bridge.cjs"), "utf8") === LEGACY_STUB_SOURCE ? "the stub" : "v1's");
    const order: string[] = [];
    const sweep = Registry.prototype.sweep;
    const load = Registry.prototype.load;
    const swept = vi.spyOn(Registry.prototype, "sweep").mockImplementation(function (this: Registry) {
      // The bridge is still v1's when the sweep is asked for.
      order.push(`sweep, bridge ${bridge()}`);
      return sweep.call(this);
    });
    const loaded = vi.spyOn(Registry.prototype, "load").mockImplementation(function (this: Registry) {
      order.push("load");
      return load.call(this);
    });
    try {
      const plugin = await started({ dataDir });
      expect(plugin.status.problem).toBeNull();
      // The start-up asks for the sweep first; the load asks again and gets the same one.
      expect(order).toEqual(["sweep, bridge v1's", "load", "sweep, bridge the stub"]);
      expect(swept.mock.results[0]?.value).toBe(swept.mock.results[1]?.value);
    } finally {
      swept.mockRestore();
      loaded.mockRestore();
    }
  });

  it("keeps an unexpected failure of the start-up as a code and a fixed phrase, never the error's own words", async () => {
    const failing = vi.spyOn(Registry.prototype, "load").mockRejectedValueOnce(new Error(`disk said ${CANARY}`));
    try {
      const plugin = await started();
      expect(plugin.status.problem).toEqual({ code: "unexpected", detail: "an unexpected error stopped the start-up" });
      expect(plugin.logs).toEqual(["secure-input failed to start: unexpected: an unexpected error stopped the start-up"]);
      expect(JSON.stringify(await plugin.diagnostics())).not.toContain("CANARY");
    } finally {
      failing.mockRestore();
    }
  });

  it("describes the runtime it is told about, and finds its own options from the environment", () => {
    expect(describeRuntime({ node: "22.0.0" }, "/usr/bin/node")).toEqual({ kind: "node", execPath: "/usr/bin/node" });
    expect(describeRuntime({ node: "22.0.0", electron: "30.1.0" }, "/App/Paseo")).toEqual({ kind: "electron", execPath: "/App/Paseo" });
    expect(describeRuntime({ electron: "" }, "/usr/bin/node").kind).toBe("node");
    expect(defaultOptions({ PASEO_HOME: "/data/paseo" }).dataDir).toBe("/data/paseo/secure-input");
    expect(defaultOptions({ PASEO_HOME: "" }).dataDir).toMatch(/\/\.paseo\/secure-input$/);
    expect(defaultOptions({}).dataDir).toMatch(/\/\.paseo\/secure-input$/);
  });

  it("reports the health of every part in the diagnostics, as names, counts and codes only", async () => {
    const plugin = await started();
    const daemon = fakeDaemon({});
    await plugin.before("agent.session_open", opening("a", "/work/a"), daemon.port);
    await plugin.before("agent.session_open", {}, daemon.port);

    const expected = {
      attached: true,
      dataDir: plugin.dataDir,
      registry: { persistence: "ok", drop: "ok", stored: "ok", dropped: 0 },
      outbox: { persistence: "ok", unsaved: 0, dropped: 0 },
      requests: { pending: 0, delivered: 0, nextDeleteBy: null },
      startup: null,
      cardsOwed: 0,
      messagesHeld: false,
      lastHookFailure: "agent.session_open: unexpected",
    };
    expect(await plugin.call(readDiagnostics.name, {}, daemon.port)).toEqual(expected);
  });

  it("counts the requests that wait and the sets that are delivered in the diagnostics, names the nearest deadline, and counts again after the human's word", async () => {
    const plugin = await started();
    const daemon = fakeDaemon({ "agent-1": { status: "idle" }, "agent-2": { status: "idle" } });
    plugin.runtime.attach(daemon.port);
    const cwd = tempDir();
    const requests = async () => DiagnosticsSchema.parse(await plugin.call(readDiagnostics.name, {}, daemon.port)).requests;
    await plugin.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    const delivering = (await plugin.registry.create({ agentId: "agent-2", cwd, title: null }, asking)).requestId;
    expect(await requests()).toEqual({ pending: 2, delivered: 0, nextDeleteBy: null });
    expect(await submit(plugin.registry, delivering, [{ key: "A", value: "typed-delivered" }])).toEqual({ ok: true, state: "delivered" });
    expect(await requests()).toEqual({ pending: 1, delivered: 1, nextDeleteBy: plugin.registry.get(delivering)?.deleteBy });
    expect(await plugin.call(clearDrop.name, {}, daemon.port)).toEqual({ released: 1, stuck: 0 });
    expect(await requests()).toEqual({ pending: 1, delivered: 0, nextDeleteBy: null });
    expect(readdirSync(plugin.files.drop)).toEqual([]);
  });

  it("offers the deletion when the start-up could not empty drop/ and no set is delivered, and the deletion ends the failure once the entry can go", async () => {
    const dataDir = tempDir();
    // What a run that was killed left behind: a directory the sweep of the start-up cannot empty.
    const stray = join(dataDir, "drop", "stray");
    mkdirSync(stray, { recursive: true, mode: 0o700 });
    writeFileSync(join(stray, "left"), "left behind", { mode: 0o600 });
    chmodSync(stray, 0o500);
    const plugin = await started({ dataDir });
    const daemon = fakeDaemon({});
    const read = async () => DiagnosticsSchema.parse(await plugin.call(readDiagnostics.name, {}, daemon.port));
    try {
      const before = await read();
      expect(before.registry.drop).toBe("failing");
      expect(before.requests.delivered).toBe(0);
      // The red row sends the human to the button, and the button is there.
      expect(statusRows(before)[1]).toMatchObject({ label: "Секрети на сервері", value: "0 · не все видалено", dot: "bad" });
      expect(canDeleteAll(before)).toBe(true);
      // The deletion while the entry cannot go: it says so, and the button stays.
      expect(await plugin.call(clearDrop.name, {}, daemon.port)).toEqual({ released: 0, stuck: 1 });
      expect(canDeleteAll(await read())).toBe(true);
    } finally {
      chmodSync(stray, 0o700);
    }
    // The entry can go now: the deletion ends the failure, and the button goes with it.
    expect(await plugin.call(clearDrop.name, {}, daemon.port)).toEqual({ released: 0, stuck: 0 });
    const after = await read();
    expect(after.registry.drop).toBe("ok");
    expect(statusRows(after)[1]).toEqual({ label: "Секрети на сервері", value: "Немає", dot: "ok", explanation: null });
    expect(canDeleteAll(after)).toBe(false);
    expect(readdirSync(plugin.files.drop)).toEqual([]);
  });

  it("says whether messages to agents are held back: while a start-up has not read the requests, and not once it has", async () => {
    // A start-up that fails before the requests are read (a bin/ that is a link): every flush is held for good, and
    // what waits stays in the file.
    const dataDir = tempDir();
    symlinkSync(tempDir(), join(dataDir, "bin"));
    const failed = await started({ dataDir });
    const daemon = fakeDaemon({});
    expect(DiagnosticsSchema.parse(await failed.call(readDiagnostics.name, {}, daemon.port)).messagesHeld).toBe(true);

    const fine = await started();
    expect(DiagnosticsSchema.parse(await fine.call(readDiagnostics.name, {}, daemon.port)).messagesHeld).toBe(false);

    // Parts that were assembled and never started hold nothing back.
    expect((await world().diagnostics()).messagesHeld).toBe(false);
  });

  it("says how many cards the timeline does not show yet, and appends them on its tick", async () => {
    const plugin = await started({ expiryIntervalMs: 20 });
    const cwd = tempDir();
    let refusing = true;
    const daemon = fakeDaemon(
      { "agent-1": { status: "running" } },
      {
        append: (agentId, item) => {
          if (refusing) return Promise.reject(new Error("the daemon could not take it just now"));
          daemon.appended.push({ agentId, item });
          return Promise.resolve({ seq: 1, epoch: "e" });
        },
      },
    );
    plugin.runtime.attach(daemon.port);
    const { requestId } = await plugin.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    await plugin.runtime.settled();
    expect(DiagnosticsSchema.parse(await plugin.call(readDiagnostics.name, {}, daemon.port)).cardsOwed).toBe(1);
    expect(daemon.appended).toEqual([]);
    // The daemon takes cards again. Nothing about the request changes: the tick is what brings the card.
    refusing = false;
    await vi.waitFor(() => expect(daemon.appended).toHaveLength(1), { timeout: 5000 });
    expect(daemon.appended[0]).toMatchObject({ agentId: "agent-1", item: { id: requestId, data: { state: "pending" } } });
    await plugin.runtime.settled();
    expect((await plugin.diagnostics()).cardsOwed).toBe(0);
  });

  it("shows a registry whose file could not be read or held invalid entries, and an outbox that cannot save", async () => {
    const unreadable = tempDir();
    plant(join(unreadable, "requests.json"), "[ not json");
    const first = await started({ dataDir: unreadable });
    expect((await first.diagnostics()).registry).toEqual({ persistence: "ok", drop: "ok", stored: "unreadable", dropped: 0 });

    const invalid = tempDir();
    plant(join(invalid, "requests.json"), JSON.stringify([{ id: "x" }, 7]));
    const second = await started({ dataDir: invalid });
    expect((await second.diagnostics()).registry).toEqual({ persistence: "ok", drop: "ok", stored: "ok", dropped: 2 });

    const third = await started();
    mkdirSync(third.files.outbox); // a directory where the file belongs: nothing can be saved
    const cwd = tempDir();
    const daemon = fakeDaemon({ "agent-1": { status: "running" } });
    third.runtime.attach(daemon.port);
    const { requestId } = await third.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    await third.registry.decline(requestId);
    await third.runtime.settled();
    expect((await third.diagnostics()).outbox).toEqual({ persistence: "failing", unsaved: 1, dropped: 0 });
    expect(daemon.sent).toEqual([]); // the agent is busy; the message waits in memory
  });
});

describe("clean-up", () => {
  it("waits for a start-up in progress, then leaves no state of the process behind", async () => {
    const hostFake = fakeHost();
    const plugin = startPlugin(hostFake.host, optionsFor());
    running.push(plugin.dispose);
    const probe = (await hostFake.call(selfTestBegin.name, {}, fakeDaemon({}).port)) as { probeId: string; publicKey: string };
    await plugin.dispose(); // without awaiting `ready`
    await plugin.ready;
    expect(plugin.status.problem).toBeNull();
    // The probe died with the plugin: its key was wiped.
    const payload = new Uint8Array(8).fill(1);
    const envelope = seal(fromBase64Url(probe.publicKey), payload, buildAad(probe.probeId, "selftest"));
    expect(await hostFake.call(selfTestFinish.name, { probeId: probe.probeId, envelope, digest: digestHex(payload) }, fakeDaemon({}).port)).toEqual({ ok: false, bytes: 0 });
  });

  describe("a start-up that does not end", () => {
    /** The plugin, with one step of its start-up held until the test lets it go. The step is replaced before the start-up reaches it. */
    function stuckAt(step: "sweep" | "load") {
      const hostFake = fakeHost();
      const plugin = startPlugin(hostFake.host, optionsFor({ startupWaitMs: SHORT }));
      running.push(plugin.dispose);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // What the step answers is handed on as it is; the two steps answer with different types, which is all the cast is for.
      const real = plugin.registry[step].bind(plugin.registry) as () => Promise<never>;
      const reached = vi.spyOn(plugin.registry, step).mockImplementation(() => held.then<never>(real));
      return { plugin, release, reached };
    }

    it("is not waited for beyond the bound: dispose returns, and the load that comes back afterwards lets no message out", async () => {
      const { plugin, release, reached } = stuckAt("load");
      await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1), { timeout: 5000 });
      // The start-up hangs in the reading of the requests, and dispose does not hang with it.
      expect(await promptly(plugin.dispose())).toBeUndefined();
      // Long after, the step comes back. A dispose is over: the registry loads nothing behind it, and the messages stay held.
      release();
      await plugin.ready;
      expect(plugin.runtime.messagesHeld).toBe(true);
      expect(plugin.status.problem).toBeNull();
    });

    it("begins no further step once dispose has begun: nothing is written or read by a start-up that comes back later", async () => {
      const { plugin, release, reached } = stuckAt("sweep");
      // v1's bridge is there: the step after the sweep would put the stub in its place.
      plantV1(plugin.dataDir);
      const load = vi.spyOn(plugin.registry, "load");
      await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(await promptly(plugin.dispose())).toBeUndefined();
      release();
      await plugin.ready;
      expect(readFileSync(join(plugin.files.bin, "bridge.cjs"), "utf8")).toBe(V1_BRIDGE);
      expect(load).not.toHaveBeenCalled();
      expect(plugin.status.problem).toBeNull();
    });

    it("removes nothing of the plugin that was started after it, when it comes back to its sweep: not a set it delivered", async () => {
      const { plugin: first, release, reached } = stuckAt("sweep");
      await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1), { timeout: 5000 });
      // The start-up hangs before it has swept anything, and the dispose gives up on it.
      expect(await promptly(first.dispose())).toBeUndefined();

      // The plugin that is started in its place, on the same directory, and a set it has delivered.
      const second = await started({ dataDir: first.dataDir });
      expect(second.files.drop).toBe(first.files.drop);
      const { requestId } = await second.registry.create({ agentId: "agent-1", cwd: tempDir(), title: null }, asking);
      expect(await submit(second.registry, requestId, [{ key: "A", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
      expect(readdirSync(second.files.drop)).toEqual([`si-secret-${requestId}`]);

      // The disk comes back under the plugin that was disposed of, and its start-up goes on with the sweep it was at.
      release();
      await first.ready;

      // Nothing of the second plugin was swept: its set is there, whole.
      expect(readFileSync(filePath(second.files.drop, requestId, "A"), "utf8")).toBe(CANARY);
      expect(first.status.problem).toBeNull();
    }, LONG);

    it("marks the registry stopped the moment it stops waiting, so a load that comes back while the rest of the dispose is under way loads nothing, and the messages stay held", async () => {
      // A message that waits across the restart, as the agent was busy when its request was declined.
      const dataDir = tempDir();
      const cwd = tempDir();
      const before = await started({ dataDir });
      before.runtime.attach(fakeDaemon({ "agent-1": { status: "running" } }).port);
      const { requestId } = await before.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
      await before.registry.decline(requestId);
      await before.runtime.settled();
      await before.dispose();
      const waiting = readFileSync(before.files.outbox, "utf8");
      expect(JSON.parse(waiting)).toMatchObject([{ agentId: "agent-1", requestId, kind: "continuation" }]);
      const saved = readFileSync(join(dataDir, "requests.json"), "utf8");

      // The next plugin hangs where it reads its requests. The agent is idle by now and the daemon has called in, so
      // a flush is wanted and held back until the requests are read.
      const hostFake = fakeHost();
      const plugin = startPlugin(hostFake.host, optionsFor({ dataDir, startupWaitMs: SHORT }));
      running.push(plugin.dispose);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const load = plugin.registry.load.bind(plugin.registry);
      const reached = vi.spyOn(plugin.registry, "load").mockImplementation(() => held.then(load));
      await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1), { timeout: 5000 });
      const daemon = fakeDaemon({ "agent-1": { status: "idle" } });
      plugin.runtime.attach(daemon.port);

      // The dispose gives up on the start-up and goes on, and is held at the registry's shutdown: the runtime still
      // delivers, and nothing but the mark the dispose set itself says that the registry is stopped.
      let goOn!: () => void;
      const shutdownHeld = new Promise<void>((resolve) => {
        goOn = resolve;
      });
      const shutdown = plugin.registry.shutdown.bind(plugin.registry);
      const atShutdown = vi.spyOn(plugin.registry, "shutdown").mockImplementation(() => shutdownHeld.then(shutdown));
      const disposing = plugin.dispose();
      try {
        await vi.waitFor(() => expect(atShutdown).toHaveBeenCalledTimes(1), { timeout: 5000 });

        // The load comes back now.
        release();
        await plugin.ready;
        await plugin.runtime.settled();

        // It loaded nothing: the request is not known here, and the file is as the plugin before left it.
        expect(plugin.registry.get(requestId)).toBeUndefined();
        expect(readFileSync(join(dataDir, "requests.json"), "utf8")).toBe(saved);
        // And the messages were not released: the outbox would have looked for the request, not found it, and
        // dropped the message from the file.
        expect(plugin.runtime.messagesHeld).toBe(true);
        expect(readFileSync(plugin.files.outbox, "utf8")).toBe(waiting);
        expect(daemon.sent).toEqual([]);
      } finally {
        goOn();
        await disposing;
      }
      expect(readFileSync(plugin.files.outbox, "utf8")).toBe(waiting);

      // The start after that loads the request, and sends the message that waited.
      const next = await started({ dataDir });
      next.runtime.attach(daemon.port);
      await next.runtime.settled();
      expect(daemon.sent).toEqual([{ agentId: "agent-1", text: continuationText(next.registry.get(requestId) as RequestRecord, next.files.drop) as string }]);
    });

    it("writes no stub once the stop has begun while it was replacing v1's bridge: what another plugin wrote stays as it is", async () => {
      const dataDir = tempDir();
      const bin = join(dataDir, "bin");
      mkdirSync(bin, { mode: 0o700 });
      plant(join(bin, "bridge.cjs"), "// the bridge another plugin installed\n");
      plant(join(bin, "secure-input"), "#!/bin/sh\n# the shim another plugin installed\n");
      const logs: string[] = [];
      let disposing: Promise<void> | undefined;
      // The step reads the path of Node as it begins to replace the bridge: the stop begins there, inside the step, past
      // the look the start-up takes between two steps.
      const plugin = startPlugin(
        fakeHost().host,
        optionsFor(
          {
            dataDir,
            runtime: {
              kind: "node",
              get execPath() {
                disposing ??= plugin.dispose();
                return process.execPath;
              },
            },
          },
          logs,
        ),
      );
      running.push(plugin.dispose);
      await plugin.ready;
      expect(disposing).toBeDefined();
      await disposing;
      expect(readdirSync(bin).sort()).toEqual(["bridge.cjs", "secure-input"]);
      expect(readFileSync(join(bin, "bridge.cjs"), "utf8")).toBe("// the bridge another plugin installed\n");
      expect(readFileSync(join(bin, "secure-input"), "utf8")).toBe("#!/bin/sh\n# the shim another plugin installed\n");
      expect(plugin.status.problem).toBeNull();
      expect(logs).toEqual([]);
    });

    it("waits no longer than five seconds for it by default", async () => {
      expect(STARTUP_WAIT_MS).toBe(5_000);
      const hostFake = fakeHost();
      const plugin = startPlugin(hostFake.host, optionsFor()); // no bound of the test's own
      running.push(plugin.dispose);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = plugin.registry.load.bind(plugin.registry);
      const reached = vi.spyOn(plugin.registry, "load").mockImplementation(() => held.then(real));
      await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1), { timeout: 5000 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let passedStartUp = false;
        // The registry's shutdown is the step after the wait for the start-up.
        vi.spyOn(plugin.registry, "shutdown").mockImplementation(async () => {
          passedStartUp = true;
        });
        const disposing = plugin.dispose();
        await vi.advanceTimersByTimeAsync(STARTUP_WAIT_MS - 1);
        expect(passedStartUp).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(SETTLE_BOUND_MS);
        await disposing;
        expect(passedStartUp).toBe(true);
      } finally {
        vi.useRealTimers();
        release();
      }
      await plugin.ready;
    });
  });

  it("can be called twice, and does its work once", async () => {
    const plugin = await started();
    const shutdown = vi.spyOn(plugin.registry, "shutdown");
    await plugin.dispose();
    await expect(plugin.dispose()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("runs every step, in order, even when one of them throws", async () => {
    const plugin = await started();
    const daemon = fakeDaemon({});
    const probe = (await plugin.call(selfTestBegin.name, {}, daemon.port)) as { probeId: string; publicKey: string };
    const order: string[] = [];
    vi.spyOn(plugin.registry, "shutdown").mockImplementation(async () => {
      order.push("registry.shutdown");
      throw new Error("shutdown failed");
    });
    vi.spyOn(plugin.runtime, "settled").mockImplementation(async () => {
      order.push("runtime.settled");
      throw new Error("settled failed");
    });
    await expect(plugin.dispose()).resolves.toBeUndefined();
    expect(order).toEqual(["registry.shutdown", "runtime.settled"]);
    // The last step ran after both failures.
    const payload = new Uint8Array(8).fill(1);
    const envelope = seal(fromBase64Url(probe.publicKey), payload, buildAad(probe.probeId, "selftest"));
    expect(await plugin.call(selfTestFinish.name, { probeId: probe.probeId, envelope, digest: digestHex(payload) }, daemon.port)).toEqual({ ok: false, bytes: 0 });
  });

  it("ends within seconds though an agent's idle check hangs, and asks the daemon nothing more", async () => {
    const plugin = await started();
    let refreshes = 0;
    const daemon = fakeDaemon(Object.fromEntries(["agent-1", "agent-2", "agent-3"].map((agentId) => [agentId, { status: "idle" }])), {
      refresh: () => {
        refreshes += 1;
        return new Promise(() => undefined);
      },
    });
    plugin.runtime.attach(daemon.port);
    for (const agentId of ["agent-1", "agent-2", "agent-3"]) {
      const { requestId } = await plugin.registry.create({ agentId, cwd: tempDir(), title: null }, asking);
      await plugin.registry.decline(requestId);
    }
    // Three messages wait, and the flush hangs on the first agent's idle check, which has half a minute to answer.
    await vi.waitFor(() => expect(refreshes).toBe(1), { timeout: 5000 });
    const cards = daemon.appended.length;

    // Time is the test's while the plugin is stopped, and the test lets none pass: the dispose ends all the same, so it
    // waited out no bound of its own, neither the half minute of the idle check nor the 300 milliseconds of the settling.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await plugin.dispose();
    } finally {
      vi.useRealTimers();
    }
    expect(SETTLE_BOUND_MS).toBe(300);
    expect(refreshes).toBe(1); // the other two were never asked

    // Whatever asks afterwards, nothing reaches the daemon: no idle check, no send, no card.
    await plugin.emit("agent.turn_ended", { agent: { id: "agent-2" }, turnId: "t", outcome: { kind: "completed" }, timeline: [] }, daemon.port);
    await plugin.runtime.flushAll();
    plugin.runtime.publish(record({ id: `r_${"9".repeat(32)}`, agentId: "agent-3", state: "declined" }), "state");
    await plugin.runtime.settled();
    expect(refreshes).toBe(1);
    expect(daemon.sent).toEqual([]);
    expect(daemon.appended).toHaveLength(cards);
    // What waited still waits, in the file, for the next start; and what was announced after the stop was saved with it.
    expect((JSON.parse(readFileSync(plugin.files.outbox, "utf8")) as Array<{ agentId: string }>).map((item) => item.agentId)).toEqual(["agent-1", "agent-2", "agent-3", "agent-3"]);
  });

  it("shuts the registry down while the runtime still delivers, then stops asking the daemon, then waits for what was under way", async () => {
    const plugin = await started();
    const order: string[] = [];
    vi.spyOn(plugin.runtime, "stop").mockImplementation(() => void order.push("runtime.stop"));
    vi.spyOn(plugin.registry, "shutdown").mockImplementation(async () => void order.push("registry.shutdown"));
    vi.spyOn(plugin.runtime, "settled").mockImplementation(async () => void order.push("runtime.settled"));
    await plugin.dispose();
    expect(order).toEqual(["registry.shutdown", "runtime.stop", "runtime.settled"]);
  });

  it("is bounded by the three waits it has for anything but its own files, added up, and ends inside the time Paseo gives a stop", () => {
    expect(DISPOSE_BOUND_MS).toBe(SHUTDOWN_BOUND_MS + DROP_SWEEP_BOUND_MS + SETTLE_BOUND_MS);
    expect([SHUTDOWN_BOUND_MS, DROP_SWEEP_BOUND_MS, SETTLE_BOUND_MS, DISPOSE_BOUND_MS]).toEqual([1000, 500, 300, 1800]);
    // Paseo 0.14 sends SIGTERM 2 seconds after `shutdown`, and the plugin's process ends there.
    expect(PASEO_STOP_WINDOW_MS).toBe(2000);
    expect(DISPOSE_BOUND_MS).toBeLessThan(PASEO_STOP_WINDOW_MS);
  });

  it("stops the expiry timer, and catches what the timer's work rejects with", async () => {
    const plugin = await started({ expiryIntervalMs: 10 });
    const expire = vi.spyOn(plugin.registry, "expire").mockRejectedValue(new Error("expire failed"));
    await vi.waitFor(() => expect(expire.mock.calls.length).toBeGreaterThan(1), { timeout: 5000 });
    expect(plugin.logs).toContain("secure-input: expire_failed");
    await plugin.dispose();
    const calls = expire.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(expire.mock.calls.length).toBe(calls);
  });

  it("does not keep the process alive for the expiry timer", async () => {
    // Its own timer, found by its interval: what else is running at the time says nothing.
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      await started({ expiryIntervalMs: 123_457 });
      const index = interval.mock.calls.findIndex((call) => call[1] === 123_457);
      expect(index).toBeGreaterThanOrEqual(0);
      expect((interval.mock.results[index]?.value as NodeJS.Timeout).hasRef()).toBe(false);
    } finally {
      interval.mockRestore();
    }
  });

  it("tries again, on its tick, for an agent that became idle without a turn that anyone told it of", async () => {
    const plugin = await started({ expiryIntervalMs: 20 });
    const cwd = tempDir();
    const daemon = fakeDaemon({ "agent-1": { status: "running" } });
    plugin.runtime.attach(daemon.port);
    const { requestId } = await plugin.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    await plugin.registry.decline(requestId);
    await new Promise((resolve) => setTimeout(resolve, 100)); // several ticks, with the agent busy
    expect(daemon.sent).toEqual([]);
    (daemon.agents["agent-1"] as FakeAgent).status = "idle"; // no turn_ended event
    await vi.waitFor(() => expect(daemon.sent).toHaveLength(1), { timeout: 5000 });
    expect(daemon.sent[0]).toEqual({ agentId: "agent-1", text: continuationText(plugin.registry.get(requestId) as RequestRecord, plugin.files.drop) as string });
  });

  it("catches what the tick's flush rejects with, and goes on to the next tick", async () => {
    const plugin = await started({ expiryIntervalMs: 10 });
    const flush = vi.spyOn(plugin.runtime, "flushAll").mockRejectedValue(new Error("flush failed"));
    await vi.waitFor(() => expect(flush.mock.calls.length).toBeGreaterThan(1), { timeout: 5000 });
    expect(plugin.logs).toContain("secure-input: flush_failed");
  });

  it("expires a request past its time on the timer", async () => {
    const plugin = await started({ expiryIntervalMs: 10 });
    const cwd = tempDir();
    const { requestId } = await plugin.registry.create({ agentId: "agent-1", cwd, title: null }, asking);
    const realNow = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 9 * 60 * 60 * 1000);
    try {
      await vi.waitFor(() => expect(plugin.registry.get(requestId)?.state).toBe("expired"), { timeout: 5000 });
    } finally {
      spy.mockRestore();
    }
  });
});
