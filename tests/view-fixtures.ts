import type { RequestView } from "../shared/view";

export const REQUEST_ID = "r_0123456789abcdef0123456789abcdef";

type FieldView = RequestView["fields"][number];

/** A text field of a view, as the daemon builds it: one value on one line, with no format. */
export function text(key: string, optional = false, label = ""): FieldView {
  return { key, label, optional, kind: "text", format: null };
}

/** A file field of a view: the format the agent asked for, `any` when it named none. */
export function file(key: string, format: "json" | "pem" | "any" = "any", optional = false, label = ""): FieldView {
  return { key, label, optional, kind: "file", format };
}

/** A pending request that asks for one text field, `A`; `overrides` change what a test is about. */
export function viewOf(overrides: Partial<RequestView> = {}): RequestView {
  return {
    id: REQUEST_ID,
    state: "pending",
    tamper: false,
    errorCode: null,
    fields: [text("A")],
    publicKey: "P".repeat(43),
    requestDigest: "d".repeat(64),
    createdAt: 1,
    ...overrides,
  };
}

/** The view of a pending request that asks for these fields. */
export function view(fields: FieldView[]): RequestView {
  return viewOf({ fields });
}
