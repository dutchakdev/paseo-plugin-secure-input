import { utf8Length } from "../shared/bytes";
import { KEY_PATTERN, LIMITS, RESERVED_KEYS } from "../shared/limits";
import { MAX_PAYLOAD_BYTES, payloadSize, type PayloadEntry } from "../shared/seal";
import { hasLoneSurrogate } from "../shared/text";
import type { RequestView } from "../shared/view";
import { checkedFile, encodedFile, wipeFile, type FileValue } from "./file-entry";
import { fieldId } from "./presentation";

/** What a row holds: a line of text, or a file, which is null until one is picked, dropped or pasted. */
export type RowValue = { kind: "text"; text: string } | { kind: "file"; file: FileValue | null };

/**
 * One row of the form. A declared row is a field the agent asked for: its key is fixed and it cannot be removed. A row
 * of the human's has the name they type in place of a key. `format` is what a file in the row is checked against; a
 * row of the human's checks none (`any`).
 */
export interface FormRow {
  id: string;
  key: string;
  declared: boolean;
  optional: boolean;
  format: "json" | "pem" | "any";
  value: RowValue;
}

/** The declared rows first, in the view's order, with ids `fieldId.declared(key)`; then the human's, `fieldId.row(n)`. */
export interface FormState {
  rows: FormRow[];
}

/** The form for a view: a row for each field the agent asked for, empty. */
export function formFromView(view: RequestView): FormState {
  return {
    rows: view.fields.map((field) => ({
      id: fieldId.declared(field.key),
      key: field.key,
      declared: true,
      optional: field.optional,
      format: field.format ?? "any",
      value: field.kind === "file" ? { kind: "file", file: null } : { kind: "text", text: "" },
    })),
  };
}

// The lines under a row, as the form words them. A limit a line names is the plugin's own number (`LIMITS`, `MAX_PAYLOAD_BYTES`).
const INVALID_NAME = "Лише A–Z, 0–9, _";
const RESERVED_NAME = "Ім'я зарезервоване";
const TEXT_TOO_LARGE = `Не довше ${LIMITS.valueBytes / 1024} КіБ`;
const BROKEN_TEXT = "Некоректний символ";
const TOTAL_TOO_LARGE = `Разом не довше ${MAX_PAYLOAD_BYTES / 1024} КіБ`;

/**
 * The key a row's name gives, and the line about it. A declared row's key is the agent's, which the plugin checked. A
 * name of the human's is trimmed, and gives no key while it is empty (and no line), is of another shape than a key, is
 * a name a plain object treats specially, or names a file an earlier row names already, exactly or by letter case: two
 * such keys would be one file on a volume that ignores case. `taken` maps each earlier key, folded, to itself.
 */
function nameOf(row: FormRow, taken: ReadonlyMap<string, string>): { key: string | null; error: string | null } {
  if (row.declared) return { key: row.key, error: null };
  const key = row.key.trim();
  if (key === "") return { key: null, error: null };
  if (!KEY_PATTERN.test(key)) return { key: null, error: INVALID_NAME };
  if (RESERVED_KEYS.includes(key)) return { key: null, error: RESERVED_NAME };
  const earlier = taken.get(key.toLowerCase());
  return earlier === undefined ? { key, error: null } : { key: null, error: `Вже є ${earlier}` };
}

/**
 * What a row's value comes to: a line, nothing to send (an empty text, no file, a file of no bytes), or an entry, made
 * only when the form is sent. A text is measured without a copy of it being made, and must be whole UTF-8: a surrogate
 * with no partner would be written as another character. A file is checked against its row's format, and encoded, once
 * for as long as the row holds it (`checkedFile`, `encodedFile`).
 */
function valueOf(row: FormRow): { error: string | null; entry: ((key: string) => PayloadEntry) | null } {
  const { value } = row;
  if (value.kind === "text") {
    const { text } = value;
    if (text === "") return { error: null, entry: null };
    if (utf8Length(text) > LIMITS.valueBytes) return { error: TEXT_TOO_LARGE, entry: null };
    if (hasLoneSurrogate(text)) return { error: BROKEN_TEXT, entry: null };
    return { error: null, entry: (key) => ({ key, value: text }) };
  }
  const { file } = value;
  if (file === null) return { error: null, entry: null };
  const check = checkedFile(file, row.format);
  if (!check.ok) return { error: check.message, entry: null };
  // The plugin gives a key whose file has no bytes no file: such a row is an empty one, here as there.
  if (file.bytes.length === 0) return { error: null, entry: null };
  return { error: null, entry: (key) => ({ key, file: encodedFile(file) }) };
}

/**
 * What the form would send, and what each row and the whole say about it. `entries` is null while «→» is disabled:
 * while a row has a line under it, a field the agent needs is empty, a row of the human's lacks a name or a value, the
 * rows together would not fit one submission (`total`), there are more of them than a request may carry, or nothing
 * would be sent at all. The plugin refuses a submission that writes nothing, and the refusal closes the request.
 *
 * An empty row says nothing: «→» is just disabled. A row has one line, about its name before its value. Messages name
 * keys, never values. Every file goes as `{ key, file }`, its bytes as base64url.
 */
export function checkForm(form: FormState): { entries: PayloadEntry[] | null; errors: ReadonlyMap<string, string>; total: string | null } {
  const errors = new Map<string, string>();
  const taken = new Map<string, string>();
  const ready: Array<() => PayloadEntry> = [];
  let complete = true;
  for (const row of form.rows) {
    const name = nameOf(row, taken);
    const { key } = name;
    if (key !== null && !taken.has(key.toLowerCase())) taken.set(key.toLowerCase(), key);
    const value = valueOf(row);
    const error = name.error ?? value.error;
    if (error !== null) {
      errors.set(row.id, error);
      complete = false;
    } else if (value.entry === null) {
      // Nothing in the row. A field the agent made optional is left out; every other row is waited for.
      if (!(row.declared && row.optional)) complete = false;
    } else if (key === null) {
      complete = false;
    } else {
      const entry = value.entry;
      ready.push(() => entry(key));
    }
  }
  if (!complete) return { entries: null, errors, total: null };
  const entries = ready.map((make) => make());
  if (payloadSize(entries) > MAX_PAYLOAD_BYTES) return { entries: null, errors, total: TOTAL_TOO_LARGE };
  if (entries.length === 0 || entries.length > LIMITS.fields) return { entries: null, errors, total: null };
  return { entries, errors, total: null };
}

/** Fills every file's bytes the form holds with zeros, and lets go of what was made of them (`wipeFile`). */
export function wipeForm(form: FormState): void {
  for (const row of form.rows) wipeRow(row);
}

function wipeRow(row: FormRow): void {
  if (row.value.kind === "file" && row.value.file !== null) wipeFile(row.value.file);
}

/** The form with one row changed, or the very form it was given when `change` leaves the row as it was or there is no such row. */
function changed(form: FormState, id: string, change: (row: FormRow) => FormRow): FormState {
  const index = form.rows.findIndex((row) => row.id === id);
  const row = form.rows[index];
  if (row === undefined) return form;
  const next = change(row);
  if (next === row) return form;
  return { rows: form.rows.map((other, at) => (at === index ? next : other)) };
}

/** What was typed into a text row. A file row has no text. */
export function setText(form: FormState, id: string, text: string): FormState {
  return changed(form, id, (row) => (row.value.kind === "text" ? { ...row, value: { kind: "text", text } } : row));
}

/** The name of a row of the human's. A field the agent asked for keeps its key. */
export function setName(form: FormState, id: string, key: string): FormState {
  return changed(form, id, (row) => (row.declared ? row : { ...row, key }));
}

/** «+»: a row of the human's, numbered `n`, a text with no name. None past the most a request may carry, and none under an id that is taken. */
export function addRow(form: FormState, n: number): FormState {
  const id = fieldId.row(n);
  if (form.rows.length >= LIMITS.fields || form.rows.some((row) => row.id === id)) return form;
  return { rows: [...form.rows, { id, key: "", declared: false, optional: false, format: "any", value: { kind: "text", text: "" } }] };
}

/** «✕» on a row of the human's: it goes, and its file is wiped. A field the agent asked for stays. */
export function removeRow(form: FormState, id: string): FormState {
  const row = form.rows.find((candidate) => candidate.id === id);
  if (row === undefined || row.declared) return form;
  wipeRow(row);
  return { rows: form.rows.filter((other) => other !== row) };
}

/** The paperclip on a text row of the human's: it becomes an empty file row, whose file no format is checked against. */
export function toFileRow(form: FormState, id: string): FormState {
  return changed(form, id, (row) => (row.declared || row.value.kind !== "text" ? row : { ...row, format: "any", value: { kind: "file", file: null } }));
}

/**
 * A file picked, dropped or pasted into a row. Only an empty file row takes one: a row that holds a file takes no
 * other until that one is taken out, and a file nothing takes is wiped here, so that no copy of it is left behind.
 */
export function fillFile(form: FormState, id: string, file: FileValue): FormState {
  const next = changed(form, id, (row) => (row.value.kind === "file" && row.value.file === null ? { ...row, value: { kind: "file", file } } : row));
  if (next === form) wipeFile(file);
  return next;
}

/** «✕» on a file: it is wiped and taken out of its row, which is empty again. */
export function clearFile(form: FormState, id: string): FormState {
  return changed(form, id, (row) => {
    if (row.value.kind !== "file" || row.value.file === null) return row;
    wipeFile(row.value.file);
    return { ...row, value: { kind: "file", file: null } };
  });
}
