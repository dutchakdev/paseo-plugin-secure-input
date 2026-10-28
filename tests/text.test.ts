import { describe, expect, it } from "vitest";
import { afterFailedAttempts, attemptsFailed, bytesText, plural } from "../client/text";

describe("Ukrainian plurals", () => {
  it("picks the form by the last digits, with 11 to 14 apart", () => {
    const forms = (count: number) => plural(count, "рядок", "рядки", "рядків");
    expect([0, 1, 2, 4, 5, 10, 11, 12, 14, 15, 20, 21, 22, 25, 100, 101, 111, 112, 121].map(forms)).toEqual([
      "0 рядків",
      "1 рядок",
      "2 рядки",
      "4 рядки",
      "5 рядків",
      "10 рядків",
      "11 рядків",
      "12 рядків",
      "14 рядків",
      "15 рядків",
      "20 рядків",
      "21 рядок",
      "22 рядки",
      "25 рядків",
      "100 рядків",
      "101 рядок",
      "111 рядків",
      "112 рядків",
      "121 рядок",
    ]);
  });

  it("writes a number of bytes the way it is said", () => {
    expect([0, 1, 2, 5, 11, 21, 41, 102, 1024].map(bytesText)).toEqual([
      "0 байтів",
      "1 байт",
      "2 байти",
      "5 байтів",
      "11 байтів",
      "21 байт",
      "41 байт",
      "102 байти",
      "1024 байти",
    ]);
  });
});

describe("a number of attempts, in words", () => {
  it("says how many attempts failed, with the noun and the verb in the form the number takes", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(attemptsFailed)).toEqual([
      "Одна спроба не вдалась",
      "Дві спроби не вдались",
      "Три спроби не вдались",
      "Чотири спроби не вдались",
      "П'ять спроб не вдалось",
      "Шість спроб не вдалось",
      "Десять спроб не вдалось",
    ]);
  });

  it("says after how many failed attempts something happens", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(afterFailedAttempts)).toEqual([
      "Після однієї невдалої спроби",
      "Після двох невдалих спроб",
      "Після трьох невдалих спроб",
      "Після чотирьох невдалих спроб",
      "Після п'яти невдалих спроб",
      "Після шести невдалих спроб",
      "Після десяти невдалих спроб",
    ]);
  });

  it("writes a number it has no word for in digits, still in the right form", () => {
    expect([11, 12, 21, 22, 25, 100].map(attemptsFailed)).toEqual([
      "11 спроб не вдалось",
      "12 спроб не вдалось",
      "21 спроба не вдалась",
      "22 спроби не вдались",
      "25 спроб не вдалось",
      "100 спроб не вдалось",
    ]);
    expect([11, 21, 22, 100].map(afterFailedAttempts)).toEqual([
      "Після 11 невдалих спроб",
      "Після 21 невдалої спроби",
      "Після 22 невдалих спроб",
      "Після 100 невдалих спроб",
    ]);
  });
});
