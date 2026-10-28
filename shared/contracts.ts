import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ERROR_CODES } from "./errors";
import { DETAIL_MAX, DIGEST_PATTERN, DIRECTORY_MAX, PUBLIC_KEY_PATTERN } from "./limits";
import { REQUEST_STATES } from "./request";
import { REQUEST_ID_PATTERN } from "./request-id";
import { AEAD_TAG_BYTES, MAX_PAYLOAD_BYTES } from "./seal";
import { RequestViewSchema } from "./view";

/**
 * The most characters the `ct` of a submission can have: the unpadded base64url text of the largest payload
 * (`MAX_PAYLOAD_BYTES`) and the tag (three bytes make four characters, a remainder of n bytes makes n + 1). A test
 * builds the largest payload the per-field limits allow, seals it, and finds this number exactly.
 */
export const ENVELOPE_CT_MAX = Math.ceil(((MAX_PAYLOAD_BYTES + AEAD_TAG_BYTES) * 4) / 3);

/** An ephemeral X25519 key is 32 bytes, 43 characters; the ChaCha20-Poly1305 nonce is 12 bytes, 16 characters. */
export const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    epk: z.string().regex(PUBLIC_KEY_PATTERN),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ct: z
      .string()
      .max(ENVELOPE_CT_MAX)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

const RequestIdInput = z.object({ requestId: z.string().regex(REQUEST_ID_PATTERN) }).strict();

const PATH_MAX = DIRECTORY_MAX + 64;

export const selfTestBegin = defineRpc({
  name: "secure-input.selftest.begin",
  input: z.object({}).strict(),
  output: z.object({ probeId: z.string().regex(/^p_[0-9a-f]{16}$/), publicKey: z.string().regex(PUBLIC_KEY_PATTERN) }).strict(),
});

export const selfTestFinish = defineRpc({
  name: "secure-input.selftest.finish",
  input: z
    .object({ probeId: z.string().regex(/^p_[0-9a-f]{16}$/), envelope: EnvelopeSchema, digest: z.string().regex(DIGEST_PATTERN) })
    .strict(),
  output: z.object({ ok: z.boolean(), bytes: z.number().int().min(0) }).strict(),
});

export const getRequest = defineRpc({ name: "secure-input.request.get", input: RequestIdInput, output: RequestViewSchema });

/**
 * Carries ciphertext only: the request it is for, and the sealed values. A refusal is data, not an exception, so no
 * error text travels through the daemon but the `detail` an earlier module wrote for a person (key names, an errno
 * name, a fixed phrase; never a value).
 */
export const fulfillRequest = defineRpc({
  name: "secure-input.request.fulfill",
  input: z.object({ requestId: z.string().regex(REQUEST_ID_PATTERN), envelope: EnvelopeSchema }).strict(),
  output: z.union([
    z.object({ ok: z.literal(true), state: z.enum(REQUEST_STATES) }).strict(),
    z
      .object({ ok: z.literal(false), code: z.enum(ERROR_CODES), retryable: z.boolean(), detail: z.string().max(DETAIL_MAX).optional() })
      .strict(),
  ]),
});

export const declineRequest = defineRpc({
  name: "secure-input.request.decline",
  input: RequestIdInput,
  output: z.object({ state: z.enum(REQUEST_STATES) }).strict(),
});

const Persistence = z.enum(["ok", "failing"]);
const Count = z.number().int().min(0);

/**
 * Names, counts and codes. No value of a request. `registry.drop` is `failing` while the last sweep of `drop/` left
 * something it could not remove, or a set could not be removed when it was released.
 */
export const DiagnosticsSchema = z
  .object({
    attached: z.boolean(),
    dataDir: z.string().max(PATH_MAX),
    registry: z
      .object({ persistence: Persistence, drop: Persistence, stored: z.enum(["ok", "unreadable"]), dropped: Count })
      .strict(),
    outbox: z.object({ persistence: Persistence, unsaved: Count, dropped: Count }).strict(),
    /**
     * How many requests wait for the human (`pending`), how many sets of files are on the daemon (`delivered`), and when
     * the nearest of those sets goes at the latest, in the plugin's clock (`nextDeleteBy`, null while none is there).
     */
    requests: z.object({ pending: Count, delivered: Count, nextDeleteBy: z.number().int().min(0).nullable() }).strict(),
    /** Why the plugin did not start, as a code and a fixed phrase; null when it did. */
    startup: z.object({ code: z.enum([...ERROR_CODES, "unexpected"]), detail: z.string().max(300) }).strict().nullable(),
    /**
     * How many requests have a card that the timeline is not known to show yet. It is tried again once a minute, and
     * once in five while the daemon has left three appends of it unanswered.
     */
    cardsOwed: Count,
    /**
     * Whether messages to agents are held back: true from the moment the plugin starts until its start-up has read
     * the requests, and for good when the start-up failed before that or never got there. What waits then stays in
     * the outbox file for the next start.
     */
    messagesHeld: z.boolean(),
    /** `<hook>: <code>` of the last hook or event handler that failed. */
    lastHookFailure: z.string().max(128).nullable(),
  })
  .strict();

/** What `readDiagnostics` answers. */
export type Diagnostics = z.output<typeof DiagnosticsSchema>;

export const readDiagnostics = defineRpc({
  name: "secure-input.diagnostics.read",
  input: z.object({}).strict(),
  output: DiagnosticsSchema,
});

/**
 * The human's word to delete every set of files at once (the settings screen). It answers with how many requests it
 * released and how many entries of `drop/` it could not remove; no path, no name, no value. A refusal (the plugin is
 * stopping, the drop cannot be swept) is an error of the call.
 */
export const clearDrop = defineRpc({
  name: "secure-input.drop.clear",
  input: z.object({}).strict(),
  output: z.object({ released: Count, stuck: Count }).strict(),
});
