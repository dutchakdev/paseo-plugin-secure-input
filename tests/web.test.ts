import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileValue } from "../client/file-entry";
import { pickFile, useFileDrop } from "../client/web";
import { utf8 } from "../shared/bytes";
import { LIMITS } from "../shared/limits";
import { promptly } from "./helpers";
import { mount } from "./react-fake";

// The one module of the app that touches the browser, `client/web.ts`, against a browser made by hand: a page whose
// `createElement` gives an input, files that hand out their bytes as the browser's do, and a row that takes listeners.
// The platform is the web build's unless a test says otherwise, and React's hooks are the test runtime's (`react-fake`).

const platform = vi.hoisted(() => ({ OS: "web" as string, select: (choices: Record<string, unknown>) => choices.default }));
vi.mock("react", async () => (await import("./react-fake")).hooks);
vi.mock("react-native", () => ({ Platform: platform }));

afterEach(() => {
  platform.OS = "web";
  vi.unstubAllGlobals();
});

/** A file the browser holds: `slice` hands out a part of its bytes as a buffer of their own, as the browser does. The parts it was asked for, and the buffers it gave, are kept. */
function browserFile(name: string, bytes: Uint8Array, options: { unreadable?: boolean } = {}) {
  const slices: Array<[number, number]> = [];
  const buffers: ArrayBuffer[] = [];
  const file = {
    name,
    slice(start: number, end: number) {
      slices.push([start, end]);
      return {
        arrayBuffer: (): Promise<ArrayBuffer> => {
          if (options.unreadable) return Promise.reject(new Error("the browser could not read it"));
          const buffer = bytes.slice(start, end).buffer;
          buffers.push(buffer);
          return Promise.resolve(buffer);
        },
      };
    },
  };
  /** Whether every buffer this file gave holds zeros only, and at least one was given. */
  const wiped = (): boolean => buffers.length > 0 && buffers.every((buffer) => new Uint8Array(buffer).every((byte) => byte === 0));
  return { file, slices, buffers, wiped };
}

const filesOf = (...files: unknown[]) => ({ item: (index: number) => files[index] ?? null });

/** What a listener threw: the browser reports it and goes on, so the dispatch here does too. */
const thrown: unknown[] = [];

/** The input of a page, as `pickFile` uses one. `fire` is the browser telling of an event; what fails at the page's say is in `failing`. */
class FakeInput {
  type = "";
  value = "C:\\fakepath\\sa.json";
  files: { item(index: number): unknown } | null = null;
  clicked = 0;
  readonly listeners = new Map<string, Array<() => void>>();
  constructor(private readonly failing: { listen?: boolean; click?: boolean }) {}
  addEventListener(type: string, listener: () => void): void {
    if (this.failing.listen) throw new Error("this page takes no listeners");
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click(): void {
    this.clicked += 1;
    if (this.failing.click) throw new Error("this page opens no picker");
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener();
      } catch (error) {
        thrown.push(error);
      }
    }
  }
}

/** A page with a document that makes inputs; the inputs it made, in order. */
function page(failing: { listen?: boolean; click?: boolean } = {}): FakeInput[] {
  const inputs: FakeInput[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "input") throw new Error(`the module made a ${tag}`);
      const input = new FakeInput(failing);
      inputs.push(input);
      return input;
    },
  });
  return inputs;
}

const only = (inputs: FakeInput[]): FakeInput => {
  expect(inputs).toHaveLength(1);
  return inputs[0] as FakeInput;
};

describe("picking a file", () => {
  it("opens the browser's picker and reads at most one byte more than a file may have, with the file's name", async () => {
    const inputs = page();
    const big = browserFile("big.bin", new Uint8Array(LIMITS.fileBytes * 2).fill(7));
    const picked = pickFile();
    const input = only(inputs);
    expect([input.type, input.clicked]).toEqual(["file", 1]);
    input.files = filesOf(big.file);
    input.fire("change");
    const value = (await picked) as FileValue;
    expect(big.slices).toEqual([[0, LIMITS.fileBytes + 1]]);
    expect([value.name, value.bytes.length, value.bytes[0]]).toEqual(["big.bin", LIMITS.fileBytes + 1, 7]);
    // The input lets go of the file it was given.
    expect(input.value).toBe("");
  });

  it("answers once: a file the browser tells of after the answer is wiped, and so is a second one", async () => {
    // Canceled first, and a change told after it.
    const inputs = page();
    const canceled = pickFile();
    const input = only(inputs);
    input.fire("cancel");
    expect(await canceled).toBeNull();
    expect(input.value).toBe("");
    const late = browserFile("late.json", utf8.encode("CANARY-a-file-after-the-answer"));
    input.files = filesOf(late.file);
    input.fire("change");
    await vi.waitFor(() => expect(late.wiped()).toBe(true));

    // Chosen, and a second change told after it.
    const more = page();
    const chosen = browserFile("first.json", utf8.encode('{"first":true}'));
    const second = browserFile("second.json", utf8.encode("CANARY-a-second-file"));
    const answered = pickFile();
    const other = only(more);
    other.files = filesOf(chosen.file);
    other.fire("change");
    expect(utf8.decode(((await answered) as FileValue).bytes)).toBe('{"first":true}');
    other.files = filesOf(second.file);
    other.fire("change");
    await vi.waitFor(() => expect(second.wiped()).toBe(true));
    expect(chosen.wiped()).toBe(false);
  });

  it("gives nothing for a change with no file, a file the browser cannot read, no page, or a phone, and touches no page on a phone", async () => {
    const empty = page();
    const none = pickFile();
    only(empty).fire("change");
    expect(await none).toBeNull();

    const broken = page();
    const unreadable = browserFile("gone.bin", new Uint8Array(3), { unreadable: true });
    const failed = pickFile();
    only(broken).files = filesOf(unreadable.file);
    only(broken).fire("change");
    expect(await failed).toBeNull();

    vi.stubGlobal("document", undefined);
    expect(await pickFile()).toBeNull();

    const phone = page();
    platform.OS = "ios";
    expect(await pickFile()).toBeNull();
    expect(phone).toEqual([]);
  });

  it("never rejects, and answers, when the page fails it while it is set up, at the click, or when it reads the choice", async () => {
    // The page takes no listeners.
    page({ listen: true });
    expect(await promptly(pickFile().catch(() => "rejected"), 500)).toBeNull();
    // The picker cannot be opened.
    page({ click: true });
    expect(await promptly(pickFile().catch(() => "rejected"), 500)).toBeNull();
    // The list of files throws when it is read.
    const inputs = page();
    const reading = pickFile().catch(() => "rejected");
    only(inputs).files = {
      item: () => {
        throw new Error("the list is gone");
      },
    };
    only(inputs).fire("change");
    expect(await promptly(reading, 500)).toBeNull();
    expect(thrown.splice(0)).toEqual([]);
  });
});

/** A row as the web build draws it, as far as `useFileDrop` uses one: it takes listeners, and `fire` is the browser's event. */
class FakeRow {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((held) => held !== listener),
    );
  }
  get count(): number {
    return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0);
  }
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A drag over the row, or a drop on it, with the files it carries. What the row's listeners did with it is kept. */
function dragEvent(...files: unknown[]) {
  return {
    prevented: 0,
    stopped: 0,
    preventDefault() {
      this.prevented += 1;
    },
    stopPropagation() {
      this.stopped += 1;
    },
    dataTransfer: { files: filesOf(...files), dropEffect: "none" },
  };
}

/** A component that takes files dropped on `target`, as a file row does. */
function DropZone({ target, onFile }: { target: unknown; onFile(file: FileValue): void }): null {
  useFileDrop({ current: target }, onFile);
  return null;
}

describe("dropping a file on a row", () => {
  it("takes the file into the row, read as a picked one is, and keeps the drag and the drop the row's own", async () => {
    const row = new FakeRow();
    const taken: FileValue[] = [];
    mount(DropZone, { target: row, onFile: (file) => void taken.push(file) });
    const over = dragEvent();
    row.fire("dragover", over);
    expect([over.prevented, over.stopped, over.dataTransfer.dropEffect]).toEqual([1, 1, "copy"]);
    const big = browserFile("dropped.bin", new Uint8Array(LIMITS.fileBytes + 10).fill(9));
    const drop = dragEvent(big.file);
    row.fire("drop", drop);
    expect([drop.prevented, drop.stopped]).toEqual([1, 1]);
    await vi.waitFor(() => expect(taken).toHaveLength(1));
    expect(big.slices).toEqual([[0, LIMITS.fileBytes + 1]]);
    expect([taken[0]?.name, taken[0]?.bytes.length]).toEqual(["dropped.bin", LIMITS.fileBytes + 1]);
    // A drop that carries no file, or one the browser cannot read, gives nothing.
    row.fire("drop", dragEvent());
    row.fire("drop", dragEvent(browserFile("gone.bin", new Uint8Array(2), { unreadable: true }).file));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(taken).toHaveLength(1);
  });

  it("wipes a file that is read after the row is gone, and the row lets go of its listeners", async () => {
    const row = new FakeRow();
    const taken: FileValue[] = [];
    const zone = mount(DropZone, { target: row, onFile: (file) => void taken.push(file) });
    expect(row.count).toBe(2);
    const dropped = browserFile("late.pem", utf8.encode("CANARY-dropped-as-the-row-went"));
    row.fire("drop", dragEvent(dropped.file));
    zone.unmount();
    expect(row.count).toBe(0);
    await vi.waitFor(() => expect(dropped.wiped()).toBe(true));
    expect(taken).toEqual([]);
  });

  it("wipes a file the row's handler throws on, and lets no rejection go unhandled", async () => {
    const row = new FakeRow();
    mount(DropZone, {
      target: row,
      onFile: () => {
        throw new Error("the row could not take it");
      },
    });
    const dropped = browserFile("x.bin", utf8.encode("CANARY-the-handler-threw"));
    row.fire("drop", dragEvent(dropped.file));
    await vi.waitFor(() => expect(dropped.wiped()).toBe(true));
  });

  it("follows the element the row's ref holds from one render to the next, and takes nothing on a phone", () => {
    const first = new FakeRow();
    const second = new FakeRow();
    const zone = mount(DropZone, { target: first, onFile: () => undefined });
    expect([first.count, second.count]).toEqual([2, 0]);
    zone.render({ target: second, onFile: () => undefined });
    expect([first.count, second.count]).toEqual([0, 2]);

    platform.OS = "android";
    const phone = new FakeRow();
    mount(DropZone, { target: phone, onFile: () => undefined });
    expect(phone.count).toBe(0);
  });
});
