import { afterEach, describe, expect, it, vi } from "vitest";
import { RETRY_CAP_MS, RETRY_MS, keepDaemonHalfAttached } from "../client/attach";

type Handlers = { snapshot(result: unknown): void; update(message: unknown): void; error?(error: unknown): void };
type ListOptions = { subscribe: object; page: { limit: number }; signal: AbortSignal };

function fixture(failObservations = 0) {
  const observers: Handlers[] = [];
  let failing = failObservations;
  const list = vi.fn(async (_options: ListOptions) => {
    if (failing > 0) {
      failing -= 1;
      throw new Error("no observation");
    }
    return { subscription: { subscribe: (next: Handlers) => { observers.push(next); } } };
  });
  const ping = vi.fn();
  const stop = keepDaemonHalfAttached({ agents: { list } } as never, ping);
  const ready = async () => {
    await vi.waitFor(() => expect(observers.length).toBeGreaterThan(0));
    return observers[0]!;
  };
  return { list, ping, stop, ready, observers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("keepDaemonHalfAttached", () => {
  it("calls at once, and again at each snapshot, which is what a reconnect delivers", async () => {
    const { ping, ready } = fixture();
    expect(ping).toHaveBeenCalledTimes(1);
    const handlers = await ready();
    handlers.snapshot({});
    handlers.snapshot({});
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it("does not call for an agent's update, and asks for one entry only", async () => {
    const { list, ping, ready } = fixture();
    const handlers = await ready();
    handlers.update({ type: "agent_update" });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]![0].page.limit).toBe(1);
  });

  it("asks for a new observation when Paseo gives one up after a reconnect, and calls at its snapshot", async () => {
    vi.useFakeTimers();
    const { list, ping, observers } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    observers[0]!.error?.(new Error("the request failed"));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(list).toHaveBeenCalledTimes(2);
    observers[1]!.snapshot({});
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("keeps trying while the observation cannot start, waiting longer each time up to the cap", async () => {
    vi.useFakeTimers();
    const { list, ping, observers } = fixture(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);
    expect(list).toHaveBeenCalledTimes(7);
    expect(observers).toHaveLength(1);
  });

  it("ends the observation with its cleanup, and calls no more after it", async () => {
    const { list, ping, stop, ready } = fixture();
    const handlers = await ready();
    stop();
    expect(list.mock.calls[0]![0].signal.aborted).toBe(true);
    handlers.snapshot({});
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("cancels a retry that is waiting when it is cleaned up", async () => {
    vi.useFakeTimers();
    const { list, stop } = fixture(1);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 2);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
