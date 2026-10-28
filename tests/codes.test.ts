import { describe, expect, it } from "vitest";
import { CODE_SENTENCE, describeCode } from "../client/codes";
import { ERROR_CODES, type ErrorCode } from "../shared/errors";

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

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
    expect(Object.keys(CODE_SENTENCE).sort()).toEqual([...ERROR_CODES].sort());
  });

  it("has one for each of the eight, in Ukrainian, that is not the code", () => {
    for (const code of ERROR_CODES) {
      const sentence = CODE_SENTENCE[code];
      expect(sentence.length, code).toBeGreaterThan(10);
      expect(sentence, code).not.toContain(code);
      expect(CYRILLIC.test(sentence), code).toBe(true);
      expect(sentence.endsWith("."), code).toBe(true);
    }
  });

  it("puts the sentence first and the code after it, in parentheses, for the settings screen", () => {
    for (const code of ERROR_CODES) expect(describeCode(code), code).toBe(`${CODE_SENTENCE[code]} (${code})`);
    expect(describeCode("write_failed")).toBe("Файл не вдалося записати. (write_failed)");
  });

  it("does not let a name from the prototype find a sentence", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(describeCode(String(name) as ErrorCode), name).toBe(`Невідома помилка. (${name})`);
    }
  });

  it("says what the two refusals of sealed values mean, with the limit in words", () => {
    expect(CODE_SENTENCE.retry_limit).toBe("Три спроби не вдались: зашифровані значення не вдалося розкрити.");
    expect(CODE_SENTENCE.decrypt_failed).toBe(
      "Плагін не зміг розкрити зашифровані значення — можливе втручання в канал. Перевірте, що з'єднання йде через relay або Tailscale, і спробуйте ще раз. Після трьох невдалих спроб запит закривається.",
    );
    expect(CODE_SENTENCE.request_closed).toBe("Запит уже було закрито, коли ви відповіли (наприклад, плагін перезапускали).");
  });

  it("calls the other side of the app the plugin, and names no destination, which the plugin has no more", () => {
    for (const code of ERROR_CODES) {
      const sentence = CODE_SENTENCE[code].toLowerCase();
      expect(sentence, code).not.toContain("сервер");
      expect(sentence, code).not.toContain("відправ");
      expect(sentence, code).not.toContain("місце призначення");
    }
  });
});
