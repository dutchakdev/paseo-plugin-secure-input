import { SecureInputError } from "../../shared/errors";
import { LIMITS } from "../../shared/request";
import { sanitizeText } from "../../shared/sanitize";
import type { RequestView } from "../../shared/view";
import type { Registry, RequestRecord } from "./registry";

/** Assembles what the form is given of a request. Agent-supplied text is scrubbed here, on the daemon, before it leaves. */
export function buildView(registry: Pick<Registry, "get">, requestId: string): RequestView {
  const record = registry.get(requestId);
  if (record === undefined) throw new SecureInputError("invalid_request", "unknown request");
  return composeView(record);
}

/**
 * The view of a request, from its record. Pure, so that the registry can build the view of a request it is about to
 * create and refuse the creation if that view is one the form's contract would not take.
 *
 * Of what the agent wrote, only the labels go, scrubbed: a screen reader reads them. A field that names no kind is a
 * text field, and a file field that names no format is checked as `any`.
 */
export function composeView(record: RequestRecord): RequestView {
  return {
    id: record.id,
    state: record.state,
    tamper: record.tamper,
    errorCode: record.errorCode,
    fields: record.request.fields.map((field) => ({
      key: field.key,
      label: sanitizeText(field.label ?? "", LIMITS.label),
      optional: field.optional === true,
      kind: field.kind ?? "text",
      format: field.kind === "file" ? (field.format ?? "any") : null,
    })),
    publicKey: record.publicKey,
    requestDigest: record.requestDigest,
    createdAt: record.createdAt,
  };
}
