import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { hasUnsafeCharacters } from "../shared/sanitize";
import { tempDir } from "./helpers";

const ROOT = join(import.meta.dirname, "..");

const DIRECTORIES = ["shared", "server", "client", "tests", "scripts", "skills"];
const FILES = ["index.server.ts", "index.client.tsx"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".json", ".md"];

/** Inclusive code point ranges that must be written as escapes, never as raw characters. Tab, LF and CR are allowed. */
const FORBIDDEN: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  // Invisible fillers and blanks, deprecated format characters, selectors, tags and space look-alikes
  // (the same set as `hasUnsafeCharacters` in shared/sanitize.ts), and a lone surrogate.
  [0x00a0, 0x00a0],
  [0x115f, 0x1160],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x206a, 0x206f],
  [0x2800, 0x2800],
  [0x3000, 0x3000],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
  [0xd800, 0xdfff],
  // What an earlier version of that set missed: the rest of the default-ignorable code points and the format
  // characters that are not default-ignorable. A test below holds this list to the set, so the two cannot part again.
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x17b4, 0x17b5],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0xfff0, 0xfff8],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0xe0080, 0xe00ff],
  [0xe01f0, 0xe0fff],
  // What was measured later to draw nothing: the object replacement character, and the private-use areas whole.
  [0xfffc, 0xfffc],
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
];

function isForbidden(codePoint: number): boolean {
  return FORBIDDEN.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/**
 * The source files below `directory`. A link is not followed and not read, whatever it points at: one that leads back up the
 * tree would make the walk endless, and one that leads out of it would put files that are not the plugin's into the scan.
 */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) found.push(...sourceFiles(path));
    else if (info.isFile() && EXTENSIONS.some((extension) => path.endsWith(extension))) found.push(path);
  }
  return found;
}

/** Every forbidden character in `text`, as "<line> U+<HEX>". */
function findForbidden(text: string): string[] {
  const found: string[] = [];
  let line = 1;
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint === 0x0a) line++;
    else if (isForbidden(codePoint)) found.push(`${line} U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return found;
}

describe("source hygiene", () => {
  it("walks a tree without following a link: not one back up the tree, not one out of it, not one to a file", () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "inside.ts"), "export {};\n");
    writeFileSync(join(outside, "elsewhere.ts"), "export {};\n");
    symlinkSync(root, join(root, "sub", "back-up"));
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(outside, "elsewhere.ts"), join(root, "linked.ts"));
    symlinkSync(join(root, "missing"), join(root, "dangling.ts"));
    expect(sourceFiles(root).map((path) => relative(root, path))).toEqual(["sub/inside.ts"]);
  });

  it("sources contain no raw control, bidi or zero-width characters", () => {
    // The detector proves itself first, on strings built from code points, so a silent detector cannot pass the scan.
    expect(findForbidden(`a${String.fromCodePoint(0x202e)}b`)).toEqual(["1 U+202E"]);
    expect(findForbidden(`a${String.fromCodePoint(0)}b`)).toEqual(["1 U+0000"]);
    expect(findForbidden(`a${String.fromCodePoint(0x09)}b${String.fromCodePoint(0x0a)}c`)).toEqual([]);
    expect(findForbidden(`a${String.fromCodePoint(0xad)}b`)).toEqual(["1 U+00AD"]);
    expect(findForbidden(`a${String.fromCodePoint(0x180e)}b`)).toEqual(["1 U+180E"]);
    expect(findForbidden(`a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`)).toEqual([
      "1 U+2028",
      "1 U+2029",
    ]);

    // The characters added later are caught the same way, at the ends of their ranges too.
    for (const codePoint of [0xa0, 0x115f, 0x1160, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x206a, 0x206f, 0x2800, 0x3000, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0xfff9, 0xfffb, 0x1d173, 0x1d17a, 0xe0000, 0xe007f, 0xe0100, 0xe01ef]) {
      expect(findForbidden(`a${String.fromCodePoint(codePoint)}b`), codePoint.toString(16)).toEqual([`1 U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`]);
    }
    expect(findForbidden(`a${String.fromCharCode(0xd83d)}b`)).toEqual(["1 U+D83D"]);
    // Neighbours that stay allowed: an emoji, an accented letter, braille that is not blank, the character after a range.
    expect(findForbidden(String.fromCodePoint(0x1f511, 0xe9, 0x2801, 0x2070, 0x205e, 0xfe10, 0xe1000, 0x1d17b))).toEqual([]);
    // The characters the set gained after its first version, at the ends of their ranges.
    for (const codePoint of [0x34f, 0x600, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0x17b4, 0x17b5, 0x180b, 0x180d, 0x180f, 0xfff0, 0xfff8, 0x110bd, 0x110cd, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff]) {
      expect(findForbidden(`a${String.fromCodePoint(codePoint)}b`), codePoint.toString(16)).toEqual([`1 U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`]);
    }

    // The object replacement character and the private-use areas, at their ends.
    for (const codePoint of [0xfffc, 0xe000, 0xf850, 0xf8ff, 0xf0000, 0xffffd, 0x100000, 0x10fffd]) {
      expect(findForbidden(`a${String.fromCodePoint(codePoint)}b`), codePoint.toString(16)).toEqual([`1 U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`]);
    }
    expect(findForbidden(String.fromCodePoint(0xfffd, 0xf900, 0xffffe, 0x10ffff))).toEqual([]);

    const files = [
      ...DIRECTORIES.map((name) => join(ROOT, name)).filter((path) => existsSync(path)).flatMap(sourceFiles),
      ...FILES.map((name) => join(ROOT, name)).filter((path) => existsSync(path)),
    ];

    const offenders = files.flatMap((file) =>
      findForbidden(readFileSync(file, "utf8")).map((hit) => `${relative(ROOT, file)}:${hit}`),
    );

    expect(offenders).toEqual([]);
  });

  it("forbids in a source file exactly what the plugin refuses to show, but for a tab and the two line breaks", () => {
    // The list above is written by hand, and so is the table in shared/sanitize.ts. A character that one of them
    // knows and the other does not could be typed raw into a test of the very check that refuses it.
    const ALLOWED_IN_SOURCE = [0x09, 0x0a, 0x0d];
    const differing: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
      const character = isSurrogate ? String.fromCharCode(codePoint) : String.fromCodePoint(codePoint);
      const refused = hasUnsafeCharacters(character) && !ALLOWED_IN_SOURCE.includes(codePoint);
      if (refused !== isForbidden(codePoint)) differing.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    expect(differing).toEqual([]);
    expect(ALLOWED_IN_SOURCE.every((codePoint) => hasUnsafeCharacters(String.fromCodePoint(codePoint)) && !isForbidden(codePoint))).toBe(true);
  });
});
