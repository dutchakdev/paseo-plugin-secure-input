import { afterEach, describe, expect, it, vi } from "vitest";
import { errnoToken } from "../server/io/descriptor";
import { raceDeadline } from "../server/io/deadline";
import { uid } from "../server/io/ownership";
import { TIMED_OUT, within } from "../server/paseo/bounded";

describe("errnoToken", () => {
  it("gives the errno name of an error that has one, and nothing for anything a library might have written", () => {
    const withCode = (code: unknown) => Object.assign(new Error("text a library wrote: /secret/path"), { code });
    for (const code of ["ENOENT", "EACCES", "EMFILE", "ELOOP", "ENAMETOOLONG", "E2BIG", "ERR_X"]) expect(errnoToken(withCode(code)), code).toBe(code);
    for (const code of ["", "E", "enoent", "ENOENT ", "ENO ENT", "ENOENT\n", "1ENOENT", "E".repeat(33), 2, null, undefined, {}, ["ENOENT"]]) {
      expect(errnoToken(withCode(code)), String(code)).toBeUndefined();
    }
    expect(errnoToken("ENOENT")).toBeUndefined();
    expect(errnoToken(null)).toBeUndefined();
    expect(errnoToken(undefined)).toBeUndefined();
    expect(errnoToken({})).toBeUndefined();
    expect(errnoToken(new Error("no code"))).toBeUndefined();
  });
});

describe("uid", () => {
  it("is the user this process runs as, a whole number that is not root's", () => {
    expect(uid()).toBe((process.getuid as () => number)());
    expect(Number.isInteger(uid())).toBe(true);
    expect(uid()).not.toBe(0);
  });
});

describe("raceDeadline", () => {
  afterEach(() => vi.useRealTimers());
  const EXPIRED = Symbol("expired");

  it("gives what the call gives when it comes first, a value or a promise, and clears its timer", async () => {
    vi.useFakeTimers();
    expect(await raceDeadline(1000, EXPIRED, () => "now")).toBe("now");
    expect(await raceDeadline(1000, EXPIRED, async () => "later")).toBe("later");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives its own error when the call fails first, also when it throws before it returns a promise", async () => {
    vi.useFakeTimers();
    await expect(raceDeadline(1000, EXPIRED, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(
      raceDeadline(1000, EXPIRED, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the expired value at the bound, to the millisecond, and ignores what the call does after that", async () => {
    vi.useFakeTimers();
    let late: (value: string) => void = () => undefined;
    let lateFailure: (error: Error) => void = () => undefined;
    let done = false;
    const raced = raceDeadline(1000, EXPIRED, () => new Promise<string>((resolve) => (late = resolve))).then((value) => {
      done = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await raced).toBe(EXPIRED);
    late("too late");
    // A call that fails after the bound has handlers on it: nothing is unhandled.
    const failing = raceDeadline(10, EXPIRED, () => new Promise<string>((_, reject) => (lateFailure = reject)));
    await vi.advanceTimersByTimeAsync(10);
    expect(await failing).toBe(EXPIRED);
    lateFailure(new Error("after the bound"));
    await vi.advanceTimersByTimeAsync(1);
  });

  it("lets the caller end the wait sooner, by the function it was handed, with the same expired value", async () => {
    vi.useFakeTimers();
    let abandon: () => void = () => undefined;
    const raced = raceDeadline(60_000, EXPIRED, () => new Promise<string>(() => undefined), (give) => (abandon = give));
    await vi.advanceTimersByTimeAsync(5);
    abandon();
    expect(await raced).toBe(EXPIRED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is what `within` goes by: the symbol is the one of server/paseo/bounded", async () => {
    vi.useFakeTimers();
    const raced = within(50, () => new Promise<string>(() => undefined));
    await vi.advanceTimersByTimeAsync(50);
    expect(await raced).toBe(TIMED_OUT);
    expect(await within(50, () => 7)).toBe(7);
  });
});
