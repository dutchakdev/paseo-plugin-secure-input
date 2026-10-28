// The one table of characters that can hide, reorder, restyle or impersonate text. What a human is shown as a fact
// (a path, a title) is refused when it holds one of them; what an agent says in its own words (a reason, a label) has
// each of them replaced by a space.
//
// What the table is: an explicit list of inclusive code point ranges, as numbers, and the text is walked code point
// by code point. It covers every code point that Unicode 17.0 gives the property Default_Ignorable_Code_Point or
// the general category Cf (format), Cc (control), Zl or Zp (line and paragraph separator), or Zs (space) other than
// U+0020, the ordinary space; where Unicode reserves a whole block for more of them, the block is listed whole.
// It also covers the general category Co, private use, whole (the area of the basic plane and the two supplementary
// ones): a private-use code point has no appearance of its own, and what a font makes of one is the font's affair.
// Eleven of them were measured to draw nothing at all with Apple's typesetter, in the very font the destination is
// shown in, so that a name with one in it could not be told from the name without it.
// Besides those it lists three things Unicode does not put in these classes: the blank braille pattern and the
// object replacement character, symbols that draw nothing (the second was measured with the same typesetter), and
// the surrogates, because a surrogate with no partner is text nobody wrote on purpose (a well-formed pair is read as
// the one code point it stands for, and never as these).
//
// Property escapes (`\p{…}`) are not used here: this module ships to the app, and Hermes is not known to have them.
// `tests/sanitize-table.test.ts` is the proof instead. It runs in Node, asks the engine for those properties for
// every code point there is, and holds each one the engine names to be refused by this table; so the table may know
// more than an engine does (a newer Unicode), and never less. When Unicode adds a character of these classes outside
// the ranges below, that test fails on an engine that knows it, and the range is added here.
//
// What it does not do: tell a letter from a look-alike of another script. A Cyrillic letter in place of a Latin one
// is an ordinary visible letter and passes (see SECURITY.md). And it is a list: it was found incomplete twice, by
// characters that draw nothing and are in no class that says so. So it is not the only thing between a human and a
// name that is not what it looks like: the keys the form shows are held to their pattern, which is ASCII alone.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls, tab and the line breaks among them
  [0x007f, 0x00a0], // DEL, the C1 controls and the no-break space
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x0600, 0x0605], // Arabic number signs (format characters that take the digits after them)
  [0x061c, 0x061c], // Arabic letter mark
  [0x06dd, 0x06dd], // Arabic end of ayah
  [0x070f, 0x070f], // Syriac abbreviation mark
  [0x0890, 0x0891], // Arabic pound and piastre marks above
  [0x08e2, 0x08e2], // Arabic disputed end of ayah
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x1680, 0x1680], // Ogham space mark
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian free variation selectors and the Mongolian vowel separator
  [0x2000, 0x200f], // en and em spaces, zero-width characters, directional marks
  [0x2028, 0x202f], // line and paragraph separators, bidi embeddings and overrides, the narrow no-break space
  [0x205f, 0x206f], // medium mathematical space, word joiner, invisible operators, bidi isolates, deprecated format characters
  [0x2800, 0x2800], // blank braille pattern
  [0x3000, 0x3000], // ideographic space
  [0x3164, 0x3164], // Hangul filler
  [0xd800, 0xdfff], // a surrogate with no partner
  [0xe000, 0xf8ff], // the private-use area
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff0, 0xfffc], // reserved specials, the interlinear annotation marks and the object replacement character
  [0x110bd, 0x110bd], // Kaithi number sign
  [0x110cd, 0x110cd], // Kaithi number sign above
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical formatting characters
  [0xe0000, 0xe0fff], // tags, the variation selectors supplement and the reserved rest of that block
  [0xf0000, 0xffffd], // supplementary private-use area A
  [0x100000, 0x10fffd], // supplementary private-use area B
];

/** `codePointAt` gives a well-formed pair as one astral code point and a surrogate with no partner as itself. */
function isUnsafeCodePoint(codePoint: number): boolean {
  // Printable ASCII is nearly all of what is ever asked about, and none of it is in the table.
  if (codePoint >= 0x20 && codePoint < 0x7f) return false;
  for (const [first, last] of UNSAFE_RANGES) {
    if (codePoint >= first && codePoint <= last) return true;
  }
  return false;
}

/** True when `text` holds any character from the unsafe set. */
export function hasUnsafeCharacters(text: string): boolean {
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    if (isUnsafeCodePoint(codePoint)) return true;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return false;
}

/** Replaces every character from the unsafe set with a space. */
function replaceUnsafe(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    result += isUnsafeCodePoint(codePoint) ? " " : text.slice(index, index + width);
    index += width;
  }
  return result;
}

/** Agent-supplied text is shown as plain text with nothing that can restyle the dialog. */
export function sanitizeText(input: string, maxLength: number): string {
  const cleaned = replaceUnsafe(input).replace(/ {2,}/g, " ").trim();
  return [...cleaned].slice(0, maxLength).join("");
}
