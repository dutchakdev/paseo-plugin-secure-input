import { z } from "zod";
import { hasUnsafeCharacters } from "./sanitize";

/**
 * Text a human reads: at most `max` code points, at least `min` (none by default), and free of anything that hides,
 * reorders or restyles it. The one definition of that refinement; a caller that wants other words for the refusal gives
 * them, and one that wants a minimum on a schema it already built can still call `.min` on the result.
 */
export function shown(max: number, min = 0, message = "unsafe characters") {
  const text = min > 0 ? z.string().min(min) : z.string();
  return text.max(max).refine((value) => !hasUnsafeCharacters(value), message);
}
