import { describe, expect, it } from "vitest";
import { hasUnsafeCharacters, sanitizeText } from "../shared/sanitize";

// The proof of the table in `shared/sanitize.ts`. The table is written by hand, because the code that holds it ships
// to the app and may not ask the engine for a Unicode property there. Here, in Node, the engine is asked for every
// code point, and the table is held to refuse each one the engine names.

const LAST = 0x10ffff;
const hex = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
const isSurrogate = (codePoint: number): boolean => codePoint >= 0xd800 && codePoint <= 0xdfff;
const refuses = (codePoint: number): boolean => hasUnsafeCharacters(`a${String.fromCodePoint(codePoint)}b`);

/**
 * What draws nothing, or formats its neighbours, or is a control, or separates lines, as the engine knows it; and the
 * private-use code points (`Co`), which have no appearance of their own: a font may draw one as nothing at all.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}]/u;
/** What passes for a space. The ordinary space is the one of these that is allowed. */
const SPACE = /\p{Zs}/u;

describe("the table of unsafe characters, against the engine", () => {
  it("refuses every code point the engine calls default-ignorable, a format character, a control, a separator, private-use or a space other than U+0020", () => {
    const missed: string[] = [];
    let seen = 0;
    for (let codePoint = 0; codePoint <= LAST; codePoint++) {
      if (isSurrogate(codePoint)) continue;
      const character = String.fromCodePoint(codePoint);
      const unsafe = INVISIBLE.test(character) || (SPACE.test(character) && codePoint !== 0x20);
      if (!unsafe) continue;
      seen += 1;
      if (!refuses(codePoint)) missed.push(hex(codePoint));
    }
    // The table may know more than this engine does (a newer Unicode); it may never know less.
    expect(missed).toEqual([]);
    // A loop that matched nothing would pass the line above: Unicode 15.1 already has more than this many, and the
    // three private-use areas alone are 137,468.
    expect(seen).toBeGreaterThan(141_000);
  });

  it("is asked with an engine that knows the characters the table was first found to miss", () => {
    // If the engine did not call these unsafe, the test above would prove nothing about them.
    for (const codePoint of [0x34f, 0x17b4, 0x180b, 0x180f, 0xfff0, 0x1bca0, 0xe0080, 0xe0fff, 0x600, 0x6dd, 0x110bd, 0x13430]) {
      expect(INVISIBLE.test(String.fromCodePoint(codePoint)), hex(codePoint)).toBe(true);
    }
    // The private-use areas, at their ends, and the eleven of them that were found to draw nothing in Apple's fonts.
    for (const codePoint of [0xe000, 0xf8ff, 0xf0000, 0xffffd, 0x100000, 0x10fffd, 0xf850, 0xf85f, 0xf866, 0xf86b, 0xf87f]) {
      expect(INVISIBLE.test(String.fromCodePoint(codePoint)), hex(codePoint)).toBe(true);
    }
    // The object replacement character is in none of these classes (it is a symbol): the table lists it by itself,
    // and the pinned tests below hold it there.
    expect(INVISIBLE.test(String.fromCodePoint(0xfffc))).toBe(false);
    expect(SPACE.test(String.fromCodePoint(0xa0))).toBe(true);
    expect(INVISIBLE.test("a")).toBe(false);
  });

  it("refuses exactly as many code points as it lists, so that a range cannot grow or shrink unnoticed", () => {
    let refused = 0;
    for (let codePoint = 0; codePoint <= LAST; codePoint++) {
      if (!isSurrogate(codePoint) && refuses(codePoint)) refused += 1;
    }
    // Counted from the table itself, with no question to the engine: 4,289 that Unicode 17.0 names as invisible, the
    // blank braille pattern, the object replacement character, and the three private-use areas (6,400 and twice 65,534).
    expect(refused).toBe(4290 + 1 + 6400 + 65_534 + 65_534);
    expect(refused).toBe(141_759);
  });
});

describe("the table of unsafe characters, pinned", () => {
  // What an earlier version of the table missed: default-ignorable code points first, then format characters that are
  // not default-ignorable. The ranges are written out here, independent of what the engine knows.
  const ranges: ReadonlyArray<readonly [string, number, number]> = [
    ["the combining grapheme joiner", 0x34f, 0x34f],
    ["the Khmer inherent vowels", 0x17b4, 0x17b5],
    ["the Mongolian free variation selectors", 0x180b, 0x180d],
    ["the fourth Mongolian free variation selector", 0x180f, 0x180f],
    ["the reserved specials", 0xfff0, 0xfff8],
    ["the shorthand format controls", 0x1bca0, 0x1bca3],
    ["the reserved code points after the tags", 0xe0080, 0xe00ff],
    ["the reserved code points after the variation selectors supplement", 0xe01f0, 0xe0fff],
    ["the Arabic number signs", 0x600, 0x605],
    ["the Arabic end of ayah", 0x6dd, 0x6dd],
    ["the Syriac abbreviation mark", 0x70f, 0x70f],
    ["the Arabic pound and piastre marks", 0x890, 0x891],
    ["the Arabic disputed end of ayah", 0x8e2, 0x8e2],
    ["the Kaithi number sign", 0x110bd, 0x110bd],
    ["the Kaithi number sign above", 0x110cd, 0x110cd],
    ["the Egyptian hieroglyph format controls", 0x13430, 0x1343f],
    // What was measured later with Apple's typesetter: these pass every class above and draw nothing.
    ["the object replacement character", 0xfffc, 0xfffc],
    ["the private-use area of the basic plane", 0xe000, 0xf8ff],
    ["the private-use code points that draw nothing in Menlo", 0xf85f, 0xf866],
    ["supplementary private-use area A", 0xf0000, 0xffffd],
    ["supplementary private-use area B", 0x100000, 0x10fffd],
  ];

  it("refuses each of the twelve code points that were measured to draw nothing, by itself and inside a file name", () => {
    const measured = [0xfffc, 0xf850, 0xf85f, 0xf860, 0xf861, 0xf862, 0xf863, 0xf864, 0xf865, 0xf866, 0xf86b, 0xf87f];
    expect(measured).toHaveLength(12);
    for (const codePoint of measured) {
      expect(refuses(codePoint), hex(codePoint)).toBe(true);
      // The name this makes: identical to `.env.local` on screen, and another file.
      expect(hasUnsafeCharacters(`.env${String.fromCodePoint(codePoint)}.local`), hex(codePoint)).toBe(true);
    }
  });

  it.each(ranges)("refuses %s, at both ends of the range", (_name, first, last) => {
    expect(refuses(first), hex(first)).toBe(true);
    expect(refuses(last), hex(last)).toBe(true);
    const character = String.fromCodePoint(first);
    // Wherever it stands, and alone.
    expect(hasUnsafeCharacters(character)).toBe(true);
    expect(hasUnsafeCharacters(`${character}ab`)).toBe(true);
    expect(hasUnsafeCharacters(`ab${character}`)).toBe(true);
  });

  it("refuses every code point inside each of those ranges", () => {
    for (const [, first, last] of ranges) {
      for (let codePoint = first; codePoint <= last; codePoint++) expect(refuses(codePoint), hex(codePoint)).toBe(true);
    }
  });

  it("still refuses a surrogate that has no partner, which is no code point at all", () => {
    expect(hasUnsafeCharacters(`a${String.fromCharCode(0xd83d)}b`)).toBe(true);
    expect(hasUnsafeCharacters(`a${String.fromCharCode(0xde00)}b`)).toBe(true);
    expect(hasUnsafeCharacters(String.fromCharCode(0xde00, 0xd83d))).toBe(true);
  });

  it("turns each of them into a space in text an agent wrote", () => {
    for (const [, first, last] of ranges) {
      expect(sanitizeText(`a${String.fromCodePoint(first)}b`, 10), hex(first)).toBe("a b");
      expect(sanitizeText(`a${String.fromCodePoint(last)}b`, 10), hex(last)).toBe("a b");
    }
  });
});

describe("what the table leaves alone", () => {
  const from = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

  it.each([
    ["Ukrainian text", "Ключ доступу до сховища: їжак, ґанок, єнот, з'їзд"],
    ["Polish text", from(0x5a, 0x61, 0x17c, 0xf3, 0x142, 0x107, 0x20, 0x67, 0x119, 0x15b, 0x6c, 0x105, 0x20, 0x6a, 0x61, 0x17a, 0x144)],
    ["the right single quotation mark", `п${from(0x2019)}ять`],
    ["the modifier letter apostrophe", `п${from(0x2bc)}ять`],
    ["the em dash", `ключ ${from(0x2014)} значення`],
    ["guillemets", `${from(0xab)}Сховати${from(0xbb)}`],
    ["the hryvnia sign", `100 ${from(0x20b4)}`],
    ["ordinary Latin letters and digits", "The quick brown fox 0123456789"],
    ["path punctuation", "./secrets/.env.local ~/a-b_c/d+e=f,g;h:i@j#k%l&m(n)[o]{p}!?*$^|<>\\\"'`"],
    ["a single emoji without joiners", from(0x1f511)],
    ["an emoji in a path", `${from(0x1f600)}/.env`],
  ])("is %s", (_name, text) => {
    expect(hasUnsafeCharacters(text), text).toBe(false);
    // Nothing of it is replaced either.
    expect(sanitizeText(text, 1000)).toBe(text);
  });

  it("is each of the Ukrainian punctuation marks on its own", () => {
    for (const codePoint of [0x2019, 0x2bc, 0x2014, 0xab, 0xbb, 0x20b4]) {
      expect(refuses(codePoint), hex(codePoint)).toBe(false);
      expect(hasUnsafeCharacters(String.fromCodePoint(codePoint)), hex(codePoint)).toBe(false);
    }
  });

  it("is every letter of the Ukrainian and Polish alphabets, every printable ASCII character and every digit", () => {
    const ukrainian = "АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюя";
    const polish = from(0x104, 0x105, 0x106, 0x107, 0x118, 0x119, 0x141, 0x142, 0x143, 0x144, 0xd3, 0xf3, 0x15a, 0x15b, 0x179, 0x17a, 0x17b, 0x17c);
    for (const character of [...ukrainian, ...polish]) expect(hasUnsafeCharacters(character), character).toBe(false);
    for (let codePoint = 0x20; codePoint < 0x7f; codePoint++) expect(refuses(codePoint), hex(codePoint)).toBe(false);
  });

  it("is the code point on each side of a range that was added", () => {
    // U+FFFC was listed here once, as the safe neighbour of the reserved specials: it is the object replacement
    // character, which draws nothing, and the range now ends on it. The replacement character after it is visible.
    for (const codePoint of [0x34e, 0x350, 0x5ff, 0x606, 0x6dc, 0x6de, 0x70e, 0x710, 0x88f, 0x892, 0x8e1, 0x8e3, 0x17b3, 0x17b6, 0x180a, 0x1810, 0xffef, 0xfffd]) {
      expect(refuses(codePoint), hex(codePoint)).toBe(false);
    }
    for (const codePoint of [0x110bc, 0x110be, 0x110cc, 0x110ce, 0x1342f, 0x13440, 0x1bc9f, 0x1bca4, 0xdffff, 0xe1000]) {
      expect(refuses(codePoint), hex(codePoint)).toBe(false);
    }
    // On each side of the private-use areas: the compatibility ideographs after the first, and the code points that
    // are no characters around the other two (the surrogates before the first are refused for what they are).
    for (const codePoint of [0xf900, 0xeffff, 0xffffe, 0xfffff, 0x10fffe, 0x10ffff]) {
      expect(refuses(codePoint), hex(codePoint)).toBe(false);
    }
  });
});
