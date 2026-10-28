import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { CARD_KIND, CARD_VERSION, cardData } from "../../shared/card";
import { SecureInputError } from "../../shared/errors";
import { announces } from "../core/continuation";
import type { AgentPort, Outbox, OutboxItem } from "../core/outbox";
import type { RecordChange, RequestRecord } from "../core/registry";
import { raceDeadline } from "../io/deadline";
import { TIMED_OUT, within } from "./bounded";

type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
/** What the daemon takes for a timeline row. */
export type TimelineItem = Parameters<AgentHandle["timeline"]["append"]>[0];

/**
 * How long a call into the daemon API may take when a card waits for it. The daemon answers these in a few
 * milliseconds, a slow one (an agent being resumed, a loaded machine) in a second or two. Five seconds does not give
 * up on those, and a daemon that has stopped answering costs a card those five seconds, and not the plugin its life.
 */
export const DAEMON_CALL_TIMEOUT_MS = 5_000;

/**
 * How long `settled` waits, once the runtime was stopped, for what is still under way: the saves of messages that
 * were just enqueued, and the unwinding of a flush and of a card that were given up on. Those are a handful of small
 * writes to the plugin's own directory, a few milliseconds; the bound is for a disk that stalls. It is the last wait of
 * the plugin's stop, after the registry's, and the whole stop has to end before Paseo ends the process
 * (`PASEO_STOP_WINDOW_MS` in `server/paseo/plugin.ts`): what is still unsaved when the bound passes stays for this
 * process to save while it lives, and is lost with it otherwise, as any message that was never saved.
 */
export const SETTLE_BOUND_MS = 300;

/**
 * How many appends for one request may be out (given up on at the bound, and not answered since) while its card is
 * still tried at every chance: on each tick and whenever the daemon calls in. With this many out the card is tried
 * more slowly (`SLOW_RETRY_TICKS`), and never given up: a daemon that takes calls and does not answer them is not
 * handed one more every minute, and a daemon that left three unanswered and then recovers still gets the card.
 */
export const MAX_UNSETTLED_APPENDS = 3;

/**
 * While `MAX_UNSETTLED_APPENDS` appends of a request are out, its card is tried once in this many ticks of the plugin
 * (`flushAll`, once a minute), and at no other occasion. Five minutes is what a human who was asked for a value can
 * still wait for a card, and twelve calls an hour is what a daemon that answers none of them is handed at most.
 */
export const SLOW_RETRY_TICKS = 5;

const NOT_ATTACHED = "the plugin is not attached to the daemon yet; retry in a few seconds";

/** The agent, as far as the plugin uses it. The daemon's own handle satisfies this. */
export interface DaemonAgent {
  readonly status: string | null;
  refresh(): Promise<unknown>;
  send(text: string): Promise<void>;
  readonly timeline: { append(item: TimelineItem): Promise<unknown> };
}

/**
 * The part of the daemon API the plugin calls. `PaseoApi` is the client package's type, which plugins do not import;
 * it is reached through the SDK's handler context, and a handler passes that context here, so the compiler checks
 * the real API against this port at every place it is handed over. A test fakes exactly this.
 */
export interface DaemonPort {
  readonly agents: { ref(agentId: string): DaemonAgent };
}

export interface RuntimeOptions {
  /** `DAEMON_CALL_TIMEOUT_MS` unless a test wants less. */
  callTimeoutMs?: number;
  /** Told a code (never a message) when something the runtime does not stop for goes wrong. */
  report?(code: string): void;
}

/**
 * A card the timeline may not show yet. `record` is the latest state of the request, the only one kept; `owed` says
 * that no append of that state is known to have landed; `unsettled` counts the appends that were given up on and
 * have not come back; `triedAt` is the tick during which the last append was made; `failing` says a failure was
 * already reported for this state, so it is reported once.
 */
interface Card {
  record: RequestRecord;
  owed: boolean;
  unsettled: number;
  triedAt: number;
  failing: boolean;
}

/**
 * Holds the daemon API. Paseo creates it before the plugin loads but only hands it to hooks and RPC handlers, so
 * the plugin captures it on first use and defers anything that needs it until then.
 *
 * Cards. The card on the timeline is the only way the human reaches the form, so a card stays owed until an append
 * of it is known to have landed: one that failed, or was not answered within the bound, is tried again on the
 * plugin's tick and whenever the daemon next calls in, and once `MAX_UNSETTLED_APPENDS` unanswered appends are out
 * for it, on every `SLOW_RETRY_TICKS`-th tick; it is never given up. Only the latest state of a request is kept, so
 * a request that closed while its first card was owed gets the closed card and no other. The order of two states on the timeline
 * is best effort, not a guarantee: an append that was given up on is not cancelled and can still land, after a
 * newer one. When it does, the latest state is appended again after it, so the older state does not stay the last
 * row. What is kept is one entry for a request with a card owed or an append still out, and it goes when the
 * registry forgets the request.
 *
 * Messages. A message is saved in the outbox the moment its request changes, and saving waits for no agent. What
 * waits is sent by the outbox's flush, of which there is one at a time (`Outbox`). No flush runs before the registry
 * has loaded (`holdMessages`): until then the outbox could not tell a request that is not loaded yet from one that
 * does not exist, and would drop what waited across a restart.
 *
 * After `stop` nothing more is asked of the daemon for cards or messages, and `settled` returns within
 * `SETTLE_BOUND_MS`. A message enqueued after that is still saved, for the next start to send.
 */
export class Runtime implements AgentPort {
  private paseo: DaemonPort | null = null;
  private readonly cards = new Map<string, Card>();
  /** A drain of the cards is under way, and another was asked for meanwhile. */
  private draining = false;
  private drainAgain = false;
  /** Gives up on the append that is under way. There is at most one. */
  private abandonAppend: (() => void) | null = null;
  /** Flushes are held back until the registry has loaded; one was asked for meanwhile. */
  private holding = false;
  private flushWanted = false;
  /** Everything under way, for `settled`. */
  private readonly work = new Set<Promise<unknown>>();
  private stopped = false;
  /** How many ticks there were (`flushAll`): what a card with many appends out is paced by. */
  private ticks = 0;
  private readonly callTimeoutMs: number;
  private readonly report: (code: string) => void;

  constructor(
    private readonly outbox: Pick<Outbox, "attach" | "enqueue" | "flush" | "drop" | "retire" | "stop">,
    options: RuntimeOptions = {},
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? DAEMON_CALL_TIMEOUT_MS;
    this.report = options.report ?? (() => undefined);
  }

  get attached(): boolean {
    return this.paseo !== null;
  }

  /** Every hook, event and RPC calls this first. A daemon API that is new is taken; one that is known only gives the owed cards another try. */
  attach(paseo: DaemonPort): void {
    if (this.paseo !== paseo) {
      this.paseo = paseo;
      this.outbox.attach(this);
      this.flush().catch(() => this.report("outbox_flush_failed"));
    }
    this.drainCards();
  }

  private track(task: Promise<unknown>): void {
    const tracked: Promise<unknown> = task.catch(() => undefined).finally(() => this.work.delete(tracked));
    this.work.add(tracked);
  }

  /**
   * Resolves when everything that was asked for so far has ended: the cards that could be appended, the messages
   * saved, the flushes. After `stop` that is soon, because nothing is waited for from the daemon any more, and it is
   * never longer than `SETTLE_BOUND_MS`.
   */
  async settled(): Promise<void> {
    const quiet = async (): Promise<void> => {
      while (this.work.size > 0) await Promise.all([...this.work]);
    };
    if (this.stopped) await within(SETTLE_BOUND_MS, quiet);
    else await quiet();
  }

  /**
   * From now on no card is appended and no agent is asked or sent anything; what is under way is given up on. An idle
   * check given up on leaves its message in the file, a send given up on is an unknown outcome and is not repeated,
   * and a card that was owed is still owed when the process ends (the dialog shows the request's true state).
   */
  stop(): void {
    this.stopped = true;
    this.outbox.stop();
    this.abandonAppend?.();
  }

  /** No flush from now until `releaseMessages`: the registry has not loaded. A flush asked for meanwhile runs then. */
  holdMessages(): void {
    this.holding = true;
  }

  /**
   * Whether flushes are held back. That is so from `holdMessages` until the registry has loaded, and for good when a
   * start-up fails before the load or never gets there: what waits then stays in the file for the next start, and
   * the diagnostics say so, because nothing else would.
   */
  get messagesHeld(): boolean {
    return this.holding;
  }

  /** The registry has loaded: what waits may be looked at, and a flush that was asked for meanwhile runs now. */
  releaseMessages(): void {
    if (!this.holding) return;
    this.holding = false;
    if (!this.flushWanted) return;
    this.flushWanted = false;
    this.flush().catch(() => this.report("outbox_flush_failed"));
  }

  /**
   * One flush of the outbox, for an agent or for everyone, unless flushes are held back. After a stop the outbox
   * serves nobody: a flush then only writes what it still held in memory.
   */
  private flush(agentId?: string): Promise<void> {
    if (this.holding) {
      this.flushWanted = true;
      return Promise.resolve();
    }
    let flushing: Promise<void>;
    try {
      flushing = this.outbox.flush(agentId);
    } catch (error) {
      flushing = Promise.reject(error);
    }
    this.track(flushing);
    return flushing;
  }

  private api(): DaemonPort {
    if (!this.paseo) throw new SecureInputError("unknown_agent", NOT_ATTACHED);
    return this.paseo;
  }

  async isIdle(agentId: string): Promise<boolean> {
    const handle = this.api().agents.ref(agentId);
    await handle.refresh();
    return handle.status === "idle";
  }

  async send(agentId: string, text: string): Promise<void> {
    await this.api().agents.ref(agentId).send(text);
  }

  /**
   * The registry calls this on every change of a record, and says what the change was. The card is the record as it
   * is now, whatever changed. A message is for one change only: the continuation when the state changed to one that
   * is announced (`announces`: not `released`, which a message still waiting says instead), the warning when the tamper
   * flag was raised, and nothing for any other change, so a record that changes again after its message was sent (in
   * this process or in an earlier one) does not make the message a second time. Both are references (which request,
   * which of the two messages); the words are built from the registry's record when they are sent.
   */
  publish(record: RequestRecord, change: RecordChange): void {
    const card = this.cards.get(record.id);
    if (card === undefined) {
      this.cards.set(record.id, { record, owed: true, unsettled: 0, triedAt: this.ticks, failing: false });
    } else {
      card.record = record;
      card.owed = true;
      card.failing = false;
    }
    this.drainCards();
    if (change === "state" && announces(record)) this.announce({ agentId: record.agentId, requestId: record.id, kind: "continuation" });
    if (change === "tamper") this.announce({ agentId: record.agentId, requestId: record.id, kind: "tamper" });
  }

  /** The registry forgot a request: what is kept for it here and in the outbox goes with it. */
  forget(requestId: string): void {
    this.cards.delete(requestId);
    this.outbox.retire(requestId);
  }

  /** How many requests have a card the timeline is not known to show yet. */
  get cardsOwed(): number {
    let owed = 0;
    for (const card of this.cards.values()) if (card.owed) owed += 1;
    return owed;
  }

  /** Saves the message, which waits for no agent, and then asks for it to be delivered. */
  private announce(item: OutboxItem): void {
    this.track(
      (async () => {
        try {
          await this.outbox.enqueue(item);
        } catch {
          this.report("outbox_enqueue_failed");
        }
        await this.flush(item.agentId).catch(() => this.report("outbox_flush_failed"));
      })(),
    );
  }

  turnEnded(agentId: string): void {
    this.drainCards();
    this.flush(agentId).catch(() => this.report("outbox_flush_failed"));
  }

  /**
   * The agent was archived: it is gone for good. What waits for it is dropped: its messages, which could only wait out
   * their day in the file, and its owed cards, which would be tried once a minute for a timeline nobody opens.
   */
  agentArchived(agentId: string): void {
    for (const [id, card] of this.cards) if (card.record.agentId === agentId) this.cards.delete(id);
    this.track(this.outbox.drop(agentId).catch(() => this.report("outbox_drop_failed")));
  }

  /**
   * The plugin's tick. Delivers what is waiting for an agent that has become idle without a turn ending that anyone
   * told us of, and gives the cards that are still owed another try. Resolves when the flush is done and rejects if it
   * fails. While a flush is under way the outbox does not start another: it runs one more after it.
   */
  flushAll(): Promise<void> {
    this.ticks += 1;
    this.drainCards();
    return this.flush();
  }

  /** Starts a drain of the owed cards, unless one is under way: then one more follows it. After a stop a drain appends nothing. */
  private drainCards(): void {
    if (this.paseo === null) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    if (this.cardsOwed === 0) return;
    this.draining = true;
    this.track(
      this.drain()
        .catch(() => this.report("card_failed"))
        .finally(() => {
          this.draining = false;
          if (!this.drainAgain) return;
          this.drainAgain = false;
          this.drainCards();
        }),
    );
  }

  /** What the append answers; `TIMED_OUT` when the bound or a stop comes first; its own error if it fails first. */
  private async answered(append: Promise<unknown>): Promise<unknown> {
    try {
      return await raceDeadline(this.callTimeoutMs, TIMED_OUT, () => append, (giveUp) => {
        this.abandonAppend = giveUp;
      });
    } finally {
      this.abandonAppend = null;
    }
  }

  /** An entry is kept only while something is owed or out for it. */
  private settle(id: string, card: Card): void {
    if (!card.owed && card.unsettled === 0 && this.cards.get(id) === card) this.cards.delete(id);
  }

  private fail(card: Card, code: string): void {
    if (card.failing) return;
    card.failing = true;
    this.report(code);
  }

  private async drain(): Promise<void> {
    const port = this.paseo;
    if (port === null) return;
    for (const [id, card] of [...this.cards]) {
      // Before every card: a stop can come between the answer to one append and the next.
      if (this.stopped) return;
      if (!card.owed || this.cards.get(id) !== card) continue;
      // With that many appends out and unanswered the card is not dropped, only tried more seldom: see `SLOW_RETRY_TICKS`.
      if (card.unsettled >= MAX_UNSETTLED_APPENDS && this.ticks - card.triedAt < SLOW_RETRY_TICKS) continue;
      const record = card.record;
      card.triedAt = this.ticks;
      let append: Promise<unknown>;
      try {
        append = Promise.resolve(
          port.agents.ref(record.agentId).timeline.append({ type: "plugin", id: record.id, kind: CARD_KIND, version: CARD_VERSION, data: cardData(record) }),
        );
      } catch {
        this.fail(card, "card_failed");
        continue;
      }
      let answer: unknown;
      try {
        answer = await this.answered(append);
      } catch {
        // Still owed: tried again on the tick and when the daemon next calls in.
        this.fail(card, "card_failed");
        continue;
      }
      if (answer !== TIMED_OUT) {
        // It landed. Unless a newer state came meanwhile, the timeline shows the request as it is.
        if (card.record === record) card.owed = false;
        this.settle(id, card);
        continue;
      }
      // Given up on because of the stop, not because the daemon was slow: nothing to report, and nothing more to do.
      if (this.stopped) return;
      this.fail(card, "daemon_timeout");
      // Given up on, not cancelled: it stays owed and is tried again, and this call can still land later.
      card.unsettled += 1;
      append.then(
        () => {
          card.unsettled -= 1;
          // It landed after all, behind anything appended since. If that was a newer state, the row is an older one
          // again and the latest is owed once more; if this was the latest, it is shown and nothing is owed.
          card.owed = card.record !== record;
          this.settle(id, card);
          this.drainCards();
        },
        () => {
          card.unsettled -= 1;
          this.settle(id, card);
          this.drainCards();
        },
      );
    }
  }
}
