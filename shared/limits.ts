// The patterns and the limits that more than one module goes by, and nothing else: no schema library, no import at all.
// The request schemas (`./request`) are built from these. What both halves of the plugin must agree on (a count, a path
// length, an id) is declared here once, and the daemon and the app import it.

export const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names a plain object would treat specially. A key like these never reaches a file. */
export const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * The limits on what a request may hold. Those on text (a reason, a label, a key) are in code points, which is what the
 * schemas count and what a check written by hand counts with `codePointLength`; the two that guard what is written to
 * a file, `valueBytes` (a text field) and `fileBytes` (a file field), are in bytes, as their names say: of UTF-8 for a
 * text, the file's own bytes for a file.
 */
export const LIMITS = {
  reason: 300,
  label: 80,
  fields: 32,
  key: 128,
  valueBytes: 64 * 1024,
  fileBytes: 128 * 1024,
} as const;

/** How long a delivered set of files may stay on the daemon at the most, from the moment it was written: 15 minutes. */
export const DROP_TTL_MS = 900_000;

/** The version of the plugin, as the settings screen says it. `tests/mirrored-constants.test.ts` holds it equal to the version in `package.json`. */
export const PLUGIN_VERSION = "0.2.0";

/** The release of Paseo the plugin needs, as the settings screen says it. The same test holds it to the requirement in `paseo-plugin.json`. */
export const PASEO_SINCE = "Paseo 0.14+";

/**
 * The most bytes one Paseo RPC message may have on its way from either app to the daemon: the smallest limit on that
 * path, as Paseo 0.14.0-beta.1 sets it (getpaseo/paseo at the tag `v0.14.0-beta.1`).
 *
 * - The desktop app talks to the daemon's WebSocket. Its limit is `MAX_WEBSOCKET_MESSAGE_BYTES`, 100 MiB
 *   (packages/protocol/src/websocket-message-limit.ts:2): the daemon's `maxPayload`
 *   (packages/server/src/server/websocket-server.ts:879), which the client checks before it sends a frame
 *   (packages/client/src/daemon-client.ts:1174).
 * - The phone usually talks through the relay. Its limit is `MAX_RELAY_WEBSOCKET_MESSAGE_BYTES`, 32 MiB of encrypted
 *   frame (packages/protocol/src/websocket-message-limit.ts:5), which the client checks against the frame's size on
 *   the wire (packages/client/src/daemon-client-relay-e2ee-transport.ts:236). The plaintext that fits in it is
 *   `maxSecuredPlaintextByteLength(MAX_RELAY_WEBSOCKET_MESSAGE_BYTES)` (packages/relay/src/secure-channel.ts:716), the
 *   size the daemon itself gives a message that must cross the relay (packages/server/src/utils/checkout-git.ts:2187):
 *   the smaller of the legacy bound, `floor(32 MiB / 4) * 3 - 40` = 25,165,784
 *   (packages/relay/src/encrypted-channel.ts:127), and the protected-record bound, 24 bytes of each chunk of 65,513
 *   (packages/relay/src/protected-records.ts:32-42), which is 25,156,584.
 * - A plugin RPC has no cap of its own on the way: the message takes any input (`PluginRpcInvokeRequestSchema`,
 *   packages/protocol/src/messages.ts:1587), the session hands it on (packages/server/src/server/session.ts:2596), and
 *   the runtime sends it to the plugin's process over Node's IPC (packages/server/src/server/plugins/runtime.ts:495 and
 *   :236-241).
 *
 * So the relay's plaintext is the limit. `tests/mirrored-constants.test.ts` holds this number to the installed packages.
 */
export const PASEO_RPC_MAX_BYTES = 25_156_584;

/** What the fulfil RPC adds around the ciphertext (the request id, the envelope's other members, the frame of the message), with margin. */
export const RPC_FRAME_MARGIN = 4096;

/**
 * How many submissions to one request may fail in a way that counts (the sealed values could not be opened) before
 * the request is closed with `retry_limit`. Both halves say this number in words, the app to the human and the plugin
 * to the agent, and both build the sentence from it.
 */
export const MAX_RETRIES = 3;

/**
 * The most of a refusal's detail that is kept: the plugin's own words about a problem (a key, a path, a fixed phrase),
 * never a library's. The daemon cuts a detail to this, and the contracts bound it by it.
 */
export const DETAIL_MAX = 1024;

/** A directory the plugin stores or shows: the working directory of a request. PATH_MAX on Linux. */
export const DIRECTORY_MAX = 4096;

/**
 * The bound on an agent id in what the plugin keeps (a stored request, a queued message). A record or an item that was
 * valid once must stay valid, and the daemon's own ids are far shorter.
 */
export const STORED_AGENT_ID_MAX = 256;

/** A SHA-256 as 64 lowercase hex characters: the digest of what a request asked for, or of a submission. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** A public key (32 bytes of X25519: a request's key, a sealed envelope's ephemeral key) as 43 characters of unpadded base64url. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whether `key` may name a value that is written to a file: the pattern, and not a name a plain object treats specially. */
export function isValidKey(key: unknown): key is string {
  return typeof key === "string" && KEY_PATTERN.test(key) && !RESERVED_KEYS.includes(key);
}

/**
 * What a request's set of files is called on the daemon: `<data>/drop/si-secret-<requestId>/`. It is declared here because
 * more than the store goes by it: the skill tells an agent never to read a path that has it.
 */
export const DROP_PREFIX = "si-secret-";

/**
 * The first two keys that name one file when letter case is ignored (an exact repeat counts), or null. A set has one file
 * for each key, and on a volume that ignores case (the macOS default) `API_KEY` and `api_key` are one file, so the second
 * would not be a second file. The keys are refused where a request is made, where a submission arrives and where the set
 * is written, and so they are refused alike on every volume. The pair comes in the order the keys were given: the key that
 * closes the first collision, and the earlier one it collides with. A map does the looking up, so that a key an object
 * would treat specially (`constructor`) collides with nothing but itself.
 */
export function caseCollision(keys: readonly string[]): readonly [string, string] | null {
  const seen = new Map<string, string>();
  for (const key of keys) {
    const folded = key.toLowerCase();
    const earlier = seen.get(folded);
    if (earlier !== undefined) return [earlier, key];
    seen.set(folded, key);
  }
  return null;
}
