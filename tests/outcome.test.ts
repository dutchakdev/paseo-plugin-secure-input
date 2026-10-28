import { describe, expect, it } from "vitest";
import {
  CLOSED,
  UNAVAILABLE,
  afterCheckFailed,
  afterDecline,
  afterFulfill,
  afterLostReply,
  afterMismatch,
  afterReadClosed,
  afterSealFailure,
  type FulfillResult,
  type Next,
} from "../client/outcome";
import { ERROR_CODES, type ErrorCode } from "../shared/errors";
import { REQUEST_STATES } from "../shared/request";

/** Nothing happens. Every row below says what differs from it, so a flag nobody meant to set shows up. */
const KEEP: Next = { top: null, close: false, closed: false, clearForm: false, dropEnvelope: false, outcomeUnknown: false };

const refused = (code: ErrorCode, retryable: boolean, detail?: string): FulfillResult =>
  detail === undefined ? { ok: false, code, retryable } : { ok: false, code, retryable, detail };

describe("the two lines the form says at its top", () => {
  it("are exactly these words", () => {
    expect(UNAVAILABLE).toBe("Плагін зараз недоступний. Натисни «→» ще раз.");
    expect(CLOSED).toBe("Запит уже закрито.");
  });
});

describe("what the form does after each answer", () => {
  it("closes and wipes after an accepted submission, and says nothing: there is no toast", () => {
    for (const state of REQUEST_STATES) {
      expect(afterFulfill({ ok: true, state }), state).toEqual({ ...KEEP, close: true, clearForm: true, dropEnvelope: true });
    }
  });

  it("asks to press «→» again after a failed decryption, and seals anew then: the kept envelope may be the trouble", () => {
    expect(afterFulfill(refused("decrypt_failed", true))).toEqual({ ...KEEP, top: UNAVAILABLE, dropEnvelope: true });
  });

  it("asks to press «→» again after an answer that says the plugin could not answer, and holds what became of the envelope unknown", () => {
    expect(afterFulfill(refused("service_unavailable", true))).toEqual({ ...KEEP, top: UNAVAILABLE, outcomeUnknown: true });
  });

  it("asks to press «→» again after every other refusal that leaves the request open, and keeps everything", () => {
    for (const code of ERROR_CODES.filter((candidate) => candidate !== "decrypt_failed" && candidate !== "service_unavailable")) {
      expect(afterFulfill(refused(code, true)), code).toEqual({ ...KEEP, top: UNAVAILABLE });
    }
  });

  it("shows the request closed after every refusal that closed it: the input stays, «→» is disabled and the envelope goes", () => {
    for (const code of ERROR_CODES) {
      expect(afterFulfill(refused(code, false)), code).toEqual({ ...KEEP, top: CLOSED, closed: true, dropEnvelope: true });
    }
  });

  it("asks to press «→» again when no reply came, sealing failed, the reread failed or the view names another request", () => {
    for (const next of [afterLostReply(), afterSealFailure(), afterCheckFailed(), afterMismatch()]) expect(next).toEqual({ ...KEEP, top: UNAVAILABLE });
  });

  it("shows the request closed when a reading finds it so, and drops the envelope", () => {
    expect(afterReadClosed()).toEqual({ ...KEEP, top: CLOSED, closed: true, dropEnvelope: true });
  });

  it("closes after a decline, and asks to try again when the decline failed", () => {
    expect(afterDecline(true)).toEqual({ ...KEEP, close: true, clearForm: true, dropEnvelope: true });
    expect(afterDecline(false)).toEqual({ ...KEEP, top: UNAVAILABLE });
  });

  it("turns every refusal of the plugin into one of the two lines, and never shows what the plugin said besides the code", () => {
    const CANARY = "CANARY-detail-0a1b";
    for (const code of ERROR_CODES) {
      for (const retryable of [true, false]) {
        const next = afterFulfill(refused(code, retryable, `${CANARY} ${code}`));
        expect([UNAVAILABLE, CLOSED], `${code} ${retryable}`).toContain(next.top);
        expect(JSON.stringify(next)).not.toContain(CANARY);
      }
    }
  });
});
