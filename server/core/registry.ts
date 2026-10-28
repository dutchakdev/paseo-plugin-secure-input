import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { toBase64Url, utf8 } from "../../shared/bytes";
import { canonicalJson } from "../../shared/canonical";
import { SecureInputError, errorDetailOf, type ErrorCode } from "../../shared/errors";
import { DETAIL_MAX, DROP_TTL_MS } from "../../shared/limits";
import { FULFILLED_STATES, InputRequestSchema, LIMITS, type InputRequest, type RequestState } from "../../shared/request";
import { sanitizeText } from "../../shared/sanitize";
import { buildAad, decodeValues, digestHex, generateRequestKeyPair, open as unseal, type PayloadEntry, type SealedEnvelope } from "../../shared/seal";
import { RequestViewSchema } from "../../shared/view";
import { raceDeadline } from "../io/deadline";
import { setName, type DropFile, type DropStore, type SweepResult } from "../io/drop";
import { validateEntries } from "./entries";
import {
  HISTORY,
  MAX_REQUESTS_BYTES,
  MAX_RETRIES,
  TITLE_MAX,
  encodeRecords,
  isOpen,
  parseRecord,
  readStored,
  saveStored,
  type ReleasedBy,
  type RequestRecord,
} from "./registry-store";
import { composeView } from "./view";

// Declared in `registry-store` (the number of failed submissions in `shared/limits`, where the app reads it too) and
// exported here, where what uses the registry looks for them.
export { HISTORY, MAX_REQUESTS_BYTES, MAX_RETRIES };
export type { RequestRecord };

export const TTL_MS = 8 * 60 * 60 * 1000;

/**
 * How long `shutdown` waits at most for the work queue, in which the sets are released and the last save is made. What
 * has not ended by then is left: see `shutdown`. It and `DROP_SWEEP_BOUND_MS` after it are what the stop of the plugin
 * spends on `drop/`, and the two are chosen to end well inside the 2 seconds Paseo 0.14 gives a plugin's process to
 * stop before it sends SIGTERM (`PASEO_STOP_WINDOW_MS` in `server/paseo/plugin.ts`, which cites the daemon's lines).
 * Honest work in the queue (a set being written, a save) takes milliseconds; a task that is still running after a
 * second is a disk that stalls, and the sweep does not wait for it any longer.
 */
export const SHUTDOWN_BOUND_MS = 1_000;

/** How long `shutdown` gives the sweep of `drop/` that follows, at most: a few sets of at most 32 files take milliseconds. */
export const DROP_SWEEP_BOUND_MS = 500;

/**
 * How long the operation of a tool call waits at most for its turn in the work queue (`admit`). Honest work in the queue
 * takes milliseconds; an operation still waiting after this is behind a disk that stalls, and its call is refused in
 * fixed words (`BUSY`) instead of being held until Paseo's own limit on a tool call, ten minutes. An operation that has
 * begun is not cut off by it.
 */
export const ADMISSION_WAIT_MS = 10_000;

/** What a tool call is refused with when its operation's turn has not come within `ADMISSION_WAIT_MS`: nothing of it was done, and nothing will be. */
export const BUSY = "the plugin is busy; retry in a few seconds";

/**
 * What a tool call that was canceled while its operation waited for its turn is answered with: nothing of it was done,
 * and nothing will be. Paseo drops what a canceled call answers, so no agent reads it; it is fixed all the same.
 */
export const CANCELED = "the call was canceled";

/** The parts of the drop store the registry uses. */
export type DropPort = Pick<DropStore, "hold" | "write" | "exists" | "release" | "remove" | "sweep">;

const NEXT = "End your turn now. You will receive a message when the user has submitted. Do not poll.";
const REQUESTS_FILE = "requests.json";
/** What a request is refused with when the dialog could not be given its view. The part of the view that does not fit is named after it. */
const NO_VIEW = "the request cannot be shown in the dialog";
/** The most of a path into the view that a refusal names. */
const VIEW_PATH_MAX = 80;
const SHUTTING_DOWN = "the plugin is shutting down";

export interface AgentIdentity {
  agentId: string;
  cwd: string;
  title: string | null;
}

/** `detail` is what the module that refused put in its error: key names, an errno name, a fixed phrase. Never a value. */
export type FulfillResult = { ok: true; state: RequestState } | { ok: false; code: ErrorCode; retryable: boolean; detail?: string };

/**
 * What a change of a record was, for whoever is told of it. The state changed (a request that was just made counts: it
 * came to be `pending`), or the tamper flag was raised, or something else changed (a failed attempt was counted). A
 * closed set, and each change is one of them: whoever is told can announce a state once, when it is reached, and not
 * again each time something else about the record changes.
 */
export type RecordChange = "state" | "tamper" | "other";

export interface RegistryDeps {
  dataDir: string;
  /** Where the sets are written and from where they are removed. */
  drop: DropPort;
  /**
   * Told of every change of a record, with a copy of it and what the change was. A record that is loaded as it was
   * saved is no change and is not told; the changes the load makes itself (`pending` to `expired`, `delivered` to
   * `released`) are changes of state.
   */
  onChange(record: RequestRecord, change: RecordChange): void;
  /** Told the id of a record that left the history, so that what others keep per request can go with it. */
  onForget?(requestId: string): void;
  now(): number;
  /** The most `requests.json` may hold. Absent, `MAX_REQUESTS_BYTES`; a test sets it small. */
  maxStoredBytes?: number;
  /** `SHUTDOWN_BOUND_MS` unless a test wants less. */
  shutdownBoundMs?: number;
  /** `ADMISSION_WAIT_MS` unless a test wants less. */
  admissionWaitMs?: number;
  /** How long a set stays at the most, and the delay of its timer: `DROP_TTL_MS` unless a test wants less. */
  dropTtlMs?: number;
}

/**
 * Where a delivered request is on the way to the end of the turn that takes its set: its message was handed over to the
 * agent (`sent`), and then a turn of that agent began (`armed`). The end of an armed request's agent's turn releases it.
 */
type TurnMark = "sent" | "armed";

/** What a tool call asks an operation with (`admit`): the call's signal, which says when the call was canceled. */
export interface CallTerms {
  signal: AbortSignal;
}

const UNKNOWN_REQUEST = "unknown request";
const NO_FILES = "the request has no files to release";
const NOT_REMOVED = "the files could not be deleted; the plugin tries again";

/** Thrown where a write meets a shutdown that began meanwhile, right before its effect. Not a refusal of the request: nothing about the request changes. */
class ShutdownBegan extends Error {}

/**
 * The digest of what a request asked for, which its submission is sealed to (the AAD, `buildAad`): its declared keys,
 * in their order, and whether each is optional. The reason, the labels, the kind and the format are not in it: the
 * kind is held to the request by the daemon itself (`validateEntries`), the format by the app.
 */
export function requestDigestOf(request: InputRequest): string {
  return digestHex(utf8.encode(canonicalJson({ declared: request.fields.map((field) => ({ key: field.key, optional: field.optional === true })) })));
}

/** What an earlier module's error says besides its code (key names, an errno name, a fixed phrase), cleaned and capped. Nothing for an error that is not the plugin's own. */
function detailOf(error: unknown): string | undefined {
  return errorDetailOf(error, DETAIL_MAX);
}

function refusal(code: ErrorCode, retryable: boolean, detail?: string): FulfillResult {
  return detail === undefined ? { ok: false, code, retryable } : { ok: false, code, retryable, detail };
}

/** The text the human reads in a request is stored clean, so a record that is saved is a record that loads. */
function cleanRequest(request: InputRequest): InputRequest {
  const fields = request.fields.map(({ label, ...field }) => {
    const text = label === undefined ? "" : sanitizeText(label, LIMITS.label);
    return text === "" ? field : { ...field, label: text };
  });
  return { ...request, reason: sanitizeText(request.reason, LIMITS.reason), fields };
}

/** What `fulfill` takes from the app, checked for type before anything is looked up: the RPC layer is not the only caller. */
function isWellFormed(id: unknown, envelope: unknown): envelope is SealedEnvelope {
  if (typeof id !== "string") return false;
  if (typeof envelope !== "object" || envelope === null) return false;
  const { v, epk, nonce, ct } = envelope as Record<string, unknown>;
  return typeof v === "number" && typeof epk === "string" && typeof nonce === "string" && typeof ct === "string";
}

const copyOf = <T>(value: T): T => structuredClone(value);

export class Registry {
  private readonly records = new Map<string, RequestRecord>();
  private readonly keys = new Map<string, Uint8Array>();
  private queue: Promise<unknown> = Promise.resolve();
  private persistence: "ok" | "failing" = "ok";
  /** The last sweep of `drop/` could not run at all (it was refused before it read the root): nothing is known of what is there. */
  private sweepFailed = false;
  /** Requests whose set could not be removed when it was released: they stay delivered, and are tried again. */
  private readonly stuck = new Set<string>();
  /**
   * What `drop/` still owes: entries that were to go and are still there, by their names in `drop/`, each tried again by
   * itself at the minute tick until it is gone (`settleOwed`), never by a sweep, which would take the sets that are live
   * too. They come from a sweep that could not remove them (`noteSwept`) and from a write whose clean-up could not take
   * away what it staged (`deliver`). The set of a request that was restored delivered and that the start's sweep could
   * not remove names that request (`load`): the restart was to release it, and the request stays delivered until the set
   * is gone. Anything else (a leftover, a stray) names nothing. Memory only: a start sweeps everything anyway.
   */
  private readonly owed = new Map<string, string | null>();
  /** The timer of each delivered set's deadline (`schedule`). Memory only: a restart sweeps every set anyway. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** How far each delivered request is on the way to the end of its turn (`TurnMark`). Memory only, as the timers. */
  private readonly turns = new Map<string, TurnMark>();
  private stored: "ok" | "unreadable" = "ok";
  private dropped = 0;
  /** Set when shutdown begins, or by `stop` ahead of it: nothing new starts. */
  private stopped = false;
  /** Set when the stop's sweep of `drop/` begins: from then on a set that is not there may be the sweep's doing (`takenBy`). */
  private sweeping = false;
  /** Set when shutdown is done: this instance starts no save and notifies nobody from then on. A save that was under way lands (see `shutdown`). */
  private finished = false;
  private ending: Promise<void> | null = null;
  private swept: Promise<void> | null = null;
  /** Requests that left the history and that nobody was told of yet. */
  private readonly left: string[] = [];

  constructor(private readonly deps: RegistryDeps) {}

  /** One operation at a time: this is what makes "first submission wins" true under concurrent calls. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(task);
    this.queue = next;
    return next;
  }

  /**
   * The operation of a tool call, in the queue (`serial`), on the call's terms. It waits for its turn at most
   * `ADMISSION_WAIT_MS`, and no longer than the call does: once the call's signal says it was canceled, it waits no more.
   * A call that stops waiting is refused at once in fixed words (`BUSY`, `CANCELED`), and when the turn comes its
   * operation is skipped: nothing of it happens, then or later (no key, no record, no card, no release). An operation
   * whose turn came while its call still waited has begun, and is waited for to the end, whatever the signal or the clock
   * say from then on: an effect that has begun is never left to run with nobody waiting for its outcome, and that outcome
   * is the call's answer. Without terms an operation is queued as any other.
   */
  private admit<T>(call: CallTerms | undefined, task: () => Promise<T>): Promise<T> {
    if (call === undefined) return this.serial(task);
    const { signal } = call;
    if (signal.aborted) return Promise.reject(new SecureInputError("service_unavailable", CANCELED));
    return new Promise<T>((resolve, reject) => {
      let waiting = true;
      const stopWaiting = (): void => {
        waiting = false;
        clearTimeout(timer);
        signal.removeEventListener("abort", canceled);
      };
      const giveUp = (why: string) => (): void => {
        if (!waiting) return;
        stopWaiting();
        reject(new SecureInputError("service_unavailable", why));
      };
      const canceled = giveUp(CANCELED);
      const timer = setTimeout(giveUp(BUSY), this.deps.admissionWaitMs ?? ADMISSION_WAIT_MS);
      timer.unref();
      signal.addEventListener("abort", canceled, { once: true });
      void this.serial(async () => {
        // The call stopped waiting before the turn came: the operation is not begun.
        if (!waiting) return;
        stopWaiting();
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * For the diagnostics: whether state is being saved, whether everything in `drop/` that was to go went (the last sweep
   * ran, every set that was released went, and nothing is owed), whether `requests.json` could be read at start, and how
   * many of its entries were not loaded.
   */
  health(): { persistence: "ok" | "failing"; drop: "ok" | "failing"; stored: "ok" | "unreadable"; dropped: number } {
    const drop = this.sweepFailed || this.stuck.size > 0 || this.owed.size > 0 ? "failing" : "ok";
    return { persistence: this.persistence, drop, stored: this.stored, dropped: this.dropped };
  }

  /**
   * For the diagnostics: how many requests wait for the human, how many sets are delivered (their files are on the daemon,
   * whether or not one could not be removed), and the nearest deadline among those sets, or null when there is none. Read
   * from memory, like `health`.
   */
  counts(): { pending: number; delivered: number; nextDeleteBy: number | null } {
    let pending = 0;
    let delivered = 0;
    let nextDeleteBy: number | null = null;
    for (const record of this.records.values()) {
      if (record.state === "pending") pending += 1;
      else if (record.state === "delivered") {
        delivered += 1;
        if (record.deleteBy !== null && (nextDeleteBy === null || record.deleteBy < nextDeleteBy)) nextDeleteBy = record.deleteBy;
      }
    }
    return { pending, delivered, nextDeleteBy };
  }

  /**
   * Closed records beyond HISTORY go; an open record never does. The oldest is the one closed longest ago: by creation
   * time, a request that waited while HISTORY newer ones came and went would be dropped by the commit that closes it.
   */
  private trim(): void {
    const closed = [...this.records.values()].filter((record) => !isOpen(record));
    closed.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of closed.slice(0, Math.max(0, closed.length - HISTORY))) this.forget(record.id);
  }

  private forget(id: string): void {
    this.records.delete(id);
    this.left.push(id);
  }

  /** Nothing is kept any more for the lifetime of a request's set: its timer is cleared, and its turn mark goes. */
  private forgetLifetime(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.turns.delete(id);
  }

  /**
   * The deadline of a set that was just written, by a timer of its own, so that the 15 minutes are kept when nothing
   * else happens; the minute tick (`expire`) compares the wall clock with the deadline for a timer that did not fire on
   * time (a machine that slept). When it fires, the set is released as `time` in the queue, if the request is still
   * delivered and shutdown has not begun. Unref'd, so that it keeps no process alive; cleared when the set goes another
   * way, and at shutdown.
   */
  private schedule(id: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.serial(async () => {
        const record = this.records.get(id);
        if (!this.stopped && record?.state === "delivered") await this.releaseSet(record, "time");
      }).catch(() => undefined);
    }, this.deps.dropTtlMs ?? DROP_TTL_MS);
    timer.unref();
    this.timers.set(id, timer);
  }

  /**
   * Tells of the requests that left the history since this was last done. It is done at each change, after the change
   * has been told and not before: a request can leave with the very change that closes it (when the open ones leave
   * no room for it), and whoever keeps something for a request must hear "it changed" and then "it is gone", or
   * would keep it for good.
   */
  private tellForgotten(): void {
    for (const id of this.left.splice(0)) {
      try {
        this.deps.onForget?.(id);
      } catch {
        // What a consumer does with it never changes what happened.
      }
    }
  }

  /** Memory is the truth: a file that cannot be written is remembered (`health`), tried again at the next change, and decides nothing. */
  private async persist(): Promise<void> {
    if (this.finished) return;
    try {
      this.trim();
      const { text, dropped } = encodeRecords([...this.records.values()], this.deps.maxStoredBytes);
      for (const record of dropped) this.forget(record.id);
      if (text === null) {
        // Open records alone do not fit. A file the reader would refuse is not written.
        this.persistence = "failing";
        return;
      }
      await saveStored(join(this.deps.dataDir, REQUESTS_FILE), text);
      this.persistence = "ok";
    } catch {
      this.persistence = "failing";
    }
  }

  private notify(record: RequestRecord, change: RecordChange): void {
    // A save that was under way when shutdown ended comes back here: nobody is told by an instance that is done.
    if (this.finished) return;
    try {
      const result: unknown = this.deps.onChange(copyOf(record), change);
      // An async consumer hands back a promise, and its rejection is no more ours to crash on than a throw.
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
        (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // What a consumer does with a change never changes what happened.
    }
  }

  private async commit(record: RequestRecord, change: RecordChange): Promise<void> {
    record.updatedAt = this.deps.now();
    if (this.finished) return;
    await this.persist();
    this.notify(record, change);
    this.tellForgotten();
  }

  private dropKey(id: string): void {
    this.keys.get(id)?.fill(0);
    this.keys.delete(id);
  }

  private require(id: string): RequestRecord {
    const record = this.records.get(id);
    if (!record) throw new SecureInputError("invalid_request", "unknown request");
    return record;
  }

  /**
   * What a sweep of `drop/` that ran left, by name. What it took away is owed no more, and a request whose set it took is
   * stuck no more. What it left is owed (`owed`), unless it is the set of a delivered request, which that request owes
   * itself (`stuck`, or `owed` under its id): so a leftover the sweep could not remove is tried again at the tick, by
   * itself. The set an owed request names stays owed until its request is released, which the tick does.
   */
  private noteSwept({ left }: SweepResult): void {
    this.sweepFailed = false;
    const still = new Set(left);
    for (const [name, requestId] of [...this.owed]) if (requestId === null && !still.has(name)) this.owed.delete(name);
    for (const id of [...this.stuck]) if (!still.has(setName(id))) this.stuck.delete(id);
    const delivered = new Set([...this.records.values()].filter((record) => record.state === "delivered").map((record) => setName(record.id)));
    for (const name of left) if (!this.owed.has(name) && !delivered.has(name)) this.owed.set(name, null);
  }

  /** Whether the restart owes this request's set: it was restored delivered, and the start's sweep could not remove it (`owed`). */
  private owes(record: RequestRecord): boolean {
    return this.owed.get(setName(record.id)) === record.id;
  }

  /**
   * Removes what a run that was killed left behind: everything in `drop/`. Once per instance, and before anything else
   * of a start but holding the data directory: a set with values in it must not outlive a start that ends in a failure
   * further on, and the sweep needs nothing but the directory. `drop/` is held first, and one that is no private
   * directory of this user fails the start-up, with nothing removed behind it. What the sweep cannot remove is left and
   * reported (`health`), and owed (`noteSwept`): the tick tries each such entry again by itself until it is gone.
   *
   * A registry that is stopped sweeps nothing. A sweep that gets its turn after the stop does not begin, and one that
   * is under way asks again right before each removal (`stillWanted`): the plugin it belongs to is no longer waited for,
   * and what is in `drop/` by then may be the sets of the plugin started after it. So a sweep the stop overtook owes
   * nothing either.
   */
  sweep(): Promise<void> {
    this.swept ??= this.serial(async () => {
      if (this.stopped) return;
      await this.deps.drop.hold();
      const swept = await this.deps.drop.sweep(this.stillWanted);
      if (!this.stopped) this.noteSwept(swept);
    });
    return this.swept;
  }

  /** The question the sweep asks right before each of its effects (`StillWanted`): no, once the registry is stopped. */
  private readonly stillWanted = (): boolean => !this.stopped;

  /**
   * Called once at start. Private keys lived in memory, so nothing open can be completed: a pending request is expired by
   * the restart. Sweeps first, if that was not done yet, so every set of an earlier run is gone: a delivered request is
   * released by the restart. A delivered request whose set the sweep could not remove is the exception: its set is still
   * there, so it stays delivered, in memory and in the file, and the restart owes its set (`owed`); the tick tries the set
   * again until it is gone, and the request is then released by the restart (`settleOwed`). Says whether the requests
   * were loaded: a registry that is stopped by the time it has read them (before the load got its turn, or while it read)
   * keeps nothing of what it read, saves nothing and tells nobody anything, and the answer is `false`. The stored requests
   * are then not known to this instance, and the next start is the one that loads them.
   */
  async load(): Promise<boolean> {
    await this.sweep();
    return this.serial(async () => {
      const state = await readStored(join(this.deps.dataDir, REQUESTS_FILE), this.deps.maxStoredBytes);
      // Asked here, after the one wait before the load's first effect: nothing has changed yet, in memory or on disk.
      if (this.stopped) return false;
      this.stored = state.status;
      this.dropped = state.dropped;
      const now = this.deps.now();
      const changed: RequestRecord[] = [];
      for (const record of state.records) {
        // A time from the future would keep a record in the history for good.
        record.createdAt = Math.min(record.createdAt, now);
        record.updatedAt = Math.min(record.updatedAt, now);
        this.records.set(record.id, record);
        if (record.state === "pending") {
          record.state = "expired";
          record.expiredBy = "restart";
        } else if (record.state === "delivered") {
          // Released only once its set is gone: one the sweep left is owed, and the request is that set's.
          const name = setName(record.id);
          if (this.owed.has(name)) {
            this.owed.set(name, record.id);
            continue;
          }
          record.state = "released";
          record.releasedBy = "restart";
        } else continue;
        record.updatedAt = now;
        changed.push(record);
      }
      // A file that could not be read is left as it is until the first change is saved.
      if (state.status === "ok") await this.persist();
      // Only what the load itself ended is told. A record that was closed when it was saved was told of then, and what
      // is still owed for it waits in the outbox file; told again, every restart would repeat a message.
      for (const record of changed) this.notify(record, "state");
      return true;
    });
  }

  /** A new pending request of `agent`'s. `call`: the terms of the tool call that asks for it (`admit`). */
  create(agent: AgentIdentity, raw: unknown, call?: CallTerms): Promise<{ status: "pending"; requestId: string; next: string }> {
    return this.admit(call, async (): Promise<{ status: "pending"; requestId: string; next: string }> => {
      // A key made now would outlive the shutdown that was meant to wipe every one. Nothing is awaited from here to
      // where the key is held, so a shutdown cannot begin in between.
      if (this.stopped) throw new SecureInputError("service_unavailable", SHUTTING_DOWN);
      const parsed = InputRequestSchema.safeParse(raw);
      if (!parsed.success) {
        // The issues quote the caller's input, invisible characters and all.
        const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`);
        throw new SecureInputError("invalid_request", sanitizeText(issues.join("; "), DETAIL_MAX));
      }
      const existing = [...this.records.values()].find((record) => record.agentId === agent.agentId && record.state === "pending");
      if (existing) throw new SecureInputError("request_already_pending", existing.id);

      const request = cleanRequest(parsed.data);
      const now = this.deps.now();
      const title = typeof agent.title === "string" ? sanitizeText(agent.title, TITLE_MAX) : "";
      // Last, so that nothing which can throw lies between making the private key and holding it.
      const keys = generateRequestKeyPair();
      let record: RequestRecord | null;
      try {
        // What is made here is what the next start will read back: the identity is held to the rules of the stored record.
        record = parseRecord({
          id: `r_${randomBytes(16).toString("hex")}`,
          agentId: agent.agentId,
          agentCwd: agent.cwd,
          agentTitle: title === "" ? null : title,
          request,
          state: "pending",
          publicKey: toBase64Url(keys.publicKey),
          requestDigest: requestDigestOf(request),
          retries: 0,
          tamper: false,
          errorCode: null,
          fulfilledDigest: null,
          written: null,
          deleteBy: null,
          createdAt: now,
          updatedAt: now,
        });
        if (record === null) throw new SecureInputError("invalid_request", "the agent's identity cannot be stored");
        // The view the dialog will be given for this request, built now and held to the dialog's own contract. A
        // request whose view the contract refuses would be pending with a card nobody can open: it could be neither
        // answered nor declined, and would hold the agent's one request until it is cancelled or its time is up. So
        // it is refused here instead, before the request exists.
        const view = RequestViewSchema.safeParse(composeView(record));
        if (!view.success) {
          // The path into the view, never the issue's message: the path is made of the view's own field names.
          const where = sanitizeText((view.error.issues[0]?.path ?? []).map(String).join("."), VIEW_PATH_MAX);
          throw new SecureInputError("invalid_request", where === "" ? NO_VIEW : `${NO_VIEW} (${where})`);
        }
        this.records.set(record.id, record);
        this.keys.set(record.id, keys.secretKey);
      } catch (error) {
        keys.secretKey.fill(0);
        throw error;
      }
      await this.commit(record, "state");
      return { status: "pending", requestId: record.id, next: NEXT };
    });
  }

  /** A copy: what a caller does to it changes nothing here. */
  get(id: string): RequestRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : copyOf(record);
  }

  /**
   * Takes a submission: opens it with the request's key, bound to the request and to what it asked for, reads it,
   * holds it to the request, and writes it as the request's set in `drop/`. The first submission that is delivered
   * wins; the same one sent again is answered as it was, and a different one is tampering. A submission that cannot
   * be opened is counted and may be tried again, up to `MAX_RETRIES`; one that is opened and found wrong, or whose set
   * cannot be written, ends the request.
   */
  fulfill(id: string, envelope: SealedEnvelope): Promise<FulfillResult> {
    if (!isWellFormed(id, envelope)) return Promise.resolve(refusal("invalid_request", false));
    return this.serial(async (): Promise<FulfillResult> => {
      const record = this.records.get(id);
      if (!record) return refusal("invalid_request", false);
      const submission = digestHex(utf8.encode(envelope.ct));

      if (record.state !== "pending") {
        if (record.fulfilledDigest === submission) return { ok: true, state: record.state };
        // Only a second, different submission to a fulfilled request is tampering.
        // A human answering an expired or declined request is just late.
        if (FULFILLED_STATES.has(record.state) && !record.tamper) {
          record.tamper = true;
          await this.commit(record, "tamper");
        }
        return refusal("request_closed", false);
      }

      // The timer is not what decides: a submission to a request past its time expires it.
      if (this.deps.now() - record.createdAt > TTL_MS) {
        await this.closePending(id, "expired");
        return refusal("request_closed", false);
      }
      // After shutdown the request stays as it is: the next start expires it, and that is what the agent is told.
      if (this.stopped) return refusal("request_closed", false);
      const secretKey = this.keys.get(id);
      if (!secretKey) return this.reject(record, "request_closed");
      let plaintext: Uint8Array;
      try {
        plaintext = unseal(secretKey, envelope, buildAad(record.id, record.requestDigest));
      } catch {
        return this.retry(record, "decrypt_failed");
      }
      let entries: PayloadEntry[];
      try {
        entries = decodeValues(plaintext);
      } catch {
        return this.reject(record, "invalid_request");
      } finally {
        plaintext.fill(0);
      }
      return this.deliver(record, entries, submission);
    });
  }

  /**
   * Writes a submission that was opened and read as the request's set, and marks the request delivered. Nothing is
   * saved ahead of the write: a set that was written and not saved is read back as a pending request, which the restart
   * expires, and its set is gone with the sweep of that start. From the write on the set has its deadline, by its own
   * timer (`schedule`); a set whose write took effect after shutdown began gets none, as the stop takes it.
   */
  private async deliver(record: RequestRecord, entries: readonly PayloadEntry[], submission: string): Promise<FulfillResult> {
    let files: DropFile[];
    try {
      files = validateEntries(record.request, entries).written;
    } catch (error) {
      // The detail names keys and nothing else, and it is all the human will hear of why: it goes with the code.
      return this.reject(record, "invalid_request", detailOf(error));
    }
    try {
      await this.deps.drop.write(record.id, files, this.beforeWrite, this.leftBehind);
    } catch (error) {
      // Turned back right before its effect: nothing was written, what was staged is removed by the write's own
      // clean-up, and the request stays as it is, in memory and in the file. The next start expires it.
      if (error instanceof ShutdownBegan) return refusal("request_closed", false);
      return this.reject(record, "write_failed", detailOf(error));
    } finally {
      for (const file of files) file.bytes.fill(0);
    }
    record.fulfilledDigest = submission;
    record.written = files.map((file) => file.key);
    record.deleteBy = this.deps.now() + (this.deps.dropTtlMs ?? DROP_TTL_MS);
    this.dropKey(record.id);
    record.state = "delivered";
    // Before the save, which may stall: the deadline does not wait for the disk.
    if (!this.stopped) this.schedule(record.id);
    // The set is in place. Saving the record is the last thing that happens and cannot undo it.
    await this.commit(record, "state");
    return { ok: true, state: "delivered" };
  }

  /**
   * The registry's last word right before a set takes effect: the store asks it when every file of the set is written
   * under the set's temporary name, right before the rename that puts the set in place (`write`). Once shutdown has
   * begun the answer is no, however late the write gets there: a submission that was opened before shutdown began, and
   * whose write outlasts the bound of `shutdown`, is turned back, and what it staged is removed by the write's own
   * clean-up as after any other failed write. So a set that had not reached its rename when shutdown began never takes
   * effect, also not after `shutdown()` has returned, where a successor's sweep could meet it. A write that is past this
   * when shutdown begins is one rename away from done, and is not undone: the shutdown removes the set, by its releases,
   * which come after this write in the queue, or by its sweep.
   */
  private readonly beforeWrite = (): void => {
    if (this.stopped) throw new ShutdownBegan();
  };

  /**
   * What a write that failed could not take away of what it staged, by its name in `drop/` (`DropStore.write`): owed from
   * here on, so the drop reads failing and the tick tries it again by itself until it is gone (`settleOwed`). It names no
   * request: the request was rejected, and the staging directory is nobody's set.
   */
  private readonly leftBehind = (name: string): void => {
    this.owed.set(name, null);
  };

  private async retry(record: RequestRecord, code: ErrorCode, detail?: string): Promise<FulfillResult> {
    record.retries += 1;
    if (record.retries >= MAX_RETRIES) return this.reject(record, "retry_limit");
    await this.commit(record, "other");
    return refusal(code, true, detail);
  }

  /** Ends the request. `detail` goes to whoever submitted, with the code; the record keeps the code alone. */
  private async reject(record: RequestRecord, code: ErrorCode, detail?: string): Promise<FulfillResult> {
    record.errorCode = code;
    this.dropKey(record.id);
    record.state = "rejected";
    await this.commit(record, "state");
    return refusal(code, false, detail);
  }

  /** A delivered request whose set is gone, released by `by`, with nothing kept for the lifetime of its set any more, and nothing owed for it. Saves nothing. */
  private markReleased(record: RequestRecord, by: ReleasedBy): void {
    this.stuck.delete(record.id);
    if (this.owes(record)) this.owed.delete(setName(record.id));
    this.forgetLifetime(record.id);
    record.state = "released";
    record.releasedBy = by;
  }

  /**
   * Who took a set that was not there when a removal came to it: once the stop's sweep has begun, the sweep may have, and
   * it is the stop's doing; before that, the restart's for a set the restart owes (`owes`: it was to go at the start), and
   * the agent's for any other, since the agent is the one who could have. Read after the removal, which can be under way
   * when the stop begins.
   */
  private takenBy(record: RequestRecord): ReleasedBy {
    if (this.sweeping) return "stop";
    return this.owes(record) ? "restart" : "agent";
  }

  /**
   * Takes a delivered request's set away and marks the request released: by `by`, or, when the set was already gone, by
   * whoever took it (`takenBy`): so a removal that was under way when the stop's sweep began never calls the sweep's
   * removal the agent's. A removal the agent asked for itself (`asked`, `release`) is the agent's release whatever took
   * the set. The store removes a link in place of the set as a link and follows none (`DropStore.release`). A set that
   * cannot be removed is remembered as stuck (`health`), the request stays delivered and the answer is false; what
   * would take the set later is kept: its turn mark, so the end of its agent's next turn tries again, and its timer if
   * it has not fired. Once its deadline has passed, the tick tries again (`expire`).
   */
  private async releaseSet(record: RequestRecord, by: ReleasedBy, asked = false): Promise<boolean> {
    const removal = await this.deps.drop.release(record.id);
    if (removal === "stuck") {
      this.stuck.add(record.id);
      return false;
    }
    this.markReleased(record, removal !== "absent" || asked ? by : this.takenBy(record));
    await this.commit(record, "state");
    return true;
  }

  /**
   * The agent's own release of its delivered set (`release_secret`): released by `agent`, also when the set was gone by
   * the time the removal came to it, the stop's sweep included. The agent asked for the files to go and they went, so a
   * delivery message that still waits has nothing to tell it (`releasedBy` `agent` drops it), whatever took them. A
   * request that is already released, by whatever, is answered as it is and nothing changes, so a release is made once.
   * Another agent's request is answered as one that does not exist; a request that never had files, and one whose files
   * cannot be removed (it stays delivered, and the plugin tries again), are refused in fixed words. A copy is returned.
   * `call`: the terms of the tool call that asks for it (`admit`).
   */
  release(agentId: string, id: string, call?: CallTerms): Promise<RequestRecord> {
    return this.admit(call, async () => {
      const record = this.records.get(id);
      if (record === undefined || record.agentId !== agentId) throw new SecureInputError("invalid_request", UNKNOWN_REQUEST);
      if (record.state === "released") return copyOf(record);
      if (record.state !== "delivered") throw new SecureInputError("invalid_request", NO_FILES);
      if (!(await this.releaseSet(record, "agent", true))) throw new SecureInputError("write_failed", NOT_REMOVED);
      return copyOf(record);
    });
  }

  /**
   * A request as it is now, for the agent that asks about it: a delivered one whose set is gone is released first, as
   * whoever took it (`takenBy`): the agent, who is the one who could have, or the restart for a set it owes. Who may ask is
   * the caller's to decide, before this is called: the look can change the request. Once shutdown has begun nothing is
   * released here, also when it began while the store was looking: the stop takes every set, and a set its sweep took is
   * not the agent's doing. A copy, or nothing for a request this registry does not know. `call`: the terms of the tool
   * call that asks (`admit`).
   */
  check(id: string, call?: CallTerms): Promise<RequestRecord | undefined> {
    return this.admit(call, async () => {
      const record = this.records.get(id);
      if (record === undefined) return undefined;
      if (record.state !== "delivered") return copyOf(record);
      const there = await this.deps.drop.exists(record.id);
      // Asked after the look, which takes time: the stop may have begun before it or meanwhile.
      if (!there && !this.stopped) await this.releaseSet(record, "agent");
      return copyOf(record);
    });
  }

  /**
   * The outbox is handing a request's message to its agent, right before the send: for a delivered request, the next
   * turn of that agent to begin is the one the message starts (`turnStarted`). Marked once; a request that is no longer
   * delivered, and one this registry does not know, are left alone. (A mark made once shutdown has begun takes no set:
   * `turnEnded` releases nothing from then on.)
   */
  messageSent(requestId: string): void {
    const record = this.records.get(requestId);
    if (record?.state !== "delivered" || this.turns.has(requestId)) return;
    this.turns.set(requestId, "sent");
  }

  /**
   * A turn of the agent began. Each of its requests whose message was handed over before this is armed: the end of this
   * turn takes its set. A request whose message is handed over later waits for a turn that begins after that, so a late
   * end of the turn before the message does not take the set early.
   */
  turnStarted(agentId: string): void {
    for (const [id, mark] of this.turns) {
      if (mark === "sent" && this.records.get(id)?.agentId === agentId) this.turns.set(id, "armed");
    }
  }

  /**
   * A turn of the agent ended, with whatever outcome. The requests of that agent that are armed are taken now, as the
   * turn ends, and their sets are released in the queue as `turn` (as whoever took it, `takenBy`, for a set that is gone
   * by then), each that is still delivered. Taken now, and not when the queue comes to it: a request armed while this
   * waits in the queue was armed by a turn that began after this one, and its set is that turn's. A set that is stuck
   * keeps its mark, and the end of the next turn tries again. Once shutdown has begun no further set is released here
   * (the stop takes them); a removal that was already under way then reads a set its sweep took as the stop's.
   */
  turnEnded(agentId: string): Promise<void> {
    const armed = [...this.turns].filter(([id, mark]) => mark === "armed" && this.records.get(id)?.agentId === agentId).map(([id]) => id);
    return this.serial(async () => {
      for (const id of armed) {
        // For each request, as the tick does: the stop can begin while one of them is removed.
        if (this.stopped) return;
        const record = this.records.get(id);
        if (record?.state === "delivered") await this.releaseSet(record, "turn");
      }
    });
  }

  private async closePending(id: string, state: "declined" | "cancelled" | "expired"): Promise<RequestRecord> {
    const record = this.require(id);
    if (record.state !== "pending") throw new SecureInputError("request_closed");
    this.dropKey(id);
    record.state = state;
    // By its time: `load` marks the ones a restart expired.
    if (state === "expired") record.expiredBy = "time";
    await this.commit(record, "state");
    return copyOf(record);
  }

  decline(id: string): Promise<RequestRecord> {
    return this.serial(() => this.closePending(id, "declined"));
  }

  /** Withdraws a pending request of the agent's own. `call`: the terms of the tool call that asks for it (`admit`). */
  cancel(agentId: string, id: string, call?: CallTerms): Promise<RequestRecord> {
    return this.admit(call, async () => {
      if (this.require(id).agentId !== agentId) throw new SecureInputError("request_closed");
      return this.closePending(id, "cancelled");
    });
  }

  /**
   * The minute tick. What `drop/` owes is tried again first, entry by entry (`settleOwed`). A pending request past its
   * time expires. A delivered set goes when the wall clock has reached its deadline (`time`), whether or not its timer
   * fired (a machine that slept fires none on time), and so a set past its deadline that could not be removed before is
   * tried again at every tick. Before its deadline, a set the agent took away itself is noticed (`agent`). A set the
   * restart owes is the owed one's to try, and not tried a second time here. Once shutdown has begun no further set is
   * released here, also when it began while the store was looking: the stop takes them, and a set its sweep took is not
   * the agent's doing. A removal that was under way when the stop began calls a set its sweep took the stop's (`takenBy`).
   */
  expire(): Promise<void> {
    return this.serial(async () => {
      const now = this.deps.now();
      await this.settleOwed();
      for (const record of [...this.records.values()]) {
        if (record.state === "pending" && now - record.createdAt > TTL_MS) await this.closePending(record.id, "expired");
        else if (record.state === "delivered" && !this.stopped && !this.owes(record)) {
          if (record.deleteBy !== null && now >= record.deleteBy) await this.releaseSet(record, "time");
          // Asked again after the look, which takes time: the stop may have begun meanwhile.
          else if (!(await this.deps.drop.exists(record.id)) && !this.stopped) await this.releaseSet(record, "agent");
        }
      }
      // A save that failed is tried again here, not only at the next change.
      if (this.persistence === "failing") await this.persist();
    });
  }

  /**
   * What `drop/` owes, tried again: each entry by itself, by its name (`DropStore.remove`, under the root's guard), and
   * never by a sweep, which would take the live sets of other requests too. An entry that is gone, by this removal or
   * before it, is owed no more. The set of a request the restart owes is released with it, as `restart` (`releaseSet`;
   * the stop's, once its sweep has begun): its request was restored delivered and is released only now that its set is
   * gone. Once shutdown has begun nothing more is tried here: the stop sweeps `drop/`.
   */
  private async settleOwed(): Promise<void> {
    for (const [name, requestId] of [...this.owed]) {
      if (this.stopped) return;
      const record = requestId === null ? undefined : this.records.get(requestId);
      if (record?.state === "delivered") await this.releaseSet(record, "restart");
      else if ((await this.deps.drop.remove(name)) !== "stuck") this.owed.delete(name);
    }
  }

  /**
   * The human's word to delete every set at once (the settings screen). It is done in the queue: a submission whose set is
   * being written is written first and then deleted, and one that comes after is delivered as usual. Every delivered
   * request's set is released as `human` (`releaseSet`: its timer and turn mark go, the request is saved and told of), and
   * then `drop/` is swept of whatever else lies in it: the leftovers of a write that was killed, what was put there.
   *
   * Says how many requests it released and how many entries of `drop/` are still there after the sweep. A set that would
   * not go at first and that the sweep then took is the human's doing as well, and counts as released: the sweep names
   * what it took, and asks before each removal whether the stop has begun, so it took nothing after that. A set that
   * would not go at first and that is gone though the sweep did not take it went some other way, and is released as
   * whoever took it (`takenBy`: the agent, the restart for a set it owes, the stop once its sweep has begun), never as
   * the human. What the sweep left is owed (`noteSwept`) and tried again at the tick. While any entry is still there
   * `health` says the drop is failing, and so it does after a sweep that could not run: that fails the call with the
   * sweep's own refusal, and what was released before stays released.
   *
   * A registry that is stopping refuses it, and so does one that begins to stop on the way: the stop takes the sets, and
   * no sweep is begun here after it, since a sweep that is told to stop counts the entry it stopped at as stuck. A stop
   * that begins while the sweep runs is asked about after it, and again after each look at a set: from then on the stop
   * owns the sets and the account of `drop/`, what this sweep left is not noted, and the call is refused once the sets it
   * found gone are released as whoever took them.
   */
  clearDrop(): Promise<{ released: number; stuck: number }> {
    return this.serial(async () => {
      let released = 0;
      const unremoved: RequestRecord[] = [];
      for (const record of [...this.records.values()]) {
        // Asked before each set, as the tick does: the stop can begin while one of them is removed.
        if (this.stopped) break;
        if (record.state !== "delivered") continue;
        if (await this.releaseSet(record, "human")) released += 1;
        else unremoved.push(record);
      }
      if (this.stopped) throw new SecureInputError("service_unavailable", SHUTTING_DOWN);
      const swept = await this.deps.drop.sweep(this.stillWanted).catch((error: unknown) => {
        this.sweepFailed = true;
        throw error;
      });
      // Asked again after the sweep, which takes time: once the stop has begun, `drop/` is the stop's to account for.
      if (!this.stopped) this.noteSwept(swept);
      const took = new Set(swept.took);
      for (const record of unremoved) {
        if (took.has(setName(record.id))) {
          // The sweep took it, at the human's word, before the stop began: told so (`asked`), since found gone it would
          // be called someone else's.
          if (await this.releaseSet(record, "human", true)) released += 1;
        } else if (!(await this.deps.drop.exists(record.id)) && (await this.releaseSet(record, "human"))) {
          // Gone, though not by the sweep: as whoever took it (`takenBy`), read after the look, when the stop may have begun.
          released += 1;
        }
      }
      if (this.stopped) throw new SecureInputError("service_unavailable", SHUTTING_DOWN);
      return { released, stuck: swept.stuck };
    });
  }

  /**
   * Wipes every key still held, releases every delivered set and sweeps `drop/`. Safe to call again: the work is done once.
   *
   * What cannot wait is done at once, whatever the work queue is doing: nothing new starts, every key is wiped, and every
   * set's timer and turn mark go, so that no set is released by its deadline or by the end of a turn from here on. A
   * submission that has not been opened yet finds no key, and its request stays as it is. A task stuck in the queue would
   * otherwise keep the keys in memory for as long as it is stuck.
   *
   * Then, in the queue and within `SHUTDOWN_BOUND_MS`, every delivered set is released as `stop` (as whoever took it,
   * `takenBy`, when it was gone before: the agent, or the restart for a set it owes), and one save covers them all, and a
   * save that had failed before. Then, whether or not the queue came to that within its bound, `drop/` is swept within
   * `DROP_SWEEP_BOUND_MS`; a sweep that is still under way at that bound removes nothing more (`stillWanted`), since
   * `drop/` may be a successor's by then. The two bounds end well inside the 2 seconds Paseo 0.14 gives the plugin's
   * process to stop (`PASEO_STOP_WINDOW_MS` in `server/paseo/plugin.ts`). So even when a task in the queue never ends, the
   * stop sweeps `drop/` before the process is ended, and the only set that outlives the plugin is one the sweep cannot
   * remove within its half second (a disk that stalls, a set it may not change). The sweep of the next start takes it,
   * and that start's `load` settles its request: released by the restart once the set is gone, owed until then. It is
   * not reported here, since the process ends right after the stop and nothing reads `health` from then on: a delivered
   * set that the sweep left is neither owed nor stuck (`noteSwept`), unless a removal before the sweep, the stop's own
   * or an earlier one, found it stuck.
   *
   * When the queue has not come to the releases by the time the sweep begins, the sweep takes the sets, and from then on
   * a set that is not there may be the sweep's doing, not the agent's (`sweeping`). So the releases of the stop end there.
   * The other ways a set goes (`check`, `expire`, `turnEnded`, the timers) begin no release once shutdown has begun, and
   * the looks among them ask again after the store has looked; a removal of theirs that was already under way when the
   * stop began reads a set that is gone by then through `takenBy`, as the stop's once the sweep has begun. So no request
   * reads `agent` because the stop removed its set, in memory or in the file. Only the agent's own word (`release`) reads
   * `agent` whatever took the set: the agent asked for the files to go. The requests the releases did not reach stay
   * delivered, in memory and in the file, and the next start reads them back as released by the restart.
   *
   * A task that is still running when the bounds pass is not cut off, which would only let it write later with nobody
   * watching. It finds `stopped` before each effect instead: no key is made and no set takes effect (`create`,
   * `beforeWrite`). From the end of the sweep's bound this instance starts no save and tells nobody of a change. A save
   * that was already under way then is not cut off either: it lands, and its change is announced by nobody, neither by
   * this instance nor by the next start, which reads the record back as it was saved (SECURITY.md says so). A set whose
   * rename was already past its last check when shutdown began is not undone: the releases of the stop take it as any
   * other, or the sweep does, and if the save of its request is skipped, the next start reads the request back as open
   * and expires it.
   */
  shutdown(): Promise<void> {
    this.ending ??= this.end();
    return this.ending;
  }

  /**
   * Marks the registry stopped, and does nothing else: the first thing `shutdown` does, for a caller that has
   * something to do between the two. The plugin calls it the moment it stops waiting for its start-up, so that a
   * sweep or a load of that start-up which comes back later finds the mark, however much of the dispose is still to
   * come (`sweep`, `load`). Everything that asks "has shutdown begun" answers yes from here on.
   */
  stop(): void {
    this.stopped = true;
  }

  private async end(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.keys.keys()]) this.dropKey(id);
    for (const id of [...this.timers.keys()]) this.forgetLifetime(id);
    this.turns.clear();

    // Behind the work that is in the queue now, and so behind the saves it makes.
    const queued = this.serial(async () => {
      const released: RequestRecord[] = [];
      for (const record of [...this.records.values()]) {
        // The sweep has begun: what is left is the sweep's to take.
        if (this.sweeping) break;
        if (record.state !== "delivered") continue;
        const removal = await this.deps.drop.release(record.id);
        if (removal === "stuck") {
          this.stuck.add(record.id);
          continue;
        }
        // Not there: the agent took it before the stop came to it (the restart, for a set it owes), unless the sweep began
        // meanwhile, which takes sets too.
        this.markReleased(record, removal === "absent" ? this.takenBy(record) : "stop");
        record.updatedAt = this.deps.now();
        released.push(record);
      }
      // One save for every set the stop released, and for a save that had failed before; then whoever is told hears of
      // each, as after any change (`commit`). An instance that is done saves nothing and tells nobody.
      if (this.finished) return;
      if (released.length > 0 || this.persistence === "failing") await this.persist();
      for (const record of released) this.notify(record, "state");
      this.tellForgotten();
    });
    // Nothing in it rejects; if something ever did, shutdown would still go on.
    await raceDeadline(this.deps.shutdownBoundMs ?? SHUTDOWN_BOUND_MS, undefined, () => queued.catch(() => undefined));

    this.sweeping = true;
    let sweepOver = false;
    const swept = this.deps.drop.sweep(() => !sweepOver).then(
      (result) => this.noteSwept(result),
      () => {
        this.sweepFailed = true;
      },
    );
    await raceDeadline(DROP_SWEEP_BOUND_MS, undefined, () => swept);
    sweepOver = true;
    this.finished = true;
  }
}
