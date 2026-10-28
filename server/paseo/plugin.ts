import type { PluginServerContext } from "@getpaseo/plugin/server";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { DiagnosticsSchema } from "../../shared/contracts";
import { SecureInputError, errorDetailOf, type ErrorCode } from "../../shared/errors";
import { messageFor } from "../core/continuation";
import { Outbox, type OutboxItem, type ResolvedMessage } from "../core/outbox";
import { DROP_SWEEP_BOUND_MS, Registry, SHUTDOWN_BOUND_MS } from "../core/registry";
import { clearSelfTests } from "../core/selftest";
import { holdDirectory } from "../io/directory";
import { DropStore } from "../io/drop";
import { replaceLegacyBridge } from "../io/legacy-shim";
import { TIMED_OUT, within } from "./bounded";
import { registerHandlers } from "./handlers";
import { registerHooks } from "./hooks";
import { Runtime, SETTLE_BOUND_MS } from "./runtime";
import { agentTools } from "./tools";

/** The parts of the server context the plugin uses. */
export type PluginHost = Pick<PluginServerContext, "handle" | "before" | "on">;

/**
 * What the plugin runs in. Under plain Node the shim v1 left is pointed at `execPath`, which runs the stub in place of
 * v1's bridge; Electron's binary runs no script as Node, so under Electron the shim is left as v1 wrote it.
 */
export interface RuntimeInfo {
  kind: "node" | "electron";
  execPath: string;
}

export interface PluginOptions {
  /** `<Paseo home>/secure-input`. Made if missing, and resolved to its real path. */
  dataDir: string;
  runtime: RuntimeInfo;
  /** Where lines for the plugin's log go. Only codes and fixed phrases are ever given to it. */
  log(line: string): void;
  /** `DAEMON_CALL_TIMEOUT_MS` unless a test wants less. */
  daemonCallTimeoutMs?: number;
  /** `STARTUP_WAIT_MS` unless a test wants less. */
  startupWaitMs?: number;
  /** `EXPIRY_INTERVAL_MS` unless a test wants less. */
  expiryIntervalMs?: number;
  /** How long a delivered set stays at the most: `DROP_TTL_MS` unless a test wants less. */
  dropTtlMs?: number;
  /** How long a tool call's operation waits for its turn in the registry's queue at the most: `ADMISSION_WAIT_MS` unless a test wants less. */
  admissionWaitMs?: number;
}

export interface StartupProblem {
  code: ErrorCode | "unexpected";
  detail: string;
}

interface Status {
  problem: StartupProblem | null;
  lastHookFailure: string | null;
}

export interface Parts {
  /** The real path of the data directory. Everything below is derived from it. */
  dataDir: string;
  /** `bin` is where v1 installed its bridge and its shim, which the start-up replaces with a stub where they are; `drop` is where the sets are. */
  files: { outbox: string; bin: string; drop: string };
  outbox: Outbox;
  runtime: Runtime;
  registry: Registry;
  status: Status;
  diagnostics(): Promise<z.input<typeof DiagnosticsSchema>>;
  /** Remembers that a hook or an event handler failed, as a code. */
  failed(hook: string, code: string): void;
}

export interface RunningPlugin extends Parts {
  /** Settles when the start-up has ended, with or without a problem. Never rejects. */
  ready: Promise<void>;
  /** Stops the plugin. Safe to call twice, and while the start-up is still going. */
  dispose(): Promise<void>;
}

/** How often requests past their time are expired, and waiting messages and owed cards are tried again. */
export const EXPIRY_INTERVAL_MS = 60_000;

/**
 * How long a tool call waits for the start-up to end before it is refused with `NOT_STARTED`, and how long `dispose`
 * waits for it before it goes on without it. The start-up is a handful of operations on the plugin's own files, a few
 * milliseconds; the wait is for the case that a disk is slow, and it is a bound so that a start-up that never ends
 * can hold up neither a call of an agent nor the stopping of the plugin.
 */
export const STARTUP_WAIT_MS = 5_000;

const PROBLEM_DETAIL_MAX = 300;

/**
 * How long Paseo 0.14 lets the plugin's process stop by itself. The daemon sends the process `shutdown`, on which the
 * process runs `dispose`; 2 seconds later it sends SIGTERM, and 2 seconds after that SIGKILL
 * (`SOFT_SHUTDOWN_TIMEOUT_MS = 2_000`, getpaseo/paseo v0.14.0-beta.1 packages/server/src/server/plugins/runtime.ts:48
 * and :1316-1324). The plugin's process has no handler for SIGTERM (packages/server/src/server/plugins/plugin-process.ts
 * installs none), so Node ends it at SIGTERM: what `dispose` has not done 2 seconds after it began is not done.
 */
export const PASEO_STOP_WINDOW_MS = 2_000;

/**
 * The longest `dispose` waits for anything but the plugin's own files: the registry's shutdown, in which the sets are
 * released and its last save is made and then `drop/` is swept, and then the runtime's settling once it was stopped.
 * 1.8 seconds, inside `PASEO_STOP_WINDOW_MS` with room for the rest of the process's stop: so `drop/` is swept before
 * Paseo ends the process, however long a task in the registry's queue takes. A start-up that has not ended is waited
 * for `STARTUP_WAIT_MS` before that, which is longer than the window. Such a start-up has delivered no set (every
 * request comes from a tool call, and a tool call waits for the start-up), so what the window cuts short then is only
 * the sweep of what an earlier run left in `drop/`, which the next start makes.
 */
export const DISPOSE_BOUND_MS = SHUTDOWN_BOUND_MS + DROP_SWEEP_BOUND_MS + SETTLE_BOUND_MS;

const UNEXPECTED_STARTUP = "an unexpected error stopped the start-up";

export function describeRuntime(versions: Readonly<Record<string, string | undefined>>, execPath: string): RuntimeInfo {
  return { kind: versions.electron ? "electron" : "node", execPath };
}

export function defaultOptions(env: NodeJS.ProcessEnv = process.env): PluginOptions {
  const home = env.PASEO_HOME || join(homedir(), ".paseo");
  return {
    dataDir: join(home, "secure-input"),
    runtime: describeRuntime(process.versions, process.execPath),
    log: (line) => console.error(line),
  };
}

/**
 * The directory as it really is, so that every path derived from it is the real one. It is made if it is missing,
 * and that is all that is done to it here: a link in place of the directory itself is not followed, the path is
 * returned as it is, and the hold that starts the plugin refuses it. The hold also checks the owner and the mode.
 */
function realDirectory(path: string): string {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return lstatSync(path).isSymbolicLink() ? path : realpathSync(path);
  } catch {
    return path;
  }
}

function describeProblem(error: unknown): StartupProblem {
  if (!(error instanceof SecureInputError)) return { code: "unexpected", detail: UNEXPECTED_STARTUP };
  return { code: error.code, detail: errorDetailOf(error, PROBLEM_DETAIL_MAX) ?? "" };
}

/** The message an outbox item stands for, from the plugin's own record and with the paths of its set in `drop`, and the agent the record belongs to. */
function resolveMessage(registry: Pick<Registry, "get">, item: OutboxItem, drop: string): ResolvedMessage | null {
  const record = registry.get(item.requestId);
  if (record === undefined) return null;
  const text = messageFor(record, item.kind, drop);
  return text === null ? null : { agentId: record.agentId, text };
}

/** Builds the parts and connects them. Nothing is started: the data directory is made and resolved, and that is all. */
export function assemble(options: PluginOptions): Parts {
  const dataDir = realDirectory(options.dataDir);
  const files = {
    outbox: join(dataDir, "outbox.json"),
    bin: join(dataDir, "bin"),
    drop: join(dataDir, "drop"),
  };
  const report = (code: string): void => options.log(`secure-input: ${code}`);
  const status: Status = { problem: null, lastHookFailure: null };

  // The resolver reads the registry, which is built below: it runs only when something is sent, and so does `onSend`.
  // A delivery message that is handed over makes the next turn of its agent the one that takes the set.
  const outbox: Outbox = new Outbox(files.outbox, (item) => resolveMessage(registry, item, files.drop), {
    onSend: (item) => {
      if (item.kind === "continuation") registry.messageSent(item.requestId);
    },
  });
  const runtime: Runtime = new Runtime(outbox, { callTimeoutMs: options.daemonCallTimeoutMs, report });
  const registry: Registry = new Registry({
    dataDir,
    drop: new DropStore(files.drop),
    onChange: (record, change) => runtime.publish(record, change),
    // The history is bounded, and so is what the runtime and the outbox keep per request.
    onForget: (requestId) => runtime.forget(requestId),
    // The clock the registry's stored times and expiry are in: integer milliseconds.
    now: () => Date.now(),
    dropTtlMs: options.dropTtlMs,
    admissionWaitMs: options.admissionWaitMs,
  });

  return {
    dataDir,
    files,
    outbox,
    runtime,
    registry,
    status,
    failed(hook, code) {
      status.lastHookFailure = `${hook}: ${code}`;
      options.log(`secure-input: hook_failed ${hook} ${code}`);
    },
    async diagnostics() {
      return {
        attached: runtime.attached,
        dataDir,
        registry: registry.health(),
        outbox: outbox.health(),
        requests: registry.counts(),
        startup: status.problem,
        cardsOwed: runtime.cardsOwed,
        messagesHeld: runtime.messagesHeld,
        lastHookFailure: status.lastHookFailure,
      };
    },
  };
}

/**
 * Starts the plugin inside the daemon: registers the RPC handlers and the hooks at once, so the daemon sees them
 * when `contribute` returns, and starts the start-up sequence, which cannot take them away. A failure of the sequence
 * is kept as a code and a fixed phrase for the diagnostics and the log, and what had been set up stays up: the tools
 * are offered all the same, and refuse in fixed words that send the agent to the user.
 */
export function startPlugin(host: PluginHost, options: PluginOptions): RunningPlugin {
  const parts = assemble(options);
  const { dataDir, files, registry, runtime, status, failed } = parts;
  const report = (code: string): void => options.log(`secure-input: ${code}`);
  const startupWaitMs = options.startupWaitMs ?? STARTUP_WAIT_MS;

  // The handlers and the hooks below are registered at once, and any of them may ask for a flush of the outbox before
  // the start-up has read the requests. Until it has, the outbox could not tell a request that is not loaded yet from
  // one that does not exist, and would drop a message that waited across the restart: so no flush runs before then.
  // A start-up that never gets as far as the load never flushes, and what waits stays in the file for the next start.
  runtime.holdMessages();

  // In this order, and the first step to fail ends it. The directory is held (a real directory of this user, 0700)
  // before anything is read from it, written into it or removed from it. Then `drop/` is held and everything a killed
  // run left in it is swept, before anything else that can fail: a set with values in it must not outlive a start that
  // ends in a failure further on (a `bin/` that is not a private directory), and the sweep needs nothing but the
  // directory. A `drop/` that is no private directory of this user fails the start-up there. Then the stub takes the
  // place of v1's bridge where v1 installed one. The registry loads last, so that no request is taken before the old
  // ones have been dealt with: a tool call waits for the start-up (`started`).
  //
  // A dispose ends it too. Between two steps: once the plugin is being stopped no further step is begun, also not by a
  // start-up that hung, was no longer waited for, and comes back later. And inside a step: the one that was under way
  // goes on, and it asks again right before each thing it would do to a path the plugin shares with the one that may
  // have been started in its place by then (`StillWanted`). The replacement of the bridge asks whether the plugin is
  // being stopped; the sweep and the load ask the registry, which the dispose marks stopped the moment it stops waiting
  // for the start-up (so that a sweep or a load that ends within that wait is done in full). On "no" nothing more in
  // `drop/` is removed, the stub and the shim are not written, and the requests are not loaded.
  let stopping = false;
  const stillWanted = (): boolean => !stopping;
  const steps: Array<() => Promise<void>> = [
    () => holdDirectory(dataDir, "data"),
    () => registry.sweep(),
    async () => {
      await replaceLegacyBridge(dataDir, options.runtime, stillWanted);
    },
    async () => {
      // A registry that was stopped before it had read the requests has loaded none, and the messages stay held:
      // released, the outbox would take every message that waits for a request it cannot find and drop it from the file.
      if (await registry.load()) runtime.releaseMessages();
    },
  ];
  const ready: Promise<void> = (async () => {
    try {
      for (const step of steps) {
        if (stopping) return;
        await step();
      }
    } catch (error) {
      status.problem = describeProblem(error);
      // A SecureInputError's text is a fixed phrase of ours; for anything else only the phrase above is kept.
      options.log(`secure-input failed to start: ${status.problem.code}${status.problem.detail === "" ? "" : `: ${status.problem.detail}`}`);
    }
  })();

  /** How the start-up ended, for a tool call: waited for within the bound, and "pending" when it has not ended by then. */
  const started = async (): Promise<StartupProblem | null | "pending"> => ((await within(startupWaitMs, () => ready)) === TIMED_OUT ? "pending" : status.problem);

  // Each part of the tick is guarded on its own: a request past its time is expired, and what waits for an agent that
  // became idle without a turn-ended event (the daemon only tells of those it sees) is tried again, as is a card the
  // timeline does not show yet. A tick that finds the last flush still under way does not start a second one.
  const expiry = setInterval(() => {
    void (async () => {
      try {
        await registry.expire();
      } catch {
        report("expire_failed");
      }
      try {
        await runtime.flushAll();
      } catch {
        report("flush_failed");
      }
    })();
  }, options.expiryIntervalMs ?? EXPIRY_INTERVAL_MS);
  expiry.unref();

  registerHandlers(host, { registry, runtime, diagnostics: parts.diagnostics, report });
  // The tools are built for each session that opens, inside the hook: one that cannot be built fails that hook, which
  // hands the session on as it came, and never the plugin. The turn events act on the registry's sets.
  registerHooks(host, { runtime, turns: registry, tools: () => agentTools({ registry, runtime, started, drop: files.drop }), failed });

  // Each step is its own, so that one that fails does not keep the rest from running.
  //
  // How long it takes at most: every step that waits for anything but the plugin's own files is bounded. A start-up
  // that has not ended is waited for `STARTUP_WAIT_MS` and then left: it begins no further step, and the step it hangs
  // in works on paths that the plugin started after this one uses too (what is in `drop/`, the stub and the shim), so
  // that step asks before each thing it does to them and does none of it once the answer is no (see above). The
  // registry's shutdown takes `SHUTDOWN_BOUND_MS` and then `DROP_SWEEP_BOUND_MS` at most; the runtime, once stopped,
  // settles within `SETTLE_BOUND_MS`. So `DISPOSE_BOUND_MS`, the sum of the three, is the most a daemon that does not
  // answer or a disk that hangs under `drop/` can add to a dispose, and it ends inside the window Paseo gives the stop
  // (`PASEO_STOP_WINDOW_MS`). A disk that hangs under the start-up adds `STARTUP_WAIT_MS` and no more.
  const step = async (name: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch {
      report(`cleanup_failed ${name}`);
    }
  };
  let disposing: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    disposing ??= (async () => {
      stopping = true;
      clearInterval(expiry);
      await step("start-up", () => within(startupWaitMs, () => ready));
      // The start-up is not waited for any longer, ended or not. From here on a sweep or a load of its own that
      // comes back does nothing: the registry is marked now, and not a step further down, where its shutdown begins.
      registry.stop();
      // The registry before the runtime: it wipes its keys, releases every set, makes its last save and sweeps `drop/`
      // while the runtime still delivers.
      await step("registry", () => registry.shutdown());
      // From here on the daemon is asked nothing more for a card or a message, however many are waiting: what is
      // still owed is saved in the outbox for the next start to send, and a card that did not land is in the dialog.
      await step("deliveries", () => runtime.stop());
      await step("runtime", () => runtime.settled());
      await step("self-tests", () => clearSelfTests());
    })();
    return disposing;
  };

  return { ...parts, ready, dispose };
}
