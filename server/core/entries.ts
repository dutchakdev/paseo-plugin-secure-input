import { decodedLength, fromBase64Url, utf8, utf8Length } from "../../shared/bytes";
import { SecureInputError } from "../../shared/errors";
import { KEY_PATTERN, caseCollision, isValidKey } from "../../shared/limits";
import { LIMITS, type Field, type InputRequest } from "../../shared/request";
import type { FileEntry, PayloadEntry } from "../../shared/seal";
import { hasLoneSurrogate } from "../../shared/text";
import type { DropFile } from "../io/drop";

function invalid(detail: string): never {
  throw new SecureInputError("invalid_request", detail);
}

function isFileEntry(entry: PayloadEntry): entry is FileEntry {
  return Object.hasOwn(entry, "file");
}

/**
 * Checks what the app sent against what the agent asked for, and turns it into the files of the set: a text as its
 * UTF-8, a file as its bytes. Errors name keys only: a value must never reach an error message.
 *
 * Every key is a valid one, said once, and no two name one file when case is ignored: the declared keys first, then the
 * human's own, which are always taken. A declared field gets the kind it was declared with (a text when it names
 * none). A text is at most `LIMITS.valueBytes` and holds no surrogate without its partner; a file is base64url and at
 * most `LIMITS.fileBytes`. An empty text or an empty file is left empty: a declared optional field is then skipped, a
 * required one refused, and a key of the human's gets no file. A submission that would write nothing is refused.
 *
 * The bytes that come out are the caller's to wipe. On a refusal every byte array made so far is wiped here.
 */
export function validateEntries(request: InputRequest, entries: readonly PayloadEntry[]): { written: DropFile[]; skipped: string[] } {
  const written: DropFile[] = [];
  try {
    if (entries.length > LIMITS.fields) invalid("too many entries");

    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isValidKey(entry.key)) invalid(KEY_PATTERN.test(entry.key) ? "a key name is reserved" : "a key is not a valid identifier");
      if (seen.has(entry.key)) invalid(`${entry.key} appears more than once`);
      seen.add(entry.key);
    }

    const declared = new Map<string, Field>(request.fields.map((field) => [field.key, field] as const));
    const theirs = entries.filter((entry) => !declared.has(entry.key)).map((entry) => entry.key);
    const collision = caseCollision([...declared.keys(), ...theirs]);
    if (collision !== null) invalid(`${collision[0]} and ${collision[1]} differ only in letter case`);

    const filled = new Set<string>();
    for (const entry of entries) {
      const field = declared.get(entry.key);
      if (field !== undefined && (field.kind === "file") !== isFileEntry(entry)) invalid(field.kind === "file" ? `${entry.key} must be a file` : `${entry.key} must be text`);
      const bytes = isFileEntry(entry) ? fileBytes(entry) : textBytes(entry.key, entry.value);
      if (bytes.length === 0) continue;
      written.push({ key: entry.key, bytes });
      filled.add(entry.key);
    }

    const skipped: string[] = [];
    for (const field of request.fields) {
      if (filled.has(field.key)) continue;
      if (field.optional !== true) invalid(`${field.key} is required`);
      skipped.push(field.key);
    }
    if (written.length === 0) invalid("nothing to write");
    return { written, skipped };
  } catch (error) {
    for (const file of written) file.bytes.fill(0);
    throw error;
  }
}

/** A text as the bytes of its file: its UTF-8, measured before it is made. */
function textBytes(key: string, value: string): Uint8Array {
  if (utf8Length(value) > LIMITS.valueBytes) invalid(`${key} is larger than the limit`);
  if (hasLoneSurrogate(value)) invalid(`${key} contains invalid Unicode`);
  return utf8.encode(value);
}

/**
 * A file as the bytes it was. One over the limit is refused from the length of its text, before it is decoded, so no
 * array of it is ever made (`decodedLength` is the length of what the decoder would give). A text the decoder refuses
 * leaves no array of it either (`fromBase64Url`), and what the decoder said is not passed on.
 */
function fileBytes(entry: FileEntry): Uint8Array {
  if (decodedLength(entry.file) > LIMITS.fileBytes) invalid(`${entry.key} is larger than the limit`);
  try {
    return fromBase64Url(entry.file);
  } catch {
    invalid(`${entry.key} is not a file the plugin can read`);
  }
}
