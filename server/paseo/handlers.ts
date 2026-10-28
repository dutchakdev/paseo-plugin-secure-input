import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import {
  type DiagnosticsSchema,
  clearDrop,
  declineRequest,
  fulfillRequest,
  getRequest,
  readDiagnostics,
  selfTestBegin,
  selfTestFinish,
} from "../../shared/contracts";
import { SecureInputError } from "../../shared/errors";
import type { FulfillResult, Registry } from "../core/registry";
import { beginSelfTest, finishSelfTest } from "../core/selftest";
import { buildView } from "../core/view";
import type { Runtime } from "./runtime";

export interface HandlerDeps {
  registry: Pick<Registry, "get" | "fulfill" | "decline" | "clearDrop">;
  runtime: Pick<Runtime, "attach">;
  diagnostics(): Promise<z.input<typeof DiagnosticsSchema>>;
  /** Told a code (never a message or a value) when a handler's answer did not fit its contract. */
  report(code: string): void;
}

/**
 * What the form is told when the plugin cannot give a sound answer to a submission: the registry failed in a way
 * that is none of its refusals, or answered with something the contract cannot carry. What became of the submission
 * is not known here, and the request is not closed by this answer, so the answer does not say that it is: it is
 * `retryable`, which the form takes to mean that the request is open. The form keeps what was typed and the sealed
 * envelope and sends the same envelope again, which the registry answers the same way however often it gets it (a
 * submission it has already taken is answered as taken).
 */
const UNAVAILABLE = { ok: false as const, code: "service_unavailable" as const, retryable: true };

/**
 * An answer through the schema it will be checked against by the daemon, so that a mismatch is seen here, with a
 * code in the log, and not as an opaque rejection of the call at run time. The answer is typed as the schema's
 * input, so the compiler checks the object each handler builds; the run-time check is for what the types cannot see
 * (a value outside a bound, an answer of a registry that is not what its type says).
 */
function checked<Schema extends z.ZodType>(schema: Schema, answer: z.input<Schema>, code: string, report: (code: string) => void): z.output<Schema> | null {
  const result = schema.safeParse(answer);
  if (result.success) return result.data;
  report(code);
  return null;
}

function cannotShow(what: string): SecureInputError {
  return new SecureInputError("service_unavailable", `the ${what} cannot be shown`);
}

/**
 * The app's side. Any owner session can call these, including an agent with the daemon credential, so none of them
 * is treated as proof that a human acted, and none returns a typed value. Each one parses its own answer through its
 * contract's schema before returning it: a fulfilment that cannot be described gets a fixed refusal, and the
 * contracts that have no refusal reject with a fixed text.
 */
export function registerHandlers(host: Pick<PluginServerContext, "handle">, { registry, runtime, diagnostics, report }: HandlerDeps): void {
  host.handle(selfTestBegin, (_input, { paseo }) => {
    runtime.attach(paseo);
    const answer = checked(selfTestBegin.output, beginSelfTest(), "selftest_invalid", report);
    if (answer === null) throw cannotShow("self-test");
    return answer;
  });

  host.handle(selfTestFinish, ({ probeId, envelope, digest }, { paseo }) => {
    runtime.attach(paseo);
    const answer = checked(selfTestFinish.output, finishSelfTest(probeId, envelope, digest), "selftest_invalid", report);
    if (answer === null) throw cannotShow("self-test");
    return answer;
  });

  host.handle(getRequest, async ({ requestId }, { paseo }) => {
    runtime.attach(paseo);
    const view = checked(getRequest.output, buildView(registry, requestId), "view_invalid", report);
    if (view === null) throw cannotShow("request");
    return view;
  });

  host.handle(fulfillRequest, async ({ requestId, envelope }, { paseo }) => {
    runtime.attach(paseo);
    let result: FulfillResult;
    try {
      result = await registry.fulfill(requestId, envelope);
    } catch {
      // Not one of the registry's refusals, which are data: nothing of it is repeated.
      report("fulfill_failed");
      return UNAVAILABLE;
    }
    const answer = result.ok
      ? { ok: true as const, state: result.state }
      : result.detail === undefined
        ? { ok: false as const, code: result.code, retryable: result.retryable }
        : { ok: false as const, code: result.code, retryable: result.retryable, detail: result.detail };
    return checked(fulfillRequest.output, answer, "fulfill_invalid", report) ?? UNAVAILABLE;
  });

  host.handle(declineRequest, async ({ requestId }, { paseo }) => {
    runtime.attach(paseo);
    const answer = checked(declineRequest.output, { state: (await registry.decline(requestId)).state }, "decline_invalid", report);
    if (answer === null) throw cannotShow("decision");
    return answer;
  });

  // The human's word to delete every file. Like the rest, anyone with the owner's session can call it, an agent included,
  // and it is no proof that a human did: it deletes what the plugin deletes by itself within 15 minutes, and returns counts.
  // A registry that refuses it (the plugin is stopping, the drop cannot be swept) is an error of the call, so that the
  // screen does not take a deletion that did not happen for one that did.
  host.handle(clearDrop, async (_input, { paseo }) => {
    runtime.attach(paseo);
    const answer = checked(clearDrop.output, await registry.clearDrop(), "clear_invalid", report);
    if (answer === null) throw cannotShow("deletion");
    return answer;
  });

  host.handle(readDiagnostics, async (_input, { paseo }) => {
    runtime.attach(paseo);
    const answer = checked(readDiagnostics.output, await diagnostics(), "diagnostics_invalid", report);
    if (answer === null) throw cannotShow("diagnostics");
    return answer;
  });
}
