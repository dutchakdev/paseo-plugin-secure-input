import { isAbsolute } from "node:path";
import { z } from "zod";
import { ERROR_CODES } from "../../shared/errors";
import { DIGEST_PATTERN, DIRECTORY_MAX, LIMITS, MAX_RETRIES, PUBLIC_KEY_PATTERN, STORED_AGENT_ID_MAX, caseCollision, isValidKey } from "../../shared/limits";
import { FULFILLED_STATES, InputRequestSchema, REQUEST_STATES } from "../../shared/request";
import { REQUEST_ID_PATTERN } from "../../shared/request-id";
import { hasUnsafeCharacters } from "../../shared/sanitize";
import { shown } from "../../shared/shown";
import { writePrivateFile } from "../io/atomic";
import { readPrivateFile } from "../io/private-file";

// Declared in `shared/limits`, where the app can read it too: it says the number to the human, in words.
export { MAX_RETRIES };
export const HISTORY = 200;
/**
 * The most of `requests.json` that is read or written. The file is writable by the agent, so a larger one was not
 * written by this module; and this module does not write one: when the records would not fit, the oldest closed ones
 * are left out until they do (`encodeRecords`). A typical record is 0.7 KB (measured), the largest the schema allows
 * is 18 KB (32 file fields with 128 character keys and 80 character labels, all 32 keys written, a 4096 character
 * directory, all ASCII; measured). 2 MiB is the room for the 400 records the reader looks at at 5 KB each, seven times
 * a typical one: everything ordinary fits, and a run of the largest still leaves the 113 newest.
 */
export const MAX_REQUESTS_BYTES = 2 * 1024 * 1024;
/** An honest file holds HISTORY records and a few open ones: only the end of a longer list is looked at. */
const MAX_RESTORED = 2 * HISTORY;

/** The most of an agent's title that is kept. The registry cuts a title to this before it makes a record. */
export const TITLE_MAX = 200;

/**
 * How a request came to be `expired`: nobody answered within its time (`time`), or the plugin started again while it
 * was open and the key to open it was gone (`restart`). The agent is told the one or the other (see `continuationText`).
 */
export const EXPIRED_BY = ["time", "restart"] as const;
export type ExpiredBy = (typeof EXPIRED_BY)[number];

/**
 * How the files of a delivered request came to be gone, and so the request `released`: the agent released them or took
 * the set away itself (`agent`), the turn the delivery message started ended (`turn`), their time was up (`time`), the
 * plugin started again (`restart`) or stopped (`stop`), or the human deleted every set (`human`). A delivery message
 * that still waits says the files are gone for the last four, and is dropped for the first two (see `continuationText`).
 */
export const RELEASED_BY = ["agent", "turn", "time", "restart", "stop", "human"] as const;
export type ReleasedBy = (typeof RELEASED_BY)[number];

/** The keys a set was written with, in the order they were written: valid keys, of which no two name one file. */
const WrittenKeys = z
  .array(z.string().refine(isValidKey, "not a valid key name"))
  .min(1)
  .max(LIMITS.fields)
  .refine((keys) => caseCollision(keys) === null, "keys that differ only in letter case");

/** What `requests.json` holds for one request, and so what a request is: there is no field a typed value could go into. */
export const RecordSchema = z
  .object({
    id: z.string().regex(REQUEST_ID_PATTERN),
    agentId: shown(STORED_AGENT_ID_MAX).min(1),
    // The root of the path the human reads: text, like the path itself.
    agentCwd: shown(DIRECTORY_MAX)
      .min(1)
      .refine((path) => isAbsolute(path), "not an absolute path"),
    agentTitle: shown(TITLE_MAX).nullable(),
    request: InputRequestSchema.refine(
      (request) => !hasUnsafeCharacters(request.reason) && request.fields.every((field) => !hasUnsafeCharacters(field.label ?? "")),
      "unsafe characters in text shown to the human",
    ),
    state: z.enum(REQUEST_STATES),
    publicKey: z.string().regex(PUBLIC_KEY_PATTERN),
    /** The digest of what the request asked for, which the submission is sealed to (`requestDigestOf`). */
    requestDigest: z.string().regex(DIGEST_PATTERN),
    retries: z.number().int().min(0).max(MAX_RETRIES),
    tamper: z.boolean(),
    errorCode: z.enum(ERROR_CODES).nullable(),
    /** The digest of the submission that was delivered, so that the same one sent again is answered as taken. */
    fulfilledDigest: z.string().regex(DIGEST_PATTERN).nullable(),
    /** The keys of the set that was written. */
    written: WrittenKeys.nullable(),
    /** When the set is deleted at the latest, in the registry's clock. */
    deleteBy: z.number().int().min(0).nullable(),
    /** Exactly with the state `released`. */
    releasedBy: z.enum(RELEASED_BY).optional(),
    /** Only with the state `expired`. A record expired by a version that did not keep it has none, and reads as `time`. */
    expiredBy: z.enum(EXPIRED_BY).optional(),
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
  })
  .strict()
  .superRefine((record, context) => {
    // A delivery leaves its digest, its keys and its deadline together, and nothing else has any of them.
    const delivery = [record.fulfilledDigest, record.written, record.deleteBy];
    const fits =
      (record.expiredBy === undefined || record.state === "expired") &&
      (record.releasedBy !== undefined) === (record.state === "released") &&
      (FULFILLED_STATES.has(record.state) ? delivery.every((part) => part !== null) : delivery.every((part) => part === null));
    if (!fits) context.addIssue({ code: "custom", message: "the state and what the record says of its end do not fit together" });
  });

export type RequestRecord = z.output<typeof RecordSchema>;

/** Open: waiting for the human, or delivered and its files not yet gone. An open record never leaves the history. */
export const isOpen = (record: RequestRecord): boolean => record.state === "pending" || record.state === "delivered";

/** A record, or null when it is not one this module could have written. */
export function parseRecord(candidate: unknown): RequestRecord | null {
  const parsed = RecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the lists of an item are no longer than their schemas allow, looked at before the schema is: a list of
 * hundreds of thousands of empty objects costs the schema half a second to refuse, an issue for each. Anything else is
 * left to the schema.
 */
function withinLimits(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return true;
  const { request, written } = item as { request?: unknown; written?: unknown };
  const tooLong = (list: unknown) => Array.isArray(list) && list.length > LIMITS.fields;
  if (typeof request === "object" && request !== null && tooLong((request as { fields?: unknown }).fields)) return false;
  return !tooLong(written);
}

export interface StoredState {
  /** The records that pass, oldest first. */
  records: RequestRecord[];
  /** `unreadable`: there is a file, and it could not be read or is no list. Only a missing file is an empty state. */
  status: "ok" | "unreadable";
  /** Entries of the file that were not loaded: invalid, repeating an id, or older than the end of the list that is looked at. */
  dropped: number;
}

/**
 * The records of `requests.json` that pass. It is a file the agent can write: read capped and without following a link,
 * checked record by record, and nothing else of it is used. A file that cannot be read is survived (the state starts
 * empty) but reported.
 */
export async function readStored(file: string, limit = MAX_REQUESTS_BYTES): Promise<StoredState> {
  let parsed: unknown;
  try {
    const text = await readPrivateFile(file, limit);
    if (text === null) return { records: [], status: "ok", dropped: 0 };
    parsed = JSON.parse(text);
  } catch {
    return { records: [], status: "unreadable", dropped: 0 };
  }
  if (!Array.isArray(parsed)) return { records: [], status: "unreadable", dropped: 0 };
  const window = parsed.slice(-MAX_RESTORED);
  let dropped = parsed.length - window.length;
  const records = new Map<string, RequestRecord>();
  for (const item of window) {
    const record = withinLimits(item) ? parseRecord(item) : null;
    // The first of two with one id is the one that is kept; the other is not reported on either.
    if (record === null || records.has(record.id)) dropped += 1;
    else records.set(record.id, record);
  }
  return { records: [...records.values()].sort((a, b) => a.createdAt - b.createdAt), status: "ok", dropped };
}

/**
 * The text to save, and the closed records that had to be left out for it to fit under the cap, oldest first (the one
 * closed longest ago goes first). Open records are never left out: when they alone are too many, there is no text.
 */
export function encodeRecords(
  records: readonly RequestRecord[],
  limit = MAX_REQUESTS_BYTES,
): { text: string | null; dropped: RequestRecord[] } {
  const texts = records.map((record) => JSON.stringify(record));
  const sizes = texts.map((text) => Buffer.byteLength(text));
  const left = new Set(records.keys());
  // `[`, `]` and a comma between neighbours.
  const total = (): number => 2 + [...left].reduce((sum, index) => sum + (sizes[index] as number), 0) + Math.max(0, left.size - 1);
  const dropped: RequestRecord[] = [];
  const closed = [...records.keys()].filter((index) => !isOpen(records[index] as RequestRecord));
  closed.sort((a, b) => (records[a] as RequestRecord).updatedAt - (records[b] as RequestRecord).updatedAt);
  for (const index of closed) {
    if (total() <= limit) break;
    left.delete(index);
    dropped.push(records[index] as RequestRecord);
  }
  if (total() > limit) return { text: null, dropped };
  return { text: `[${[...left].map((index) => texts[index]).join(",")}]`, dropped };
}

export function saveStored(file: string, text: string): Promise<void> {
  return writePrivateFile(file, text);
}
