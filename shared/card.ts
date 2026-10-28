import { z } from "zod";
import { KEY_PATTERN, LIMITS, REQUEST_STATES, type InputRequest, type RequestState } from "./request";
import { REQUEST_ID_PATTERN } from "./request-id";

export const CARD_KIND = "secure-input-request";
export const CARD_VERSION = 2;

/**
 * The timeline row, and the contract with the client that draws it. Agents can read timelines, so this carries names
 * and state only, and the client checks what it receives against this schema: strict, so nothing else can ride along,
 * and bounded, so a row cannot be made to grow. `z.number()` already refuses NaN and the infinities.
 */
export const CardDataSchema = z
  .object({
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    state: z.enum(REQUEST_STATES),
    keys: z.array(z.string().regex(KEY_PATTERN)).max(LIMITS.fields),
    tamper: z.boolean(),
    updatedAt: z.number().min(0),
  })
  .strict();

export type CardData = z.output<typeof CardDataSchema>;

/** The row of a request: the keys it asked for, and once its values are delivered the keys that were written as files. */
export function cardData(record: {
  id: string;
  state: RequestState;
  request: InputRequest;
  written: string[] | null;
  tamper: boolean;
  updatedAt: number;
}): CardData {
  return {
    requestId: record.id,
    state: record.state,
    keys: record.written ?? record.request.fields.map((field) => field.key),
    tamper: record.tamper,
    updatedAt: record.updatedAt,
  };
}
