import { toBase64Url, utf8 } from "../shared/bytes";
import { LIMITS } from "../shared/limits";
import { sanitizeText } from "../shared/sanitize";
import { bytesText } from "./text";

/**
 * A file the human picked, dropped or pasted: its bytes, as they are, and its name. The name is null for a paste. The
 * bytes are the form's to wipe, when the file leaves its row and when the form closes (`wipeForm`), and they are wiped
 * through `wipeFile` alone. Nothing changes a file but its wipe: what is made of it once (`checkedFile`, `encodedFile`)
 * holds until then.
 */
export interface FileValue {
  name: string | null;
  bytes: Uint8Array;
}

type Format = "json" | "pem" | "any";

/** What the app found of a file, before anything is sealed: it passes, or the one line under its row says why not. */
export type FileCheck = { ok: true } | { ok: false; message: "Це не JSON" | "Це не PEM" | "Не довше 128 КіБ" };

const PASSES: FileCheck = { ok: true };
/** `LIMITS.fileBytes`, 128 KiB, as the form words it: a literal, so that the type says which line it is. */
const TOO_LARGE: FileCheck = { ok: false, message: "Не довше 128 КіБ" };
const NOT_JSON: FileCheck = { ok: false, message: "Це не JSON" };
const NOT_PEM: FileCheck = { ok: false, message: "Це не PEM" };

/** A line of a PEM that opens a block, and one that closes it, ending in CR LF or in LF. */
const PEM_BEGIN = /^-----BEGIN [^\r\n]+-----\r?$/m;
const PEM_END = /^-----END [^\r\n]+-----\r?$/m;

/**
 * The bytes as text when they are UTF-8, and null when they are not: no character is replaced, and a byte order mark at
 * the start stays the first character. The daemon writes the bytes as they are, BOM and all, and a reader of that file
 * meets the BOM first: a check that dropped it would pass a JSON or a PEM the reader refuses.
 */
function textOf(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether a file is what its field asks for. The size comes first, for every format: a file over `LIMITS.fileBytes`
 * is refused however it reads. `json` is UTF-8 that parses as JSON; `pem` is UTF-8 with a line that begins a block and
 * one that ends one; `any` is not looked into, so a `.p12` or anything else binary passes. The bytes are only read.
 */
export function checkFile(file: FileValue, format: Format): FileCheck {
  if (file.bytes.length > LIMITS.fileBytes) return TOO_LARGE;
  if (format === "any") return PASSES;
  const text = textOf(file.bytes);
  if (format === "pem") return text !== null && PEM_BEGIN.test(text) && PEM_END.test(text) ? PASSES : NOT_PEM;
  if (text === null) return NOT_JSON;
  try {
    JSON.parse(text);
    return PASSES;
  } catch {
    return NOT_JSON;
  }
}

/** The most of a file's name that is shown: the longest name a file system gives one. */
const NAME_MAX = 255;

/** «2,1 КіБ»: the size of a file, in bytes below a KiB and in KiB with one decimal above. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return bytesText(bytes);
  return `${(bytes / 1024).toFixed(1).replace(".", ",")} КіБ`;
}

/**
 * The line that stands for a file in its row: its name, or «вставлено» for a paste, its size, and for a format that
 * is checked, the check. Never a byte of the file. The name is the human's file system's, and it is shown without what
 * could hide or reorder it, which a name made to deceive could hold.
 */
export function fileLine(file: FileValue, format: "json" | "pem" | "any", check: FileCheck): string {
  const name = file.name === null ? "вставлено" : sanitizeText(file.name, NAME_MAX);
  const parts = [name, sizeText(file.bytes.length)];
  if (format !== "any") parts.push(`${format} ${check.ok ? "✓" : "✗"}`);
  return parts.filter((part) => part !== "").join(" · ");
}

/** What was pasted into a file row's area, as the file's bytes: nothing pasted is no file, and the row stays empty. */
export function fromPasted(text: string): FileValue | null {
  return text === "" ? null : { name: null, bytes: utf8.encode(text) };
}

/**
 * What is made of each file the form holds, made once: its check against each format it is held to, and its bytes as
 * base64url, which is how it is sent. Every change of the form checks every row again, so without this every keystroke
 * would read and parse every file anew and make another copy of its content as text. Keyed by the file itself, so that
 * it goes with the file; `wipeFile` lets go of it at once. The text cannot be wiped, as no string can: it is held no
 * longer than the file it was made from, which is no longer than the form.
 */
const made = new WeakMap<FileValue, { checks: Map<Format, FileCheck>; encoded: string | null }>();

function madeOf(file: FileValue): { checks: Map<Format, FileCheck>; encoded: string | null } {
  let entry = made.get(file);
  if (entry === undefined) made.set(file, (entry = { checks: new Map(), encoded: null }));
  return entry;
}

/** `checkFile`, made once for each file and format, and kept until the file is wiped. */
export function checkedFile(file: FileValue, format: Format): FileCheck {
  const { checks } = madeOf(file);
  let check = checks.get(format);
  if (check === undefined) checks.set(format, (check = checkFile(file, format)));
  return check;
}

/** The bytes of a file as base64url, as a file goes in a submission: made once, and kept until the file is wiped. */
export function encodedFile(file: FileValue): string {
  const entry = madeOf(file);
  entry.encoded ??= toBase64Url(file.bytes);
  return entry.encoded;
}

/** Wipes a file's bytes, and lets go of what was made of them (`checkedFile`, `encodedFile`): nothing of the file is held after. */
export function wipeFile(file: FileValue): void {
  file.bytes.fill(0);
  made.delete(file);
}

/**
 * A file the human gave a row, handed to `take` while `open` says the form may take one, and wiped otherwise. What
 * `take` throws on is wiped too, and goes no further: a file that nothing takes leaves nothing behind. The form is open
 * to a file while it is on screen and nothing is under way (the dialog), and a row while it is not locked and still
 * mounted (a file row).
 */
export function takeFile(file: FileValue, open: boolean, take: (file: FileValue) => void): void {
  if (!open) {
    wipeFile(file);
    return;
  }
  try {
    take(file);
  } catch {
    wipeFile(file);
  }
}
