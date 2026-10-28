/**
 * How long a text is, in code points: a pair of surrogates counts once, a lone surrogate as itself. This is the unit
 * the schemas state their limits in (Zod's string maximum counts code points, and so does `maxLength` of JSON Schema),
 * so a check written by hand beside a schema counts with this and not with `.length`, which counts UTF-16 units and
 * would refuse half of what the schema accepts of text outside the basic plane. Nothing is allocated.
 *
 * It is for limits on text an agent supplies and a human reads. A limit that guards a file, a volume or a socket is
 * in bytes, and says so where it is declared.
 */
export function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    length++;
  }
  return length;
}

/**
 * Whether a string holds a surrogate code unit with no partner. Such a value would be written as U+FFFD and silently
 * change the secret: the daemon refuses it, and the dialog says so before anything is sent.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
