import { afterEach, describe, expect, it, vi } from "vitest";
import { validateEntries } from "../server/core/entries";
import type { DropFile } from "../server/io/drop";
import { toBase64Url, utf8 } from "../shared/bytes";
import { SecureInputError } from "../shared/errors";
import { FULFILLED_STATES, FieldSchema, InputRequestSchema, LIMITS, REQUEST_STATES, SecretRequestShape } from "../shared/request";
import type { PayloadEntry } from "../shared/seal";
import { arraysMadeBy, unwiped } from "./helpers";

const accepts = (input: unknown) => InputRequestSchema.safeParse(input).success;

const fieldsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `K${index}` }));

/** The messages the schema refuses `input` with, in the order it gives them. */
function issuesOf(input: unknown): string[] {
  const parsed = InputRequestSchema.safeParse(input);
  if (parsed.success) throw new Error("expected the request schema to refuse the request");
  return parsed.error.issues.map((issue) => issue.message);
}

/** Runs `run` and returns what it threw. Fails the test if it did not throw. */
function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

/** What `validateEntries` refused with: its text, which is `invalid_request: <detail>`. */
const refusedWith = (request: ReturnType<typeof InputRequestSchema.parse>, entries: readonly PayloadEntry[]): string => {
  const error = thrownBy(() => validateEntries(request, entries));
  expect(error).toBeInstanceOf(SecureInputError);
  expect((error as SecureInputError).code).toBe("invalid_request");
  return error.message;
};

const hexOf = (files: readonly DropFile[]) => files.map((file) => [file.key, Buffer.from(file.bytes).toString("hex")]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InputRequestSchema", () => {
  it("takes text and file fields, or none, and fills the defaults", () => {
    expect(InputRequestSchema.parse({ fields: [{ key: "SA_JSON", kind: "file", format: "json" }] })).toEqual({ reason: "", fields: [{ key: "SA_JSON", kind: "file", format: "json" }] });
    expect(InputRequestSchema.parse({})).toEqual({ reason: "", fields: [] });
    // A field says no more than it was given: a text field is one that names no kind.
    expect(InputRequestSchema.parse({ reason: "why", fields: [{ key: "A", label: "hint", optional: true, kind: "text" }, { key: "B" }] })).toEqual({
      reason: "why",
      fields: [{ key: "A", label: "hint", optional: true, kind: "text" }, { key: "B" }],
    });
    for (const format of ["json", "pem", "any"]) expect(accepts({ fields: [{ key: "F", kind: "file", format }] }), format).toBe(true);
  });

  it("refuses keys that differ only in case, a repeated key, a reserved key, a format on a text field, a sink and allowExtraRows", () => {
    expect(issuesOf({ fields: [{ key: "API_KEY" }, { key: "api_key" }] })).toEqual(["field keys must differ in more than letter case"]);
    // An exact repeat is said once, as a repeat; a pair that differs by case beside it is said as well, after it.
    expect(issuesOf({ fields: [{ key: "A" }, { key: "A" }] })).toEqual(["field keys must be unique"]);
    expect(issuesOf({ fields: [{ key: "A" }, { key: "A" }, { key: "a" }] })).toEqual(["field keys must be unique", "field keys must differ in more than letter case"]);
    for (const key of ["__proto__", "constructor", "prototype"]) expect(issuesOf({ fields: [{ key }] }), key).toEqual(["this key name is reserved"]);
    expect(issuesOf({ fields: [{ key: "PEM", format: "pem" }] })).toEqual(["format is only for a file field"]);
    expect(issuesOf({ fields: [{ key: "PEM", kind: "text", format: "pem" }] })).toEqual(["format is only for a file field"]);
    // What v1 took, and this one does not: a destination, and the switch for rows of the human's, who may always add them now.
    expect(issuesOf({ sink: { kind: "dotenv", path: ".env.local", dialect: "dotenv" }, fields: [{ key: "A" }] })).toEqual(['Unrecognized key: "sink"']);
    expect(issuesOf({ fields: [{ key: "A" }], allowExtraRows: true })).toEqual(['Unrecognized key: "allowExtraRows"']);
  });

  it.each([
    ["a key that is not an identifier", { fields: [{ key: "A-B" }] }],
    ["a key that starts with a digit", { fields: [{ key: "1A" }] }],
    ["a kind it does not know", { fields: [{ key: "A", kind: "secret" }] }],
    ["a format it does not know", { fields: [{ key: "A", kind: "file", format: "yaml" }] }],
    ["an unknown property of a field", { fields: [{ key: "A", value: "typed" }] }],
    ["an unknown property", { fields: [{ key: "A" }], argv: ["rm"] }],
    ["an overlong reason", { fields: [{ key: "A" }], reason: "x".repeat(LIMITS.reason + 1) }],
    ["more fields than the limit", { fields: fieldsOf(LIMITS.fields + 1) }],
    ["an overlong label", { fields: [{ key: "A", label: "x".repeat(LIMITS.label + 1) }] }],
  ])("refuses %s", (_name, input) => {
    expect(accepts(input)).toBe(false);
  });

  it("accepts the largest field list, label, reason and key", () => {
    expect(accepts({ fields: fieldsOf(LIMITS.fields) })).toBe(true);
    expect(accepts({ fields: [{ key: "A", label: "x".repeat(LIMITS.label) }], reason: "x".repeat(LIMITS.reason) })).toBe(true);
    expect(accepts({ fields: [{ key: "K".repeat(LIMITS.key) }] })).toBe(true);
    expect(accepts({ fields: [{ key: "K".repeat(LIMITS.key + 1) }] })).toBe(false);
  });

  it("lists the states of a request, and the two a submission fulfils", () => {
    expect([...REQUEST_STATES]).toEqual(["pending", "delivered", "released", "rejected", "declined", "cancelled", "expired"]);
    expect([...FULFILLED_STATES]).toEqual(["delivered", "released"]);
  });
});

// The agent reads these words: they are what the daemon builds the tool's input schema from.
describe("SecretRequestShape", () => {
  const DESCRIBED: Record<string, string> = {
    reason: "Why you need the values, in one sentence. It is kept with the request and not shown in the form: say it in your own message too.",
    fields:
      "The keys you need; each becomes a file named after it. The human can add keys and files of their own. Keys that differ only in letter case are refused.",
    key: "The name of the value and of its file: letters, digits and _, not starting with a digit.",
    label: "A short hint about the value. It is not shown on screen; a screen reader reads it.",
    optional: "The human may leave it empty; it then gets no file.",
    kind: '"text" (default): one value on one line, such as a token or a password. "file": the content of a whole file, such as a JSON key, a PEM, a kubeconfig or a .p12; it may be binary.',
    format: 'For a file only. "json" or "pem" is checked in the app before it is sent; "any" (default) is not.',
  };

  it("describes every member in the words the agent is given", () => {
    expect(Object.fromEntries(Object.entries(SecretRequestShape.shape).map(([name, member]) => [name, member.description]))).toEqual({
      reason: DESCRIBED.reason,
      fields: DESCRIBED.fields,
    });
    expect(Object.fromEntries(Object.entries(FieldSchema.shape).map(([name, member]) => [name, member.description]))).toEqual({
      key: DESCRIBED.key,
      label: DESCRIBED.label,
      optional: DESCRIBED.optional,
      kind: DESCRIBED.kind,
      format: DESCRIBED.format,
    });
  });

  it("is the shape the request schema refines: the same members, and the refinements on top", () => {
    const input = { reason: "why", fields: [{ key: "A" }, { key: "a" }] };
    expect(SecretRequestShape.parse(input)).toEqual(input);
    expect(InputRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("validateEntries", () => {
  // Declared: a text field, an optional text field, and a file field of JSON.
  const request = InputRequestSchema.parse({ fields: [{ key: "API_KEY" }, { key: "OPT", optional: true }, { key: "SA", kind: "file", format: "json" }] });
  const sa = { key: "SA", file: toBase64Url(utf8.encode('{"a":1}')) };

  it("turns text and files into the bytes to write, skips an empty optional field, and takes a key of the human's", () => {
    const { written, skipped } = validateEntries(request, [
      { key: "API_KEY", value: "value-one" },
      { key: "SA", file: toBase64Url(utf8.encode('{"a":1}')) },
      { key: "EXTRA", file: toBase64Url(Uint8Array.from([0, 255])) },
    ]);
    expect(written.map((file) => [file.key, Buffer.from(file.bytes).toString("hex")])).toEqual([
      ["API_KEY", Buffer.from("value-one").toString("hex")],
      ["SA", Buffer.from('{"a":1}').toString("hex")],
      ["EXTRA", "00ff"],
    ]);
    expect(skipped).toEqual(["OPT"]);
  });

  it("refuses a file for a text field, text for a file field, bad base64url, and a file one byte over 128 KiB", () => {
    expect(LIMITS.fileBytes).toBe(128 * 1024);
    expect(refusedWith(request, [{ key: "API_KEY", file: toBase64Url(utf8.encode("value-one")) }, sa])).toBe("invalid_request: API_KEY must be text");
    expect(refusedWith(request, [{ key: "API_KEY", value: "value-one" }, { key: "SA", value: '{"a":1}' }])).toBe("invalid_request: SA must be a file");
    // Not the alphabet, not a length base64url has, bits after the end: each one, and no word of the decoder's.
    for (const file of ["e30+", "e30=", "AAAAA", "AB"]) {
      expect(refusedWith(request, [{ key: "API_KEY", value: "value-one" }, { key: "SA", file }]), file).toBe("invalid_request: SA is not a file the plugin can read");
    }
    expect(refusedWith(request, [{ key: "API_KEY", value: "value-one" }, { key: "SA", file: toBase64Url(new Uint8Array(LIMITS.fileBytes + 1)) }])).toBe(
      "invalid_request: SA is larger than the limit",
    );
    // The same holds for a file of the human's, and a file of exactly the limit is taken.
    expect(refusedWith(request, [{ key: "API_KEY", value: "v" }, sa, { key: "BIG", file: toBase64Url(new Uint8Array(LIMITS.fileBytes + 1)) }])).toBe(
      "invalid_request: BIG is larger than the limit",
    );
    const atTheLimit = validateEntries(request, [{ key: "API_KEY", value: "v" }, { key: "SA", file: toBase64Url(new Uint8Array(LIMITS.fileBytes).fill(7)) }]);
    expect(atTheLimit.written.map((file) => [file.key, file.bytes.length])).toEqual([
      ["API_KEY", 1],
      ["SA", LIMITS.fileBytes],
    ]);
  });

  it("refuses a file over the limit from the length of its text, before it is decoded: no array of it is made", () => {
    const over = { key: "SA", file: toBase64Url(new Uint8Array(LIMITS.fileBytes + 1).fill(7)) };
    const { made, error } = arraysMadeBy(() => validateEntries(request, [{ key: "API_KEY", value: "v" }, over]));
    expect((error as Error).message).toBe("invalid_request: SA is larger than the limit");
    expect(made.filter((bytes) => bytes.length > LIMITS.fileBytes)).toEqual([]);
    expect(unwiped(made)).toEqual([]);
    // A file of exactly the limit is decoded, into an array of its size.
    const at = { key: "SA", file: toBase64Url(new Uint8Array(LIMITS.fileBytes).fill(7)) };
    const taken = arraysMadeBy(() => validateEntries(request, [{ key: "API_KEY", value: "v" }, at]));
    expect(taken.error).toBeUndefined();
    expect(taken.made.map((bytes) => bytes.length)).toEqual([LIMITS.fileBytes]);
  });

  it("wipes a file it decoded when an entry after it is refused, and leaves nothing of a file it cannot read", () => {
    const decoded = { key: "SA", file: toBase64Url(utf8.encode("CANARY-a-file-that-was-decoded")) };
    const late = arraysMadeBy(() => validateEntries(request, [decoded, { key: "API_KEY", value: "x".repeat(LIMITS.valueBytes + 1) }]));
    expect((late.error as Error).message).toBe("invalid_request: API_KEY is larger than the limit");
    expect(late.made.map((bytes) => bytes.length)).toEqual(["CANARY-a-file-that-was-decoded".length]);
    expect(unwiped(late.made)).toEqual([]);
    // A file whose text breaks off in a character that is not base64url, after a file that was decoded.
    const broken = { key: "EXTRA", file: `${toBase64Url(utf8.encode("CANARY-a-file-it-cannot-read"))}!` };
    const refused = arraysMadeBy(() => validateEntries(request, [{ key: "API_KEY", value: "v" }, decoded, broken]));
    expect((refused.error as Error).message).toBe("invalid_request: EXTRA is not a file the plugin can read");
    expect(unwiped(refused.made)).toEqual([]);
  });

  it("refuses a key of the human's that differs from a declared one only by case, even when that field is empty", () => {
    expect(refusedWith(request, [{ key: "API_KEY", value: "value-one" }, sa, { key: "opt", value: "value-two" }])).toBe("invalid_request: OPT and opt differ only in letter case");
    expect(refusedWith(request, [{ key: "API_KEY", value: "value-one" }, sa, { key: "OPT", value: "" }, { key: "opt", file: toBase64Url(utf8.encode("x")) }])).toBe(
      "invalid_request: OPT and opt differ only in letter case",
    );
    // Two keys of the human's that would name one file, in the order they came.
    expect(refusedWith(request, [{ key: "API_KEY", value: "v" }, sa, { key: "Extra", value: "1" }, { key: "EXTRA", value: "2" }])).toBe(
      "invalid_request: Extra and EXTRA differ only in letter case",
    );
  });

  it("refuses a submission that would write nothing: every field optional and left empty, and no key of the human's", () => {
    const optional = InputRequestSchema.parse({ fields: [{ key: "A", optional: true }, { key: "F", optional: true, kind: "file" }] });
    expect(refusedWith(optional, [])).toBe("invalid_request: nothing to write");
    expect(refusedWith(optional, [{ key: "A", value: "" }, { key: "F", file: "" }])).toBe("invalid_request: nothing to write");
    expect(refusedWith(InputRequestSchema.parse({}), [])).toBe("invalid_request: nothing to write");
    // One value is enough.
    expect(validateEntries(optional, [{ key: "A", value: "" }, { key: "F", file: toBase64Url(Uint8Array.from([9])) }])).toMatchObject({ skipped: ["A"] });
    expect(validateEntries(InputRequestSchema.parse({}), [{ key: "MINE", value: "typed" }]).written.map((file) => file.key)).toEqual(["MINE"]);
  });

  it("writes text as its UTF-8, with no line break added and none taken away, and a file's bytes as they are", () => {
    const multiline = "-----BEGIN KEY-----\r\nabc\n-----END KEY-----";
    const binary = Uint8Array.from([0, 1, 2, 0x7f, 0x80, 0xfe, 0xff, 10, 13]);
    const { written } = validateEntries(request, [
      { key: "API_KEY", value: `${multiline}\n` },
      { key: "OPT", value: "ключ \u{1F511}" },
      { key: "SA", file: toBase64Url(binary) },
    ]);
    expect(hexOf(written)).toEqual([
      ["API_KEY", Buffer.from(`${multiline}\n`, "utf8").toString("hex")],
      ["OPT", Buffer.from("ключ \u{1F511}", "utf8").toString("hex")],
      ["SA", Buffer.from(binary).toString("hex")],
    ]);
  });

  it.each([
    ["a missing required key", [sa], "API_KEY"],
    ["an empty required text", [{ key: "API_KEY", value: "" }, sa], "API_KEY"],
    ["an empty required file", [{ key: "API_KEY", value: "v" }, { key: "SA", file: "" }], "SA"],
  ])("refuses %s, naming it", (_name, entries, missing) => {
    expect(refusedWith(request, entries as PayloadEntry[])).toBe(`invalid_request: ${missing} is required`);
  });

  describe("error text", () => {
    const CANARY = "CANARY-VALUE";

    it.each([
      ["repeated", [{ key: "API_KEY", value: CANARY }, { key: "API_KEY", value: CANARY }, sa], "invalid_request: API_KEY appears more than once"],
      ["oversized", [{ key: "API_KEY", value: CANARY + "x".repeat(LIMITS.valueBytes) }, sa], "invalid_request: API_KEY is larger than the limit"],
      ["missing next to a filled one", [{ key: "OPT", value: CANARY }, sa], "invalid_request: API_KEY is required"],
      ["sent as a file to a text field", [{ key: "API_KEY", file: toBase64Url(utf8.encode(CANARY)) }, sa], "invalid_request: API_KEY must be text"],
      ["sent as text to a file field", [{ key: "API_KEY", value: "v" }, { key: "SA", value: CANARY }], "invalid_request: SA must be a file"],
    ])("names only the key when a value is %s", (_name, entries, message) => {
      const error = thrownBy(() => validateEntries(request, entries as PayloadEntry[]));
      expect(error).toBeInstanceOf(SecureInputError);
      expect(error.message).not.toContain(CANARY);
      expect(error.message).toBe(message);
    });
  });

  it("refuses more entries than the field limit, the human's own included", () => {
    const open = InputRequestSchema.parse({});
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `K${index}`, value: "1" }));
    expect(validateEntries(open, entries(LIMITS.fields)).written).toHaveLength(LIMITS.fields);
    expect(thrownBy(() => validateEntries(open, entries(LIMITS.fields + 1))).message).toBe("invalid_request: too many entries");
  });

  it.each(["__proto__", "constructor", "prototype"])("refuses a key of the human's named %s without naming it", (key) => {
    expect(refusedWith(InputRequestSchema.parse({}), [{ key, value: "1" }])).toBe("invalid_request: a key name is reserved");
  });

  it("refuses a key of the human's that is no identifier without naming it", () => {
    expect(refusedWith(InputRequestSchema.parse({}), [{ key: "not valid", value: "1" }])).toBe("invalid_request: a key is not a valid identifier");
  });

  it("wipes every byte array it made when it refuses", () => {
    const made: Uint8Array[] = [];
    const encode = utf8.encode;
    vi.spyOn(utf8, "encode").mockImplementation((text: string) => {
      const bytes = encode(text);
      made.push(bytes);
      return bytes;
    });
    // Two texts are turned into bytes, and then a file field arrives as text: the refusal comes after the bytes exist.
    const late = InputRequestSchema.parse({ fields: [{ key: "A" }, { key: "B" }, { key: "F", kind: "file" }] });
    expect(refusedWith(late, [{ key: "A", value: "first-typed" }, { key: "B", value: "second-typed" }, { key: "F", value: "x" }])).toBe("invalid_request: F must be a file");
    expect(made.length).toBeGreaterThanOrEqual(2);
    for (const bytes of made) {
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
    // And when nothing is refused, the bytes are the caller's, whole.
    made.length = 0;
    const { written } = validateEntries(late, [{ key: "A", value: "first-typed" }, { key: "B", value: "second-typed" }, { key: "F", file: toBase64Url(utf8.encode("{}")) }]);
    expect(written.map((file) => Buffer.from(file.bytes).toString("utf8"))).toEqual(["first-typed", "second-typed", "{}"]);
  });

  describe("byte counting", () => {
    const euro = String.fromCodePoint(0x20ac);
    const text = InputRequestSchema.parse({ fields: [{ key: "A" }] });

    it("measures a value in bytes, not characters", () => {
      const value = euro.repeat(22_000);
      expect(value).toHaveLength(22_000);
      expect(Buffer.byteLength(value, "utf8")).toBe(66_000);
      expect(refusedWith(text, [{ key: "A", value }])).toBe("invalid_request: A is larger than the limit");
    });

    it("accepts a value of exactly the byte limit and rejects one byte more", () => {
      expect(validateEntries(text, [{ key: "A", value: "x".repeat(LIMITS.valueBytes) }]).written).toHaveLength(1);
      expect(refusedWith(text, [{ key: "A", value: "x".repeat(LIMITS.valueBytes + 1) }])).toBe("invalid_request: A is larger than the limit");
    });
  });
});

describe("validateEntries, invalid Unicode", () => {
  const request = InputRequestSchema.parse({ fields: [{ key: "A" }] });
  // Built from numbers: a lone surrogate would be written to disk as U+FFFD, silently changing the secret.
  const highAlone = String.fromCharCode(0xd83d);
  const lowAlone = String.fromCharCode(0xde00);
  const emoji = String.fromCodePoint(0x1f511);

  it.each([
    ["a lone high surrogate", `a${highAlone}b`],
    ["a lone low surrogate", `a${lowAlone}b`],
    ["a high surrogate at the end", `ab${highAlone}`],
    ["a low surrogate at the start", `${lowAlone}ab`],
    ["two high surrogates in a row", `${highAlone}${highAlone}`],
    ["a reversed pair", `${lowAlone}${highAlone}`],
  ])("rejects %s in a text field, naming the key and not the value", (_name, value) => {
    expect(refusedWith(request, [{ key: "A", value }])).toBe("invalid_request: A contains invalid Unicode");
  });

  it("accepts a real emoji, a surrogate pair", () => {
    expect(emoji).toHaveLength(2);
    expect(validateEntries(request, [{ key: "A", value: `k${emoji}` }]).written).toHaveLength(1);
  });
});
