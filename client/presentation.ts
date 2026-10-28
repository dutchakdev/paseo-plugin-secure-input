import type { CardData } from "../shared/card";
import type { RequestView } from "../shared/view";
import { plural } from "./text";
import type { Tone } from "./tone";

/** What the form says of how the values travel: the cipher `shared/seal.ts` really uses, and nothing else. */
export const FORM_BADGE = "X25519 · ChaCha20-Poly1305";

/** The form's title: one key on screen, or several. */
export function formTitle(rowsOnScreen: number): string {
  return rowsOnScreen > 1 ? "Секрети для агента" : "Секрет для агента";
}

/** What a screen reader says of each control that has an icon and no words, and of each input that shows no name of its own. */
export const A11Y: Readonly<
  Record<"enter" | "decline" | "add" | "remove" | "show" | "hide" | "submit" | "pick" | "paste" | "removeFile" | "name" | "pasteArea", string>
> = {
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
};

/** What the name input of a row of the human's shows while it is empty: the form a key has. */
export const KEY_PLACEHOLDER = "KEY_NAME";

/** The eye of a text row: what it shows, and what pressing it will do. */
export function eye(shown: boolean): { icon: "Eye" | "EyeOff"; label: string } {
  return shown ? { icon: "EyeOff", label: A11Y.hide } : { icon: "Eye", label: A11Y.show };
}

/** The pill in the chat. Its look comes from the card's data alone, and nothing in it changes its height. */
export interface Pill {
  tone: "accent" | "success" | "muted" | "dim" | "danger";
  icon: "Shield" | "ShieldCheck" | "ShieldX" | "ShieldAlert";
  title: string;
  detail: string;
  struck: boolean;
  pressable: boolean;
}

/** The height of the pill, in every state. The chat's list does not take a row whose height changes (getpaseo/paseo#7486). */
export const PILL_HEIGHT = 36;

/** The word for each way a request ends without its values. All of them are drawn the same way: dimmed and struck through. */
const ENDED_AS: Readonly<Record<"declined" | "cancelled" | "expired" | "rejected", string>> = {
  declined: "Відхилено",
  cancelled: "Скасовано",
  expired: "Час минув",
  rejected: "Не прийнято",
};

/**
 * How a request looks as a pill in each state it can be in. Only a request that waits can be pressed, and not once a
 * second, different submission has come: that one is red in every state. A waiting request names its one key, or counts
 * several; every other state counts them.
 */
export function pill(data: Pick<CardData, "state" | "tamper" | "keys">): Pill {
  const count = plural(data.keys.length, "ключ", "ключі", "ключів");
  if (data.tamper) return { tone: "danger", icon: "ShieldAlert", title: "Підозріле подання", detail: count, struck: false, pressable: false };
  switch (data.state) {
    case "pending":
      return data.keys.length > 1
        ? { tone: "accent", icon: "Shield", title: "Секрети для агента", detail: count, struck: false, pressable: true }
        : { tone: "accent", icon: "Shield", title: "Секрет для агента", detail: data.keys[0] ?? "", struck: false, pressable: true };
    case "delivered":
      return { tone: "success", icon: "ShieldCheck", title: "Передано", detail: count, struck: false, pressable: false };
    case "released":
      return { tone: "muted", icon: "ShieldCheck", title: "Передано", detail: count, struck: false, pressable: false };
    default:
      return { tone: "dim", icon: "ShieldX", title: ENDED_AS[data.state], detail: count, struck: true, pressable: false };
  }
}

/** The colour a pill is drawn in, from the theme: `dim` is the muted colour, fainter. */
export function pillColor(tone: Pill["tone"], colors: Tone): { color: string; opacity: number } {
  switch (tone) {
    case "accent":
      return { color: colors.accent, opacity: 1 };
    case "success":
      return { color: colors.success, opacity: 1 };
    case "danger":
      return { color: colors.danger, opacity: 1 };
    case "dim":
      return { color: colors.muted, opacity: 0.6 };
    default:
      return { color: colors.muted, opacity: 1 };
  }
}

/**
 * Which screen the form is on: waiting for its first reading, unable to read the request, or the form. Once a view is
 * held the form stays: a request that no longer waits keeps what was typed, with «→» disabled.
 */
export type Screen = "loading" | "failed" | "form";

export function dialogScreen(state: { view: RequestView | null; loadFailed: boolean }): Screen {
  if (state.view !== null) return "form";
  return state.loadFailed ? "failed" : "loading";
}

/** The id a row of the form goes by: a declared field by its key, a row of the human's by its number. The prefix keeps a key like `constructor` a plain name. */
export const fieldId = {
  declared: (key: string): string => `field:${key}`,
  row: (n: number): string => `row:${n}`,
};
