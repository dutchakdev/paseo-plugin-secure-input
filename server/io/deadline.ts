/**
 * What `call` gives, or `expired` if `milliseconds` pass first, or if the caller gives up sooner by the function it is
 * handed through `onAbandon` (a stop, the end of a budget: it settles the race with `expired` as the clock would). If
 * `call` fails first, its own error. A result or an error that comes later is ignored, and it is not an unhandled
 * rejection either: the handlers stay on the call. The timer is cleared on every way out, and nothing here knows of
 * the daemon's API or of any SDK, so the plugin's core can bound its calls with it too.
 *
 * Each caller says what "expired" is in its own value (`TIMED_OUT` in `server/paseo/bounded.ts`, `UNSETTLED` of the
 * outbox) and keeps what a time-out means to it.
 */
export async function raceDeadline<T, Expired>(
  milliseconds: number,
  expired: Expired,
  call: () => Promise<T> | T,
  onAbandon?: (abandon: () => void) => void,
): Promise<T | Expired> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T | Expired>((resolve, reject) => {
      timer = setTimeout(() => resolve(expired), milliseconds);
      onAbandon?.(() => resolve(expired));
      // A call that throws before it returns a promise is a rejection of the race, as one that fails later is.
      Promise.resolve(call()).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}
