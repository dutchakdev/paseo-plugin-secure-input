import { describe, expect, it } from "vitest";
import { applyOutcome, applyRead, arrowAction, declineAction, openedDialog, type DialogState } from "../client/dialog-state";
import { CLOSED, UNAVAILABLE, afterDecline, afterFulfill, afterLostReply, afterReadClosed } from "../client/outcome";
import { dialogScreen } from "../client/presentation";
import { REQUEST_STATES } from "../shared/request";
import { REQUEST_ID, viewOf } from "./view-fixtures";

// What a reading or an answer does to the form: which view it holds, whether it is on the failed screen, whether the
// request is closed, and the line at its top. The component applies this and decides none of it.

const SEEN = viewOf();
const OTHER = viewOf({ id: "r_ffffffffffffffffffffffffffffffff" });
const stateOf = (parts: Partial<DialogState> = {}): DialogState => ({ ...openedDialog(), ...parts });

describe("a form that has just been opened", () => {
  it("holds nothing, waits for its one reading, and has nothing for «→» to do", () => {
    expect(openedDialog()).toEqual({ view: null, loadFailed: false, closed: false, top: null });
    expect(dialogScreen(openedDialog())).toBe("loading");
    expect(arrowAction(openedDialog(), true)).toBeNull();
  });

  it("shows the request it read when the request waits", () => {
    const after = applyRead(openedDialog(), REQUEST_ID, SEEN);
    expect(after).toEqual(stateOf({ view: SEEN }));
    expect(dialogScreen(after)).toBe("form");
  });

  it("shows the failed screen with the one line when there was nothing to read, or what was read is of another request", () => {
    for (const loaded of [null, OTHER]) {
      const after = applyRead(openedDialog(), REQUEST_ID, loaded);
      expect(after).toEqual(stateOf({ loadFailed: true, top: UNAVAILABLE }));
      expect(dialogScreen(after)).toBe("failed");
      // «→» reads the request again.
      expect(arrowAction(after, false)).toBe("read");
    }
  });

  it("leaves the failed screen for the form when «→» reads the request, and stays on it when it cannot", () => {
    const failed = applyRead(openedDialog(), REQUEST_ID, null);
    expect(applyRead(failed, REQUEST_ID, SEEN)).toEqual(stateOf({ view: SEEN }));
    expect(applyRead(failed, REQUEST_ID, null)).toEqual(failed);
  });

  it("shows a request that no longer waits with its line, «→» disabled, whatever closed it", () => {
    for (const state of REQUEST_STATES.filter((candidate) => candidate !== "pending")) {
      const closed = viewOf({ state });
      const after = applyRead(openedDialog(), REQUEST_ID, closed);
      expect(after, state).toEqual(stateOf({ view: closed, closed: true, top: CLOSED }));
      expect(dialogScreen(after), state).toBe("form");
      expect(arrowAction(after, true), state).toBeNull();
    }
  });
});

describe("what an answer does to the form", () => {
  const open = stateOf({ view: SEEN });

  it("puts the answer's line at the top, and takes it away with an answer that has none", () => {
    const failed = applyOutcome(open, { next: afterLostReply(), view: null });
    expect(failed).toEqual(stateOf({ view: SEEN, top: UNAVAILABLE }));
    expect(applyOutcome(failed, { next: afterFulfill({ ok: true, state: "delivered" }), view: null })).toEqual(open);
  });

  it("is closed from the answer that says so, and stays closed whatever comes after", () => {
    const closed = applyOutcome(open, { next: afterFulfill({ ok: false, code: "request_closed", retryable: false }), view: null });
    expect(closed).toEqual(stateOf({ view: SEEN, closed: true, top: CLOSED }));
    expect(arrowAction(closed, true)).toBeNull();
    for (const next of [afterLostReply(), afterFulfill({ ok: true, state: "delivered" }), afterDecline(false)]) {
      expect(applyOutcome(closed, { next, view: null }).closed).toBe(true);
    }
  });

  it("shows a view the answer brings, and keeps the one it held otherwise", () => {
    const fresh = viewOf({ state: "delivered" });
    expect(applyOutcome(open, { next: afterReadClosed(), view: fresh })).toEqual(stateOf({ view: fresh, closed: true, top: CLOSED }));
    expect(applyOutcome(open, { next: afterLostReply(), view: null }).view).toBe(SEEN);
  });

  it("hands back a new state, and leaves the one it was given as it was", () => {
    const copy = structuredClone(open);
    applyOutcome(open, { next: afterReadClosed(), view: viewOf({ state: "expired" }) });
    applyRead(open, REQUEST_ID, null);
    expect(open).toEqual(copy);
  });
});

describe("what «→» and «✕» do", () => {
  it("sends the form only when the form is ready and the request is open", () => {
    const open = stateOf({ view: SEEN });
    expect(arrowAction(open, true)).toBe("submit");
    expect(arrowAction(open, false)).toBeNull();
    expect(arrowAction(stateOf({ view: SEEN, closed: true }), true)).toBeNull();
    // Whatever the line at the top says, a form that is ready and open can be sent again.
    expect(arrowAction(stateOf({ view: SEEN, top: UNAVAILABLE }), true)).toBe("submit");
  });

  it("declines a request that may still be open, and only closes the form over one that is known to be closed", () => {
    expect(declineAction(openedDialog())).toBe("decline");
    expect(declineAction(stateOf({ loadFailed: true, top: UNAVAILABLE }))).toBe("decline");
    expect(declineAction(stateOf({ view: SEEN }))).toBe("decline");
    expect(declineAction(stateOf({ view: SEEN, closed: true, top: CLOSED }))).toBe("close");
  });
});
