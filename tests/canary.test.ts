import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { AgentToolContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { shellPath } from "../server/core/continuation";
import type { RequestRecord } from "../server/core/registry";
import { filePath, setPath } from "../server/io/drop";
import type { SessionOpenRequest } from "../server/paseo/hooks";
import { defaultOptions, startPlugin, type PluginHost, type RunningPlugin } from "../server/paseo/plugin";
import type { DaemonPort, TimelineItem } from "../server/paseo/runtime";
import { TOOL_NAMES, type ToolAgent } from "../server/paseo/tools";
import { fromBase64Url, toBase64Url } from "../shared/bytes";
import { CardDataSchema } from "../shared/card";
import {
  declineRequest,
  fulfillRequest,
  getRequest,
  readDiagnostics,
  selfTestBegin,
  selfTestFinish,
} from "../shared/contracts";
import { buildAad, digestHex, encodeValues, seal, type PayloadEntry } from "../shared/seal";
import { RequestViewSchema, type RequestView } from "../shared/view";
import { tempDir } from "./helpers";

// ---------------------------------------------------------------------------------------------------------------
// The end-to-end canary. Recognisable values are typed and picked as files (a text, a JSON file, a binary file of the
// human's), through the tools the plugin gives an agent and the whole plugin; only the Paseo daemon API is a
// hand-written fake. Then everything that left the trusted path is searched for each value, in every spelling a
// careless leak could take. The only place that may hold them is the set of files in `drop/`, until the plugin stops.
// ---------------------------------------------------------------------------------------------------------------

// Long and random enough that a piece of it, 12 characters from either end, cannot occur by chance.
const CANARY = "CANARY-9f8e7d6c5b4a3210-1f2e3d4c5b6a7988";
/** Inside the JSON file the human picks for `SA_JSON`. */
const CANARY2 = "CANARY2-a1b2c3d4e5f60718-293a4b5c6d7e8f90";
/** Inside the binary file of the human's own (`P12`), between bytes no text has. */
const CANARY3 = "CANARY3-0f1e2d3c4b5a6978-8796a5b4c3d2e1f0";
const AGENT = "agent-1";
const LONG = 60_000;

interface Needle {
  label: string;
  text: string;
}

interface Place {
  name: string;
  text: string;
}

/**
 * The spellings of a secret that a careless leak could take. Base64 of a value inside a longer text depends on where
 * the value starts, so it is searched at all three alignments, keeping only the characters the value alone decides.
 */
function spellingsOf(secret: string): Needle[] {
  const bytes = Buffer.from(secret, "utf8");
  const hex = bytes.toString("hex");
  const needles: Needle[] = [
    { label: "the value", text: secret },
    { label: "the value in hex", text: hex },
    { label: "the value in hex (capitals)", text: hex.toUpperCase() },
  ];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset, 0x78), bytes]).toString("base64");
    const text = encoded.slice(Math.ceil((offset * 8) / 6), Math.floor(((offset + bytes.length) * 8) / 6));
    needles.push({ label: `the value in base64 (alignment ${offset})`, text });
    const urlSafe = text.replaceAll("+", "-").replaceAll("/", "_");
    if (urlSafe !== text) needles.push({ label: `the value in base64url (alignment ${offset})`, text: urlSafe });
  }
  return needles;
}

const PART = 12;

/** What a preview or a truncation of a spelling would show: its first and its last characters. */
function withParts(needles: readonly Needle[]): Needle[] {
  return needles.flatMap((needle) => [
    needle,
    { label: `${needle.label}, its first ${PART} characters`, text: needle.text.slice(0, PART) },
    { label: `${needle.label}, its last ${PART} characters`, text: needle.text.slice(-PART) },
  ]);
}

function findHits(places: readonly Place[], needles: readonly Needle[]): Array<{ place: string; found: string }> {
  return places.flatMap((place) =>
    needles.filter((needle) => place.text.includes(needle.text)).map((needle) => ({ place: place.name, found: needle.label })),
  );
}

const sayHit = (hit: { place: string; found: string }): string => `${hit.place}: holds ${hit.found}`;

/** Every regular file below a directory, binary-safe, by path relative to it. Sockets and links are not followed. */
function filesUnder(directory: string, skip: ReadonlySet<string> = new Set(), root = directory): Place[] {
  const found: Place[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (skip.has(path)) continue;
    const info = lstatSync(path);
    if (info.isDirectory()) found.push(...filesUnder(path, skip, root));
    else if (info.isFile()) found.push({ name: `file ${relative(root, path)}`, text: readFileSync(path).toString("latin1") });
  }
  return found;
}

describe("the search for a leaked value", () => {
  it("names the place that holds the value, in any spelling or in part, and no other", () => {
    const needles = withParts(spellingsOf(CANARY));
    const base64Of = (text: string): string => Buffer.from(text).toString("base64");
    const leaky: Place[] = [
      { name: "plain", text: `{"x":"${CANARY}"}` },
      { name: "hex", text: Buffer.from(CANARY).toString("hex") },
      // The value at every alignment a longer text can give it.
      ...[0, 1, 2, 3, 4, 5].map((length) => ({ name: `base64 after ${length}`, text: base64Of(`${"a".repeat(length)}${CANARY}`) })),
      { name: "base64 inside a line", text: base64Of(`API_KEY=${CANARY}\n`) },
      // What a preview or a truncation shows.
      { name: "the start", text: `key ${CANARY.slice(0, PART)}...` },
      { name: "the end", text: `...${CANARY.slice(-PART)} (cut)` },
      { name: "the start in base64", text: `${base64Of(CANARY).slice(0, PART)}...` },
    ];
    const harmless: Place[] = [
      { name: "clean", text: "API_KEY and nothing else" },
      { name: "one character short at the start", text: CANARY.slice(0, PART - 1) },
      { name: "one character short at the end", text: CANARY.slice(-(PART - 1)) },
    ];
    const hits = findHits([...harmless, ...leaky], needles);
    expect([...new Set(hits.map((hit) => hit.place))]).toEqual(leaky.map((place) => place.name));
    expect(hits.filter((hit) => hit.place === "the start").map((hit) => hit.found)).toEqual([`the value, its first ${PART} characters`]);
    expect(sayHit({ place: "a card", found: "the value" })).toBe("a card: holds the value");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Paseo side, by hand: the server context that records what the plugin registers, and the daemon API.
// ---------------------------------------------------------------------------------------------------------------

type Handler = (input: never, context: never) => unknown;

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
  const context = (port: DaemonPort) => ({ paseo: port as unknown as PluginHandlerContext["paseo"], signal: new AbortController().signal });
  return {
    host,
    /** The round trip the daemon makes: the input through the contract, the handler, the answer through the contract. */
    async call(name: string, input: unknown, port: DaemonPort): Promise<unknown> {
      const entry = rpc.get(name);
      if (!entry) throw new Error(`no handler registered for ${name}`);
      const handler = entry.handler as (input: unknown, context: PluginHandlerContext) => unknown;
      return entry.contract.output.parse(await handler(entry.contract.input.parse(input), context(port)));
    },
    async before(name: string, request: unknown, port: DaemonPort): Promise<unknown> {
      const handler = befores.get(name) as ((input: { request: unknown }, context: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`no before hook for ${name}`);
      return handler({ request }, context(port));
    },
    /** An event as the daemon emits it, waited for as the daemon waits for its handlers. */
    async emit(name: string, event: unknown, port: DaemonPort): Promise<void> {
      const handler = events.get(name) as ((event: unknown, context: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`no handler for ${name}`);
      await handler(event, context(port));
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
            handle.status = "idle";
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

// ---------------------------------------------------------------------------------------------------------------
// The agent's side: the tools its session is given, called the way the daemon calls them, with the agent it names.
// ---------------------------------------------------------------------------------------------------------------

/** A hook result as the plugin process sends it on (server `plugins/agent-tools.ts`): each tool by its name, words and input schema. */
function onTheWire(opened: SessionOpenRequest): string {
  const tools = opened.tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, input: z.toJSONSchema(tool.input, { io: "input" }) }));
  return JSON.stringify({ ...opened, tools });
}

/** Seals as the form does: to the request's key, bound to the request and to the digest its view carries. */
const sealed = (view: Pick<RequestView, "id" | "publicKey" | "requestDigest">, entries: PayloadEntry[], digest = view.requestDigest) =>
  seal(fromBase64Url(view.publicKey), encodeValues(entries), buildAad(view.id, digest));

// ---------------------------------------------------------------------------------------------------------------

const running: RunningPlugin[] = [];
afterEach(async () => {
  for (const plugin of running.splice(0)) await plugin.dispose();
  vi.restoreAllMocks();
});

describe("a typed value", () => {
  it("reaches its set of files and nothing else, as text, as a JSON file and as a binary file, and the end of the turn takes the set away", async () => {
    // The plugin's own console output: in the daemon, the plugin's log goes to console.error. A clean run logs
    // nothing, so the capture is checked once with a line of its own, which holds no value.
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => void logged.push(parts.map(String).join(" ")));
    }
    console.error("canary: console capture check");
    expect(logged, "the console is not being captured").toEqual(["canary: console capture check"]);

    const home = tempDir("si-");
    // The agent's working directory: the plugin writes nothing into it.
    const cwd = tempDir("si work-");
    writeFileSync(join(cwd, "README.md"), "a project of the agent's\n", { mode: 0o600 });

    const daemon = fakeDaemon();
    const hostFake = fakeHost();
    const plugin = startPlugin(hostFake.host, defaultOptions({ PASEO_HOME: home }));
    running.push(plugin);
    await plugin.ready;
    expect(plugin.dataDir).toBe(join(home, "secure-input"));
    expect(plugin.status).toEqual({ problem: null, lastHookFailure: null });

    // Everything that leaves the trusted path is recorded under the name of the place it left through.
    const places: Place[] = [];
    const see = (name: string, text: string): void => {
      const same = places.filter((place) => place.name === name || place.name.startsWith(`${name} #`)).length;
      places.push({ name: same === 0 ? name : `${name} #${same + 1}`, text });
    };
    const rpc = async (name: string, input: unknown, as = `RPC ${name}`): Promise<unknown> => {
      const out = await hostFake.call(name, input, daemon.port);
      see(as, JSON.stringify(out));
      return out;
    };
    // The registry's onChange payloads: it hands each one to the runtime.
    const published = vi.spyOn(plugin.runtime, "publish");

    // The agent's session opens, as the daemon opens it: the plugin's tools come with it.
    const agent: ToolAgent = { id: AGENT, workspaceId: "ws-1", parentAgentId: null, provider: "claude", cwd, title: "Canary agent" };
    const session: SessionOpenRequest = { agentId: AGENT, workspaceId: "ws-1", provider: "claude", cwd, reason: "create", purpose: "interactive", title: "Canary agent", labels: {}, tools: [], env: {}, mcpServers: {} };
    const opened = (await hostFake.before("agent.session_open", session, daemon.port)) as SessionOpenRequest;
    see("hook result agent.session_open", onTheWire(opened));
    // The four tools, exactly.
    expect(opened.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);

    const tool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structuredContent?: unknown }> => {
      const found = opened.tools.find((candidate) => candidate.name === name);
      if (found === undefined) throw new Error(`the session was not given ${name}`);
      const result = await found.execute(args, { agent, paseo: daemon.port as unknown as AgentToolContext["paseo"], signal: new AbortController().signal });
      // Both what the model reads and what a client may show: the text and the structured content.
      see(`tool ${name}`, JSON.stringify(result));
      return { text: result.text ?? "", isError: result.isError === true, structuredContent: result.structuredContent };
    };
    const askWithTool = async (request: unknown): Promise<string> => {
      const asked = await tool("request_secret", request as Record<string, unknown>);
      expect(asked.isError).toBe(false);
      return (JSON.parse(asked.text) as { requestId: string }).requestId;
    };
    const dialog = async (requestId: string): Promise<RequestView> => RequestViewSchema.parse(await rpc(getRequest.name, { requestId }));
    // What the form sends: the request id and the envelope, and nothing else.
    const submit = (view: RequestView, envelope: ReturnType<typeof sealed>) => rpc(fulfillRequest.name, { requestId: view.id, envelope });
    const endsAs = async (requestId: string, state: string, messages: number): Promise<RequestRecord> => {
      await vi.waitFor(() => expect(plugin.registry.get(requestId)?.state).toBe(state), { timeout: 15_000 });
      await vi.waitFor(() => expect(daemon.sent).toHaveLength(messages), { timeout: 15_000 });
      await plugin.runtime.settled();
      return plugin.registry.get(requestId) as RequestRecord;
    };
    // The state files are read after every step, and not only at the end: a value written and removed in between
    // would otherwise go unseen.
    const stateFiles = ["requests.json", "outbox.json"];
    const checkpoint = (step: string): void => {
      for (const name of stateFiles) {
        const path = join(plugin.dataDir, name);
        see(`${name} after ${step}`, existsSync(path) ? readFileSync(path).toString("latin1") : "(absent)");
      }
    };
    const asAgent = async (requestId: string): Promise<void> => {
      await tool("request_status", { requestId });
    };

    // 1. A text, a JSON file and a file of the human's own. The first submission cannot be opened (it is sealed to
    //    another digest); the second is delivered.
    const saJson = `{"type":"service_account","private_key":"${CANARY2}"}`;
    const p12 = Uint8Array.from([0x30, 0x82, 0x0a, 0x00, 0xff, ...Buffer.from(CANARY3, "utf8"), 0x00, 0x0d, 0x80]);
    const deliveredId = await askWithTool({
      reason: "Canary: an API key and a service account",
      fields: [{ key: "API_KEY", label: "from the canary" }, { key: "PEM", optional: true }, { key: "SA_JSON", kind: "file", format: "json" }],
    });
    const deliveredView = await dialog(deliveredId);
    const entries: PayloadEntry[] = [
      { key: "API_KEY", value: CANARY },
      { key: "SA_JSON", file: toBase64Url(Buffer.from(saJson, "utf8")) },
      { key: "P12", file: toBase64Url(p12) },
    ];
    expect(await submit(deliveredView, sealed(deliveredView, entries, "f".repeat(64)))).toMatchObject({ ok: false, code: "decrypt_failed", retryable: true });
    checkpoint("the submission that could not be opened");
    expect(await submit(deliveredView, sealed(deliveredView, entries))).toEqual({ ok: true, state: "delivered" });
    const delivered = await endsAs(deliveredId, "delivered", 1);
    await asAgent(deliveredId);
    checkpoint("the delivery");

    // The set: byte for byte, each file 0600 in a directory 0700, and only what was sent.
    const drop = join(plugin.dataDir, "drop");
    const set = setPath(drop, deliveredId);
    expect(readdirSync(set).sort()).toEqual(["API_KEY", "P12", "SA_JSON"]);
    expect(readFileSync(join(set, "API_KEY")).equals(Buffer.from(CANARY, "utf8"))).toBe(true);
    expect(readFileSync(join(set, "SA_JSON")).equals(Buffer.from(saJson, "utf8"))).toBe(true);
    expect(readFileSync(join(set, "P12")).equals(Buffer.from(p12))).toBe(true);
    expect(statSync(set).mode & 0o777).toBe(0o700);
    for (const key of ["API_KEY", "P12", "SA_JSON"]) expect(statSync(join(set, key)).mode & 0o777, key).toBe(0o600);
    expect(delivered).toMatchObject({ written: ["API_KEY", "SA_JSON", "P12"] });

    // The message holds the paths, and nothing of a value.
    const message = daemon.sent[0]?.text ?? "";
    for (const key of ["API_KEY", "SA_JSON", "P12"]) expect(message, key).toContain(`  ${key} → ${shellPath(filePath(drop, deliveredId, key))}`);
    expect(message).toContain("Left empty by the user, so no file: PEM.");

    // 2. A request rejected for a value sent as the wrong kind: the refusal names the key, and nothing of the value.
    const rejectedId = await askWithTool({ fields: [{ key: "TOKEN" }] });
    const rejectedView = await dialog(rejectedId);
    expect(await submit(rejectedView, sealed(rejectedView, [{ key: "TOKEN", file: toBase64Url(Buffer.from(CANARY, "utf8")) }]))).toEqual({
      ok: false,
      code: "invalid_request",
      retryable: false,
      detail: "TOKEN must be text",
    });
    await endsAs(rejectedId, "rejected", 2);
    await asAgent(rejectedId);
    checkpoint("the rejected request");

    // 3. A request the agent withdraws, and one the human declines, which the agent then tries to withdraw.
    const withdrawnId = await askWithTool({ fields: [{ key: "UNUSED" }] });
    expect(JSON.parse((await tool("cancel_request", { requestId: withdrawnId })).text)).toEqual({ requestId: withdrawnId, state: "cancelled" });
    await asAgent(withdrawnId);
    checkpoint("the withdrawn request");
    const declinedId = await askWithTool({ fields: [{ key: "UNUSED" }] });
    await rpc(declineRequest.name, { requestId: declinedId });
    await endsAs(declinedId, "declined", 3);
    expect((await tool("cancel_request", { requestId: declinedId })).isError).toBe(true);
    checkpoint("the declined request");

    // The rest of what the app can ask.
    await rpc(readDiagnostics.name, {});
    const probe = (await rpc(selfTestBegin.name, {})) as { probeId: string; publicKey: string };
    const dummy = new Uint8Array(1024).fill(0x61);
    await rpc(selfTestFinish.name, { probeId: probe.probeId, envelope: seal(fromBase64Url(probe.publicKey), dummy, buildAad(probe.probeId, "selftest")), digest: digestHex(dummy) });
    await plugin.runtime.settled();
    expect(daemon.sent).toHaveLength(3);

    // --- Everything else, while the set is there. ---
    checkpoint("all the steps");
    // Nothing but the plugin's own files is in its data directory, and the set in drop/, which is where the values are.
    places.push(...filesUnder(plugin.dataDir, new Set([drop])).map((place) => ({ ...place, name: `data directory ${place.name}` })));
    places.push(...filesUnder(cwd).map((place) => ({ ...place, name: `working directory ${place.name}` })));
    const needles = [CANARY, CANARY2, CANARY3].flatMap((secret) => withParts(spellingsOf(secret)));
    expect(findHits(places, needles).map(sayHit), "a value was found outside its set of files while the set was there").toEqual([]);

    // --- The agent moves a value where it belongs without reading it, in the turn the message started. ---
    const savedStates = () => JSON.parse(readFileSync(join(plugin.dataDir, "requests.json"), "utf8")) as RequestRecord[];
    await hostFake.emit("agent.turn_started", { agent, turnId: "t-1" }, daemon.port);
    // The path as the message quotes it for the shell, run by a real shell; the value goes from file to file.
    const named = `  API_KEY → `;
    const quoted = message.split("\n").find((line) => line.startsWith(named))?.slice(named.length) ?? "";
    expect(quoted).toBe(shellPath(filePath(drop, deliveredId, "API_KEY")));
    const copied = join(cwd, "copied.txt");
    execFileSync("/bin/sh", ["-c", `cp ${quoted} ${shellPath(copied)}`], { stdio: "ignore" });
    expect(readFileSync(copied).equals(Buffer.from(CANARY, "utf8"))).toBe(true);
    expect(existsSync(set)).toBe(true);
    await hostFake.emit("agent.turn_ended", { agent, turnId: "t-1", outcome: { kind: "completed" }, timeline: [] }, daemon.port);
    expect(readdirSync(drop)).toEqual([]);
    expect(plugin.registry.get(deliveredId)).toMatchObject({ state: "released", releasedBy: "turn" });
    expect(savedStates().find((record) => record.id === deliveredId)).toMatchObject({ state: "released", releasedBy: "turn" });
    await plugin.runtime.settled();
    // Released is not announced.
    expect(daemon.sent).toHaveLength(3);
    checkpoint("the end of the turn");
    await asAgent(deliveredId);

    // --- The stop: nothing is left to take away, and the record keeps why the set went. ---
    await plugin.dispose();
    expect(readdirSync(drop)).toEqual([]);
    expect(plugin.registry.get(deliveredId)).toMatchObject({ state: "released", releasedBy: "turn" });
    expect(savedStates().find((record) => record.id === deliveredId)).toMatchObject({ state: "released", releasedBy: "turn" });
    checkpoint("the stop");
    places.push(...filesUnder(plugin.dataDir).map((place) => ({ ...place, name: `data directory after the stop ${place.name}` })));
    // The copy is where the value was meant to go: the one file outside drop/ that may hold it.
    places.push(...filesUnder(cwd, new Set([copied])).map((place) => ({ ...place, name: `working directory after the turn ${place.name}` })));
    // What the plugin handed the daemon and the runtime, the stop included.
    for (const entry of daemon.appended) see("card on the timeline", JSON.stringify(CardDataSchema.parse(entry.item.data)) + JSON.stringify(entry.item));
    for (const [index, call] of published.mock.calls.entries()) see(`onChange payload ${index + 1}`, JSON.stringify(call[0]));
    for (const entry of daemon.sent) see("message sent to the agent", entry.text);
    see("the plugin's console output", logged.join("\n"));

    // --- The search must have something to search. A class of place that came back empty would pass for clean. ---
    const ofClass = (prefix: string): Place[] => places.filter((place) => place.name.startsWith(prefix));
    const captured = (prefix: string, atLeast: number): void => {
      const found = ofClass(prefix);
      expect(found.length, `only ${found.length} place(s) captured for "${prefix}", at least ${atLeast} expected: its search would be empty`).toBeGreaterThanOrEqual(atLeast);
      for (const place of found) expect(place.text, `${place.name} was captured empty`).not.toBe("");
    };
    captured("hook result", 1);
    captured("tool request_secret", 4);
    captured("tool request_status", 4);
    captured("tool cancel_request", 2);
    captured("RPC ", 9);
    captured("card on the timeline", 8);
    captured("onChange payload", 8);
    captured("message sent to the agent", 3);
    captured("requests.json after", 7);
    captured("outbox.json after", 6);
    // What the tools gave back are answers and not silence, as text and as structured content alike.
    // An `every` over a list that came back empty is true of nothing: the length is asserted first.
    const answered = ofClass("tool request_secret").map((place) => JSON.parse(place.text) as { text: string; structuredContent?: { status?: string } });
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.every((result) => result.structuredContent?.status === "pending" && (JSON.parse(result.text) as { status: string }).status === "pending")).toBe(true);
    expect(ofClass("tool request_status").every((place) => (JSON.parse(place.text) as { structuredContent?: { state?: string } }).structuredContent?.state !== undefined)).toBe(true);
    // The state files were there to be read at every step that needs them, and at the end.
    for (const place of ofClass("requests.json after")) expect(place.text, `${place.name} was read from a file that was not there`).not.toBe("(absent)");
    expect(ofClass("outbox.json after all the steps")[0]?.text, "outbox.json was not there at the end").not.toBe("(absent)");
    // What was captured is what it should be: cards followed the requests to their ends, messages are the plugin's.
    expect(new Set(daemon.appended.map((entry) => CardDataSchema.parse(entry.item.data).state))).toEqual(new Set(["pending", "delivered", "rejected", "declined", "cancelled", "released"]));
    expect(daemon.sent.every((entry) => entry.text.startsWith("[secure-input] "))).toBe(true);
    expect(readFileSync(join(plugin.dataDir, "requests.json"), "utf8")).toContain(AGENT);
    const reached = new Map(places.map((place) => [place.name, place.text]));
    for (const name of ["data directory file requests.json", "data directory file outbox.json", "working directory file README.md", "working directory after the turn file README.md"]) {
      expect(reached.get(name), `the search did not reach ${name}`).toBeTypeOf("string");
    }
    expect(reached.has("working directory after the turn file copied.txt"), "the copy is allowed, and only the copy").toBe(false);

    // Searched again, in every spelling and in part, with the copy allowed. Nothing may be found outside the set of files
    // the values were written to, and the file the agent moved one of them into.
    const hits = findHits(places, needles);
    expect(hits.map(sayHit), "a value was found outside its set of files").toEqual([]);
  }, LONG);
});
