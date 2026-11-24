import { describe, expect, it } from "vitest";
import { messages } from "../client/messages";
import { MAX_RETRIES } from "../shared/limits";
import { translate } from "./translation-fixture";

/** Every leaf key, as the SDK looks it up, including the suffixes of plural forms. */
function keysOf(resource: object, prefix = ""): string[] {
  return Object.entries(resource).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string" ? [path] : keysOf(value, path);
  });
}

describe("the app's messages", () => {
  it("has every English key in every language, with exactly that language's plural categories and no extra key", () => {
    const english = keysOf(messages.resources.en);
    const bases = new Set(english.filter((key) => key.endsWith("_one") && english.includes(key.replace(/_one$/, "_other"))).map((key) => key.replace(/_one$/, "")));
    for (const [locale, resource] of Object.entries(messages.resources)) {
      if (locale === "en") continue;
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      const expected = [
        ...english.filter((key) => !bases.has(key.replace(/_(zero|one|two|few|many|other)$/, ""))),
        ...[...bases].flatMap((base) => categories.map((category) => `${base}_${category}`)),
      ];
      expect(keysOf(resource).sort(), locale).toEqual(expected.sort());
    }
  });

  it("holds the retry limit to the three attempts the sentences name in words", () => {
    expect(MAX_RETRIES, "codes.retry_limit and codes.decrypt_failed say three in words in every language and must change with MAX_RETRIES").toBe(3);
  });

  it("uses the app's locale, with English for any other language", () => {
    expect(translate()("form.titleOne")).toBe("Secret for the agent");
    expect(translate("uk")("form.titleOne")).toBe("Секрет для агента");
    expect(translate("ko")("pill.keys", { count: 2 })).toBe("키 2개");
    expect(translate("fr")("form.titleOne")).toBe("Secret for the agent");
  });
});
