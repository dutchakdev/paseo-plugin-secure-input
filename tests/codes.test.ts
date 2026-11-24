import { describe, expect, it } from "vitest";
import { describeCode } from "../client/codes";
import { messages } from "../client/messages";
import { ERROR_CODES, type ErrorCode } from "../shared/errors";
import { translate } from "./translation-fixture";

const t = translate();

describe("the sentence for every error code", () => {
  it("knows the eight codes the plugin has, and no other", () => {
    expect([...ERROR_CODES]).toEqual([
      "invalid_request",
      "request_already_pending",
      "unknown_agent",
      "service_unavailable",
      "write_failed",
      "retry_limit",
      "request_closed",
      "decrypt_failed",
    ]);
    expect(Object.keys(messages.resources.en.codes).filter((key) => key !== "unknown").sort()).toEqual([...ERROR_CODES].sort());
  });

  it("has one for each of the eight, in English, that is not the code", () => {
    for (const code of ERROR_CODES) {
      const sentence = t(`codes.${code}`);
      expect(sentence.length, code).toBeGreaterThan(10);
      expect(sentence, code).not.toContain(code);
      expect(/[A-Za-z]/.test(sentence), code).toBe(true);
      expect(sentence.endsWith("."), code).toBe(true);
    }
  });

  it("puts the sentence first and the code after it, in parentheses, for the settings screen", () => {
    for (const code of ERROR_CODES) expect(describeCode(t, code), code).toBe(`${t(`codes.${code}`)} (${code})`);
    expect(describeCode(t, "write_failed")).toBe("The file could not be written. (write_failed)");
  });

  it("does not let a name from the prototype find a sentence", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(describeCode(t, String(name) as ErrorCode), name).toBe(`Unknown error. (${name})`);
    }
  });

  it("says what the two refusals of sealed values mean, with the limit in words", () => {
    expect(t("codes.retry_limit")).toBe("Three attempts failed: the encrypted values could not be opened.");
    expect(t("codes.decrypt_failed")).toBe(
      "The plugin could not open the encrypted values, and the channel may have been tampered with. Check that the connection goes through the relay or Tailscale, and try again. After three failed attempts the request closes.",
    );
    expect(translate("uk")("codes.retry_limit")).toBe("Три спроби не вдались: зашифровані значення не вдалося розкрити.");
    expect(translate("uk")("codes.decrypt_failed")).toBe(
      "Плагін не зміг розкрити зашифровані значення — можливе втручання в канал. Перевірте, що з'єднання йде через relay або Tailscale, і спробуйте ще раз. Після трьох невдалих спроб запит закривається.",
    );
    expect(translate("uk")("codes.request_closed")).toBe("Запит уже було закрито, коли ви відповіли (наприклад, плагін перезапускали).");
  });

  it("calls the other side of the app the plugin, and names no destination, which the plugin has no more", () => {
    for (const code of ERROR_CODES) {
      const sentence = t(`codes.${code}`).toLowerCase();
      expect(sentence, code).not.toContain("server");
      expect(sentence, code).not.toContain("send");
      expect(sentence, code).not.toContain("destination");
    }
  });
});
