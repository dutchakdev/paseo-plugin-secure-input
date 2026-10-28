import { fromBase64Url } from "../shared/bytes";
import { MAX_PAYLOAD_BYTES, buildAad, digestHex, seal, type SealedEnvelope } from "../shared/seal";

/**
 * What the self-test seals: the largest submission one Paseo call can carry. It proves on this device that the biggest thing
 * a person can send travels the whole way (sealed here, through the daemon's channel, opened there), which a small payload
 * does not: a path with a limit on its messages passes the small one and refuses this.
 */
export const SELF_TEST_BYTES = MAX_PAYLOAD_BYTES;

/**
 * Where the self-test stands. `running` takes the place of an earlier result the moment a run starts, so that the screen
 * never shows the result of the run before as if it were this one's.
 */
export type SelfTestState =
  | { kind: "idle" }
  | { kind: "running" }
  /** `bytes` is what the plugin says it opened. */
  | { kind: "passed"; bytes: number; ms: number }
  /** The plugin answered, and it had not opened the message or found another digest. */
  | { kind: "mismatch" }
  /** A step failed: sealing in the app, or one of the two calls to the plugin. */
  | { kind: "failed"; stage: "seal" | "plugin" };

export const IDLE: SelfTestState = { kind: "idle" };
export const RUNNING: SelfTestState = { kind: "running" };

/** What the sequence needs from outside: the two calls to the plugin, and the clock. */
export interface SelfTestDeps {
  begin(input: Record<string, never>): Promise<{ probeId: string; publicKey: string }>;
  finish(input: { probeId: string; envelope: SealedEnvelope; digest: string }): Promise<{ ok: boolean; bytes: number }>;
  now(): number;
}

const failed = (stage: "seal" | "plugin"): SelfTestState => ({ kind: "failed", stage });

/**
 * Seals a dummy payload in the app and has the plugin open it: the path a real value takes. Decided here and not in
 * the component: which step failed, and what is kept of a failure, which is its stage and nothing of what the error said.
 * It never rejects.
 *
 * The dummy bytes are the largest thing the screen ever holds. They are wiped as a value is, the moment they are sealed
 * and hashed and on every way out, which is before the plugin is asked to open what they became.
 */
export async function runSelfTest(deps: SelfTestDeps, bytes: number = SELF_TEST_BYTES): Promise<SelfTestState> {
  let startedAt: number;
  let probe: { probeId: string; publicKey: string };
  try {
    startedAt = deps.now();
    probe = await deps.begin({});
  } catch {
    return failed("plugin");
  }

  let envelope: SealedEnvelope;
  let digest: string;
  let payload: Uint8Array | undefined;
  try {
    payload = new Uint8Array(bytes).fill(0x61);
    envelope = seal(fromBase64Url(probe.publicKey), payload, buildAad(probe.probeId, "selftest"));
    digest = digestHex(payload);
  } catch {
    return failed("seal");
  } finally {
    payload?.fill(0);
  }

  try {
    const outcome = await deps.finish({ probeId: probe.probeId, envelope, digest });
    return outcome.ok ? { kind: "passed", bytes: outcome.bytes, ms: deps.now() - startedAt } : { kind: "mismatch" };
  } catch {
    return failed("plugin");
  }
}

/** What a screen reader says of the spinner that stands in the place of the result while a run is going. */
export const SELF_TEST_RUNNING = "Перевірка триває";

/**
 * What the settings screen says of a run, next to the button: how long it took, or why it did not pass, in a fixed
 * sentence and never in the words of an error. Before a run and while one is going it says nothing: the screen shows a
 * spinner then (`SELF_TEST_RUNNING`).
 */
export function selfTestText(state: SelfTestState): string {
  switch (state.kind) {
    case "idle":
    case "running":
      return "";
    case "passed":
      return `✓ ${state.ms} мс`;
    case "mismatch":
      return "✗ дані не збіглися";
    default:
      return state.stage === "seal" ? "✗ не вдалося зашифрувати" : "✗ плагін не відповів";
  }
}
