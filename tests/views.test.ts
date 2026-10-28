import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestDialog } from "../client/dialog";
import { DELETE_FAILED } from "../client/diagnostics-rows";
import type { FileValue } from "../client/file-entry";
import { FileRow, IconButton, RowLine, TextRow } from "../client/fields";
import type { FormRow } from "../client/form-state";
import { A11Y, eye } from "../client/presentation";
import { SELF_TEST_RUNNING } from "../client/self-test";
import { SettingsScreen } from "../client/settings";
import type { Tone } from "../client/tone";
import type { Diagnostics } from "../shared/contracts";
import { toBase64Url, utf8 } from "../shared/bytes";
import { generateRequestKeyPair } from "../shared/seal";
import type { RequestView } from "../shared/view";
import { elements, find, findAll, mount } from "./react-fake";
import { REQUEST_ID, file, text, viewOf } from "./view-fixtures";

// The views of the form and of the settings screen, drawn by the test runtime of React's hooks (`react-fake`): what
// each control tells a screen reader, and what becomes of a file the form is given at each moment. The host's UI, the
// RPCs and the query are stand-ins the test sets; React Native's primitives are drawn as their names.

const platform = vi.hoisted(() => ({ OS: "web" as string, select: (choices: Record<string, unknown>) => choices.default }));
const rpc = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());
const query = vi.hoisted(() => ({ current: { data: undefined as unknown, isError: false, refetch: async () => undefined as unknown } }));
const modal = vi.hoisted(() => Object.assign(() => null, { Content: "Modal.Content" }));
vi.mock("react", async () => (await import("./react-fake")).hooks);
vi.mock("react-native", () => ({ Platform: platform, View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  Icon: "Icon",
  TextInput: "TextInput",
  Modal: modal,
  SettingsAction: "SettingsAction",
  SettingsCard: "SettingsCard",
  SettingsRow: "SettingsRow",
  SettingsSection: "SettingsSection",
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) => {
    const call = rpc.get(contract.name);
    if (call === undefined) throw new Error(`no stand-in for ${contract.name}`);
    return call(input);
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => query.current }));

afterEach(() => {
  rpc.clear();
  platform.OS = "web";
  vi.unstubAllGlobals();
});

const COLORS: Tone = { surface: "s", raised: "r", text: "t", muted: "m", accent: "a", onAccent: "o", border: "b", success: "g", warning: "w", danger: "d" };
const THEME = {
  colors: { surface0: "s", surface1: "r", foreground: "t", foregroundMuted: "m", accent: "a", accentForeground: "o", border: "b", statusSuccess: "g", statusWarning: "w", statusDanger: "d" },
};
const HOST = { theme: THEME, host: { id: "h", label: "desktop" }, layout: { compact: false, platform: "web" } };

const fileOf = (content: string, name: string | null = "sa.json"): FileValue => ({ name, bytes: utf8.encode(content) });
const wiped = (value: FileValue): boolean => value.bytes.every((byte) => byte === 0);
const nothing = (): void => undefined;

/** Draws an element of a component that uses no hook, as React would: its type called with its props. */
function drawn(element: { type: unknown; props: Record<string, unknown> }): unknown {
  if (typeof element.type !== "function") throw new Error("not an element of a component");
  return (element.type as (props: Record<string, unknown>) => unknown)(element.props);
}

/** A file row of a field the agent asked for, empty, or holding `held`. */
function fileRow(held: FileValue | null = null, overrides: Partial<FormRow> = {}): FormRow {
  return { id: "field:SA", key: "SA", declared: true, optional: false, format: "any", value: { kind: "file", file: held }, ...overrides };
}

/** A file row on screen, and a stand-in for the element its box is drawn as, to drop files on: attached through the box's ref, as the web build's element is. */
function mountedFileRow(props: Partial<Parameters<typeof FileRow>[0]> = {}) {
  const taken: FileValue[] = [];
  const base = { row: fileRow(), hint: "", error: null, colors: COLORS, locked: false, onName: nothing, onFile: (value: FileValue) => void taken.push(value), onClearFile: nothing, onRemove: nothing };
  const row = mount(FileRow, { ...base, ...props });
  const listeners = new Map<string, (event: unknown) => void>();
  const box = elements(row.tree).find((element) => element.type === "View" && element.props.ref !== undefined);
  if (box === undefined) throw new Error("the file row's box has no ref");
  (box.props.ref as { current: unknown }).current = {
    addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, listener),
    removeEventListener: (type: string) => void listeners.delete(type),
  };
  row.render();
  /** A file dropped on the row's box. */
  const drop = (bytes: Uint8Array) => {
    const buffer = bytes.slice().buffer;
    const handed = new Uint8Array(buffer);
    listeners.get("drop")?.({
      preventDefault: nothing,
      stopPropagation: nothing,
      dataTransfer: { files: { item: (index: number) => (index === 0 ? { name: "dropped.bin", slice: () => ({ arrayBuffer: async () => buffer }) } : null) }, dropEffect: "none" },
    });
    return handed;
  };
  return { row, taken, drop, base };
}

describe("a file row", () => {
  it("hands on a file only while it may take one: one that comes while the form is locked, or after the row is gone, is wiped", async () => {
    const open = mountedFileRow();
    const first = open.drop(utf8.encode('{"taken":true}'));
    await vi.waitFor(() => expect(open.taken).toHaveLength(1));
    expect(utf8.decode(open.taken[0]?.bytes as Uint8Array)).toBe('{"taken":true}');
    expect(wiped({ name: null, bytes: first })).toBe(false);

    // The form is being sent: the row is drawn locked, and a file dropped on it then goes nowhere.
    const locked = mountedFileRow();
    locked.row.render({ ...locked.base, locked: true });
    const late = locked.drop(utf8.encode("CANARY-dropped-while-locked"));
    await vi.waitFor(() => expect(late.every((byte) => byte === 0)).toBe(true));
    expect(locked.taken).toEqual([]);

    // The row is gone (the chat's list unmounted it) by the time a picked file is read.
    const inputs: Array<{ files: unknown; listeners: Map<string, () => void> }> = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const input = { type: "", value: "", files: null as unknown, listeners: new Map<string, () => void>(), addEventListener: (type: string, listener: () => void) => void input.listeners.set(type, listener), click: nothing };
        inputs.push(input);
        return input;
      },
    });
    const gone = mountedFileRow();
    (find(gone.row.tree, IconButton, { label: A11Y.pick }).props.onPress as () => void)();
    const buffer = utf8.encode("CANARY-picked-as-the-row-went").buffer;
    const input = inputs[0] as (typeof inputs)[number];
    input.files = { item: () => ({ name: "late.json", slice: () => ({ arrayBuffer: async () => buffer }) }) };
    gone.row.unmount();
    input.listeners.get("change")?.();
    await vi.waitFor(() => expect(new Uint8Array(buffer).every((byte) => byte === 0)).toBe(true));
    expect(gone.taken).toEqual([]);
  });

  it("opens the paste area under the row, labelled for a screen reader, and what was pasted becomes the file when it loses focus", async () => {
    const { row, taken } = mountedFileRow({ hint: "The service account JSON" });
    (find(row.tree, IconButton, { label: A11Y.paste }).props.onPress as () => void)();
    row.render();
    expect(A11Y.pasteArea).toBe("Вміст файлу");
    const area = find(row.tree, "TextInput", { multiline: true });
    expect([area.props.accessibilityLabel, area.props.accessibilityHint]).toEqual([A11Y.pasteArea, "The service account JSON"]);
    (area.props.onChangeText as (text: string) => void)('{"pasted":1}');
    row.render();
    (find(row.tree, "TextInput", { multiline: true }).props.onBlur as () => void)();
    row.render();
    expect(taken.map((value) => [value.name, utf8.decode(value.bytes)])).toEqual([[null, '{"pasted":1}']]);
    expect(findAll(row.tree, "TextInput", { multiline: true })).toEqual([]);
  });

  it("gives the agent's label to a screen reader on each of its controls, and none when the agent gave none", () => {
    const hint = "The service account JSON";
    const empty = mount(FileRow, { row: fileRow(), hint, error: null, colors: COLORS, locked: false, onName: nothing, onFile: nothing, onClearFile: nothing, onRemove: nothing });
    expect(findAll(empty.tree, IconButton).map((button) => [button.props.label, button.props.hint])).toEqual([
      [A11Y.pick, hint],
      [A11Y.paste, hint],
    ]);
    const filled = mount(FileRow, { row: fileRow(fileOf("{}")), hint, error: null, colors: COLORS, locked: false, onName: nothing, onFile: nothing, onClearFile: nothing, onRemove: nothing });
    expect(findAll(filled.tree, IconButton).map((button) => [button.props.label, button.props.hint])).toEqual([[A11Y.removeFile, hint]]);
    // A button reads the hint as its accessibility hint; an empty one is none.
    const press = (props: Record<string, unknown>) => find(mount(IconButton, { icon: "X", label: "Прибрати файл", color: "m", onPress: nothing, ...props }).tree, "Pressable");
    expect(press({ hint }).props.accessibilityHint).toBe(hint);
    expect(press({ hint: "" }).props.accessibilityHint).toBeUndefined();
    expect(press({}).props.accessibilityHint).toBeUndefined();
  });
});

describe("a text row", () => {
  const row = (declared: boolean): FormRow => ({ id: declared ? "field:API_KEY" : "row:1", key: declared ? "API_KEY" : "", declared, optional: false, format: "any", value: { kind: "text", text: "" } });
  const props = { hint: "", error: null, colors: COLORS, onText: nothing, onName: nothing, onToFile: nothing, onRemove: nothing };

  it("keeps the eye from being pressed while the form is locked, as every other control of the row", () => {
    const look = eye(false);
    for (const locked of [false, true]) {
      const drawnRow = mount(TextRow, { ...props, row: row(false), locked });
      expect(find(drawnRow.tree, IconButton, { label: look.label }).props.disabled, String(locked)).toBe(locked);
      for (const button of findAll(drawnRow.tree, IconButton)) expect(button.props.disabled, `${String(button.props.label)} ${String(locked)}`).toBe(locked);
    }
  });

  it("labels the name of a key of the human's for a screen reader", () => {
    const drawnRow = mount(TextRow, { ...props, row: row(false), locked: false });
    const name = elements(drawnRow.tree).find((element) => typeof element.type === "function" && element.type.name === "NameInput");
    if (name === undefined) throw new Error("no name input");
    expect(A11Y.name).toBe("Назва ключа");
    expect(find(drawn(name), "TextInput").props.accessibilityLabel).toBe(A11Y.name);
  });
});

describe("the lines that say what is wrong", () => {
  it("are told to a screen reader as they appear: the line under a row, and the line at the top of the form", async () => {
    const line = find(drawn(find(mount(TextRow, { row: { id: "row:1", key: "1A", declared: false, optional: false, format: "any", value: { kind: "text", text: "v" } }, hint: "", error: "Лише A–Z, 0–9, _", colors: COLORS, locked: false, onText: nothing, onName: nothing, onToFile: nothing, onRemove: nothing }).tree, RowLine) as never), "Text");
    expect([line.props.accessibilityRole, line.props.accessibilityLiveRegion, line.props.children]).toEqual(["alert", "polite", "Лише A–Z, 0–9, _"]);

    // A reading that fails: the form says so at its top.
    rpc.set("secure-input.request.get", async () => Promise.reject(new Error("unreachable")));
    const dialog = mount(RequestDialog, { ...HOST, requestId: REQUEST_ID, session: 1, onClose: nothing } as never);
    await dialog.settle();
    const top = findAll(dialog.tree, "Text").find((element) => element.props.children === "Плагін зараз недоступний. Натисни «→» ще раз.");
    expect([top?.props.accessibilityRole, top?.props.accessibilityLiveRegion]).toEqual(["alert", "polite"]);
  });
});

describe("the form", () => {
  /** The form for a request that asks for a text and two files, the second optional, read once it opens. Its submission waits until `answer`. */
  async function openForm() {
    // A key the app can seal to: the submission goes all the way to the plugin's stand-in.
    const keys = generateRequestKeyPair();
    keys.secretKey.fill(0);
    const view: RequestView = viewOf({ fields: [text("A"), file("SA", "any", false, "The service account"), file("SB", "any", true)], publicKey: toBase64Url(keys.publicKey) });
    rpc.set("secure-input.request.get", async () => view);
    let answer!: (result: unknown) => void;
    rpc.set("secure-input.request.fulfill", () => new Promise((resolve) => (answer = resolve)));
    let closed = 0;
    const form = mount(RequestDialog, { ...HOST, requestId: REQUEST_ID, session: 1, onClose: () => void (closed += 1) } as never);
    await form.settle();
    const rowOf = (key: string) => elements(form.tree).find((element) => (element.type === FileRow || element.type === TextRow) && (element.props.row as FormRow).key === key) as { props: Record<string, unknown> };
    return { form, rowOf, answer: (result: unknown) => answer(result), closed: () => closed };
  }

  it("gives a file row the agent's label, as it gives a text row", async () => {
    const { rowOf } = await openForm();
    expect(rowOf("SA").props.hint).toBe("The service account");
    expect(rowOf("SB").props.hint).toBe("");
  });

  it("wipes a file it is given while a submission is under way, and every file it held once the plugin took the submission", async () => {
    const { form, rowOf, answer, closed } = await openForm();
    (rowOf("A").props.onText as (text: string) => void)("typed-value");
    form.render();
    const kept = fileOf('{"kept":true}');
    (rowOf("SA").props.onFile as (value: FileValue) => void)(kept);
    form.render();
    expect(((rowOf("SA").props.row as FormRow).value as { file: FileValue | null }).file).toBe(kept);
    (find(form.tree, IconButton, { label: A11Y.submit }).props.onPress as () => void)();
    form.render();
    // The submission is under way: a file that comes now is taken by nothing.
    const during = fileOf("CANARY-given-while-sending");
    (rowOf("SB").props.onFile as (value: FileValue) => void)(during);
    expect(wiped(during)).toBe(true);
    form.render();
    expect(((rowOf("SB").props.row as FormRow).value as { file: FileValue | null }).file).toBeNull();
    expect(wiped(kept)).toBe(false);
    // The plugin took it: the form clears, wiping what it held, and closes.
    answer({ ok: true, state: "delivered" });
    await form.settle();
    expect(wiped(kept)).toBe(true);
    expect(closed()).toBe(1);
  });

  it("wipes every file it holds when it is unmounted with its row", async () => {
    const { form, rowOf } = await openForm();
    const held = fileOf("CANARY-held-when-the-row-went");
    (rowOf("SA").props.onFile as (value: FileValue) => void)(held);
    form.render();
    expect(wiped(held)).toBe(false);
    form.unmount();
    expect(wiped(held)).toBe(true);
    // A file that arrives after that is taken by nothing.
    const late = fileOf("CANARY-after-the-form-went");
    (rowOf("SB").props.onFile as (value: FileValue) => void)(late);
    expect(wiped(late)).toBe(true);
  });
});

describe("the settings screen", () => {
  const DATA: Diagnostics = {
    attached: true,
    dataDir: "/data/secure-input",
    registry: { persistence: "ok", drop: "ok", stored: "ok", dropped: 0 },
    outbox: { persistence: "ok", unsaved: 0, dropped: 0 },
    requests: { pending: 0, delivered: 1, nextDeleteBy: Date.UTC(2026, 9, 28, 12, 15) },
    startup: null,
    cardsOwed: 0,
    messagesHeld: false,
    lastHookFailure: null,
  };

  /** The screen, and the element of one of its parts by the part's name, mounted as its own component. */
  function part(name: string) {
    query.current = { data: DATA, isError: false, refetch: async () => DATA };
    const screen = mount(SettingsScreen, HOST as never);
    const element = elements(screen.tree).find((candidate) => typeof candidate.type === "function" && candidate.type.name === name);
    if (element === undefined) throw new Error(`the screen has no ${name}`);
    return mount(element.type as (props: unknown) => unknown, element.props);
  }

  it("says in one fixed line that a deletion it asked for was refused, and no more once one is not", async () => {
    let refuse = true;
    rpc.set("secure-input.drop.clear", async () => (refuse ? Promise.reject(new Error("service_unavailable: the plugin is shutting down")) : { released: 1, stuck: 0 }));
    expect(DELETE_FAILED).toBe("Не вдалося видалити");
    const deleteAll = part("DeleteAll");
    const action = () => find(deleteAll.tree, "SettingsAction");
    expect(action().props.error ?? null).toBeNull();
    (action().props.onPress as () => void)();
    await deleteAll.settle();
    expect(action().props.error).toBe(DELETE_FAILED);
    expect(JSON.stringify(deleteAll.tree)).not.toContain("shutting down");
    refuse = false;
    (action().props.onPress as () => void)();
    await deleteAll.settle();
    expect(action().props.error ?? null).toBeNull();
  });

  it("tells a screen reader that the self-test is running while its spinner stands in the place of the result", async () => {
    rpc.set("secure-input.selftest.begin", () => new Promise(() => undefined));
    expect(SELF_TEST_RUNNING).toBe("Перевірка триває");
    const encryption = part("Encryption");
    expect(findAll(encryption.tree, "ActivityIndicator")).toEqual([]);
    (find(encryption.tree, "SettingsAction").props.onPress as () => void)();
    encryption.render();
    expect(find(encryption.tree, "ActivityIndicator").props.accessibilityLabel).toBe(SELF_TEST_RUNNING);
  });
});
