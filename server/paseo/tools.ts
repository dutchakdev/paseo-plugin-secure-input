import { defineAgentTool, type AgentToolContext, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import { SecureInputError } from "../../shared/errors";
import { DROP_TTL_MS } from "../../shared/limits";
import { SecretRequestShape } from "../../shared/request";
import { REQUEST_ID_PATTERN } from "../../shared/request-id";
import type { AgentIdentity, Registry, RequestRecord } from "../core/registry";
import { filePath } from "../io/drop";
import type { StartupProblem } from "./plugin";
import type { Runtime } from "./runtime";

/** The agent the daemon hands to a tool's `execute`: the SDK's `PluginHookAgent`. */
export interface ToolAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

/** The names of the plugin's tools. A tool of one of these names that comes with a session is an older one of its own. */
export const TOOL_NAMES = ["request_secret", "request_status", "cancel_request", "release_secret"] as const;

export const NOT_STARTED = "the plugin has not finished starting; retry in a few seconds";
export const START_FAILED = (code: string) => `the plugin did not start (${code}). Tell the user. Do not ask for the secret in chat instead.`;
/** What any failure that is not one of the plugin's refusals becomes: nothing of its own message is passed on. */
export const NOT_HANDLED = "the request could not be handled";

export interface ToolDeps {
  registry: Pick<Registry, "create" | "get" | "cancel" | "release" | "check">;
  runtime: Pick<Runtime, "attach">;
  /** How the start-up ended, waited for within `STARTUP_WAIT_MS`: its problem, `null` for none, or "pending" when it has not ended. */
  started(): Promise<StartupProblem | null | "pending">;
  /** `<data>/drop`, where the sets are: the paths a status names. */
  drop: string;
}

/** The most minutes a set of files stays: what the agent is told. */
const MINUTES = DROP_TTL_MS / 60_000;

// Each member of the input is described in its own schema (`SecretRequestShape`), which the daemon hands on to the agent.
const REQUEST_SECRET =
  "Ask the human for secret values (passwords, API keys, tokens, private keys, connection strings, whole credential files) through a secure form in the Paseo app. " +
  "Each value is written, exactly as typed or as the file was, to its own short-lived file that only your OS user can read; you receive the paths, never the values. " +
  "Use this instead of asking for a secret in chat or asking the user to edit a file. " +
  'It returns at once with status "pending": end your turn, and a message with the paths arrives when the user has submitted. Do not poll. ' +
  "Never read, print, open, compare or log a file or directory whose name starts with si-secret-. " +
  "Move each value where it belongs without reading it (`command < PATH`, `cp PATH DESTINATION`), then delete the directory or call release_secret. " +
  `The files are deleted at the end of the turn the message starts, and ${MINUTES} minutes after they were written at the latest.`;

const REQUEST_STATUS =
  "The state of one of your requests, its keys and whether a second submission reached it; while its files exist, the path of each file and when they are deleted. Never returns values. " +
  "Use it when the user says no form appeared or that they answered and you heard nothing; it is not for polling.";

const CANCEL_REQUEST =
  "Withdraw one of your own pending requests, when the values are no longer needed. " +
  "Never use it to clear request_already_pending for a request the user may be answering: wait for that request instead.";

const RELEASE_SECRET = `Delete the files of one of your delivered requests now, once each value is where it belongs. The same as deleting its directory. Without it the files go at the end of the turn the message started, or after ${MINUTES} minutes.`;

const RequestIdInput = z.object({ requestId: z.string().regex(REQUEST_ID_PATTERN) }).strict();

/**
 * Where the files of a delivered request are, key by key in the order they were written, and when they are deleted at
 * the latest (ISO 8601); both null for a request that has no files. Paths only: what is in the files is never read.
 */
function filesOf(record: RequestRecord, drop: string): { files: Record<string, string> | null; deleteBy: string | null } {
  if (record.state !== "delivered" || record.written === null || record.deleteBy === null) return { files: null, deleteBy: null };
  return { files: Object.fromEntries(record.written.map((key) => [key, filePath(drop, record.id, key)])), deleteBy: new Date(record.deleteBy).toISOString() };
}

/**
 * Who is asking: the agent identity Paseo supplies with the call, and nothing the call itself says (an argument, the
 * agent's environment, a marker). Cross-agent impersonation is a host limitation; see SECURITY.md.
 */
export function identityOf(agent: ToolAgent): AgentIdentity {
  return { agentId: agent.id, cwd: agent.cwd, title: agent.title };
}

/**
 * What a tool gives back. An answer is its JSON, as text and as structured content alike. The plugin's own refusal is
 * its code and its words, which are the plugin's (a key, a request id, a fixed phrase). Anything else, and an answer JSON
 * cannot carry, is one fixed refusal: what a library or the system wrote is never passed on. Never rejects.
 */
export async function toolResult(run: () => Promise<object>): Promise<{ text: string; structuredContent?: object; isError?: true }> {
  try {
    const answer = await run();
    const text: unknown = JSON.stringify(answer);
    if (typeof text !== "string") throw new TypeError("the answer is not JSON");
    return { text, structuredContent: answer };
  } catch (error) {
    const refusal = error instanceof SecureInputError ? error : new SecureInputError("service_unavailable", NOT_HANDLED);
    return { isError: true, text: JSON.stringify({ error: refusal.code, message: refusal.message }) };
  }
}

/**
 * The tools the session-open hook gives every agent. Each call is made as the agent the daemon hands to `execute`.
 * It takes the daemon's API first, as every hook and RPC does; then waits for the start-up, within its bound, and is
 * refused in fixed words while that has not ended or when it failed; and only then does what it is for.
 */
export function agentTools({ registry, runtime, started, drop }: ToolDeps): AgentToolDefinition[] {
  // Each operation goes to the registry with the call's signal (`CallTerms`): an operation whose call was canceled, or
  // whose turn in the registry's queue has not come within `ADMISSION_WAIT_MS`, is refused and never begun, and one that
  // has begun is waited for to the end.
  const answer = (paseo: AgentToolContext["paseo"], operation: () => Promise<object>) =>
    toolResult(async () => {
      runtime.attach(paseo);
      const state = await started();
      if (state === "pending") throw new SecureInputError("service_unavailable", NOT_STARTED);
      if (state !== null) throw new SecureInputError("service_unavailable", START_FAILED(state.code));
      return operation();
    });

  /** The caller's own request. One that is not theirs and one that does not exist are answered alike, before anything else is looked at. */
  const own = (agent: ToolAgent, requestId: string) => {
    const record = registry.get(requestId);
    if (record === undefined || record.agentId !== agent.id) throw new SecureInputError("invalid_request", "unknown request");
    return record;
  };

  return [
    defineAgentTool({
      name: "request_secret",
      description: REQUEST_SECRET,
      input: SecretRequestShape,
      // The shape is what the daemon checks a call against; the registry holds the input to the whole request schema.
      execute: (input, { agent, paseo, signal }) => answer(paseo, () => registry.create(identityOf(agent), input, { signal })),
    }),
    defineAgentTool({
      name: "request_status",
      description: REQUEST_STATUS,
      input: RequestIdInput,
      // What an agent may know of its own request: the state, the keys it asked for and the keys that were written as
      // files, how it ended, whether a second, different submission reached it (`tamper`), and while its files exist,
      // the path of each and when they go. Names, codes and paths only. The owner is checked before the registry looks:
      // the look releases a set the agent took away itself, which nobody else's call may do.
      execute: (input, { agent, paseo, signal }) =>
        answer(paseo, async () => {
          own(agent, input.requestId);
          const record = await registry.check(input.requestId, { signal });
          // Gone from the history between the two looks: as unknown as any other.
          if (record === undefined) throw new SecureInputError("invalid_request", "unknown request");
          return {
            requestId: input.requestId,
            state: record.state,
            keys: record.request.fields.map((field) => field.key),
            written: record.written,
            tamper: record.tamper,
            errorCode: record.errorCode,
            ...filesOf(record, drop),
          };
        }),
    }),
    defineAgentTool({
      name: "cancel_request",
      description: CANCEL_REQUEST,
      input: RequestIdInput,
      execute: (input, { agent, paseo, signal }) =>
        answer(paseo, async () => {
          own(agent, input.requestId);
          return { requestId: input.requestId, state: (await registry.cancel(agent.id, input.requestId, { signal })).state };
        }),
    }),
    defineAgentTool({
      name: "release_secret",
      description: RELEASE_SECRET,
      input: RequestIdInput,
      // The registry holds the request to its owner again, and refuses one with no files in its own words.
      execute: (input, { agent, paseo, signal }) =>
        answer(paseo, async () => {
          own(agent, input.requestId);
          return { requestId: input.requestId, state: (await registry.release(agent.id, input.requestId, { signal })).state };
        }),
    }),
  ];
}
