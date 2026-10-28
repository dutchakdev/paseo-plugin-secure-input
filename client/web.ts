import { useEffect, useRef, type RefObject } from "react";
import { Platform } from "react-native";
import { LIMITS } from "../shared/limits";
import { wipeFile, type FileValue } from "./file-entry";

// The one module of the app that touches the browser's own objects. The desktop app is the web build of the app in
// Electron, and the SDK gives a plugin neither a file picker nor a way to take a file that is dropped: this module does
// both. It reaches the browser through `globalThis`, and describes below the few members it uses, so that no project is
// checked against the DOM's types. Every export is gated on the web platform and does nothing anywhere else: a phone has
// no picking and no dropping, only the paste area of a file row.

/** A file the browser holds, as far as this module reads it. */
interface BrowserFile {
  readonly name: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

interface BrowserFiles {
  item(index: number): BrowserFile | null;
}

interface FileInput {
  type: string;
  value: string;
  readonly files: BrowserFiles | null;
  addEventListener(type: "change" | "cancel", listener: () => void): void;
  click(): void;
}

interface Page {
  createElement(tag: "input"): FileInput;
}

interface DragEventLike {
  preventDefault(): void;
  stopPropagation(): void;
  readonly dataTransfer: { readonly files: BrowserFiles; dropEffect: string } | null;
}

interface DropTarget {
  addEventListener(type: "dragover" | "drop", listener: (event: DragEventLike) => void): void;
  removeEventListener(type: "dragover" | "drop", listener: (event: DragEventLike) => void): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The page the app is drawn in, when there is one that can make an input. */
function page(): Page | null {
  const found: unknown = Reflect.get(globalThis, "document");
  return isObject(found) && typeof found.createElement === "function" ? (found as unknown as Page) : null;
}

/** What a row's ref holds on the web: the element it is drawn as, which takes listeners. Anything else is no target. */
function dropTarget(value: unknown): DropTarget | null {
  return isObject(value) && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function"
    ? (value as unknown as DropTarget)
    : null;
}

/**
 * A file's bytes and name. At most one byte more than a file may have is read: enough for the check to say that it is
 * too large, and nothing more of a large file taken into memory. Null when the browser cannot read it.
 */
function read(file: BrowserFile): Promise<FileValue | null> {
  try {
    return file
      .slice(0, LIMITS.fileBytes + 1)
      .arrayBuffer()
      .then(
        (buffer) => ({ name: file.name, bytes: new Uint8Array(buffer) }),
        () => null,
      );
  } catch {
    return Promise.resolve(null);
  }
}

/** Whether this app can pick a file: the web build can, through an input of the page; a phone cannot. */
export const canPickFiles: boolean = Platform.OS === "web";

/**
 * Opens the browser's file picker and resolves with the file the human chose, or null when they chose none, the
 * picker could not be opened, or the app is not the web build. It never rejects: every step that touches the page (the
 * input made, its listeners, the click, the choice read) is in one path that settles with null when one of them throws.
 * A file that comes after the answer was given is wiped, and the input lets go of what it was given.
 */
export function pickFile(): Promise<FileValue | null> {
  if (Platform.OS !== "web") return Promise.resolve(null);
  const found = page();
  if (found === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let input: FileInput | null = null;
    let settled = false;
    const settle = (file: FileValue | null): void => {
      if (settled) {
        if (file !== null) wipeFile(file);
        return;
      }
      settled = true;
      try {
        if (input !== null) input.value = "";
      } catch {
        // The input goes with this call, and what it was given with it.
      }
      resolve(file);
    };
    try {
      const made = found.createElement("input");
      input = made;
      made.type = "file";
      made.addEventListener("change", () => {
        let chosen: BrowserFile | null;
        try {
          chosen = made.files?.item(0) ?? null;
        } catch {
          chosen = null;
        }
        if (chosen === null) settle(null);
        else void read(chosen).then(settle, () => settle(null));
      });
      made.addEventListener("cancel", () => settle(null));
      made.click();
    } catch {
      settle(null);
    }
  });
}

/**
 * Takes a file dropped on the element `ref` holds: its bytes go to `onFile`, read as `pickFile` reads them. The drop is
 * the row's alone: the browser does not open the file, and nothing around the row is given it. A file that is read after
 * the row is gone is wiped. On a phone it does nothing.
 */
export function useFileDrop(ref: RefObject<unknown>, onFile: (file: FileValue) => void): void {
  if (Platform.OS !== "web") return;
  // The platform is the same on every render, so these hooks are called on every render of a web app and on none elsewhere.
  const held = useRef({ onFile, mounted: true });
  useEffect(() => {
    held.current.onFile = onFile;
  });
  useEffect(() => {
    const state = held.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
    };
  }, []);
  // After every render: the element the ref holds may be another one.
  useEffect(() => {
    const target = dropTarget(ref.current);
    if (target === null) return undefined;
    const over = (event: DragEventLike): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEventLike): void => {
      event.preventDefault();
      event.stopPropagation();
      const file = event.dataTransfer?.files.item(0) ?? null;
      if (file === null) return;
      void read(file).then((value) => {
        if (value === null) return;
        if (!held.current.mounted) {
          wipeFile(value);
          return;
        }
        try {
          held.current.onFile(value);
        } catch {
          wipeFile(value);
        }
      });
    };
    target.addEventListener("dragover", over);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", over);
      target.removeEventListener("drop", drop);
    };
  });
}
