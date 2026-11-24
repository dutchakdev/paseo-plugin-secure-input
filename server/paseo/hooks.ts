import type { AgentToolDefinition, PluginHookRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { SecureInputError } from "../../shared/errors";
import type { Registry } from "../core/registry";
import { within } from "./bounded";
import type { Runtime } from "./runtime";
import { TOOL_NAMES } from "./tools";

export type SessionOpenRequest = PluginHookRequests["agent.open.before"];

/**
 * How long the handler of a turn's end, or of an agent's archiving, waits at most for what it closes (`Registry.turnEnded`,
 * `Registry.agentArchived`). Removing a set is a few system calls; the bound is for a disk that stalls, and it ends the
 * wait, not the removal, which goes on in the registry's queue. Five seconds keeps an event handler that the daemon waits for from being held for longer.
 */
export const RELEASE_WAIT_MS = 5_000;

/** The plugin's own tool names, for a lookup by a name that comes with the request. */
const OWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

/**
 * The request as it came, with the plugin's tools added to `tools`. A tool already there under one of the plugin's own
 * names is an older one of its own and is replaced; any other stays. In Paseo 0.14 the list a hook is handed holds only
 * what this plugin's own earlier hooks put there: each plugin gets an empty one, and the daemon merges what the plugins
 * return afterwards (server `plugins/runtime.ts`). So the filter is defensive: no name leaves this hook twice.
 */
export function withTools(request: SessionOpenRequest, tools: readonly AgentToolDefinition[]): SessionOpenRequest {
  return { ...request, tools: [...request.tools.filter((tool) => !OWN_TOOLS.has(tool.name)), ...tools] };
}

export interface HookDeps {
  runtime: Pick<Runtime, "attach" | "turnEnded" | "agentArchived">;
  /** What a turn's start and end do to the sets of the agent's delivered requests (they arm the deletion, and fire it), and what its archiving does to its open requests. */
  turns: Pick<Registry, "turnStarted" | "turnEnded" | "agentArchived">;
  /** The plugin's tools, built for the session that opens. One that cannot be built is a failure of the hook. */
  tools(): AgentToolDefinition[];
  /** Remembers, for the diagnostics, that a hook or an event handler failed. A code, never a message. */
  failed(hook: string, code: string): void;
  /** `RELEASE_WAIT_MS` unless a test wants less. */
  releaseWaitMs?: number;
}

/** The code a failure is remembered under: ours when it is ours, `unexpected` for anything else. */
export function failureCode(error: unknown): string {
  return error instanceof SecureInputError ? error.code : "unexpected";
}

/**
 * The daemon runs the `before` hooks inside the opening of an agent's session: a throw from one fails that opening (0.14
 * passes it on as "Plugin … before agent.open.before failed"), and it gives a hook 30 seconds. So nothing here can
 * reject, and the session-open hook waits for nothing: it builds the tools and hands them over, and a call waits for the
 * start-up itself (`agentTools`). Any failure of the hook (tools that cannot be built, a payload that is not what the SDK
 * declares) is remembered as a code, and the request goes on as it came. The handlers of events are held to the same
 * rule, which the daemon only logs for; the two handlers that wait, a turn's end and an agent's archiving, wait within
 * `RELEASE_WAIT_MS`.
 */
export function registerHooks(host: Pick<PluginServerContext, "addHook">, deps: HookDeps): void {
  host.addHook("agent.open.before", async ({ request }, { paseo }) => {
    try {
      deps.runtime.attach(paseo);
      return withTools(request, deps.tools());
    } catch (error) {
      deps.failed("agent.open.before", failureCode(error));
      return request;
    }
  });

  // A turn began: a delivered request whose message was handed over before it is armed, and the end of this turn takes
  // its set (`Registry.turnStarted`). The event is read inside the guard: a payload without an agent is a failure.
  host.addHook("agent.turn.before", async (event, { paseo }) => {
    try {
      deps.runtime.attach(paseo);
      deps.turns.turnStarted(event.agent.id);
    } catch (error) {
      deps.failed("agent.turn.before", failureCode(error));
    }
  });

  // A turn ended, with any outcome. First the sets it releases, waited for within `RELEASE_WAIT_MS`: a wait that runs out
  // is no failure, and the removal goes on in the registry. Then what waits for the agent is asked for, also when the
  // releases failed: a message is never held back by them.
  host.addHook("agent.turn.after", async (event, { paseo }) => {
    try {
      deps.runtime.attach(paseo);
      const agentId = event.agent.id;
      try {
        await within(deps.releaseWaitMs ?? RELEASE_WAIT_MS, () => deps.turns.turnEnded(agentId));
      } catch (error) {
        deps.failed("agent.turn.after", failureCode(error));
      }
      deps.runtime.turnEnded(agentId);
    } catch (error) {
      deps.failed("agent.turn.after", failureCode(error));
    }
  });

  // An archived agent has no use for what it asked for, so its requests close and what waits for it is dropped. `agent.closed`
  // is deliberately not used for this: what "closed" means for an agent that can be opened again could not be established.
  host.addHook("agent.archive.after", async (event, { paseo }) => {
    try {
      deps.runtime.attach(paseo);
      const agentId = event.agent.id;
      try {
        await within(deps.releaseWaitMs ?? RELEASE_WAIT_MS, () => deps.turns.agentArchived(agentId));
      } catch (error) {
        deps.failed("agent.archive.after", failureCode(error));
      }
      deps.runtime.agentArchived(agentId);
    } catch (error) {
      deps.failed("agent.archive.after", failureCode(error));
    }
  });
}
