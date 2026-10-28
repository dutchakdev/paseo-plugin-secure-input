import type { RequestView } from "../shared/view";
import { UNAVAILABLE, afterReadClosed, type Next } from "./outcome";
import { dialogScreen } from "./presentation";

/**
 * What the form holds about the request itself, apart from what was typed: the view it shows, whether its reading
 * failed, whether the request is closed, and the line at its top. One value, moved on by the functions below and by
 * nothing in the component.
 */
export interface DialogState {
  view: RequestView | null;
  loadFailed: boolean;
  /** The request is closed: «→» is disabled for as long as the form is open, and what was typed stays. */
  closed: boolean;
  /** The one line at the top of the form, or none. */
  top: string | null;
}

/** A form that has just been opened: nothing read yet. */
export function openedDialog(): DialogState {
  return { view: null, loadFailed: false, closed: false, top: null };
}

/**
 * The state after a reading of the request: the one the form makes when it opens, or «→» on the failed screen. A view
 * of another request is no view of this one, and a reading that brought none is the failed screen, with the line that
 * asks for «→» again; a view that was held stays under it. A request that no longer waits is shown closed.
 */
export function applyRead(state: DialogState, requestId: string, loaded: RequestView | null): DialogState {
  if (loaded === null || loaded.id !== requestId) return { ...state, loadFailed: true, top: UNAVAILABLE };
  if (loaded.state !== "pending") return applyOutcome({ ...state, loadFailed: false }, { next: afterReadClosed(), view: loaded });
  return { ...state, view: loaded, loadFailed: false, top: null };
}

/**
 * The state after an answer: of a submission (`submitEntries`) or of a decline. A view the answer brings is held in
 * place of the one before; the line at the top is the answer's, none when it has none; and once the request is closed,
 * it stays closed.
 */
export function applyOutcome(state: DialogState, outcome: { next: Next; view: RequestView | null }): DialogState {
  return {
    view: outcome.view ?? state.view,
    loadFailed: state.loadFailed,
    closed: state.closed || outcome.next.closed,
    top: outcome.next.top,
  };
}

/** What «→» does now: read the request again on the failed screen, send a form that is ready to a request that is open, or nothing. */
export function arrowAction(state: DialogState, ready: boolean): "read" | "submit" | null {
  const screen = dialogScreen(state);
  if (screen === "failed") return "read";
  return screen === "form" && ready && !state.closed ? "submit" : null;
}

/** What «✕» does: decline the request, unless it is known to be closed already, when there is nothing to decline and the form only closes. */
export function declineAction(state: Pick<DialogState, "closed">): "decline" | "close" {
  return state.closed ? "close" : "decline";
}
