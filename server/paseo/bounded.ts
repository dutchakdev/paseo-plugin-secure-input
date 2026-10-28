import { raceDeadline } from "../io/deadline";

export const TIMED_OUT = Symbol("timed out");

/**
 * What `call` gives; `TIMED_OUT` if it takes longer than `milliseconds`; its own error if it fails first. Every call
 * into the daemon API that a request waits for goes through here, so a daemon that stops answering costs a request
 * the bound and not its life. The race keeps a handler on the call, so one that fails after the bound is no
 * unhandled rejection (which would end the plugin's process), and the timer is cleared on every way out.
 */
export function within<T>(milliseconds: number, call: () => Promise<T> | T): Promise<T | typeof TIMED_OUT> {
  return raceDeadline(milliseconds, TIMED_OUT, call);
}
