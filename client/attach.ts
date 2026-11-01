import type { PluginClientContext } from "@getpaseo/plugin/client";

/** How long after a failure the observation is asked for again; each failure in a row doubles it, up to the cap. */
export const RETRY_MS = 5_000;
export const RETRY_CAP_MS = 60_000;

/**
 * Calls `ping` now and after every reconnect.
 *
 * The daemon half gets its API handle only inside a hook or an RPC, so after a daemon restart it can send nothing until
 * something calls it. Paseo before 0.15 set the plugin up again on a reconnect, and setting up made that call. From 0.15
 * an unchanged plugin stays installed and is not set up again, and the fresh snapshot of an owned observation is what
 * marks the reconnect. One entry is enough for that: the agents themselves are of no interest here. Paseo gives up an
 * observation whose request fails after a reconnect, so a failure asks for a new one. Returns the cleanup.
 */
export function keepDaemonHalfAttached(paseo: PluginClientContext["paseo"], ping: () => void): () => void {
  const lifetime = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function observeAgain(): void {
    if (lifetime.signal.aborted) return;
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(observe, Math.min(RETRY_CAP_MS, RETRY_MS * 2 ** failures));
    failures += 1;
  }

  function observe(): void {
    if (lifetime.signal.aborted) return;
    void paseo.agents
      .list({ subscribe: {}, page: { limit: 1 }, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot() {
            if (lifetime.signal.aborted) return;
            failures = 0;
            ping();
          },
          update() {},
          error: observeAgain,
        });
        return undefined;
      })
      .catch(observeAgain);
  }

  ping();
  observe();
  return () => {
    lifetime.abort();
    if (retry !== undefined) clearTimeout(retry);
  };
}
