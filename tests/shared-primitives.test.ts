import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decodedLength, fromBase64Url, randomBytes, toBase64Url, toHex, utf8, utf8Length } from "../shared/bytes";
import { canonicalJson } from "../shared/canonical";
import { ERROR_CODES, SecureInputError, errorDetailOf } from "../shared/errors";
import { DIGEST_PATTERN, PUBLIC_KEY_PATTERN, isValidKey } from "../shared/limits";
import { FieldSchema } from "../shared/request";
import { hasUnsafeCharacters, sanitizeText } from "../shared/sanitize";
import { shown } from "../shared/shown";
import { codePointLength, hasLoneSurrogate } from "../shared/text";
import { Registry } from "../server/core/registry";
import { DropStore } from "../server/io/drop";
import { replaceLegacyBridge } from "../server/io/legacy-shim";
import { arraysMadeBy, refusalOf, tempDir, unwiped } from "./helpers";

describe("bytes", () => {
  it("matches Node's base64url for every length up to 64", () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = randomBytes(length);
      const expected = Buffer.from(bytes).toString("base64url");
      expect(toBase64Url(bytes)).toBe(expected);
      expect(Buffer.from(fromBase64Url(expected))).toEqual(Buffer.from(bytes));
      // What the length of a text says it decodes to, without decoding it.
      expect(decodedLength(expected)).toBe(length);
    }
  });

  it("decodes nothing before the whole text is known to be base64url: a text it refuses leaves no array with any of its bytes", () => {
    const secret = utf8.encode("CANARY-decoded-before-the-refusal-0123456789");
    const encoded = toBase64Url(secret);
    expect(encoded.length % 4).not.toBe(0);
    // The last character changed to one that leaves bits after the last byte; and a character outside the alphabet at
    // the end, and in the middle. Each is found only once most of the text would have been decoded.
    const last = encoded.at(-1) as string;
    const spare = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const trailing = encoded.slice(0, -1) + spare[spare.indexOf(last) + 1];
    for (const text of [trailing, `${encoded.slice(0, -1)}+`, `${encoded.slice(0, 20)}!${encoded.slice(21)}`]) {
      expect(text.length % 4, text).not.toBe(1);
      const { made, error } = arraysMadeBy(() => fromBase64Url(text));
      expect(error, text).toBeInstanceOf(Error);
      expect(unwiped(made), text).toEqual([]);
    }
    // The same text as it was is decoded, into one array: the watch sees what it should.
    const { made, error } = arraysMadeBy(() => fromBase64Url(encoded));
    expect(error).toBeUndefined();
    expect(made.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual(["CANARY-decoded-before-the-refusal-0123456789"]);
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => fromBase64Url("ab+/")).toThrow();
  });

  it("rejects a length no encoder produces", () => {
    expect(() => fromBase64Url("A")).toThrow();
    expect(() => fromBase64Url("AAAAA")).toThrow();
  });

  it("rejects non-canonical trailing bits", () => {
    expect(fromBase64Url("AA")).toEqual(new Uint8Array([0]));
    expect(() => fromBase64Url("AB")).toThrow();
    expect(fromBase64Url("AAA")).toEqual(new Uint8Array([0, 0]));
    expect(() => fromBase64Url("AAB")).toThrow();
  });

  it("round-trips non-ASCII text and renders hex", () => {
    expect(utf8.decode(utf8.encode("ключ 🔑 مفتاح"))).toBe("ключ 🔑 مفتاح");
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("refuses more random bytes than one getRandomValues call allows", () => {
    expect(randomBytes(65_536)).toHaveLength(65_536);
    expect(() => randomBytes(65_537)).toThrow();
  });

  it("refuses a length that is not an integer from 0 to 65536", () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(() => randomBytes(Number.NaN)).toThrow();
    expect(() => randomBytes(1.5)).toThrow();
    expect(() => randomBytes(-1)).toThrow();
    expect(() => randomBytes(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("utf8Length", () => {
  const high = String.fromCharCode(0xd83d);
  const low = String.fromCharCode(0xdd11);
  const from = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
  const encoded = (text: string): number => new TextEncoder().encode(text).length;

  it("is the number of bytes an encoder writes, for one, two, three and four byte characters", () => {
    const table: Array<[string, string, number]> = [
      ["nothing", "", 0],
      ["ASCII", "abc", 3],
      ["NUL and DEL", from(0x00, 0x7f), 2],
      ["the first two-byte character", from(0x80), 2],
      ["the last two-byte character", from(0x7ff), 2],
      ["the first three-byte character", from(0x800), 3],
      ["the characters around the surrogates", from(0xd7ff, 0xe000), 6],
      ["the last three-byte character", from(0xffff), 3],
      ["the first four-byte character", from(0x10000), 4],
      ["the last four-byte character", from(0x10ffff), 4],
      ["Ukrainian", "ключ", 8],
      ["an emoji", from(0x1f511), 4],
      ["mixed", `a${from(0xe9)}${from(0x20ac)}${from(0x1f511)}z`, 11],
      ["a CJK extension character", from(0x20000), 4],
    ];
    for (const [name, text, bytes] of table) {
      expect(utf8Length(text), name).toBe(bytes);
      expect(encoded(text), name).toBe(bytes);
    }
  });

  it("counts a surrogate with no partner as three bytes, which is what an encoder writes in its place", () => {
    const table: Array<[string, string, number]> = [
      ["a high surrogate alone", high, 3],
      ["a low surrogate alone", low, 3],
      ["a low surrogate before a high one", low + high, 6],
      ["two high surrogates and a low one", high + high + low, 7],
      ["a pair and a low surrogate", high + low + low, 7],
      ["a high surrogate at the end", `ab${high}`, 5],
      ["a high surrogate before a letter", `${high}a`, 4],
      ["a pair between lone surrogates", low + high + low + high, 10],
    ];
    for (const [name, text, bytes] of table) {
      expect(utf8Length(text), name).toBe(bytes);
      expect(encoded(text), name).toBe(bytes);
    }
  });

  it("agrees with the encoder for every mix of characters of each width and of surrogates", () => {
    const alphabet = ["a", from(0xe9), from(0x20ac), high, low, String.fromCharCode(0xdbff), String.fromCharCode(0xdc00)];
    let layer = [""];
    let tried = 0;
    for (let length = 1; length <= 5; length++) {
      layer = layer.flatMap((prefix) => alphabet.map((unit) => prefix + unit));
      for (const text of layer) {
        tried += 1;
        expect(utf8Length(text), JSON.stringify(text)).toBe(encoded(text));
      }
    }
    expect(tried).toBe(7 + 7 ** 2 + 7 ** 3 + 7 ** 4 + 7 ** 5);
  });

  it("agrees with the encoder for every code point there is, and with Buffer.byteLength", () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += codePoint < 0x3000 ? 1 : 97) {
      const text = `a${codePoint >= 0xd800 && codePoint <= 0xdfff ? String.fromCharCode(codePoint) : from(codePoint)}b`;
      const bytes = encoded(text);
      if (utf8Length(text) !== bytes) throw new Error(`U+${codePoint.toString(16)}: ${utf8Length(text)} against ${bytes}`);
      if (Buffer.byteLength(text, "utf8") !== bytes) throw new Error(`U+${codePoint.toString(16)}: Buffer.byteLength differs`);
    }
    expect(utf8Length(from(0x10ffff))).toBe(4);
  });

  it("allocates nothing that holds the text: it never asks the encoder", () => {
    const spy = vi.spyOn(utf8, "encode");
    try {
      expect(utf8Length("секрет ".repeat(1000))).toBe(13 * 1000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("codePointLength", () => {
  const high = String.fromCharCode(0xd83d);
  const low = String.fromCharCode(0xdd11);
  const key = high + low;

  it("counts a pair of surrogates once and a lone one as itself", () => {
    expect(codePointLength("")).toBe(0);
    expect(codePointLength("abc")).toBe(3);
    expect(codePointLength(key)).toBe(1);
    expect(codePointLength(`a${key}b${key}`)).toBe(4);
    expect(codePointLength(high)).toBe(1);
    expect(codePointLength(low)).toBe(1);
    expect(codePointLength(low + high)).toBe(2);
    expect(codePointLength(high + high + low)).toBe(2);
    expect(codePointLength(high + low + low)).toBe(2);
    expect(codePointLength(`${key}${high}`)).toBe(2);
    expect(codePointLength(String.fromCodePoint(0xffff, 0x10000, 0x10ffff))).toBe(3);
  });

  it("is the number of steps the string's own iterator takes, for every mix of ordinary letters and surrogates", () => {
    const alphabet = ["a", high, low, String.fromCodePoint(0xe9), String.fromCharCode(0xdbff), String.fromCharCode(0xdc00)];
    let layer = [""];
    for (let length = 1; length <= 5; length++) {
      layer = layer.flatMap((prefix) => alphabet.map((unit) => prefix + unit));
      for (const text of layer) expect(codePointLength(text), JSON.stringify(text)).toBe([...text].length);
    }
  });

  // The reason it exists: a limit a schema states and a check written by hand beside it must count alike.
  it("counts what a Zod string maximum counts, at the limit and one over it", () => {
    const atMost = z.string().max(4);
    for (const text of ["abcd", "abcde", key.repeat(4), key.repeat(5), `${key}${high}ab`, `${key}${high}abc`, high.repeat(4), high.repeat(5), `ab${key}${key}`, `abc${key}${key}`]) {
      expect(atMost.safeParse(text).success, JSON.stringify(text)).toBe(codePointLength(text) <= 4);
    }
    expect(atMost.safeParse(key.repeat(4)).success).toBe(true);
    expect(key.repeat(4)).toHaveLength(8);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("drops undefined properties but renders every other plain value", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("throws on every value it could not render injectively", () => {
    class Point {
      x = 1;
    }
    const rejected: unknown[] = [
      undefined,
      [undefined],
      [1, undefined, 2],
      new Array(2),
      { nested: [Number.NaN] },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      () => 1,
      Symbol("s"),
      12345678901234567890n,
      { a: 12345678901234567890n },
      new Date(0),
      new Map(),
      new Point(),
    ];
    for (const value of rejected) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
      expect(() => canonicalJson(value)).toThrow("canonicalJson: unsupported value");
    }
  });
});

describe("errors", () => {
  it("builds its text from the code and the detail it was given, and from the code alone when there is none", () => {
    const error = new SecureInputError("invalid_request", "STRIPE_KEY");
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("invalid_request: STRIPE_KEY");
    expect(new SecureInputError("request_closed").message).toBe("request_closed");
  });

  // A code that is on the list is a promise to the app and to the agent: each has a sentence in the dialog, a row in the
  // skills. The constructor takes only listed codes by its type; this follows refusals out of the modules that raise them.
  it("carries a code from the fixed list along each real refusal path: the request schema, the drop store, the registry and the stub for v1", async () => {
    const dataDir = tempDir();
    const registry = new Registry({
      dataDir,
      drop: new DropStore(join(dataDir, "drop")),
      onChange: () => undefined,
      onForget: () => undefined,
      now: () => Date.now(),
    });
    const asking = { agentId: "agent-1", cwd: "/work/agent-1", title: null };
    const { requestId } = await registry.create(asking, { fields: [{ key: "A" }] });
    // A data directory whose `bin/` is a link: the stub that takes the place of v1's bridge is not written through it.
    const linked = tempDir();
    symlinkSync(tempDir(), join(linked, "bin"));
    // A `drop/` that is a link: no set is written through it.
    const dropLinked = tempDir();
    symlinkSync(tempDir(), join(dropLinked, "drop"));
    const paths: Array<[string, string, () => Promise<unknown>]> = [
      ["the request schema, as the registry applies it", "invalid_request", () => registry.create(asking, { fields: [{ key: "A" }], sink: { kind: "dotenv" } })],
      ["the drop store: a drop/ that is a link", "service_unavailable", () => new DropStore(join(dropLinked, "drop")).hold()],
      ["the registry: another agent's request", "request_closed", () => registry.cancel("agent-2", requestId)],
      ["the stub for v1: a bin/ that is a link", "service_unavailable", () => replaceLegacyBridge(linked, { kind: "node", execPath: process.execPath })],
    ];
    for (const [where, code, refused] of paths) {
      const error = await refusalOf(refused);
      expect(error.code, where).toBe(code);
      expect(ERROR_CODES as readonly string[], where).toContain(error.code);
    }
  });

  it("hands on the detail an error of the plugin's own carries, cleaned and cut, and nothing of any other error", () => {
    const bidi = String.fromCodePoint(0x202e);
    expect(errorDetailOf(new SecureInputError("write_failed", "config/dir"), 100)).toBe("config/dir");
    expect(errorDetailOf(new SecureInputError("write_failed", `con${bidi}fig\n/dir`), 100)).toBe("con fig /dir");
    expect(errorDetailOf(new SecureInputError("write_failed", "abcdefghij"), 4)).toBe("abcd");
    expect(errorDetailOf(new SecureInputError("write_failed", "\u{1F511}\u{1F511}\u{1F511}"), 2)).toBe("\u{1F511}\u{1F511}");
    // None, or none that is left once it is cleaned.
    expect(errorDetailOf(new SecureInputError("request_closed"), 100)).toBeUndefined();
    expect(errorDetailOf(new SecureInputError("write_failed", ` ${bidi} `), 100)).toBeUndefined();
    // An error that is not the plugin's own: what a library or the system wrote is never passed on.
    expect(errorDetailOf(new Error("write_failed: config/dir"), 100)).toBeUndefined();
    expect(errorDetailOf(Object.assign(new Error("ENOENT: no such file, open '/secret/path'"), { code: "ENOENT" }), 100)).toBeUndefined();
    expect(errorDetailOf({ code: "write_failed", message: "write_failed: config/dir" }, 100)).toBeUndefined();
    expect(errorDetailOf("write_failed: config/dir", 100)).toBeUndefined();
    expect(errorDetailOf(undefined, 100)).toBeUndefined();
    // An error whose message was changed after it was made says nothing of its own.
    const changed = new SecureInputError("write_failed", "config/dir");
    changed.message = "something else";
    expect(errorDetailOf(changed, 100)).toBeUndefined();
  });
});

describe("sanitizeText", () => {
  it("removes control and bidi characters and caps by code point", () => {
    expect(sanitizeText("pay\u202Eload\nnext\u0000", 100)).toBe("pay load next");
    expect(sanitizeText("🔑🔑🔑", 2)).toBe("🔑🔑");
    expect(sanitizeText("  a   b  ", 10)).toBe("a b");
  });
});

describe("hasUnsafeCharacters", () => {
  const family: ReadonlyArray<readonly [string, number]> = [
    ["a C0 control (DEL)", 0x7f],
    ["a C1 control (NEL)", 0x85],
    ["the soft hyphen", 0xad],
    ["the Arabic letter mark", 0x61c],
    ["the Mongolian vowel separator", 0x180e],
    ["a zero-width space", 0x200b],
    ["a directional mark", 0x200e],
    ["the line separator", 0x2028],
    ["a bidi override", 0x202e],
    ["a bidi isolate", 0x2066],
    ["the byte order mark", 0xfeff],
  ];

  it.each(family)("is true for %s", (_name, codePoint) => {
    expect(hasUnsafeCharacters(`a${String.fromCodePoint(codePoint)}b`)).toBe(true);
  });

  it("is false for plain ASCII, Cyrillic text and an emoji", () => {
    expect(hasUnsafeCharacters("plain ascii: .env.local")).toBe(false);
    expect(hasUnsafeCharacters("ключ доступу")).toBe(false);
    expect(hasUnsafeCharacters(String.fromCodePoint(0x1f511))).toBe(false);
  });

  it("gives the same answer when called twice in a row on the same input", () => {
    const unsafe = `a${String.fromCodePoint(0x202e)}b`;
    expect(hasUnsafeCharacters(unsafe)).toBe(true);
    expect(hasUnsafeCharacters(unsafe)).toBe(true);
  });

  it("agrees with sanitizeText on the new code points", () => {
    for (const codePoint of [0xad, 0x180e, 0x2028, 0x2029]) {
      expect(sanitizeText(`a${String.fromCodePoint(codePoint)}b`, 10)).toBe("a b");
    }
  });
});

describe("hasUnsafeCharacters: fillers, format characters, selectors, tags and look-alike spaces", () => {
  // Each range as [name, first, last]: its two ends and its middle are all tested.
  const ranges: ReadonlyArray<readonly [string, number, number]> = [
    ["the Hangul choseong filler", 0x115f, 0x115f],
    ["the Hangul jungseong filler", 0x1160, 0x1160],
    ["the Hangul filler", 0x3164, 0x3164],
    ["the halfwidth Hangul filler", 0xffa0, 0xffa0],
    ["the blank braille pattern", 0x2800, 0x2800],
    ["a deprecated format character", 0x206a, 0x206f],
    ["an interlinear annotation mark", 0xfff9, 0xfffb],
    ["a musical formatting character", 0x1d173, 0x1d17a],
    ["a variation selector", 0xfe00, 0xfe0f],
    ["a variation selector from the supplement", 0xe0100, 0xe01ef],
    ["a tag character", 0xe0000, 0xe007f],
    ["the no-break space", 0xa0, 0xa0],
    ["the Ogham space mark", 0x1680, 0x1680],
    ["an en or em space", 0x2000, 0x200a],
    ["the narrow no-break space", 0x202f, 0x202f],
    ["the medium mathematical space", 0x205f, 0x205f],
    ["the ideographic space", 0x3000, 0x3000],
  ];
  const rows = ranges.flatMap(([name, first, last]) =>
    [...new Set([first, Math.floor((first + last) / 2), last])].map((codePoint) => [name, codePoint] as const),
  );
  const hex = (codePoint: number) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

  it.each(rows)("is true for %s, %#", (_name, codePoint) => {
    const character = String.fromCodePoint(codePoint);
    expect(hasUnsafeCharacters(character), hex(codePoint)).toBe(true);
    expect(hasUnsafeCharacters(`ab${character}cd`), hex(codePoint)).toBe(true);
    expect(hasUnsafeCharacters(`${character}ab`), hex(codePoint)).toBe(true);
    expect(hasUnsafeCharacters(`ab${character}`), hex(codePoint)).toBe(true);
  });

  it("covers every code point of every range, not only the three tried above", () => {
    for (const [, first, last] of ranges) {
      for (let codePoint = first; codePoint <= last; codePoint++) {
        expect(hasUnsafeCharacters(`a${String.fromCodePoint(codePoint)}b`), hex(codePoint)).toBe(true);
      }
    }
  });

  it("stops at the ends of each range", () => {
    // Assigned or not, these sit one step outside a range and stay safe. The code points between the tags and the
    // variation selectors supplement, and after the supplement, are default-ignorable and were added to the table after
    // its first version; the ends of that block are the neighbours now. The object replacement character, U+FFFC, stood
    // here as the neighbour of the annotation marks: it draws nothing and is in the table, and the replacement
    // character after it, which is drawn, is the neighbour.
    const outside = [
      0xa1, 0x115e, 0x1161, 0x167f, 0x1681, 0x205e, 0x2070, 0x27ff, 0x2801, 0x3001, 0x3163, 0x3165, 0xfe10, 0xff9f, 0xffa1,
      0xfffd, 0x1d172, 0x1d17b, 0xdffff, 0xe1000,
    ];
    for (const codePoint of outside) {
      expect(hasUnsafeCharacters(`a${String.fromCodePoint(codePoint)}b`), hex(codePoint)).toBe(false);
    }
  });

  it("leaves ordinary text alone: an ordinary space, accented and Cyrillic letters, CJK, emoji and punctuation", () => {
    const safe = [
      "plain text with spaces: .env.local, a-b_c (d) [e] {f} \"g\" 'h'",
      `caf${String.fromCodePoint(0xe9)}`,
      "ключ доступу",
      String.fromCodePoint(0x4e2d, 0x6587),
      String.fromCodePoint(0x1f511),
      String.fromCodePoint(0x1f600),
      `a${String.fromCodePoint(0x1f3fb)}`,
      String.fromCodePoint(0x20000),
      String.fromCodePoint(0x2a700),
      String.fromCodePoint(0x20),
    ];
    for (const text of safe) expect(hasUnsafeCharacters(text), text).toBe(false);
  });

  describe("a lone surrogate", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    const emoji = String.fromCodePoint(0x1f600);

    it.each([
      ["a high surrogate alone", high],
      ["a low surrogate alone", low],
      ["a high surrogate in text", `a${high}b`],
      ["a low surrogate in text", `a${low}b`],
      ["a high surrogate at the end", `ab${high}`],
      ["a low surrogate at the start", `${low}ab`],
      ["a low surrogate before a high one", `${low}${high}`],
      ["two high surrogates", `${high}${high}`],
      ["a high surrogate before a whole emoji", `${high}${emoji}`],
      ["a low surrogate after a whole emoji", `${emoji}${low}`],
      ["a high surrogate between whole emoji", `${emoji}${high}${emoji}`],
    ])("is unsafe: %s", (_name, text) => {
      expect(hasUnsafeCharacters(text)).toBe(true);
    });

    it("is safe for a well-formed pair, alone, repeated and in text", () => {
      expect(emoji).toBe(`${high}${low}`);
      expect(hasUnsafeCharacters(emoji)).toBe(false);
      expect(hasUnsafeCharacters(`a${emoji}${emoji}b`)).toBe(false);
    });
  });

  it("gives the same answer when asked again, whichever way the first call went", () => {
    for (const text of [`a${String.fromCodePoint(0xe0041)}b`, `a${String.fromCharCode(0xd83d)}`, "ab"]) {
      expect(hasUnsafeCharacters(text)).toBe(hasUnsafeCharacters(text));
    }
  });
});

describe("sanitizeText: fillers, format characters, selectors, tags and look-alike spaces", () => {
  const classes = [
    0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x1d173, 0x1d17a, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0xe0000,
    0xe007f, 0xa0, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000,
  ];

  it("turns each into a space and leaves nothing unsafe behind", () => {
    for (const codePoint of classes) {
      const cleaned = sanitizeText(`a${String.fromCodePoint(codePoint)}b`, 10);
      expect(cleaned, `U+${codePoint.toString(16)}`).toBe("a b");
      expect(hasUnsafeCharacters(cleaned)).toBe(false);
    }
  });

  it("handles one of each class, a lone surrogate of each kind and old and new characters together", () => {
    const replaced = [
      ...classes.map((codePoint) => String.fromCodePoint(codePoint)),
      String.fromCharCode(0xd83d),
      String.fromCharCode(0xde00),
      String.fromCodePoint(0x202e),
    ];
    let cleaned = "";
    expect(() => {
      cleaned = sanitizeText([...replaced, "y"].join("x"), 1000);
    }).not.toThrow();
    expect(hasUnsafeCharacters(cleaned)).toBe(false);
    // Each replaced character became a space and was followed by an "x"; the last "x" is glued to the "y". Runs of spaces collapse and the leading one is trimmed.
    expect(cleaned).toBe(`${Array(replaced.length - 1).fill("x").join(" ")} xy`);
  });

  it("keeps a well-formed emoji and counts it as one character against the cap", () => {
    const emoji = String.fromCodePoint(0x1f511);
    expect(sanitizeText(`a${emoji}b`, 10)).toBe(`a${emoji}b`);
    expect(sanitizeText(`${emoji}${emoji}${emoji}`, 2)).toBe(`${emoji}${emoji}`);
    expect(sanitizeText(`${emoji}${String.fromCharCode(0xd83d)}${emoji}`, 10)).toBe(`${emoji} ${emoji}`);
  });

  it("removes tag characters that smuggle text, and a name made only of look-alike spaces becomes empty", () => {
    const tags = [...("evil")].map((letter) => String.fromCodePoint(0xe0000 + letter.charCodeAt(0))).join("");
    expect(sanitizeText(`hello${tags}`, 20)).toBe("hello");
    expect(sanitizeText(String.fromCodePoint(0xa0, 0x3000, 0x2800, 0x3164), 20)).toBe("");
  });

  it("does not throw on text made only of surrogates", () => {
    const text = String.fromCharCode(0xde00, 0xd83d, 0xd83d, 0xde00, 0xde00, 0xd83d);
    expect(() => sanitizeText(text, 5)).not.toThrow();
    expect(hasUnsafeCharacters(sanitizeText(text, 5))).toBe(false);
  });
});

describe("isValidKey", () => {
  it("takes a name of the key pattern that a plain object does not treat specially, and nothing that is not a string", () => {
    for (const key of ["A", "_", "STRIPE_KEY", "a1_b2", "K".repeat(128), "constructors", "protos"]) expect(isValidKey(key), key).toBe(true);
    for (const key of ["", "1A", "A-B", "A B", "A\n", "K".repeat(129), "__proto__", "constructor", "prototype", "é", "A.B"]) expect(isValidKey(key), JSON.stringify(key)).toBe(false);
    for (const key of [undefined, null, 5, {}, ["A"], Symbol("A")]) expect(isValidKey(key), String(key)).toBe(false);
  });

  it("is the pattern and the reserved names, as the request schema holds a field key to them", () => {
    for (const key of ["A", "__proto__", "constructor", "prototype", "1A", ""]) {
      expect(FieldSchema.safeParse({ key }).success, JSON.stringify(key)).toBe(isValidKey(key));
    }
  });
});

describe("hasLoneSurrogate", () => {
  const high = String.fromCharCode(0xd83d);
  const low = String.fromCharCode(0xdd11);
  it("is true for a surrogate unit with no partner, wherever it stands, and false for a pair and for any other text", () => {
    for (const [text, expected] of [
      ["", false],
      ["plain", false],
      ["секрет €", false],
      [high + low, false],
      [`a${high}${low}b`, false],
      [high + low + high + low, false],
      [high, true],
      [low, true],
      [`a${high}`, true],
      [`${high}a`, true],
      [low + high, true],
      [high + high + low, true],
      [high + low + low, true],
      [`${high}${low}${high}`, true],
    ] as const) {
      expect(hasLoneSurrogate(text), JSON.stringify(text)).toBe(expected);
    }
  });
});

describe("shown", () => {
  it("bounds the text in code points, wants a minimum only when asked for one, and refuses text that hides or reorders", () => {
    const bidi = String.fromCodePoint(0x202e);
    expect(shown(3).safeParse("abc").success).toBe(true);
    expect(shown(3).safeParse("abcd").success).toBe(false);
    expect(shown(3).safeParse("").success).toBe(true);
    expect(shown(3, 1).safeParse("").success).toBe(false);
    expect(shown(3, 2).safeParse("a").success).toBe(false);
    expect(shown(3, 2).safeParse("ab").success).toBe(true);
    expect(shown(2).safeParse("\u{1F511}\u{1F511}").success).toBe(true);
    expect(shown(2).safeParse("\u{1F511}\u{1F511}\u{1F511}").success).toBe(false);
    expect(shown(10).safeParse(`a${bidi}b`).success).toBe(false);
    expect(shown(10).safeParse(`a${String.fromCharCode(0)}b`).success).toBe(false);
    expect(shown(10).safeParse(5).success).toBe(false);
    // The words of the refusal are the caller's.
    expect(shown(10).safeParse(`a${bidi}`).error?.issues[0]?.message).toBe("unsafe characters");
    expect(shown(10, 0, "no hidden text here").safeParse(`a${bidi}`).error?.issues[0]?.message).toBe("no hidden text here");
    // A minimum can still be added after the fact.
    expect(shown(3).min(1).safeParse("").success).toBe(false);
  });
});

describe("the patterns both halves share", () => {
  it("say what each is a pattern of", () => {
    const accepts = (pattern: RegExp, values: string[]) => values.map((value) => pattern.test(value));
    expect(accepts(DIGEST_PATTERN, ["a".repeat(64), "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)])).toEqual([true, false, false, false, false]);
    expect(accepts(PUBLIC_KEY_PATTERN, ["A".repeat(43), "a-_9".repeat(10) + "abc", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + "+"])).toEqual([true, true, false, false, false, false]);
  });
});
