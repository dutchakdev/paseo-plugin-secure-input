import { z } from "zod";
import { ERROR_CODES } from "./errors";
import { DIGEST_PATTERN, PUBLIC_KEY_PATTERN } from "./limits";
import { KEY_PATTERN, LIMITS, REQUEST_STATES } from "./request";
import { REQUEST_ID_PATTERN } from "./request-id";
import { shown } from "./shown";

/**
 * One field of the form: the key the agent asked for, its label (the agent's words, scrubbed, which a screen reader
 * reads and nobody sees), whether it may stay empty, and whether it is one line of text or a whole file. A file field
 * has the format the app checks it against (`any` when the agent named none); a text field has none.
 */
const FieldViewSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN),
    label: shown(LIMITS.label),
    optional: z.boolean(),
    kind: z.enum(["text", "file"]),
    format: z.enum(["json", "pem", "any"]).nullable(),
  })
  .strict()
  .refine((field) => (field.kind === "file") === (field.format !== null), "a file field has a format, and a text field none");

/**
 * What the form receives: the request's state and tamper flag, the code it was rejected with, the fields, and the key
 * and digest a submission is sealed to. Nothing of the agent's but the scrubbed labels: the reason is kept with the
 * request and shown nowhere, and the agent's title is not shown either.
 */
export const RequestViewSchema = z
  .object({
    id: z.string().regex(REQUEST_ID_PATTERN),
    state: z.enum(REQUEST_STATES),
    tamper: z.boolean(),
    errorCode: z.enum(ERROR_CODES).nullable(),
    fields: z.array(FieldViewSchema).max(LIMITS.fields),
    publicKey: z.string().regex(PUBLIC_KEY_PATTERN),
    requestDigest: z.string().regex(DIGEST_PATTERN),
    createdAt: z.number().int().min(0),
  })
  .strict();

export type RequestView = z.output<typeof RequestViewSchema>;
