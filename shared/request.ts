import { z } from "zod";
import { KEY_PATTERN, LIMITS, RESERVED_KEYS, caseCollision } from "./limits";

// The patterns and the limits are declared in `./limits`, which has no schema library in it and imports nothing, so that
// a module that needs only a pattern or a number does not take the schemas along. They are part of this module as well.
export { KEY_PATTERN, LIMITS, RESERVED_KEYS };

// What the agent is told about each member. The daemon builds the input schema of `request_secret` from the shape
// below, descriptions included, and that schema is what the agent reads.
const DESCRIBED = {
  reason: "Why you need the values, in one sentence. It is kept with the request and not shown in the form: say it in your own message too.",
  fields:
    "The keys you need; each becomes a file named after it. The human can add keys and files of their own. Keys that differ only in letter case are refused.",
  key: "The name of the value and of its file: letters, digits and _, not starting with a digit.",
  label: "A short hint about the value. It is not shown on screen; a screen reader reads it.",
  optional: "The human may leave it empty; it then gets no file.",
  kind: '"text" (default): one value on one line, such as a token or a password. "file": the content of a whole file, such as a JSON key, a PEM, a kubeconfig or a .p12; it may be binary.',
  format: 'For a file only. "json" or "pem" is checked in the app before it is sent; "any" (default) is not.',
} as const;

/** One key the agent asks for. A field that names no kind is a text field. */
export const FieldSchema = z
  .object({
    key: z
      .string()
      .regex(KEY_PATTERN)
      .refine((key) => !RESERVED_KEYS.includes(key), "this key name is reserved")
      .describe(DESCRIBED.key),
    label: z.string().max(LIMITS.label).optional().describe(DESCRIBED.label),
    optional: z.boolean().optional().describe(DESCRIBED.optional),
    kind: z.enum(["text", "file"]).optional().describe(DESCRIBED.kind),
    format: z.enum(["json", "pem", "any"]).optional().describe(DESCRIBED.format),
  })
  .strict()
  .refine((field) => field.format === undefined || field.kind === "file", "format is only for a file field");

/** The members of a request, as the agent writes them: the input of the `request_secret` tool. */
export const SecretRequestShape = z
  .object({
    reason: z.string().max(LIMITS.reason).default("").describe(DESCRIBED.reason),
    fields: z.array(FieldSchema).max(LIMITS.fields).default([]).describe(DESCRIBED.fields),
  })
  .strict();

/**
 * A request as the registry takes it: the shape, and what no shape can say. Keys are unique, and they differ in more than
 * letter case: each one becomes a file, and on a volume that ignores case two such keys would be one file. A pair that
 * is an exact repeat is said once, as a repeat.
 */
export const InputRequestSchema = SecretRequestShape.superRefine((request, context) => {
  const keys = request.fields.map((field) => field.key);
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const distinct = [...new Set(keys)];
  if (distinct.length !== keys.length) issue("field keys must be unique");
  if (caseCollision(distinct) !== null) issue("field keys must differ in more than letter case");
});

export type InputRequest = z.output<typeof InputRequestSchema>;
export type Field = z.output<typeof FieldSchema>;

export const REQUEST_STATES = ["pending", "delivered", "released", "rejected", "declined", "cancelled", "expired"] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

/** States reached by a successful submission. A second, different submission to one of these is tampering. */
export const FULFILLED_STATES: ReadonlySet<RequestState> = new Set(["delivered", "released"]);
