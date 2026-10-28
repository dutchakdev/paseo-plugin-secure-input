const UNSUPPORTED = "canonicalJson: unsupported value";

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deterministic JSON for authenticated data and digests: keys sorted at every depth, no whitespace.
 * Strict on purpose, so two different inputs never render to the same text: only null, booleans,
 * strings, finite numbers, arrays and plain objects are accepted. Properties whose value is
 * undefined are dropped; an undefined array element, or any other value, throws without echoing it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(UNSUPPORTED);
    return JSON.stringify(value);
  }
  // Array.from visits holes of a sparse array as undefined, so they throw like any undefined element.
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(UNSUPPORTED);
}
