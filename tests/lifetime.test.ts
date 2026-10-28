import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { continuationText } from "../server/core/continuation";
import type { Registry, RequestRecord } from "../server/core/registry";
import type { ReleasedBy } from "../server/core/registry-store";
import type { OpenFile } from "../server/io/descriptor";
import { setPath } from "../server/io/drop";
import { registerHooks } from "../server/paseo/hooks";
import type { PluginHost } from "../server/paseo/plugin";
import type { DaemonPort } from "../server/paseo/runtime";
import { toBase64Url } from "../shared/bytes";
import { SecureInputError } from "../shared/errors";
import { rejectionOf, tempDir } from "./helpers";
import { CANARY, GatedDrop, agent, asking, deliverOne, gate, harness, sealed, stored, submit, withFile, type Harness } from "./registry-harness";

const idOf = (n: number) => `r_${n.toString(16).padStart(32, "0")}`;
const UNKNOWN = { code: "invalid_request", message: "invalid_request: unknown request" };
const NO_FILES = { code: "invalid_request", message: "invalid_request: the request has no files to release" };
const STUCK = { code: "write_failed", message: "write_failed: the files could not be deleted; the plugin tries again" };

/** The agent the daemon names in a turn event. */
const hookAgent = (id: string) => ({ id, workspaceId: null, parentAgentId: null, provider: "claude", cwd: `/work/${id}`, title: null });

/** The plugin's hooks on a host of the test's, with the registry as what the turns act on and a runtime that only notes the flushes it is asked for. */
function hooked(registry: Registry) {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  const host: Pick<PluginHost, "before" | "on"> = {
    before: () => () => undefined,
    on: (name, handler) => {
      events.set(name, handler as (event: unknown, context: unknown) => unknown);
      return () => undefined;
    },
  };
  const failures: string[] = [];
  const flushed: string[] = [];
  registerHooks(host, {
    runtime: { attach: () => undefined, turnEnded: (agentId) => void flushed.push(agentId), agentArchived: () => undefined },
    turns: registry,
    tools: () => [],
    failed: (hook, code) => void failures.push(`${hook}:${code}`),
  });
  const port: DaemonPort = { agents: { ref: () => ({ status: null, refresh: async () => null, send: async () => undefined, timeline: { append: async () => null } }) } };
  const context = { paseo: port, signal: new AbortController().signal };
  return {
    failures,
    flushed,
    async emit(name: string, event: unknown): Promise<void> {
      const handler = events.get(name);
      if (handler === undefined) throw new Error(`no handler for ${name}`);
      await handler(event, context);
    },
  };
}

describe("the deadline", () => {
  it("deletes the files at the deadline by its own timer", async () => {
    const h = harness(tempDir(), { dropTtlMs: 40 });
    const id = await deliverOne(h);
    // Told once the change is saved: the record changes in memory first, and its save lands after.
    await vi.waitFor(() => expect(h.told).toContain(`released ${id}`), { timeout: 5000 });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "time" });
    expect(existsSync(setPath(h.dropRoot, id))).toBe(false);
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "time" });
    expect(h.told).toEqual([`pending ${id}`, `delivered ${id}`, `released ${id}`]);
  });

  it("deletes them at the first tick after the deadline when no timer fired (a machine that slept)", async () => {
    // A timer that cannot fire within the test: the tick and its wall clock are all there is.
    const h = harness(tempDir(), { dropTtlMs: 3_600_000 });
    const id = await deliverOne(h);
    const deleteBy = h.registry.get(id)?.deleteBy as number;
    expect(deleteBy).toBe(h.clock.now + 3_600_000);
    h.clock.now = deleteBy - 1;
    await h.registry.expire();
    expect(h.registry.get(id)?.state).toBe("delivered");
    expect(existsSync(setPath(h.dropRoot, id))).toBe(true);
    h.clock.now = deleteBy;
    await h.registry.expire();
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "time" });
    expect(existsSync(setPath(h.dropRoot, id))).toBe(false);
  });

  it("gives each set a timer that keeps no process alive, and clears it when the set goes before it, or as the stop begins", async () => {
    const TTL = 123_457;
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clears = vi.spyOn(globalThis, "clearTimeout");
    const cleared = (timer: NodeJS.Timeout) => clears.mock.calls.some(([call]) => call === timer);
    const stuck = gate();
    try {
      const h = harness(tempDir(), { dropTtlMs: TTL, shutdownBoundMs: 50 });
      /** The timer the delivery of a set made, found by its delay: what else runs meanwhile says nothing. */
      const timerOf = async (agentId: string) => {
        const before = timers.mock.calls.length;
        const id = await deliverOne(h, agentId);
        const index = timers.mock.calls.findIndex((call, at) => at >= before && call[1] === TTL);
        expect(index, agentId).toBeGreaterThanOrEqual(0);
        return { id, timer: timers.mock.results[index]?.value as NodeJS.Timeout };
      };
      const released = await timerOf("agent-1");
      const stopped = await timerOf("agent-2");
      for (const { timer } of [released, stopped]) expect(timer.hasRef()).toBe(false);

      await h.registry.release("agent-1", released.id);
      expect(cleared(released.timer)).toBe(true);
      expect(cleared(stopped.timer)).toBe(false);

      // A write that does not end holds the queue, so the releases of the stop do not get their turn: the timer goes all
      // the same, the moment the stop begins.
      const held = (await h.registry.create(agent("agent-3"), asking)).requestId;
      let reached = false;
      h.drop.onWrite = () => {
        reached = true;
        return stuck.held;
      };
      const fulfilled = h.registry.fulfill(held, sealed(h.registry, held, [{ key: "API_KEY", value: `${CANARY}-held` }]));
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });
      const shutdown = h.registry.shutdown();
      expect(cleared(stopped.timer)).toBe(true);
      stuck.open();
      expect(await fulfilled).toEqual({ ok: false, code: "request_closed", retryable: false });
      await shutdown;
    } finally {
      stuck.open();
      timers.mockRestore();
      clears.mockRestore();
    }
  });
});

describe("the agent's own deletion", () => {
  it("notices at the tick that the agent deleted the set itself", async () => {
    const h = harness();
    const id = await deliverOne(h);
    await h.registry.expire();
    expect(h.registry.get(id)?.state).toBe("delivered");
    rmSync(setPath(h.dropRoot, id), { recursive: true });
    await h.registry.expire();
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "agent" });
    // Once: the next tick finds nothing more to do.
    await h.registry.expire();
    expect(h.told.filter((line) => line.startsWith("released"))).toEqual([`released ${id}`]);
  });

  it("notices it when the agent asks for the state of its request, and answers with what it found", async () => {
    const h = harness();
    const id = await deliverOne(h);
    expect(await h.registry.check(id)).toMatchObject({ id, state: "delivered" });
    rmSync(setPath(h.dropRoot, id), { recursive: true });
    expect(await h.registry.check(id)).toMatchObject({ id, state: "released", releasedBy: "agent" });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(await h.registry.check(idOf(9))).toBeUndefined();
    // A copy: what the caller does to it changes nothing.
    const copy = (await h.registry.check(id)) as { state: string };
    copy.state = "pending";
    expect(h.registry.get(id)?.state).toBe("released");
  });
});

describe("the end of the turn the message started", () => {
  it("arms on the first turn start after the message and releases at the next turn end, whatever its outcome", async () => {
    const h = harness();
    const id = await deliverOne(h);
    // A turn that began before the message was handed over is not the one the message starts.
    h.registry.turnStarted("agent-1");
    await h.registry.turnEnded("agent-1");
    expect(h.registry.get(id)?.state).toBe("delivered");
    h.registry.messageSent(id);
    // The end of the turn before the message, told late.
    await h.registry.turnEnded("agent-1");
    expect(h.registry.get(id)?.state).toBe("delivered");
    expect(existsSync(setPath(h.dropRoot, id))).toBe(true);
    h.registry.turnStarted("agent-1");
    // A second start in the same turn changes nothing, and a second hand-over does not take the mark back.
    h.registry.turnStarted("agent-1");
    h.registry.messageSent(id);
    expect(existsSync(setPath(h.dropRoot, id))).toBe(true);
    await h.registry.turnEnded("agent-1");
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "turn" });
    expect(existsSync(setPath(h.dropRoot, id))).toBe(false);
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "turn" });

    // Through the hooks, which the daemon calls with the outcome of the turn: each outcome ends it alike.
    const outcomes = [{ kind: "completed" }, { kind: "failed", error: { message: "the model gave up" } }, { kind: "canceled", reason: "the user stopped it" }];
    for (const outcome of outcomes) {
      const other = harness();
      const set = await deliverOne(other);
      const hooks = hooked(other.registry);
      other.registry.messageSent(set);
      await hooks.emit("agent.turn_started", { agent: hookAgent("agent-1"), turnId: "t-1" });
      expect(other.registry.get(set)?.state, outcome.kind).toBe("delivered");
      await hooks.emit("agent.turn_ended", { agent: hookAgent("agent-1"), turnId: "t-1", outcome, timeline: [] });
      expect(other.registry.get(set), outcome.kind).toMatchObject({ state: "released", releasedBy: "turn" });
      expect(existsSync(setPath(other.dropRoot, set)), outcome.kind).toBe(false);
      expect(hooks.flushed, outcome.kind).toEqual(["agent-1"]);
      expect(hooks.failures, outcome.kind).toEqual([]);
    }
  });

  it("does not touch a request whose message was not handed over, nor another agent's", async () => {
    const h = harness();
    const quiet = await deliverOne(h, "agent-1");
    const others = await deliverOne(h, "agent-2");
    h.registry.messageSent(others);
    // Nothing for a request that is not delivered, or that the registry does not know.
    const pending = (await h.registry.create(agent("agent-3"), asking)).requestId;
    h.registry.messageSent(pending);
    h.registry.messageSent(idOf(9));

    h.registry.turnStarted("agent-1");
    await h.registry.turnEnded("agent-1");
    h.registry.turnStarted("agent-3");
    await h.registry.turnEnded("agent-3");
    expect(h.registry.get(quiet)?.state).toBe("delivered");
    expect(h.registry.get(others)?.state).toBe("delivered");
    expect(h.registry.get(pending)?.state).toBe("pending");
    expect(readdirSync(h.dropRoot).sort()).toEqual([`si-secret-${quiet}`, `si-secret-${others}`].sort());

    h.registry.turnStarted("agent-2");
    await h.registry.turnEnded("agent-2");
    expect(h.registry.get(others)).toMatchObject({ state: "released", releasedBy: "turn" });
    expect(h.registry.get(quiet)?.state).toBe("delivered");
    expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${quiet}`]);
  });
});

describe("the end of the turn the message started, while the queue is busy", () => {
  it("takes at a turn's end only the sets armed when it ended, however long it waits in the queue", async () => {
    // The setup: R1's message started t-1. R2 is delivered meanwhile, and its message waits.
    const h = harness();
    const r1 = await deliverOne(h, "agent-1");
    h.registry.messageSent(r1);
    h.registry.turnStarted("agent-1");
    const r2 = await deliverOne(h, "agent-1", `${CANARY}-second`);
    // Another agent's write holds the queue where it begins.
    const stuck = gate();
    try {
      const other = (await h.registry.create(agent("agent-2"), asking)).requestId;
      let reached = false;
      h.drop.onWrite = () => {
        reached = true;
        return stuck.held;
      };
      const written = h.registry.fulfill(other, sealed(h.registry, other, [{ key: "API_KEY", value: `${CANARY}-other` }]));
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });
      // t-1 ends, and its releases wait in the queue. Meanwhile R2's message is handed over and starts t-2.
      const t1Ended = h.registry.turnEnded("agent-1");
      h.registry.messageSent(r2);
      h.registry.turnStarted("agent-1");
      stuck.open();
      expect(await written).toEqual({ ok: true, state: "delivered" });
      await t1Ended;
      expect(h.registry.get(r1)).toMatchObject({ state: "released", releasedBy: "turn" });
      // R2's set stays for the turn its own message started.
      expect(h.registry.get(r2)?.state).toBe("delivered");
      expect(existsSync(setPath(h.dropRoot, r2))).toBe(true);
      await h.registry.turnEnded("agent-1");
      expect(h.registry.get(r2)).toMatchObject({ state: "released", releasedBy: "turn" });
    } finally {
      stuck.open();
    }
  });
});

describe("release_secret", () => {
  it("releases on request: the owner only, once, and refuses a request with no files", async () => {
    const h = harness();
    const id = await deliverOne(h);
    expect(await rejectionOf(h.registry.release("agent-2", id))).toEqual(UNKNOWN);
    expect(h.registry.get(id)?.state).toBe("delivered");
    expect(existsSync(setPath(h.dropRoot, id))).toBe(true);
    expect(await rejectionOf(h.registry.release("agent-1", idOf(9)))).toEqual(UNKNOWN);

    const released = await h.registry.release("agent-1", id);
    expect(released).toMatchObject({ id, state: "released", releasedBy: "agent" });
    expect(existsSync(setPath(h.dropRoot, id))).toBe(false);
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "agent" });
    // Once: asked again, it answers the same, and nothing changes or is told.
    const told = h.told.length;
    expect(await h.registry.release("agent-1", id)).toEqual(released);
    expect(h.told).toHaveLength(told);
    expect(await rejectionOf(h.registry.release("agent-2", id))).toEqual(UNKNOWN);

    const open = (await h.registry.create(agent("agent-3"), asking)).requestId;
    expect(await rejectionOf(h.registry.release("agent-3", open))).toEqual(NO_FILES);
    await h.registry.decline(open);
    expect(await rejectionOf(h.registry.release("agent-3", open))).toEqual(NO_FILES);
    expect(h.registry.get(open)?.state).toBe("declined");
  });

  it("keeps a request delivered and says so when its files cannot be removed", async () => {
    const h = harness();
    const id = await deliverOne(h);
    const set = setPath(h.dropRoot, id);
    // Its message was handed over and its turn began: the turn's end tries as well.
    h.registry.messageSent(id);
    h.registry.turnStarted("agent-1");
    chmodSync(set, 0o500);
    try {
      expect(await rejectionOf(h.registry.release("agent-1", id))).toEqual(STUCK);
      expect(h.registry.get(id)?.state).toBe("delivered");
      expect(h.registry.health().drop).toBe("failing");
      expect(existsSync(join(set, "API_KEY"))).toBe(true);
      await h.registry.turnEnded("agent-1");
      expect(h.registry.get(id)?.state).toBe("delivered");
      expect(h.registry.health().drop).toBe("failing");
    } finally {
      chmodSync(set, 0o700);
    }
    // The plugin tries again: here at the deadline, by the tick.
    h.clock.now = h.registry.get(id)?.deleteBy as number;
    await h.registry.expire();
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "time" });
    expect(existsSync(set)).toBe(false);
    expect(h.registry.health().drop).toBe("ok");
  });
});

describe("a link in place of the set", () => {
  /** A directory of the agent's own, outside drop/, holding a file named as the set's file and a directory. */
  function ownDirectory(): { path: string; intact(): boolean } {
    const path = tempDir("si own-");
    writeFileSync(join(path, "API_KEY"), "the agent's own file", { mode: 0o600 });
    mkdirSync(join(path, "nested"));
    writeFileSync(join(path, "nested", "KEEP"), "kept", { mode: 0o600 });
    const intact = () =>
      JSON.stringify(readdirSync(path).sort()) === JSON.stringify(["API_KEY", "nested"]) &&
      readFileSync(join(path, "API_KEY"), "utf8") === "the agent's own file" &&
      readFileSync(join(path, "nested", "KEEP"), "utf8") === "kept";
    return { path, intact };
  }

  it("never follows a link the agent put in place of the set when it notices the set is gone", async () => {
    // Where the plugin looks before it removes (a status, the tick): the set is gone when it looks, and the agent's link
    // is in its place right after, by the time the plugin removes what is there.
    const looks: Array<[string, (h: Harness, id: string) => Promise<unknown>]> = [
      ["a status", (h, id) => h.registry.check(id)],
      ["the tick", (h) => h.registry.expire()],
    ];
    for (const [where, look] of looks) {
      const h = harness();
      const id = await deliverOne(h);
      const own = ownDirectory();
      rmSync(setPath(h.dropRoot, id), { recursive: true });
      h.drop.onExists = (answer) => {
        if (!answer) symlinkSync(own.path, setPath(h.dropRoot, id));
      };
      await look(h, id);
      expect(h.registry.get(id), where).toMatchObject({ state: "released", releasedBy: "agent" });
      // The link went, as a link, and what it points to is as it was.
      expect(readdirSync(h.dropRoot), where).toEqual([]);
      expect(own.intact(), where).toBe(true);
    }

    // Where the plugin removes without looking first: the link is there already, and goes as a link.
    const removals: Array<[string, (h: Harness, id: string) => Promise<unknown>, ReleasedBy]> = [
      ["release_secret", (h, id) => h.registry.release("agent-1", id), "agent"],
      [
        "the end of the turn",
        async (h, id) => {
          h.registry.messageSent(id);
          h.registry.turnStarted("agent-1");
          await h.registry.turnEnded("agent-1");
        },
        "turn",
      ],
      [
        "the deadline",
        async (h, id) => {
          h.clock.now = h.registry.get(id)?.deleteBy as number;
          await h.registry.expire();
        },
        "time",
      ],
      ["the stop", (h) => h.registry.shutdown(), "stop"],
    ];
    for (const [where, remove, by] of removals) {
      const h = harness();
      const id = await deliverOne(h);
      const own = ownDirectory();
      rmSync(setPath(h.dropRoot, id), { recursive: true });
      symlinkSync(own.path, setPath(h.dropRoot, id));
      await remove(h, id);
      expect(h.registry.get(id), where).toMatchObject({ state: "released", releasedBy: by });
      expect(readdirSync(h.dropRoot), where).toEqual([]);
      expect(own.intact(), where).toBe(true);
    }

    // And the set's own timer, which the test moves only once the link is in place.
    const timed = harness(tempDir(), { dropTtlMs: 40 });
    const own = ownDirectory();
    let id: string;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      id = await deliverOne(timed);
      rmSync(setPath(timed.dropRoot, id), { recursive: true });
      symlinkSync(own.path, setPath(timed.dropRoot, id));
      await vi.advanceTimersByTimeAsync(40);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(timed.registry.get(id)).toMatchObject({ state: "released", releasedBy: "time" }), { timeout: 5000 });
    expect(readdirSync(timed.dropRoot)).toEqual([]);
    expect(own.intact()).toBe(true);
  });
});

describe("a link in place of drop/ itself", () => {
  it("removes nothing through it: the agent's release is refused, the request stays delivered and is tried again, and the tree behind the link stays", async () => {
    const h = harness();
    const id = await deliverOne(h);
    // The real drop/ is renamed aside and a link to a directory of the agent's own takes its place, which holds a set of
    // the same name: no race, any time before the release.
    const far = tempDir("si own-");
    mkdirSync(join(far, `si-secret-${id}`));
    writeFileSync(join(far, `si-secret-${id}`, "API_KEY"), "the agent's own file", { mode: 0o600 });
    const aside = join(tempDir(), "aside");
    renameSync(h.dropRoot, aside);
    symlinkSync(far, h.dropRoot);
    expect(await rejectionOf(h.registry.release("agent-1", id))).toEqual(STUCK);
    expect(h.registry.get(id)?.state).toBe("delivered");
    expect(h.registry.health().drop).toBe("failing");
    // The tick at the deadline tries again, and finds the same.
    h.clock.now = h.registry.get(id)?.deleteBy as number;
    await h.registry.expire();
    expect(h.registry.get(id)?.state).toBe("delivered");
    expect(readFileSync(join(far, `si-secret-${id}`, "API_KEY"), "utf8")).toBe("the agent's own file");
    expect(readdirSync(far)).toEqual([`si-secret-${id}`]);
    expect(readlinkSync(h.dropRoot)).toBe(far);
    expect(readdirSync(join(aside, `si-secret-${id}`))).toEqual(["API_KEY"]);
  });
});

describe("what drop/ still owes, tried again at the tick", () => {
  it("keeps a set the start's sweep could not remove delivered and owed, tries it at each tick, and releases it as the restart's once it goes", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const kept = await deliverOne(donor, "agent-1");
    // The run that delivered it is killed: nothing of it acts any more, and its set stays.
    donor.registry.stop();
    const set = setPath(donor.dropRoot, kept);
    chmodSync(set, 0o500);
    const h = harness(dataDir);
    let live = "";
    try {
      expect(await h.registry.load()).toBe(true);
      // The restart could not take the set: its request stays delivered, in memory and in the file, and nothing is told.
      expect(h.registry.get(kept)?.state).toBe("delivered");
      expect(stored(dataDir).find((record) => record.id === kept)?.state).toBe("delivered");
      expect(h.told).toEqual([]);
      expect(h.registry.health().drop).toBe("failing");
      // Another agent's set, delivered in this run.
      live = await deliverOne(h, "agent-2");
      // A tick while the set still cannot go: it stays, and so does what is owed.
      await h.registry.expire();
      expect(h.registry.get(kept)?.state).toBe("delivered");
      expect(existsSync(join(set, "API_KEY"))).toBe(true);
      expect(h.registry.health().drop).toBe("failing");
    } finally {
      chmodSync(set, 0o700);
    }
    // The fault is gone: the next tick takes the set by itself, and the restart is what released it.
    await h.registry.expire();
    expect(existsSync(set)).toBe(false);
    expect(h.registry.get(kept)).toMatchObject({ state: "released", releasedBy: "restart" });
    expect(stored(dataDir).find((record) => record.id === kept)).toMatchObject({ state: "released", releasedBy: "restart" });
    expect(h.told.filter((line) => line.endsWith(kept))).toEqual([`released ${kept}`]);
    expect(continuationText(h.registry.get(kept) as RequestRecord, h.dropRoot)).toBe(
      `[secure-input] Request ${kept} was delivered, but its files were deleted when the plugin restarted, before this message reached you. Nothing is left to move. If the values are still needed, make a new request.`,
    );
    // The other agent's set was not touched: the tick takes what is owed, never everything.
    expect(h.registry.get(live)?.state).toBe("delivered");
    expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${live}`]);
    expect(h.registry.health().drop).toBe("ok");
    // Once: the next tick finds nothing more to do.
    await h.registry.expire();
    expect(h.told.filter((line) => line.startsWith("released"))).toEqual([`released ${kept}`]);
  });

  it("tries an owed set once a tick, as the restart's, also past its deadline: never a second time as the deadline's", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const kept = await deliverOne(donor, "agent-1");
    donor.registry.stop();
    const set = setPath(donor.dropRoot, kept);
    chmodSync(set, 0o500);
    const h = harness(dataDir);
    const tries: number[] = [];
    try {
      expect(await h.registry.load()).toBe(true);
      // Past its deadline. The first removal of a tick finds the set as it is; any second one in the same tick would find
      // it removable.
      h.clock.now = (h.registry.get(kept)?.deleteBy as number) + 1;
      h.drop.onRelease = () => {
        tries.push(tries.length + 1);
        if (tries.length === 2) chmodSync(set, 0o700);
      };
      await h.registry.expire();
      expect(tries).toEqual([1]);
      expect(h.registry.get(kept)?.state).toBe("delivered");
    } finally {
      chmodSync(set, 0o700);
    }
    await h.registry.expire();
    expect(h.registry.get(kept)).toMatchObject({ state: "released", releasedBy: "restart" });
  });

  it("calls an owed set that is found gone the restart's, not the agent's", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const kept = await deliverOne(donor, "agent-1");
    donor.registry.stop();
    const set = setPath(donor.dropRoot, kept);
    chmodSync(set, 0o500);
    const h = harness(dataDir);
    try {
      expect(await h.registry.load()).toBe(true);
    } finally {
      chmodSync(set, 0o700);
    }
    // Gone before the tick came to it: by a hand that deleted drop/, or by the agent. The restart was to take it.
    rmSync(set, { recursive: true });
    expect(await h.registry.check(kept)).toMatchObject({ state: "released", releasedBy: "restart" });
    expect(h.registry.health().drop).toBe("ok");
  });

  it("tries again at each tick, by itself, what the start's sweep could not remove and no request owns, and leaves the live sets", async () => {
    const h = harness();
    await h.drop.hold();
    const leftover = join(h.dropRoot, `si-secret-${idOf(7)}.0123456789abcdef.tmp`);
    mkdirSync(leftover, { mode: 0o700 });
    writeFileSync(join(leftover, "API_KEY"), "half a set", { mode: 0o600 });
    chmodSync(leftover, 0o500);
    let live = "";
    try {
      expect(await h.registry.load()).toBe(true);
      expect(h.registry.health().drop).toBe("failing");
      live = await deliverOne(h);
      await h.registry.expire();
      expect(existsSync(join(leftover, "API_KEY"))).toBe(true);
      expect(h.registry.health().drop).toBe("failing");
    } finally {
      chmodSync(leftover, 0o700);
    }
    await h.registry.expire();
    expect(existsSync(leftover)).toBe(false);
    expect(h.registry.health().drop).toBe("ok");
    expect(h.registry.get(live)?.state).toBe("delivered");
    expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${live}`]);
  });

  it("owes nothing more once a sweep has taken it: the human's word clears what the start's sweep left, and the drop is ok", async () => {
    const h = harness();
    await h.drop.hold();
    const stray = join(h.dropRoot, "stray");
    mkdirSync(stray, { mode: 0o700 });
    writeFileSync(join(stray, "left"), "left behind", { mode: 0o600 });
    chmodSync(stray, 0o500);
    try {
      expect(await h.registry.load()).toBe(true);
      expect(h.registry.health().drop).toBe("failing");
    } finally {
      chmodSync(stray, 0o700);
    }
    expect(await h.registry.clearDrop()).toEqual({ released: 0, stuck: 0 });
    expect(existsSync(stray)).toBe(false);
    expect(h.registry.health().drop).toBe("ok");
  });

  it("owes what a failed write staged and could not take away: the drop is failing until the tick has taken it, and a live set stays", async () => {
    let opened = 0;
    let staging = "";
    // The third file the store opens is the second file of a write: it cannot be written, and by then the write's staging
    // directory can no longer be changed, so its clean-up fails too.
    const openFile: OpenFile = async (...args) => {
      if ((opened += 1) === 3) {
        staging = dirname(args[0]);
        chmodSync(staging, 0o500);
        throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      }
      return open(...args);
    };
    const h = harness(tempDir(), { openFile });
    const live = await deliverOne(h, "agent-1");
    const { requestId } = await h.registry.create(agent("agent-2"), withFile);
    const p12 = toBase64Url(Uint8Array.from([0x30, 0x82, 0x00, 0xff, 0x0a, 0x0d, 0x80, 0x7f, 0x00, 0x01]));
    try {
      expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: `${CANARY}-staged` }, { key: "P12", file: p12 }])).toEqual({
        ok: false,
        code: "write_failed",
        retryable: false,
        detail: "ENOSPC",
      });
      expect(h.registry.get(requestId)).toMatchObject({ state: "rejected", errorCode: "write_failed" });
      expect(basename(staging)).toMatch(new RegExp(`^si-secret-${requestId}\\.[0-9a-f]{16}\\.tmp$`));
      expect(readdirSync(staging)).toEqual(["API_KEY"]);
      expect(h.registry.health().drop).toBe("failing");
      // A tick while it still cannot go: it stays, and so does what is owed.
      await h.registry.expire();
      expect(readdirSync(staging)).toEqual(["API_KEY"]);
      expect(h.registry.health().drop).toBe("failing");
    } finally {
      if (staging !== "") chmodSync(staging, 0o700);
    }
    await h.registry.expire();
    expect(existsSync(staging)).toBe(false);
    expect(h.registry.health().drop).toBe("ok");
    expect(h.registry.get(live)?.state).toBe("delivered");
    expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${live}`]);
  });
});

describe("the stop", () => {
  it("releases nothing by a turn's end, a deadline, the tick or a look once the plugin is stopping: the stop takes the sets", async () => {
    const h = harness(tempDir(), { dropTtlMs: 40 });
    // The sets' own timers are the test's to move: each fires only once the plugin is stopping.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let ids: string[];
    try {
      // Four sets, each about to go another way: an armed turn, the timers, the tick past the deadline, a look that finds
      // the set deleted.
      ids = [await deliverOne(h, "agent-1"), await deliverOne(h, "agent-2"), await deliverOne(h, "agent-3"), await deliverOne(h, "agent-4")];
      const [turn, , ticked, looked] = ids as [string, string, string, string];
      h.registry.messageSent(turn);
      h.registry.turnStarted("agent-1");
      rmSync(setPath(h.dropRoot, looked), { recursive: true });
      // The mark the plugin sets first when it stops: from here on, a set that is not there may be the sweep's doing.
      h.registry.stop();
      await h.registry.turnEnded("agent-1");
      await vi.advanceTimersByTimeAsync(40);
      h.clock.now = (h.registry.get(ticked)?.deleteBy as number) + 1;
      await h.registry.expire();
      expect(await h.registry.check(looked)).toMatchObject({ state: "delivered" });
    } finally {
      vi.useRealTimers();
    }
    for (const id of ids) expect(h.registry.get(id)?.state, id).toBe("delivered");
    expect(h.told.filter((line) => line.startsWith("released"))).toEqual([]);

    await h.registry.shutdown();
    for (const id of ids.slice(0, 3)) expect(h.registry.get(id), id).toMatchObject({ state: "released", releasedBy: "stop" });
    // Deleted by the agent before the stop came to it, and so said.
    expect(h.registry.get(ids[3] as string)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
  });

  it("gives no deadline to a set whose write took effect after shutdown began, and the stop takes it", async () => {
    const TTL = 123_461;
    const h = harness(tempDir(), { dropTtlMs: TTL });
    const { requestId } = await h.registry.create(agent(), asking);
    // The set is in place, its last check passed, when shutdown begins: it is not undone.
    let shutdown: Promise<void> | undefined;
    h.drop.onWritten = () => void (shutdown ??= h.registry.shutdown());
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: "typed-after-the-check" }])).toEqual({ ok: true, state: "delivered" });
      expect(timers.mock.calls.filter((call) => call[1] === TTL)).toEqual([]);
    } finally {
      timers.mockRestore();
    }
    await shutdown;
    expect(h.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
  });
});

describe("a release or a look under way when the stop begins", () => {
  /**
   * The stop begins while a call of the registry's own is under way, held at `held` (a disk that stalls). The stop waits
   * out its bound for the queue; as its sweep begins it takes the set, as the sweep would, and lets the held call go on,
   * waiting for `done` before the sweep's own bound passes, so that the call's save still lands. What the record says
   * then, in memory and in the file.
   */
  async function stopMidway(h: Harness, id: string, held: { open(): void }, done: () => Promise<unknown>) {
    h.drop.onSweep = async () => {
      rmSync(setPath(h.dropRoot, id), { recursive: true, force: true });
      held.open();
      await done();
    };
    await h.registry.shutdown();
    const saved = stored(h.dataDir).find((record) => record.id === id);
    return { memory: h.registry.get(id)?.releasedBy ?? h.registry.get(id)?.state, saved: saved?.releasedBy ?? saved?.state };
  }

  /** Holds the next removal of a set where it begins. */
  function holdRelease(h: Harness) {
    const held = gate();
    const at = { reached: false };
    h.drop.onRelease = () => {
      at.reached = true;
      return held.held;
    };
    return { held, at };
  }

  /** Holds the next look at a set where it begins: before it looks. */
  function holdLook(h: Harness) {
    const held = gate();
    const at = { reached: false };
    const look = GatedDrop.prototype.exists.bind(h.drop);
    vi.spyOn(h.drop, "exists").mockImplementation(async (requestId: string) => {
      at.reached = true;
      await held.held;
      return look(requestId);
    });
    return { held, at };
  }

  /** Until the release of `id` is told, which is once its save has landed: the record changes in memory before that. */
  const released = (h: Harness, id: string) => () => vi.waitFor(() => expect(h.told).toContain(`released ${id}`), { timeout: 5000 });

  it("calls a set its timer found gone once the stop's sweep began the stop's doing, not the agent's", async () => {
    const h = harness(tempDir(), { dropTtlMs: 40, shutdownBoundMs: 50 });
    const { held, at } = holdRelease(h);
    const id = await deliverOne(h);
    // The deadline passes, and the timer's removal is under way.
    await vi.waitFor(() => expect(at.reached).toBe(true), { timeout: 5000 });
    expect(await stopMidway(h, id, held, released(h, id))).toEqual({ memory: "stop", saved: "stop" });
  });

  it("calls a set the end of its turn found gone once the stop's sweep began the stop's doing, not the agent's", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 50 });
    const id = await deliverOne(h);
    h.registry.messageSent(id);
    h.registry.turnStarted("agent-1");
    const { held, at } = holdRelease(h);
    const ended = h.registry.turnEnded("agent-1");
    await vi.waitFor(() => expect(at.reached).toBe(true), { timeout: 5000 });
    expect(await stopMidway(h, id, held, () => ended)).toEqual({ memory: "stop", saved: "stop" });
  });

  it("calls a set the tick found gone past its deadline once the stop's sweep began the stop's doing, and notices nothing for a look the stop overtook", async () => {
    // The deadline: the removal is under way when the stop begins.
    const due = harness(tempDir(), { shutdownBoundMs: 50 });
    const late = await deliverOne(due);
    due.clock.now = due.registry.get(late)?.deleteBy as number;
    const removal = holdRelease(due);
    const ticked = due.registry.expire();
    await vi.waitFor(() => expect(removal.at.reached).toBe(true), { timeout: 5000 });
    expect(await stopMidway(due, late, removal.held, () => ticked)).toEqual({ memory: "stop", saved: "stop" });

    // Before the deadline: the tick's look is under way when the stop begins, and the set it finds gone is the sweep's.
    const early = harness(tempDir(), { shutdownBoundMs: 50 });
    const id = await deliverOne(early);
    const look = holdLook(early);
    const looked = early.registry.expire();
    await vi.waitFor(() => expect(look.at.reached).toBe(true), { timeout: 5000 });
    expect(await stopMidway(early, id, look.held, () => looked)).toEqual({ memory: "delivered", saved: "delivered" });
  });

  it("notices nothing when the stop overtook a look at the request: the set it finds gone is the sweep's", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 50 });
    const id = await deliverOne(h);
    const { held, at } = holdLook(h);
    const looked = h.registry.check(id);
    await vi.waitFor(() => expect(at.reached).toBe(true), { timeout: 5000 });
    expect(await stopMidway(h, id, held, () => looked)).toEqual({ memory: "delivered", saved: "delivered" });
    expect(await looked).toMatchObject({ id, state: "delivered" });
  });

  it("begins no further release of a turn's end once the stop has begun: the second of two armed sets is left to the stop", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 50 });
    const first = await deliverOne(h, "agent-1");
    const second = await deliverOne(h, "agent-1", `${CANARY}-second`);
    h.registry.messageSent(first);
    h.registry.messageSent(second);
    h.registry.turnStarted("agent-1");
    const { held, at } = holdRelease(h);
    const ended = h.registry.turnEnded("agent-1");
    await vi.waitFor(() => expect(at.reached).toBe(true), { timeout: 5000 });
    // The first set's removal was under way when the stop began, and its sweep took the set.
    expect(await stopMidway(h, first, held, () => ended)).toEqual({ memory: "stop", saved: "stop" });
    // The second was not begun: the stop's sweep took its set, and its request is as the stop left it, for the next start
    // to read back as the restart's. Asked once for the whole turn, and not before each set, it would read `turn`.
    expect(h.registry.get(second)?.state).toBe("delivered");
    expect(stored(h.dataDir).find((record) => record.id === second)?.state).toBe("delivered");
    expect(readdirSync(h.dropRoot)).toEqual([]);
  });

  it("keeps the agent's own release the agent's, though the stop's sweep took the set while it was under way", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 50 });
    const id = await deliverOne(h);
    const { held, at } = holdRelease(h);
    const asked = h.registry.release("agent-1", id);
    await vi.waitFor(() => expect(at.reached).toBe(true), { timeout: 5000 });
    expect(await stopMidway(h, id, held, () => asked)).toEqual({ memory: "agent", saved: "agent" });
    expect(await asked).toMatchObject({ id, state: "released", releasedBy: "agent" });
  });
});

describe("what the settings screen is told of the requests", () => {
  it("counts the requests that wait and the sets that are delivered, and names the earliest deadline", async () => {
    const h = harness();
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 0, nextDeleteBy: null });
    // Three requests, made in one order and delivered in another: the earliest deadline is neither the first request's nor the last's.
    const made: string[] = [];
    for (const agentId of ["agent-1", "agent-2", "agent-3"]) made.push((await h.registry.create(agent(agentId), asking)).requestId);
    const [x, y, z] = made as [string, string, string];
    expect(h.registry.counts()).toEqual({ pending: 3, delivered: 0, nextDeleteBy: null });

    const begun = h.clock.now;
    for (const [id, after] of [[y, 0], [x, 60_000], [z, 120_000]] as const) {
      h.clock.now = begun + after;
      expect(await submit(h.registry, id, [{ key: "API_KEY", value: `${CANARY}-${after}` }])).toEqual({ ok: true, state: "delivered" });
    }
    const earliest = h.registry.get(y)?.deleteBy as number;
    expect([x, y, z].map((id) => h.registry.get(id)?.deleteBy)).toEqual([earliest + 60_000, earliest, earliest + 120_000]);
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 3, nextDeleteBy: earliest });

    // As each goes, the deadline named is the earliest of those that are left.
    await h.registry.release("agent-2", y);
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 2, nextDeleteBy: earliest + 60_000 });
    await h.registry.release("agent-1", x);
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 1, nextDeleteBy: earliest + 120_000 });
    await h.registry.release("agent-3", z);
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 0, nextDeleteBy: null });

    // A request that waits is counted until it ends.
    const open = (await h.registry.create(agent("agent-4"), asking)).requestId;
    expect(h.registry.counts()).toEqual({ pending: 1, delivered: 0, nextDeleteBy: null });
    await h.registry.decline(open);
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 0, nextDeleteBy: null });
  });
});

describe("the human's deletion of every set", () => {
  it("deletes every set at the human's word, says how many, and the waiting messages become 'deleted by the user'", async () => {
    const h = harness();
    const ids = [await deliverOne(h, "agent-1"), await deliverOne(h, "agent-2")];
    expect(await h.registry.clearDrop()).toEqual({ released: 2, stuck: 0 });
    for (const id of ids) expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
    for (const id of ids) {
      expect(continuationText(h.registry.get(id) as RequestRecord, h.dropRoot)).toBe(
        `[secure-input] Request ${id} was delivered, but its files were deleted by the user, before this message reached you. Nothing is left to move. If the values are still needed, make a new request.`,
      );
    }
    // Saved and told, once for each, and nothing is left for the screen to count.
    for (const id of ids) expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(h.told.filter((line) => line.startsWith("released")).sort()).toEqual(ids.map((id) => `released ${id}`).sort());
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 0, nextDeleteBy: null });
    expect(h.registry.health().drop).toBe("ok");
    // The word given again finds nothing, and changes and tells nothing.
    const told = h.told.length;
    expect(await h.registry.clearDrop()).toEqual({ released: 0, stuck: 0 });
    expect(h.told).toHaveLength(told);
  });

  it("touches only the sets that are delivered: a request that waits, one that ended and one released before keep their states", async () => {
    const h = harness();
    const delivered = await deliverOne(h, "agent-1");
    const waiting = (await h.registry.create(agent("agent-2"), asking)).requestId;
    const declined = (await h.registry.create(agent("agent-3"), asking)).requestId;
    await h.registry.decline(declined);
    const gone = await deliverOne(h, "agent-4");
    await h.registry.release("agent-4", gone);
    expect(await h.registry.clearDrop()).toEqual({ released: 1, stuck: 0 });
    expect(h.registry.get(delivered)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(h.registry.get(waiting)?.state).toBe("pending");
    expect(h.registry.get(declined)?.state).toBe("declined");
    expect(h.registry.get(gone)).toMatchObject({ state: "released", releasedBy: "agent" });
    // The request that waits is answered as before.
    expect(await submit(h.registry, waiting, [{ key: "API_KEY", value: `${CANARY}-late` }])).toEqual({ ok: true, state: "delivered" });
  });

  it("takes whatever else lies in drop/ as well, the leftovers of a write that was killed and what was put there, and counts none of it as a set", async () => {
    const h = harness();
    const id = await deliverOne(h);
    const leftover = join(h.dropRoot, `si-secret-${idOf(7)}.0123456789abcdef.tmp`);
    mkdirSync(leftover, { mode: 0o700 });
    writeFileSync(join(leftover, "API_KEY"), "half a set", { mode: 0o600 });
    writeFileSync(join(h.dropRoot, "stray"), "put there", { mode: 0o600 });
    expect(await h.registry.clearDrop()).toEqual({ released: 1, stuck: 0 });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
  });

  it("does not race a write: a submission under way is written first, and then deleted", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent("agent-1"), asking);
    const stalled = gate();
    let reached = false;
    h.drop.onWrite = () => {
      reached = true;
      return stalled.held;
    };
    try {
      const fulfilled = h.registry.fulfill(requestId, sealed(h.registry, requestId, [{ key: "API_KEY", value: `${CANARY}-raced` }]));
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });
      // The human's word comes while the set is being written, and nothing of it is on disk yet.
      const cleared = h.registry.clearDrop();
      stalled.open();
      expect(await fulfilled).toEqual({ ok: true, state: "delivered" });
      expect(await cleared).toEqual({ released: 1, stuck: 0 });
    } finally {
      stalled.open();
    }
    expect(h.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
  });

  it("leaves a submission alone that comes after the word: only what exists, or is under way, is deleted", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent("agent-1"), asking);
    const cleared = h.registry.clearDrop();
    const fulfilled = submit(h.registry, requestId, [{ key: "API_KEY", value: `${CANARY}-after` }]);
    expect(await cleared).toEqual({ released: 0, stuck: 0 });
    expect(await fulfilled).toEqual({ ok: true, state: "delivered" });
    expect(h.registry.get(requestId)?.state).toBe("delivered");
    expect(existsSync(setPath(h.dropRoot, requestId))).toBe(true);
  });

  it("counts what it cannot remove, keeps those requests delivered, and ends them at the next word once they can go", async () => {
    const h = harness();
    const stuck = await deliverOne(h, "agent-1");
    const fine = await deliverOne(h, "agent-2");
    const set = setPath(h.dropRoot, stuck);
    chmodSync(set, 0o500);
    try {
      expect(await h.registry.clearDrop()).toEqual({ released: 1, stuck: 1 });
      expect(h.registry.get(fine)).toMatchObject({ state: "released", releasedBy: "human" });
      expect(h.registry.get(stuck)?.state).toBe("delivered");
      expect(existsSync(join(set, "API_KEY"))).toBe(true);
      expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${stuck}`]);
      // What the screen reads: a set is still there, and the drop is failing.
      expect(h.registry.counts()).toMatchObject({ delivered: 1 });
      expect(h.registry.health().drop).toBe("failing");
    } finally {
      chmodSync(set, 0o700);
    }
    expect(await h.registry.clearDrop()).toEqual({ released: 1, stuck: 0 });
    expect(h.registry.get(stuck)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
    expect(h.registry.health().drop).toBe("ok");
  });

  it("counts an entry of drop/ that is no set and cannot be removed, with no set delivered, and ends it at the next word once it can go", async () => {
    const h = harness();
    await h.drop.hold();
    const stray = join(h.dropRoot, "stray");
    mkdirSync(stray, { mode: 0o700 });
    writeFileSync(join(stray, "left"), "left behind", { mode: 0o600 });
    chmodSync(stray, 0o500);
    try {
      expect(await h.registry.clearDrop()).toEqual({ released: 0, stuck: 1 });
      expect(h.registry.counts()).toEqual({ pending: 0, delivered: 0, nextDeleteBy: null });
      expect(h.registry.health().drop).toBe("failing");
      expect(existsSync(join(stray, "left"))).toBe(true);
    } finally {
      chmodSync(stray, 0o700);
    }
    expect(await h.registry.clearDrop()).toEqual({ released: 0, stuck: 0 });
    expect(readdirSync(h.dropRoot)).toEqual([]);
    expect(h.registry.health().drop).toBe("ok");
  });

  it("calls a set the sweep took after the removal of its own failed the human's doing, not the agent's", async () => {
    const h = harness();
    const id = await deliverOne(h);
    const set = setPath(h.dropRoot, id);
    // The removal fails once, as it would for a file the agent holds, and the sweep that follows finds the set removable.
    let first = true;
    h.drop.onRelease = () => {
      if (first) chmodSync(set, 0o500);
      first = false;
    };
    h.drop.onSweep = () => chmodSync(set, 0o700);
    expect(await h.registry.clearDrop()).toEqual({ released: 1, stuck: 0 });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
    expect(h.registry.counts()).toEqual({ pending: 0, delivered: 0, nextDeleteBy: null });
    expect(h.registry.health().drop).toBe("ok");
  });

  it("calls a set that was gone before the word the agent's, as its first pass finds it, and its waiting message is not 'deleted by the user'", async () => {
    const h = harness();
    const id = await deliverOne(h);
    rmSync(setPath(h.dropRoot, id), { recursive: true });
    expect(await h.registry.clearDrop()).toEqual({ released: 1, stuck: 0 });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "agent" });
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "agent" });
    // The agent took the files: a delivery message that still waits is dropped, and never says the user deleted them.
    expect(continuationText(h.registry.get(id) as RequestRecord, h.dropRoot)).toBeNull();
  });

  it("calls a set the stop's sweep took while the word's own sweep waited the stop's doing, and refuses: once the stop has begun, the sets are the stop's", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 25 });
    const id = await deliverOne(h);
    const set = setPath(h.dropRoot, id);
    // The first removal fails on a set that cannot be changed, and the word's sweep is held where it begins.
    chmodSync(set, 0o500);
    const clearSweep = gate();
    let sweeps = 0;
    let cleared: Promise<unknown> = Promise.resolve();
    try {
      h.drop.onSweep = async () => {
        sweeps += 1;
        if (sweeps === 1) return clearSweep.held;
        // The stop's sweep, which does not wait for the queue: the set can go now, and it goes. The word goes on while the
        // stop is still under way, and the stop waits for it to end.
        chmodSync(set, 0o700);
        rmSync(set, { recursive: true });
        clearSweep.open();
        await cleared.catch(() => undefined);
      };
      cleared = h.registry.clearDrop();
      await vi.waitFor(() => expect(sweeps).toBe(1), { timeout: 5000 });
      await h.registry.shutdown();
    } finally {
      clearSweep.open();
      if (existsSync(set)) chmodSync(set, 0o700);
    }
    expect(await rejectionOf(cleared)).toEqual({ code: "service_unavailable", message: "service_unavailable: the plugin is shutting down" });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(existsSync(set)).toBe(false);
  });

  it("calls a set its own sweep took the human's, though the stop begins right after that sweep, and refuses then", async () => {
    const h = harness();
    const id = await deliverOne(h);
    const set = setPath(h.dropRoot, id);
    // The first removal fails on a set that cannot be changed; the word's sweep finds it removable and takes it, and the
    // stop begins the moment that sweep is over, before the word looks at what is left. The stop's own sweep has not begun.
    chmodSync(set, 0o500);
    h.drop.onSweep = () => chmodSync(set, 0o700);
    const sweep = h.drop.sweep.bind(h.drop);
    vi.spyOn(h.drop, "sweep").mockImplementation(async (stillWanted) => {
      const swept = await sweep(stillWanted);
      h.registry.stop();
      return swept;
    });
    try {
      expect(await rejectionOf(h.registry.clearDrop())).toEqual({ code: "service_unavailable", message: "service_unavailable: the plugin is shutting down" });
    } finally {
      if (existsSync(set)) chmodSync(set, 0o700);
    }
    // The sweep says it took the set, and it asked before each removal whether the stop had begun: the human's doing.
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(stored(h.dataDir).find((record) => record.id === id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(existsSync(set)).toBe(false);
  });

  it("fails with a sweep that cannot run and calls the drop failing, though what it released stays released", async () => {
    const h = harness();
    const id = await deliverOne(h);
    h.drop.onSweep = () => {
      throw new SecureInputError("service_unavailable", "the drop directory cannot be read");
    };
    expect(await rejectionOf(h.registry.clearDrop())).toEqual({ code: "service_unavailable", message: "service_unavailable: the drop directory cannot be read" });
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(h.registry.health().drop).toBe("failing");
    // The next word, with the sweep working again, ends it.
    h.drop.onSweep = undefined;
    expect(await h.registry.clearDrop()).toEqual({ released: 0, stuck: 0 });
    expect(h.registry.health().drop).toBe("ok");
  });

  it("refuses once the plugin is stopping and removes nothing itself: the stop takes the sets", async () => {
    const h = harness();
    const id = await deliverOne(h);
    h.registry.stop();
    expect(await rejectionOf(h.registry.clearDrop())).toEqual({ code: "service_unavailable", message: "service_unavailable: the plugin is shutting down" });
    expect(h.registry.get(id)?.state).toBe("delivered");
    expect(existsSync(setPath(h.dropRoot, id))).toBe(true);
    expect(h.registry.health().drop).toBe("ok");
    await h.registry.shutdown();
    expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "stop" });
  });

  it("stops where the plugin's stop begins: what it released stays released, the rest is the stop's, and the drop is not called failing", async () => {
    const h = harness();
    const first = await deliverOne(h, "agent-1");
    const second = await deliverOne(h, "agent-2");
    // The stop begins while the first set is being removed.
    h.drop.onRelease = () => h.registry.stop();
    expect(await rejectionOf(h.registry.clearDrop())).toEqual({ code: "service_unavailable", message: "service_unavailable: the plugin is shutting down" });
    expect(h.registry.get(first)).toMatchObject({ state: "released", releasedBy: "human" });
    expect(h.registry.get(second)?.state).toBe("delivered");
    expect(existsSync(setPath(h.dropRoot, second))).toBe(true);
    expect(h.registry.health().drop).toBe("ok");
    await h.registry.shutdown();
    expect(h.registry.get(second)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(readdirSync(h.dropRoot)).toEqual([]);
  });
});
