import { describe, expect, it, vi } from "vitest";
import { encodedFile, type FileValue } from "../client/file-entry";
import { addRow, checkForm, clearFile, fillFile, formFromView, removeRow, setName, setText, toFileRow, wipeForm, type FormRow, type FormState } from "../client/form-state";
import { fieldId } from "../client/presentation";
import { toBase64Url, utf8 } from "../shared/bytes";
import { LIMITS } from "../shared/limits";
import { MAX_PAYLOAD_BYTES } from "../shared/seal";
import { file, text, view } from "./view-fixtures";

const CANARY = "CANARY-4d1e-never-in-a-message";

/** The row with this id; the test fails when there is none. */
function rowOf(form: FormState, id: string): FormRow {
  const row = form.rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
}

/** What the human types into a row, and the file they attach: these change the form in place, as a test may with the form it made. */
function type(form: FormState, id: string, value: string): void {
  rowOf(form, id).value = { kind: "text", text: value };
}
function attach(form: FormState, id: string, value: FileValue): void {
  rowOf(form, id).value = { kind: "file", file: value };
}

/** The form with a row of the human's own, numbered `n`, with a name and a text. */
function human(form: FormState, n: number, key: string, value: string): FormState {
  const id = fieldId.row(n);
  return setText(setName(addRow(form, n), id, key), id, value);
}

const NOTHING = { entries: null, errors: new Map(), total: null };
const bytesOf = (content: string): FileValue => ({ name: "f", bytes: utf8.encode(content) });
const wiped = (value: FileValue) => value.bytes.every((byte) => byte === 0);

describe("the form a view gives", () => {
  it("makes one row for each field the agent asked for, in its order, empty, and none of the human's", () => {
    expect(formFromView(view([text("API_KEY", false, "з панелі"), file("SA", "json", true), file("BLOB")]))).toEqual({
      rows: [
        { id: "field:API_KEY", key: "API_KEY", declared: true, optional: false, format: "any", value: { kind: "text", text: "" } },
        { id: "field:SA", key: "SA", declared: true, optional: true, format: "json", value: { kind: "file", file: null } },
        { id: "field:BLOB", key: "BLOB", declared: true, optional: false, format: "any", value: { kind: "file", file: null } },
      ],
    });
    expect(formFromView(view([]))).toEqual({ rows: [] });
  });
});

describe("checkForm", () => {
  it("sends text and files, leaves out empty optional fields, and wants nothing else to be ready", () => {
    const form = formFromView(view([text("API_KEY"), file("SA", "json"), text("OPT", true)]));
    type(form, "field:API_KEY", "value-one");
    attach(form, "field:SA", { name: "sa.json", bytes: utf8.encode('{"a":1}') });
    expect(checkForm(form)).toEqual({
      entries: [
        { key: "API_KEY", value: "value-one" },
        { key: "SA", file: toBase64Url(utf8.encode('{"a":1}')) },
      ],
      errors: new Map(),
      total: null,
    });
  });

  it("keeps «→» disabled without a word while a required field is empty", () => {
    const form = formFromView(view([text("API_KEY"), file("SA", "json"), text("OPT", true)]));
    expect(checkForm(form)).toEqual(NOTHING);
    type(form, "field:API_KEY", "value-one");
    expect(checkForm(form)).toEqual(NOTHING);
    attach(form, "field:SA", bytesOf("{}"));
    expect(checkForm(form).entries).toEqual([
      { key: "API_KEY", value: "value-one" },
      { key: "SA", file: toBase64Url(utf8.encode("{}")) },
    ]);
    // Emptied again, it waits again.
    type(form, "field:API_KEY", "");
    expect(checkForm(form)).toEqual(NOTHING);
  });

  it("puts each error under its row, in the words the form has for it", () => {
    let form = formFromView(view([text("API_KEY")]));
    type(form, "field:API_KEY", "value-one");
    form = human(form, 1, "api_key", "value-two");
    expect(checkForm(form)).toEqual({ entries: null, errors: new Map([["row:1", "Вже є API_KEY"]]), total: null });
    form = setName(form, "row:1", "1X");
    expect(checkForm(form)).toEqual({ entries: null, errors: new Map([["row:1", "Лише A–Z, 0–9, _"]]), total: null });
    form = setName(form, "row:1", "EXTRA");
    form = setText(form, "row:1", "a".repeat(65_537));
    expect(checkForm(form)).toEqual({ entries: null, errors: new Map([["row:1", "Не довше 64 КіБ"]]), total: null });
    form = setText(form, "row:1", `x${String.fromCharCode(0xd83d)}`);
    expect(checkForm(form)).toEqual({ entries: null, errors: new Map([["row:1", "Некоректний символ"]]), total: null });
    form = setText(form, "row:1", "value-two");
    expect(checkForm(form)).toEqual({ entries: [{ key: "API_KEY", value: "value-one" }, { key: "EXTRA", value: "value-two" }], errors: new Map(), total: null });
  });

  it("refuses the names a plain object would treat specially, and a name of another shape, in a row of the human's", () => {
    const base = formFromView(view([]));
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(checkForm(human(base, 1, name, "value")).errors.get("row:1"), name).toBe("Ім'я зарезервоване");
    }
    for (const name of ["1X", "A-B", "A B", "ключ", "K".repeat(LIMITS.key + 1), "$X"]) {
      expect(checkForm(human(base, 1, name, "value")).errors.get("row:1"), name).toBe("Лише A–Z, 0–9, _");
    }
    // Names that only look like those, the longest name, and names a prototype has but nothing treats specially.
    for (const name of ["constructors", "_proto_", "K".repeat(LIMITS.key), "toString", "hasOwnProperty", "x"]) {
      expect(checkForm(human(base, 1, name, "value")), name).toEqual({ entries: [{ key: name, value: "value" }], errors: new Map(), total: null });
    }
  });

  it("names the earlier row a name collides with, exactly or by letter case, and only the later row is marked", () => {
    let form = human(formFromView(view([])), 1, "TOKEN", "value-one");
    form = human(form, 2, "token", "value-two");
    expect(checkForm(form)).toEqual({ entries: null, errors: new Map([["row:2", "Вже є TOKEN"]]), total: null });
    form = setName(form, "row:2", "TOKEN");
    expect(checkForm(form).errors).toEqual(new Map([["row:2", "Вже є TOKEN"]]));
    // A third row that collides with both is told of the first.
    form = human(form, 3, "Token", "value-three");
    expect(checkForm(form).errors).toEqual(new Map([["row:2", "Вже є TOKEN"], ["row:3", "Вже є TOKEN"]]));
    // A declared field the human leaves empty is a row all the same: its name is taken.
    const optional = human(formFromView(view([text("WEBHOOK", true)])), 1, "Webhook", "value-one");
    expect(checkForm(optional).errors).toEqual(new Map([["row:1", "Вже є WEBHOOK"]]));
  });

  it("does not let a name it refused take a name from a later row", () => {
    let form = human(formFromView(view([])), 1, "constructor", "value-one");
    form = human(form, 2, "constructor", "value-two");
    expect(checkForm(form).errors).toEqual(new Map([["row:1", "Ім'я зарезервоване"], ["row:2", "Ім'я зарезервоване"]]));
  });

  it("trims the name of a row of the human's before it is checked and sent", () => {
    expect(checkForm(human(formFromView(view([])), 1, "  EXTRA  ", "value")).entries).toEqual([{ key: "EXTRA", value: "value" }]);
  });

  it("shows no text for a row of the human's without a name or a value, and sends nothing while there is one", () => {
    const named = formFromView(view([text("A")]));
    type(named, "field:A", "value-one");
    expect(checkForm(addRow(named, 1))).toEqual(NOTHING);
    expect(checkForm(human(named, 1, "EXTRA", ""))).toEqual(NOTHING);
    expect(checkForm(human(named, 1, "", "value-two"))).toEqual(NOTHING);
    expect(checkForm(human(named, 1, "   ", "value-two"))).toEqual(NOTHING);
    // A row whose name is not there yet still says what is wrong with its value.
    expect(checkForm(human(named, 1, "", "a".repeat(65_537))).errors).toEqual(new Map([["row:1", "Не довше 64 КіБ"]]));
    // The name is said first: a row has one line.
    expect(checkForm(human(named, 1, "1X", "a".repeat(65_537))).errors).toEqual(new Map([["row:1", "Лише A–Z, 0–9, _"]]));
  });

  it("sends nothing, and so keeps «→» disabled, when no entry would go: every declared field optional and empty and no row of the human's", () => {
    // The plugin refuses a submission that writes nothing, and that refusal closes the request.
    const optional = formFromView(view([text("OPT", true), file("OPT_FILE", "any", true)]));
    expect(checkForm(optional)).toEqual(NOTHING);
    expect(checkForm(formFromView(view([])))).toEqual(NOTHING);
    // One row of the human's with a name and a value is enough, and so is one optional field filled.
    expect(checkForm(human(optional, 1, "EXTRA", "value-two")).entries).toEqual([{ key: "EXTRA", value: "value-two" }]);
    const filled = formFromView(view([text("OPT", true), file("OPT_FILE", "any", true)]));
    attach(filled, "field:OPT_FILE", bytesOf("x"));
    expect(checkForm(filled).entries).toEqual([{ key: "OPT_FILE", file: toBase64Url(utf8.encode("x")) }]);
  });

  it("takes a file of no bytes for no file: a required field still waits, an optional one is left out, and alone it sends nothing", () => {
    const empty = (): FileValue => ({ name: "empty.txt", bytes: new Uint8Array(0) });
    const required = formFromView(view([file("SA")]));
    attach(required, "field:SA", empty());
    expect(checkForm(required)).toEqual(NOTHING);
    const optional = formFromView(view([file("SA", "any", true), text("A")]));
    attach(optional, "field:SA", empty());
    type(optional, "field:A", "value-one");
    expect(checkForm(optional).entries).toEqual([{ key: "A", value: "value-one" }]);
    const alone = formFromView(view([file("SA", "any", true)]));
    attach(alone, "field:SA", empty());
    expect(checkForm(alone)).toEqual(NOTHING);
    let theirs = toFileRow(addRow(formFromView(view([])), 1), "row:1");
    theirs = setName(theirs, "row:1", "EXTRA");
    theirs = fillFile(theirs, "row:1", empty());
    expect(checkForm(theirs)).toEqual(NOTHING);
  });

  it("puts a file's check under its row, and the size first", () => {
    const form = formFromView(view([file("SA", "json"), file("KEY", "pem"), file("BLOB")]));
    attach(form, "field:SA", bytesOf("{nope"));
    attach(form, "field:KEY", bytesOf("not a key"));
    attach(form, "field:BLOB", { name: "big.bin", bytes: new Uint8Array(LIMITS.fileBytes + 1) });
    expect(checkForm(form)).toEqual({
      entries: null,
      errors: new Map([
        ["field:SA", "Це не JSON"],
        ["field:KEY", "Це не PEM"],
        ["field:BLOB", "Не довше 128 КіБ"],
      ]),
      total: null,
    });
  });

  it("holds a text to its size limit in bytes, at the boundary, and counts a lone surrogate as the three bytes it would be written as", () => {
    const check = (value: string) => {
      const form = formFromView(view([text("A")]));
      type(form, "field:A", value);
      return checkForm(form).errors.get("field:A") ?? "ok";
    };
    expect(LIMITS.valueBytes).toBe(64 * 1024);
    expect(check("a".repeat(LIMITS.valueBytes))).toBe("ok");
    expect(check("a".repeat(LIMITS.valueBytes + 1))).toBe("Не довше 64 КіБ");
    expect(check("я".repeat(LIMITS.valueBytes / 2))).toBe("ok");
    expect(check("я".repeat(LIMITS.valueBytes / 2 + 1))).toBe("Не довше 64 КіБ");
    const emoji = String.fromCodePoint(0x1f511);
    expect(check(emoji.repeat(LIMITS.valueBytes / 4))).toBe("ok");
    expect(check(emoji.repeat(LIMITS.valueBytes / 4 + 1))).toBe("Не довше 64 КіБ");
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);
    expect(check(`${"a".repeat(LIMITS.valueBytes - 3)}${high}`)).toBe("Некоректний символ");
    expect(check(`${"a".repeat(LIMITS.valueBytes - 2)}${high}`)).toBe("Не довше 64 КіБ");
    expect(check(`${low}x`)).toBe("Некоректний символ");
    expect(check(`${high}${high}${low}`)).toBe("Некоректний символ");
    expect(check(`x${emoji}y`)).toBe("ok");
  });

  it("measures a text without making a copy of it in bytes", () => {
    // The limit is in bytes of UTF-8, and a buffer made only to be measured would hold the typed value with nothing to wipe it.
    const spy = vi.spyOn(utf8, "encode");
    try {
      let form = formFromView(view([text("A"), file("SA", "json")]));
      type(form, "field:A", `${CANARY}-ключ`);
      attach(form, "field:SA", { name: "sa.json", bytes: Uint8Array.from([0x7b, 0x7d]) });
      form = human(form, 1, "EXTRA", "я".repeat(LIMITS.valueBytes / 2 + 1));
      expect(checkForm(form).errors).toEqual(new Map([["row:1", "Не довше 64 КіБ"]]));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("puts the declared fields first, in the view's order, then the human's rows in theirs", () => {
    let form = formFromView(view([text("Z"), file("M"), text("A")]));
    type(form, "field:Z", "z-value");
    attach(form, "field:M", bytesOf("m"));
    type(form, "field:A", "a-value");
    form = human(form, 7, "Y", "y-value");
    form = human(form, 3, "B", "b-value");
    expect(checkForm(form).entries).toEqual([
      { key: "Z", value: "z-value" },
      { key: "M", file: toBase64Url(utf8.encode("m")) },
      { key: "A", value: "a-value" },
      { key: "Y", value: "y-value" },
      { key: "B", value: "b-value" },
    ]);
  });

  it("sends a file of the human's own as a file, its bytes as they are", () => {
    const binary = { name: "cert.p12", bytes: Uint8Array.from([0x30, 0x82, 0x00, 0xff, 0x0d, 0x0a]) };
    let form = toFileRow(addRow(formFromView(view([])), 1), "row:1");
    form = fillFile(setName(form, "row:1", "P12"), "row:1", binary);
    expect(checkForm(form).entries).toEqual([{ key: "P12", file: toBase64Url(binary.bytes) }]);
  });

  it("says the total is too large when the rows together would not fit one submission, and never for rows within the limits", () => {
    // The most the limits allow: every row a text of 64 KiB of the character JSON writes as six bytes, under the longest key.
    const worst = String.fromCharCode(1).repeat(LIMITS.valueBytes);
    const rowsOf = (count: number): FormRow[] =>
      Array.from({ length: count }, (_, index) => ({
        id: fieldId.row(index + 1),
        key: `${"K".repeat(LIMITS.key - 2)}${String(index).padStart(2, "0")}`,
        declared: false,
        optional: false,
        format: "any",
        value: { kind: "text", text: worst },
      }));
    const within = checkForm({ rows: rowsOf(LIMITS.fields) });
    expect(within.total).toBeNull();
    expect(within.entries).toHaveLength(LIMITS.fields);
    // One row more than a request may carry, which «+» does not allow, is more than one submission carries.
    const over = checkForm({ rows: rowsOf(LIMITS.fields + 1) });
    expect(over).toEqual({ entries: null, errors: new Map(), total: `Разом не довше ${MAX_PAYLOAD_BYTES / 1024} КіБ` });
    expect(over.total).toBe("Разом не довше 12293 КіБ");
  }, 30_000);

  it("sends no more rows than a request may carry, however the form came to have them", () => {
    let form = formFromView(view([]));
    for (let n = 1; n <= LIMITS.fields + 1; n++) form = { rows: [...form.rows, ...human({ rows: [] }, n, `K${n}`, "v").rows] };
    expect(form.rows).toHaveLength(LIMITS.fields + 1);
    expect(checkForm(form)).toEqual(NOTHING);
    expect(checkForm({ rows: form.rows.slice(0, LIMITS.fields) }).entries).toHaveLength(LIMITS.fields);
  });

  it("never puts a value into a message", () => {
    const attempts: FormState[] = [];
    const add = (build: (form: FormState) => FormState) => attempts.push(build(formFromView(view([text("A"), file("SA", "json")]))));
    add((form) => human(form, 1, "bad name", CANARY));
    add((form) => human(form, 1, "constructor", CANARY));
    add((form) => human(human(form, 1, "X", CANARY), 2, "x", CANARY));
    add((form) => human(form, 1, "EXTRA", `${CANARY}${"a".repeat(LIMITS.valueBytes)}`));
    add((form) => human(form, 1, "EXTRA", `${CANARY}${String.fromCharCode(0xd83d)}`));
    add((form) => {
      attach(form, "field:SA", bytesOf(`{"k":"${CANARY}"`));
      return form;
    });
    for (const form of attempts) {
      const result = checkForm(form);
      expect(result.entries).toBeNull();
      expect(result.errors.size).toBeGreaterThan(0);
      expect(JSON.stringify({ errors: [...result.errors], total: result.total })).not.toContain("CANARY");
    }
  });
});

describe("what the human does to the form", () => {
  it("adds rows of the human's own, numbered as asked, up to the most a request may carry", () => {
    let form = formFromView(view([text("A")]));
    form = addRow(form, 1);
    expect(form.rows[1]).toEqual({ id: "row:1", key: "", declared: false, optional: false, format: "any", value: { kind: "text", text: "" } });
    for (let n = 2; n < LIMITS.fields; n++) form = addRow(form, n);
    expect(form.rows).toHaveLength(LIMITS.fields);
    // «+» is disabled at 32 rows: the form stays as it was.
    expect(addRow(form, 99)).toBe(form);
  });

  it("changes one row and hands back a new form, leaving the one it was given as it was", () => {
    const before = human(formFromView(view([text("A")])), 1, "EXTRA", "value-two");
    const copy = structuredClone(before);
    const after = setText(before, "field:A", "value-one");
    expect(before).toEqual(copy);
    expect(rowOf(after, "field:A").value).toEqual({ kind: "text", text: "value-one" });
    expect(rowOf(after, "row:1")).toBe(rowOf(before, "row:1"));
    expect(setName(after, "row:1", "OTHER").rows.map((row) => row.key)).toEqual(["A", "OTHER"]);
  });

  it("never renames a field the agent asked for, and never removes one", () => {
    const form = formFromView(view([text("A"), file("SA")]));
    expect(setName(form, "field:A", "B")).toBe(form);
    expect(removeRow(form, "field:A")).toBe(form);
    expect(toFileRow(form, "field:A")).toBe(form);
  });

  it("turns a text row of the human's into a file row, with no format to check", () => {
    const form = toFileRow(human(formFromView(view([])), 1, "EXTRA", "typed"), "row:1");
    expect(rowOf(form, "row:1")).toEqual({ id: "row:1", key: "EXTRA", declared: false, optional: false, format: "any", value: { kind: "file", file: null } });
    // A file row has no text to type into.
    expect(setText(form, "row:1", "x")).toBe(form);
  });

  it("fills an empty file row, and takes no second file into a row that holds one: that one is wiped", () => {
    const first = bytesOf("{}");
    const second = bytesOf("[]");
    const form = fillFile(formFromView(view([file("SA", "json")])), "field:SA", first);
    expect(rowOf(form, "field:SA").value).toEqual({ kind: "file", file: first });
    expect(fillFile(form, "field:SA", second)).toBe(form);
    expect(wiped(second)).toBe(true);
    expect(wiped(first)).toBe(false);
    // Nor into a text row, or a row there is not.
    const third = bytesOf("x");
    const texts = formFromView(view([text("A")]));
    expect(fillFile(texts, "field:A", third)).toBe(texts);
    expect(fillFile(texts, "row:9", bytesOf("y"))).toBe(texts);
    expect(wiped(third)).toBe(true);
  });

  it("wipes a file when it is taken out of its row, and when its row is removed", () => {
    const one = bytesOf("one");
    const cleared = clearFile(fillFile(formFromView(view([file("SA")])), "field:SA", one), "field:SA");
    expect(rowOf(cleared, "field:SA").value).toEqual({ kind: "file", file: null });
    expect(wiped(one)).toBe(true);
    const two = bytesOf("two");
    const theirs = fillFile(setName(toFileRow(addRow(formFromView(view([])), 1), "row:1"), "row:1", "EXTRA"), "row:1", two);
    expect(removeRow(theirs, "row:1").rows).toEqual([]);
    expect(wiped(two)).toBe(true);
  });

  it("checks and encodes each file once, however often the form is checked, and keeps nothing of a file once it leaves its row", () => {
    const value = bytesOf('{"a":1}');
    let form = fillFile(setText(formFromView(view([text("API_KEY"), file("SA", "json")])), "field:API_KEY", "v"), "field:SA", value);
    const parse = vi.spyOn(JSON, "parse");
    try {
      // Every change of another row checks the whole form again.
      for (let round = 0; round < 5; round++) {
        form = setText(form, "field:API_KEY", `typed-${round}`);
        expect(checkForm(form).entries).toEqual([
          { key: "API_KEY", value: `typed-${round}` },
          { key: "SA", file: toBase64Url(utf8.encode('{"a":1}')) },
        ]);
      }
      expect(parse.mock.calls.filter(([text]) => text === '{"a":1}')).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
    // Taken out of its row, the file is wiped, and what was made of it is let go with it.
    const cleared = clearFile(form, "field:SA");
    expect(wiped(value)).toBe(true);
    expect(encodedFile(value)).toBe(toBase64Url(new Uint8Array(value.bytes.length)));
    expect(checkForm(cleared).entries).toBeNull();
    // So is one that a row did not take, and every one of a form that is wiped.
    const refused = bytesOf("[1]");
    encodedFile(refused);
    expect(fillFile(fillFile(formFromView(view([file("SB")])), "field:SB", bytesOf("{}")), "field:SB", refused)).toBeDefined();
    expect(encodedFile(refused)).toBe(toBase64Url(new Uint8Array(3)));
    const held = bytesOf("[2]");
    const holding = fillFile(formFromView(view([file("SC")])), "field:SC", held);
    expect(checkForm(holding).entries).toEqual([{ key: "SC", file: toBase64Url(utf8.encode("[2]")) }]);
    wipeForm(holding);
    expect(encodedFile(held)).toBe(toBase64Url(new Uint8Array(3)));
  });

  it("wipes every file it holds", () => {
    const one = { name: "a.bin", bytes: Uint8Array.from([1, 2, 3]) };
    const two = { name: null, bytes: utf8.encode('{"k":1}') };
    const three = { name: "c.pem", bytes: utf8.encode("-----BEGIN KEY-----") };
    let form = formFromView(view([file("A"), file("B", "json"), text("C")]));
    attach(form, "field:A", one);
    attach(form, "field:B", two);
    type(form, "field:C", "value-one");
    form = fillFile(toFileRow(addRow(form, 1), "row:1"), "row:1", three);
    wipeForm(form);
    for (const held of [one, two, three]) expect(wiped(held), String(held.name)).toBe(true);
    // A form with no file is no trouble.
    expect(() => wipeForm(formFromView(view([text("A")])))).not.toThrow();
  });
});
