import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SecureInputError } from "../../shared/errors";
import { writePrivateFileIf, type StillWanted } from "./atomic";
import { errnoToken } from "./descriptor";
import { holdDirectory } from "./directory";

/** What an agent created under v1 is told when it calls a tool of its old server or runs the old CLI. */
export const LEGACY_TEXT = "secure-input now gives its tools through Paseo itself. This old server has none. Do not ask for the secret in chat instead.";

/**
 * What takes the place of v1's bridge in `<data>/bin/bridge.cjs`. An agent created under v1 keeps, in its stored
 * configuration, an MCP server that runs `<data>/bin/secure-input mcp --binding <id>`, and its shell may run the same shim
 * as a CLI. The shim runs this script with Node, which has nothing installed beside it: CommonJS and Node's built-ins only.
 *
 * As an MCP server (newline-delimited JSON-RPC on stdio) it has no tools: `initialize`, `ping` and `tools/list` are
 * answered, a tool call gets `LEGACY_TEXT` as a tool error, and any other request is a method that is not found. What
 * needs no answer gets none: a notification, an id that cannot be sent back as it came, a message without a method, a
 * line that is not JSON. It ends with its input. In any other mode it prints the refusal and exits 1.
 */
export const LEGACY_STUB_SOURCE = `"use strict";
// Written by the secure-input plugin in place of the bridge of v1. Its tools now come from Paseo itself.
const TEXT = ${JSON.stringify(LEGACY_TEXT)};
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

function answer(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(message)) return;
  const id = message.id;
  if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) return;
  if (typeof message.method !== "string") return;
  const result = (value) => write({ jsonrpc: "2.0", id, result: value });
  switch (message.method) {
    case "initialize": {
      const asked = isRecord(message.params) ? message.params.protocolVersion : undefined;
      return result({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "secure-input", version: "0.2.0" },
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: [] });
    case "tools/call":
      return result({ content: [{ type: "text", text: TEXT }], isError: true });
    default:
      return write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

if (process.argv[2] === "mcp") {
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("line", answer);
  lines.on("close", () => process.stdout.write("", () => process.exit(0)));
} else {
  process.stdout.write(JSON.stringify({ error: "service_unavailable", message: TEXT }) + "\\n", () => process.exit(1));
}
`;

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Puts the stub where v1 left its bridge, so that an agent created under v1 meets a server with no tools and no error,
 * and under Node points the shim at the daemon's own Node: the one v1 wrote down may have been upgraded away since. Under
 * Electron the shim stays as v1 wrote it, because Electron's binary runs no script as Node.
 *
 * Only where v1 installed: without `<data>/bin` nothing is made (`absent`). The directory holds code an agent executes,
 * so it gets v1's rule: a real directory of this user, held at 0700, never a link. Both paths that go into the shim must
 * be absolute; a relative one would depend on the working directory of whoever runs it.
 *
 * It is a step of the start-up, and `stillWanted` is that start-up's question, asked for each file before anything of it
 * is written and again right before it is put in place (`writePrivateFileIf`). On "no" that file and the one after it
 * are not written, what was there stays (it may be what the plugin started after this one wrote), and the answer is
 * `not_wanted`.
 */
export async function replaceLegacyBridge(
  dataDir: string,
  runtime: { kind: "node" | "electron"; execPath: string },
  stillWanted: StillWanted = () => true,
): Promise<"replaced" | "absent" | "not_wanted"> {
  const { kind, execPath } = runtime;
  if (!isAbsolute(dataDir)) throw new SecureInputError("service_unavailable", "the data directory must be an absolute path");
  if (kind === "node" && !isAbsolute(execPath)) throw new SecureInputError("service_unavailable", "the node path must be an absolute path");
  const bin = join(dataDir, "bin");
  try {
    await lstat(bin);
  } catch (error) {
    if (errnoToken(error) === "ENOENT") return "absent";
    // Anything else is said by the hold, in its own words.
  }
  await holdDirectory(bin, "bridge");
  const bridge = join(bin, "bridge.cjs");
  if (!(await writePrivateFileIf(bridge, LEGACY_STUB_SOURCE, 0o700, stillWanted))) return "not_wanted";
  if (kind === "electron") return "replaced";
  const shim = `#!/bin/sh\nexec ${quote(execPath)} ${quote(bridge)} "$@"\n`;
  return (await writePrivateFileIf(join(bin, "secure-input"), shim, 0o700, stillWanted)) ? "replaced" : "not_wanted";
}
