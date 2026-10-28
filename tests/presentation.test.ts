import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { A11Y, FORM_BADGE, KEY_PLACEHOLDER, PILL_HEIGHT, dialogScreen, eye, fieldId, formTitle, pill, pillColor, type Pill } from "../client/presentation";
import { tone, type Tone } from "../client/tone";
import { REQUEST_STATES, type RequestState } from "../shared/request";
import { viewOf } from "./view-fixtures";

const keysOf = (count: number) => Array.from({ length: count }, (_, index) => `K${index}`);

describe("the pill in the chat", () => {
  it("draws the pill from the state, the keys and the tamper flag, one height for all", () => {
    expect(pill({ state: "pending", tamper: false, keys: ["STRIPE_KEY"] })).toEqual({ tone: "accent", icon: "Shield", title: "Секрет для агента", detail: "STRIPE_KEY", struck: false, pressable: true });
    expect(pill({ state: "pending", tamper: false, keys: ["A", "B", "C"] }).detail).toBe("3 ключі");
    expect(pill({ state: "pending", tamper: false, keys: Array.from({ length: 5 }, (_, i) => `K${i}`) }).title).toBe("Секрети для агента");
    expect(pill({ state: "released", tamper: false, keys: ["A"] })).toMatchObject({ tone: "muted", title: "Передано", detail: "1 ключ" });
    expect(pill({ state: "expired", tamper: false, keys: ["A", "B"] })).toEqual({ tone: "dim", icon: "ShieldX", title: "Час минув", detail: "2 ключі", struck: true, pressable: false });
    expect(pill({ state: "delivered", tamper: true, keys: ["A"] })).toMatchObject({ tone: "danger", icon: "ShieldAlert", title: "Підозріле подання", pressable: false });
    expect(PILL_HEIGHT).toBe(36);
  });

  it("follows the table below for every state, row by row", () => {
    const two = ["A", "B"];
    const rows: Array<[RequestState, Pill]> = [
      ["pending", { tone: "accent", icon: "Shield", title: "Секрети для агента", detail: "2 ключі", struck: false, pressable: true }],
      ["delivered", { tone: "success", icon: "ShieldCheck", title: "Передано", detail: "2 ключі", struck: false, pressable: false }],
      ["released", { tone: "muted", icon: "ShieldCheck", title: "Передано", detail: "2 ключі", struck: false, pressable: false }],
      ["declined", { tone: "dim", icon: "ShieldX", title: "Відхилено", detail: "2 ключі", struck: true, pressable: false }],
      ["cancelled", { tone: "dim", icon: "ShieldX", title: "Скасовано", detail: "2 ключі", struck: true, pressable: false }],
      ["expired", { tone: "dim", icon: "ShieldX", title: "Час минув", detail: "2 ключі", struck: true, pressable: false }],
      ["rejected", { tone: "dim", icon: "ShieldX", title: "Не прийнято", detail: "2 ключі", struck: true, pressable: false }],
    ];
    expect(rows.map(([state]) => state).sort()).toEqual([...REQUEST_STATES].sort());
    for (const [state, expected] of rows) expect(pill({ state, tamper: false, keys: two }), state).toEqual(expected);
  });

  it("shows a second, different submission in red in every state, and lets nobody open it", () => {
    for (const state of REQUEST_STATES) {
      expect(pill({ state, tamper: true, keys: ["A", "B", "C"] }), state).toEqual({ tone: "danger", icon: "ShieldAlert", title: "Підозріле подання", detail: "3 ключі", struck: false, pressable: false });
    }
  });

  it("names the one key a waiting request asks for, and says nothing when it asks for none", () => {
    expect(pill({ state: "pending", tamper: false, keys: [] })).toEqual({ tone: "accent", icon: "Shield", title: "Секрет для агента", detail: "", struck: false, pressable: true });
    expect(pill({ state: "pending", tamper: false, keys: ["A", "B"] })).toMatchObject({ title: "Секрети для агента", detail: "2 ключі" });
    // Once the request is closed, the count stands for the keys, one key included.
    expect(pill({ state: "declined", tamper: false, keys: ["STRIPE_KEY"] }).detail).toBe("1 ключ");
    expect(pill({ state: "delivered", tamper: false, keys: [] }).detail).toBe("0 ключів");
  });

  it("counts keys with the Ukrainian plural", () => {
    const count = (n: number) => pill({ state: "delivered", tamper: false, keys: keysOf(n) }).detail;
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 32].map(count)).toEqual([
      "1 ключ",
      "2 ключі",
      "4 ключі",
      "5 ключів",
      "11 ключів",
      "12 ключів",
      "14 ключів",
      "21 ключ",
      "22 ключі",
      "25 ключів",
      "32 ключі",
    ]);
  });

  it("is drawn in its tone's colour, and the dim one is the muted colour at 0.6", () => {
    const colors: Tone = {
      surface: "surface",
      raised: "raised",
      text: "text",
      muted: "muted",
      accent: "accent",
      onAccent: "on-accent",
      border: "border",
      success: "success",
      warning: "warning",
      danger: "danger",
    };
    expect(pillColor("accent", colors)).toEqual({ color: "accent", opacity: 1 });
    expect(pillColor("success", colors)).toEqual({ color: "success", opacity: 1 });
    expect(pillColor("muted", colors)).toEqual({ color: "muted", opacity: 1 });
    expect(pillColor("dim", colors)).toEqual({ color: "muted", opacity: 0.6 });
    expect(pillColor("danger", colors)).toEqual({ color: "danger", opacity: 1 });
  });
});

describe("the form over the chat", () => {
  it("names the cipher the plugin really uses", () => {
    expect(FORM_BADGE).toBe("X25519 · ChaCha20-Poly1305");
    const seal = readFileSync(join(import.meta.dirname, "..", "shared", "seal.ts"), "utf8");
    expect(seal).toContain("x25519");
    expect(seal).toContain("chacha20poly1305");
  });

  it("has an accessibility label in Ukrainian for every control without words, and every input that shows no name", () => {
    expect(A11Y).toEqual({
      enter: "Ввести значення",
      decline: "Відхилити запит",
      add: "Додати ключ",
      remove: "Прибрати ключ",
      show: "Показати значення",
      hide: "Сховати значення",
      submit: "Передати",
      pick: "Вибрати файл",
      paste: "Вставити з буфера",
      removeFile: "Прибрати файл",
      name: "Назва ключа",
      pasteArea: "Вміст файлу",
    });
  });

  it("is titled by the number of rows on screen", () => {
    expect([0, 1, 2, 5, 32].map(formTitle)).toEqual(["Секрет для агента", "Секрет для агента", "Секрети для агента", "Секрети для агента", "Секрети для агента"]);
  });

  it("puts the name of a key the human adds in an input that shows the form of a name", () => {
    expect(KEY_PLACEHOLDER).toBe("KEY_NAME");
  });

  it("switches a value between hidden and shown with the eye, which says what it will do", () => {
    expect(eye(false)).toEqual({ icon: "Eye", label: "Показати значення" });
    expect(eye(true)).toEqual({ icon: "EyeOff", label: "Сховати значення" });
  });

  it("is on one of three screens: loading, failed, or the form", () => {
    expect(dialogScreen({ view: null, loadFailed: false })).toBe("loading");
    expect(dialogScreen({ view: null, loadFailed: true })).toBe("failed");
    expect(dialogScreen({ view: viewOf(), loadFailed: false })).toBe("form");
    // A request that no longer waits is still the form: its input stays, with «→» disabled.
    for (const state of REQUEST_STATES) expect(dialogScreen({ view: viewOf({ state }), loadFailed: false }), state).toBe("form");
  });

  it("names a declared row and a row of the human's apart, and neither like a name of a prototype", () => {
    expect(fieldId.declared("A")).toBe("field:A");
    expect(fieldId.row(3)).toBe("row:3");
    expect(fieldId.declared("3")).not.toBe(fieldId.row(3));
    expect(fieldId.declared("constructor")).toBe("field:constructor");
  });
});

describe("the colours a screen draws with", () => {
  const theme = {
    surface0: "s0",
    surface1: "s1",
    surface2: "s2",
    border: "bd",
    foreground: "fg",
    foregroundMuted: "fgm",
    accent: "ac",
    accentForeground: "acf",
    statusSuccess: "ok",
    statusWarning: "warn",
    statusDanger: "bad",
  };

  it("takes each colour from the theme's own token, and the warning from the theme's warning", () => {
    expect(tone(theme)).toEqual({
      surface: "s0",
      raised: "s1",
      text: "fg",
      muted: "fgm",
      accent: "ac",
      onAccent: "acf",
      border: "bd",
      success: "ok",
      warning: "warn",
      danger: "bad",
    });
  });

  it("falls back for the tokens an older app does not have, so that no colour is missing", () => {
    const { surface1: _raised, border: _border, statusSuccess: _success, statusWarning: _warning, statusDanger: _danger, ...older } = theme;
    expect(tone(older as unknown as Parameters<typeof tone>[0])).toEqual({
      surface: "s0",
      raised: "s0",
      text: "fg",
      muted: "fgm",
      accent: "ac",
      onAccent: "acf",
      border: "rgba(127,127,127,0.28)",
      success: "ac",
      warning: "fgm",
      danger: "fg",
    });
  });
});
