import { z } from "zod";
import { SecureInputError } from "../../shared/errors";
import { STORED_AGENT_ID_MAX } from "../../shared/limits";
import { REQUEST_ID_PATTERN } from "../../shared/request-id";
import { shown } from "../../shared/shown";
import { writePrivateFile } from "../io/atomic";
import { raceDeadline } from "../io/deadline";
import { privateFileRefusal, readPrivateFile } from "../io/private-file";

export interface AgentPort {
  isIdle(agentId: string): Promise<boolean>;
  send(agentId: string, text: string): Promise<void>;
}

/** The most items the file holds. When it is full the oldest go: the newest message is the one an agent is waiting for. */
export const MAX_OUTBOX_ITEMS = 256;

/**
 * The most of `outbox.json` that is read. An item is under a kilobyte (a 256 character agent id of three-byte
 * characters, an id, a kind and a time), so a full honest file is under half of this, and a larger one was not written
 * by this module. It also bounds the work done before the items are checked: the entries of a file this size can only
 * be so many.
 */
export const MAX_OUTBOX_BYTES = 512 * 1024;

/**
 * How long an item may wait for an idle agent, measured from the moment it was enqueued, not from the creation of the
 * request. A request stays open for eight hours at most and its message is enqueued when it ends; that message must
 * outlive the longest turn an agent may be busy with by then, so a day (three request lifetimes) covers an overnight
 * run, and an item that was abandoned (an agent that never became idle, a planted one) cannot stay in the file for ever.
 */
export const MAX_OUTBOX_AGE_MS = 24 * 60 * 60 * 1000;

/** A time stamped this far ahead of the clock is taken for a clock that was set back a little. A year 3000 is not. */
export const OUTBOX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * How long the outbox waits for the agent port, per call. A call to the daemon answers in well under a second, a slow
 * one (a loaded machine, an agent being resumed) in a few; half a minute is long enough not to mistake those for a
 * dead port and short enough that a port that has stopped answering costs a flush that long and not for ever.
 */
export const PORT_TIMEOUT_MS = 30 * 1000;

/**
 * How long one flush may take in all, however many agents have something waiting. One agent whose port does not
 * answer costs `PORT_TIMEOUT_MS` of it, and the quarter of a minute beyond that is for the agents after it in the same
 * flush, so one silent agent never uses up a flush alone. It is also less than the minute between two ticks of the
 * plugin's timer, so a flush that used all of it has ended before the next one is asked for. A call that the end of
 * the budget cuts short is given up on like one that reached its own bound, and a call that starts after it is given
 * `PORT_FLOOR_MS`.
 */
export const FLUSH_BUDGET_MS = 45 * 1000;

/**
 * What a call to the port is given when it starts with the budget of its flush already used up: the least any call
 * gets. Before that a call has its own bound or what is left of the budget, whichever is less (the end of the budget
 * cuts it short). The two calls that can still start after the budget ended are the idle check and the send of the
 * agent whose turn it was: a send must be attempted once its item is out of the file. A daemon that answers at all
 * answers within this.
 */
export const PORT_FLOOR_MS = 1_000;

/**
 * Where a message goes and which of the two fixed messages it is. The file holds exactly this and the time it was
 * enqueued, never the words: it is writable by the agent, so the words are rebuilt from the plugin's own record when
 * the message is sent.
 *
 * The identity of an item is derived from these fields and is not a field of its own: `<kind>:<request id>:<agent id>`
 * (a kind and a request id contain no colon, so the form is unambiguous). Two items are the same message when their
 * identities are equal; an item for another agent is another message and cannot shadow the genuine one.
 */
export interface OutboxItem {
  agentId: string;
  requestId: string;
  kind: "continuation" | "tamper";
}

export interface ResolvedMessage {
  /** The agent the record belongs to. The outbox sends only when it is the item's agent. */
  agentId: string;
  text: string;
}

/**
 * Builds a message from the plugin's own records at the moment it is sent. It must look the record up by
 * `item.requestId` and return `{ agentId: record.agentId, text: messageFor(record, item.kind) }`, or `null` when there
 * is no such record or `messageFor` has nothing to say. The outbox drops an item whose resolved agent is not the
 * item's agent, so a message can only go to the agent whose request it is about; the resolver is never given, and never
 * returns, text that came from the file.
 */
export type MessageResolver = (item: OutboxItem) => ResolvedMessage | null;

export interface OutboxOptions {
  /** The clock, in milliseconds. */
  now?: () => number;
  /** How long a call to the port may take before it is given up on; `PORT_TIMEOUT_MS` unless a test wants less. */
  portTimeoutMs?: number;
  /** How long one flush may take in all; `FLUSH_BUDGET_MS` unless a test wants less. */
  flushBudgetMs?: number;
  /**
   * Told of an item it is handing over, right before the send of its message is attempted and after the item is out of
   * the file: once per item, as the send is. It is given the three fields of the item. What it does, throws or rejects
   * with changes nothing here: the send is attempted all the same.
   */
  onSend?(item: OutboxItem): void;
}

const ItemSchema = z
  .object({
    agentId: shown(STORED_AGENT_ID_MAX, 1),
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    kind: z.enum(["continuation", "tamper"]),
  })
  .strict();

/** `z.number()` refuses NaN and the infinities, which JSON can still carry as `1e999`. */
const StoredSchema = ItemSchema.extend({ enqueuedAt: z.number().min(0) }).strict();

type Stored = z.output<typeof StoredSchema>;

const identityOf = (item: OutboxItem): string => `${item.kind}:${item.requestId}:${item.agentId}`;

/**
 * Whether the reader refused the file for what it is: a link, a pipe or a directory, a file over the cap, bytes that
 * are not UTF-8 (the reader's own tokens say which). Such a file is not one this module wrote and may be replaced. Any
 * other rejection (EMFILE, EIO, EACCES, ...) means the file could not be read just now, which says nothing about what
 * it holds; it is not replaced.
 */
const isNotOurFile = (error: unknown): boolean => privateFileRefusal(error) !== null;

const UNSETTLED = Symbol("unsettled");

/** Which agents a flush is for: the ones named, in the order they were named, and then, when `all`, everyone else who has something waiting. */
interface Scope {
  all: boolean;
  agents: string[];
}

/**
 * What an operation works with. `status` says what became of the file: `ok` (read, or not there), `replace` (it is not a
 * file this module wrote, so the next write may replace it) or `unreadable` (it could not be read just now, so it is not
 * written to and what is not on it is kept in memory). `onDisk` are the valid items of the file; `all` also holds the
 * items kept in memory, newest `MAX_OUTBOX_ITEMS` at most; `dropped` counts what reading left out.
 */
interface Loaded {
  status: "ok" | "replace" | "unreadable";
  onDisk: Stored[];
  all: Stored[];
  dropped: number;
}

/**
 * Delivers each message at most once, and only to an agent that says it is idle: a send to a busy agent would
 * interrupt its turn. An item leaves the file (or, when it never reached the file, memory) before the send is
 * attempted, so a crash or an unknown send outcome can lose a message but can never repeat one. Only the answer
 * "idle" allows a send: an idle check that fails, or is not answered in time, is no answer, and the item stays for a
 * later flush (until it is too old, `MAX_OUTBOX_AGE_MS`). Whoever asked to know (`onSend`) is told of each item in
 * between: out of the file, right before its send is attempted.
 *
 * `outbox.json` is a file the agent can write, so it is read as hostile input (`readPrivateFile`, then a strict schema,
 * item by item) and it holds references, not text: the words come from the resolver, which rebuilds them from the
 * plugin's own record and names the agent they are for. A planted item can at most make the plugin repeat a message
 * of its own to the agent its record names (a record that was itself planted in `requests.json` is such a record
 * too, and fills that message with its names: SECURITY.md).
 *
 * Memory is the truth: an item whose save failed (or that was enqueued while the file could not be read) stays in
 * memory, is delivered in this process like any other, and is written at the next save that works. A restart forgets
 * what was never saved; that is the accepted loss.
 *
 * What a flush costs. The port is called for one agent after another. A call has `PORT_TIMEOUT_MS`, or what is left
 * of the flush's budget (`FLUSH_BUDGET_MS`) when that is less: the end of the budget cuts short the call that is under
 * way, and no further agent is begun. What can still start after it are the calls of the agent whose turn it was, an
 * idle check and a send at most, and each of those is given `PORT_FLOOR_MS`. So the calls of a flush take
 * `FLUSH_BUDGET_MS` and twice `PORT_FLOOR_MS` at the very most, however many agents are waiting and whatever their
 * ports do; the reads and writes of the plugin's own file come on top. An agent that answers costs milliseconds. One
 * whose port has stopped answering costs up to half a minute for the idle check, and as much again for a send that
 * does not return, so a flush reaches one or two such agents and then ends. The next flush for everyone starts with
 * the agent after the last one that had its whole turn: an agent whose turn the end of the budget cut short was not
 * served, and the rotation does not pass it, so it is the first of the next flush (or the first of those that gave
 * no answer). An agent behind silent ones is thus reached on a later flush instead of never: behind n silent agents,
 * within n such flushes (the plugin's tick asks for one a minute). A flush for one agent (its turn ended, its
 * request ended) does not wait its turn in that rotation.
 * And an agent whose last idle check got no answer is served after the others in every flush until one is answered,
 * so that an agent that has gone silent holds an agent that answers back once, and not at every flush.
 *
 * There is one flush at a time. A flush asked for while one is under way makes that one be followed by exactly one
 * more, which serves the agents that were named meanwhile first; it never starts a second chain. The file is not held
 * during a call to the port: saving a new item waits for other reads and writes of the file, never for an agent.
 *
 * After `stop` nothing more is asked of the port: no idle check starts, no item is taken out of the file, and a call
 * that is under way is no longer waited for. An idle check given up on this way leaves its item in the file. A send
 * given up on this way is an unknown outcome, like any other: its item was already out and is not sent again. The
 * one call that can still start is the send of an item that was being taken out of the file at the very moment of
 * the stop: taking an item out and sending it are one step, or the item would be lost without an attempt.
 */
export class Outbox {
  private port: AgentPort | null = null;
  /** The reads and writes of the file, one at a time. Never held across a call to the port. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Identities handed over by this process, by request: a copy of one that reappears in the file (planted, or put there
   * again) is not sent a second time. Not persisted: a restart relies on the file, from which an item is gone before its
   * send. An entry goes when its request leaves the registry's history (`retire`), after which the resolver has
   * nothing to say for it anyway; so this holds at most two identities for each request the registry still knows.
   */
  private readonly delivered = new Map<string, Set<string>>();
  /** Items not known to be on disk. */
  private held: Stored[] = [];
  private persistence: "ok" | "failing" = "ok";
  private dropped = 0;
  /** The flush under way, and the one that follows it when somebody asked meanwhile. */
  private inFlight: Promise<void> | null = null;
  private next: { scope: Scope; promise: Promise<void>; run(flush: Promise<void>): void } | null = null;
  /** The last agent a flush for everyone served to the end of its turn: the next one starts after it. */
  private servedLast: string | null = null;
  /** The budget of the flush under way is used up. There is one flush at a time. */
  private spent = false;
  /** The agents whose last idle check got no answer. Only agents with something waiting are kept. */
  private readonly unanswered = new Set<string>();
  /** Gives up on the call to the port that is under way. There is at most one. */
  private abandon: (() => void) | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly portTimeoutMs: number;
  private readonly flushBudgetMs: number;
  private readonly onSend: ((item: OutboxItem) => void) | undefined;

  constructor(
    private readonly file: string,
    private readonly resolver: MessageResolver,
    options: OutboxOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.portTimeoutMs = options.portTimeoutMs ?? PORT_TIMEOUT_MS;
    this.flushBudgetMs = options.flushBudgetMs ?? FLUSH_BUDGET_MS;
    this.onSend = options.onSend;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(task);
    this.queue = next;
    return next;
  }

  private isCurrent(item: Stored, now: number): boolean {
    return now - item.enqueuedAt <= MAX_OUTBOX_AGE_MS && item.enqueuedAt - now <= OUTBOX_CLOCK_SKEW_MS;
  }

  /**
   * The valid items of the file, oldest first, one per identity; whatever else it holds is counted in `dropped`. The
   * whole array is checked (its length is bounded by the size cap), and only then are the newest items kept, so
   * padding after a genuine item cannot push it out of the window.
   */
  private async readFile(): Promise<{ status: Loaded["status"]; items: Stored[]; dropped: number }> {
    let text: string | null;
    try {
      text = await readPrivateFile(this.file, MAX_OUTBOX_BYTES);
    } catch (error) {
      return isNotOurFile(error) ? { status: "replace", items: [], dropped: 1 } : { status: "unreadable", items: [], dropped: 0 };
    }
    if (text === null) return { status: "ok", items: [], dropped: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "replace", items: [], dropped: 1 };
    }
    if (!Array.isArray(parsed)) return { status: "replace", items: [], dropped: 1 };
    const now = this.now();
    const seen = new Set<string>();
    const items: Stored[] = [];
    for (const candidate of parsed) {
      const result = StoredSchema.safeParse(candidate);
      if (!result.success || !this.isCurrent(result.data, now) || seen.has(identityOf(result.data))) continue;
      seen.add(identityOf(result.data));
      items.push(result.data);
    }
    return { status: "ok", items, dropped: parsed.length - items.length };
  }

  private async load(): Promise<Loaded> {
    const file = await this.readFile();
    const now = this.now();
    this.held = this.held.filter((item) => this.isCurrent(item, now));
    const known = new Set(file.items.map(identityOf));
    const merged = [...file.items, ...this.held.filter((item) => !known.has(identityOf(item)))];
    const all = merged.slice(-MAX_OUTBOX_ITEMS);
    return { status: file.status, onDisk: file.items, all, dropped: file.dropped + merged.length - all.length };
  }

  /**
   * Writes `all` over the file, unless the file could not be read (then it holds things this module cannot see). When
   * nothing was written, whatever is not on disk stays in memory and `health()` says so.
   */
  private async commit(loaded: Loaded, all: Stored[]): Promise<boolean> {
    const kept = all.slice(-MAX_OUTBOX_ITEMS);
    if (loaded.status !== "unreadable") {
      try {
        await writePrivateFile(this.file, JSON.stringify(kept));
        this.held = [];
        this.persistence = "ok";
        this.dropped += loaded.dropped + all.length - kept.length;
        return true;
      } catch {
        // Kept below.
      }
    }
    this.persistence = "failing";
    const onDisk = new Set(loaded.onDisk.map(identityOf));
    this.held = kept.filter((item) => !onDisk.has(identityOf(item)));
    return false;
  }

  /**
   * Takes an item out, so that it cannot be sent twice, and says whether it did. One that is on disk must leave the
   * file: false when that cannot be done. One that only ever lived in memory just leaves memory. One that is no longer
   * there (dropped with its agent, too old by now) was not taken out by this call: false, so nothing is sent for it.
   */
  private async remove(item: OutboxItem): Promise<boolean> {
    const id = identityOf(item);
    const loaded = await this.load();
    if (!loaded.all.some((other) => identityOf(other) === id)) return false;
    const memoryOnly = !loaded.onDisk.some((other) => identityOf(other) === id);
    const written = await this.commit(
      loaded,
      loaded.all.filter((other) => identityOf(other) !== id),
    );
    return written || memoryOnly;
  }

  private wasDelivered(item: OutboxItem): boolean {
    return this.delivered.get(item.requestId)?.has(identityOf(item)) === true;
  }

  /**
   * Whether saving works, how many items are only in memory, and how many entries reading and writing left out of the
   * file (invalid, aged, repeated, over the limit; a file that is no file of ours counts as one), for the diagnostics.
   */
  health(): { persistence: "ok" | "failing"; unsaved: number; dropped: number } {
    return { persistence: this.persistence, unsaved: this.held.length, dropped: this.dropped };
  }

  attach(port: AgentPort): void {
    this.port = port;
  }

  pending(): Promise<number> {
    return this.serial(async () => (await this.load()).all.length);
  }

  /**
   * Rejects with `invalid_request` for an item the file could not hold (a mistake of the caller, not of the file). A file
   * that cannot be written does not reject: the item stays in memory and `health()` reports it.
   */
  enqueue(item: OutboxItem): Promise<void> {
    return this.serial(async () => {
      const parsed = ItemSchema.safeParse(item);
      if (!parsed.success) throw new SecureInputError("invalid_request", "outbox item");
      const id = identityOf(parsed.data);
      const loaded = await this.load();
      if (this.wasDelivered(parsed.data) || loaded.all.some((existing) => identityOf(existing) === id)) return;
      await this.commit(loaded, [...loaded.all, { ...parsed.data, enqueuedAt: this.now() }]);
    });
  }

  /**
   * Drops everything that waits for an agent, unsent. For an agent that is gone for good (archived): its messages
   * could only wait out their day in the file.
   */
  drop(agentId: string): Promise<void> {
    return this.serial(async () => {
      const loaded = await this.load();
      if (!loaded.all.some((item) => item.agentId === agentId)) return;
      await this.commit(
        loaded,
        loaded.all.filter((item) => item.agentId !== agentId),
      );
    });
  }

  /** Forgets what was handed over for a request that left the registry's history: the resolver has nothing to say for it any more. */
  retire(requestId: string): void {
    this.delivered.delete(requestId);
  }

  /**
   * From now on nothing is asked of the port, and a call under way is no longer waited for. The file still takes new
   * items, and a flush still writes what was held in memory; it serves nobody.
   */
  stop(): void {
    this.stopped = true;
    this.abandon?.();
  }

  /** Tells `onSend` of an item that is being handed over. Never throws, and leaves no rejection of an async one unhandled. */
  private tellSent(item: OutboxItem): void {
    try {
      const result: unknown = this.onSend?.({ agentId: item.agentId, requestId: item.requestId, kind: item.kind });
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") (result as PromiseLike<unknown>).then(undefined, () => undefined);
    } catch {
      // What whoever is told does with it never changes whether the message is sent.
    }
  }

  /** The text for an item, or null: no record, nothing to say, another agent's record, or a resolver that fails. */
  private text(item: OutboxItem): string | null {
    try {
      const resolved = this.resolver({ agentId: item.agentId, requestId: item.requestId, kind: item.kind });
      return resolved !== null && resolved.agentId === item.agentId ? resolved.text : null;
    } catch {
      return null;
    }
  }

  /**
   * What the call to the port returns; `UNSETTLED` when its bound, the end of the flush's budget or a stop comes
   * first; its own error if it fails first. A result or an error that comes later is ignored. The bound is the
   * port's own, and for a call that starts with the budget already used up, the floor.
   */
  private async ask<T>(call: () => Promise<T>): Promise<T | typeof UNSETTLED> {
    try {
      return await raceDeadline(this.spent ? PORT_FLOOR_MS : this.portTimeoutMs, UNSETTLED, call, (abandon) => {
        this.abandon = abandon;
      });
    } finally {
      this.abandon = null;
    }
  }

  /**
   * Delivers what can be delivered now: to one agent, or to everyone who has something waiting. Resolves when a flush
   * that began after the call has ended. While one is under way the call does not start another: it marks that one
   * more is wanted, and every call made meanwhile is answered by that one.
   */
  flush(agentId?: string): Promise<void> {
    if (this.inFlight === null) return this.begin({ all: agentId === undefined, agents: agentId === undefined ? [] : [agentId] });
    if (this.next === null) {
      let run!: (flush: Promise<void>) => void;
      const promise = new Promise<void>((resolve) => {
        run = resolve;
      });
      this.next = { scope: { all: false, agents: [] }, promise, run };
    }
    if (agentId === undefined) this.next.scope.all = true;
    else if (!this.next.scope.agents.includes(agentId)) this.next.scope.agents.push(agentId);
    return this.next.promise;
  }

  private begin(scope: Scope): Promise<void> {
    const flush = this.pass(scope).finally(() => {
      this.inFlight = null;
      const next = this.next;
      this.next = null;
      if (next !== null) next.run(this.begin(next.scope));
    });
    this.inFlight = flush;
    return flush;
  }

  /** The agents of a flush for everyone, starting after the one the last such flush ended with. */
  private inRotation(agents: string[]): string[] {
    const last = this.servedLast === null ? -1 : agents.indexOf(this.servedLast);
    return [...agents.slice(last + 1), ...agents.slice(0, last + 1)];
  }

  private async pass(scope: Scope): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.spent = false;
    const budget = setTimeout(() => {
      this.spent = true;
      this.abandon?.();
    }, this.flushBudgetMs);
    try {
      const items = await this.serial(async () => {
        const loaded = await this.load();
        // What an earlier failure left in memory gets its chance to be written, whether or not anything is sent now.
        if (this.held.length > 0) await this.commit(loaded, loaded.all);
        return loaded.all;
      });
      const waiting = [...new Set(items.map((item) => item.agentId))];
      for (const agentId of this.unanswered) if (!waiting.includes(agentId)) this.unanswered.delete(agentId);
      const named = scope.agents.filter((agentId) => waiting.includes(agentId));
      const others = scope.all ? this.inRotation(waiting.filter((agentId) => !named.includes(agentId))) : [];
      const order = [...named, ...others];
      // Those that did not answer last time come after those that did, each group in the order it had.
      const turns = [...order.filter((agentId) => !this.unanswered.has(agentId)), ...order.filter((agentId) => this.unanswered.has(agentId))];
      for (const agentId of turns) {
        if (this.spent) return;
        await this.serve(
          port,
          items.filter((item) => item.agentId === agentId),
        );
        // An agent whose turn the end of the budget cut short was not served: the rotation stays before it, or with
        // two agents waiting the order of every flush would be the same and the second would never have its turn.
        if (!named.includes(agentId) && !this.spent) this.servedLast = agentId;
      }
    } finally {
      clearTimeout(budget);
      this.spent = false;
    }
  }

  /**
   * One agent's turn in a flush: its oldest item that has something to say, if the agent says it is idle. One message
   * at most. This is where a stop takes effect: before each item is looked at, and once more before one is taken out.
   */
  private async serve(port: AgentPort, items: Stored[]): Promise<void> {
    for (const item of items) {
      if (this.stopped) return;
      // An identity this process already handed over is never handed over again, wherever the file got it from.
      if (this.wasDelivered(item) || this.text(item) === null) {
        // Nothing to say, so the agent's turn is not used up. If the item cannot be taken out it stays and is met again.
        await this.serial(() => this.remove(item));
        continue;
      }
      let idle = false;
      try {
        // No answer in time is no answer either: the item stays for a later flush.
        const answer = await this.ask(() => port.isIdle(item.agentId));
        if (answer === UNSETTLED) this.unanswered.add(item.agentId);
        else this.unanswered.delete(item.agentId);
        idle = answer === true;
      } catch {
        // A check that failed says nothing about the agent: a daemon that could not answer just now would otherwise
        // have a busy agent interrupted, or, if the send failed with it, the message lost before it could be sent.
        // An agent that is really gone is dropped when it is archived (`drop`) or when its item is too old.
      }
      if (!idle) return;
      const text = await this.serial(async () => {
        // The agent said it is idle, and the plugin was stopped before the item's turn at the file came: it stays.
        if (this.stopped) return null;
        // Out first. If that cannot be done nothing is sent: the item stays for the next flush.
        if (!(await this.remove(item))) return null;
        // The words as the record has them now: the idle check took time. The mark is set in the same breath, while
        // the record is known to be there, so `retire` always finds it when the record goes.
        const words = this.text(item);
        if (words === null) return null;
        const marks = this.delivered.get(item.requestId) ?? new Set<string>();
        this.delivered.set(item.requestId, marks.add(identityOf(item)));
        return words;
      });
      if (text === null) return;
      // Out of the file, and about to be sent: whoever asked to know is told now, before the agent can act on it.
      this.tellSent(item);
      try {
        await this.ask(() => port.send(item.agentId, text));
      } catch {
        // The send failed. Whether the agent got the message is not known, and it is not sent again.
      }
      // No answer in time is an unknown outcome: the item is already out, and is not sent again either.
      return;
    }
  }
}
