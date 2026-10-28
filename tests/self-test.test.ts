import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE, RUNNING, SELF_TEST_BYTES, runSelfTest, selfTestText, type SelfTestDeps, type SelfTestState } from "../client/self-test";
import { beginSelfTest, clearSelfTests, finishSelfTest } from "../server/core/selftest";
import { ENVELOPE_CT_MAX, EnvelopeSchema } from "../shared/contracts";
import { SecureInputError } from "../shared/errors";
import { MAX_PAYLOAD_BYTES } from "../shared/seal";

const CANARY = "CANARY-6a02-library-text";
/** The tests that seal the largest submission there can be, with room for a loaded machine. */
const LONG = 30_000;

afterEach(() => {
  vi.restoreAllMocks();
  clearSelfTests();
});

/** The plugin's own two functions behind the two calls, and a clock that moves 7 ms each time it is read. */
function realDeps(overrides: Partial<SelfTestDeps> = {}): SelfTestDeps {
  let time = 1000;
  return {
    begin: async () => beginSelfTest(),
    finish: async ({ probeId, envelope, digest }) => finishSelfTest(probeId, envelope, digest),
    now: () => {
      time += 7;
      return time;
    },
    ...overrides,
  };
}

describe("the self-test sequence", () => {
  it("seals in the app what the plugin opens, and reports the size and the time it took", async () => {
    expect(await runSelfTest(realDeps(), 1024)).toEqual({ kind: "passed", bytes: 1024, ms: 7 });
    expect(await runSelfTest(realDeps(), 350 * 1024)).toEqual({ kind: "passed", bytes: 350 * 1024, ms: 7 });
  });

  it("seals the largest submission there can be, and sends an envelope that the plugin's call takes", async () => {
    expect(SELF_TEST_BYTES).toBe(MAX_PAYLOAD_BYTES);
    expect(SELF_TEST_BYTES).toBe(12_588_032);
    const sent: Array<{ ct: string }> = [];
    const deps = realDeps({
      finish: async ({ probeId, envelope, digest }) => {
        sent.push(envelope);
        return finishSelfTest(probeId, envelope, digest);
      },
    });
    // With no size said, it is the largest, and the plugin opens all of it.
    expect(await runSelfTest(deps)).toEqual({ kind: "passed", bytes: SELF_TEST_BYTES, ms: 7 });
    expect(sent).toHaveLength(1);
    expect(EnvelopeSchema.safeParse(sent[0]).success).toBe(true);
    expect(sent[0]?.ct).toHaveLength(ENVELOPE_CT_MAX);
  }, LONG);

  it("says that the plugin did not open the message when the plugin answers so", async () => {
    const wrongDigest = realDeps({ finish: async ({ probeId, envelope }) => finishSelfTest(probeId, envelope, "00") });
    expect(await runSelfTest(wrongDigest, 1024)).toEqual({ kind: "mismatch" });
    const forgotten = realDeps({
      finish: async ({ probeId, envelope, digest }) => {
        clearSelfTests();
        return finishSelfTest(probeId, envelope, digest);
      },
    });
    expect(await runSelfTest(forgotten, 1024)).toEqual({ kind: "mismatch" });
  });

  it("reports a call the plugin refused or could not answer as a failure of the plugin, and keeps nothing of the error", async () => {
    const thrown = [
      new SecureInputError("service_unavailable", "the self-test cannot be shown"),
      new Error(`RPC secure-input.selftest.finish failed: service_unavailable: the self-test cannot be shown (${CANARY})`),
      new Error(`socket hang up ${CANARY}`),
      new TypeError(CANARY),
      CANARY,
      { message: CANARY },
      null,
      undefined,
      7,
    ];
    for (const error of thrown) {
      const refusing = async (): Promise<never> => {
        throw error;
      };
      const calls: Array<[string, SelfTestDeps]> = [
        ["begin", realDeps({ begin: refusing })],
        ["finish", realDeps({ finish: refusing })],
      ];
      for (const [call, deps] of calls) {
        const state = await runSelfTest(deps, 1024);
        expect(state, `${call}: ${String(error)}`).toEqual({ kind: "failed", stage: "plugin" });
        expect(JSON.stringify(state)).not.toContain("CANARY");
        expect(selfTestText(state)).toBe("✗ плагін не відповів");
      }
    }
  });

  it("reports a key it cannot seal to as a failure to seal in the app", async () => {
    for (const publicKey of ["", "short", "!".repeat(43), "A".repeat(44)]) {
      const state = await runSelfTest(realDeps({ begin: async () => ({ probeId: "p_0123456789abcdef", publicKey }) }), 1024);
      expect(state, publicKey).toEqual({ kind: "failed", stage: "seal" });
    }
  });

  it("reports a host without usable randomness as a failure to seal in the app, in fixed words", async () => {
    const probe = beginSelfTest();
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new TypeError(`crypto.getRandomValues is not a function ${CANARY}`);
    });
    const finished = vi.fn(async () => ({ ok: true, bytes: 1 }));
    const state = await runSelfTest(realDeps({ begin: async () => probe, finish: finished }), 1024);
    expect(state).toEqual({ kind: "failed", stage: "seal" });
    expect(selfTestText(state)).toBe("✗ не вдалося зашифрувати");
    // Nothing was sent to the plugin when nothing could be sealed.
    expect(finished).not.toHaveBeenCalled();
  });

  it("never rejects, whatever the two calls and the clock do", async () => {
    const broken: SelfTestDeps = {
      begin: () => {
        throw new Error(CANARY);
      },
      finish: () => {
        throw new Error(CANARY);
      },
      now: () => {
        throw new Error(CANARY);
      },
    };
    const state = await runSelfTest(broken, 1024);
    expect(state.kind).toBe("failed");
    expect(selfTestText(state)).not.toContain("CANARY");
  });
});

describe("the dummy bytes the self-test seals", () => {
  const SIZE = 4099;

  /** The buffers of this size that were filled with the dummy byte, found by the calls that filled them. */
  function dummyBuffers(fills: { mock: { contexts: unknown[]; calls: unknown[][] } }): Uint8Array[] {
    return (fills.mock.contexts as Uint8Array[]).filter((buffer, index) => buffer.length === SIZE && fills.mock.calls[index]?.[0] === 0x61);
  }

  /** What a run leaves of the one buffer it filled with its dummy byte. */
  async function leftOfPayload(deps: SelfTestDeps): Promise<Uint8Array> {
    const fills = vi.spyOn(Uint8Array.prototype, "fill");
    try {
      await runSelfTest(deps, SIZE);
      const filled = dummyBuffers(fills);
      expect(filled).toHaveLength(1);
      return filled[0] as Uint8Array;
    } finally {
      fills.mockRestore();
    }
  }

  it("are wiped once they are sealed and hashed, as a value is", async () => {
    const left = await leftOfPayload(realDeps());
    expect(left).toHaveLength(SIZE);
    expect(left.every((byte) => byte === 0)).toBe(true);
  });

  it("are wiped when sealing fails after they were made", async () => {
    // A key that is no key: the bytes exist when the seal is refused.
    const left = await leftOfPayload(realDeps({ begin: async () => ({ probeId: "p_0123456789abcdef", publicKey: "short" }) }));
    expect(left.every((byte) => byte === 0)).toBe(true);
  });

  it("are gone before the plugin is asked to open what they became", async () => {
    let atTheCall: number | undefined;
    const fills = vi.spyOn(Uint8Array.prototype, "fill");
    try {
      const deps = realDeps({
        finish: async ({ probeId, envelope, digest }) => {
          atTheCall = dummyBuffers(fills)[0]?.reduce((sum, byte) => sum + byte, 0);
          return finishSelfTest(probeId, envelope, digest);
        },
      });
      await runSelfTest(deps, SIZE);
    } finally {
      fills.mockRestore();
    }
    expect(atTheCall).toBe(0);
  });
});

describe("what the settings screen says about a self-test", () => {
  it("says nothing while it has not run or is running: the screen shows a spinner then, and never a result that is not this run's", () => {
    expect(selfTestText(IDLE)).toBe("");
    expect(selfTestText(RUNNING)).toBe("");
  });

  it("says a success with the time it took", () => {
    expect(selfTestText({ kind: "passed", bytes: SELF_TEST_BYTES, ms: 12 })).toBe("✓ 12 мс");
    expect(selfTestText({ kind: "passed", bytes: 1024, ms: 0 })).toBe("✓ 0 мс");
    expect(selfTestText({ kind: "passed", bytes: 1024, ms: 4210 })).toBe("✓ 4210 мс");
  });

  it("says every failure in a fixed sentence that begins with a cross", () => {
    const states: SelfTestState[] = [{ kind: "mismatch" }, { kind: "failed", stage: "seal" }, { kind: "failed", stage: "plugin" }];
    expect(states.map(selfTestText)).toEqual(["✗ дані не збіглися", "✗ не вдалося зашифрувати", "✗ плагін не відповів"]);
    for (const state of states) expect(selfTestText(state).startsWith("✗ ")).toBe(true);
  });
});
