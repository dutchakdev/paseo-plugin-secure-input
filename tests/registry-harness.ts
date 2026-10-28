import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { Registry, type AgentIdentity, type FulfillResult, type RecordChange, type RequestRecord } from "../server/core/registry";
import type { StillWanted } from "../server/io/atomic";
import type { OpenFile } from "../server/io/descriptor";
import { DropStore, type DropFile, type Removal, type SweepResult } from "../server/io/drop";
import { fromBase64Url } from "../shared/bytes";
import { buildAad, encodeValues, seal, type PayloadEntry } from "../shared/seal";
import { leaksOf, searchable, tempDir } from "./helpers";

// The registry harness of `tests/registry.test.ts`, shared with `tests/lifetime.test.ts`: a registry on a temporary data
// directory, with the real drop store, a clock the test sets, and every notice it gives kept. Importing this module also
// installs the search for typed values that runs after each test of the importing file (below).

export const CANARY = "CANARY-sk_live_4242";

/**
 * The real drop store, with the places a test can act in: `onWrite` runs when a write begins, before anything of the set
 * is on disk, and the write goes on once what it returns has settled; `onSweep` and `onRelease` do the same for a sweep and
 * for the removal of one set; `onWritten` runs when a write has put its set in place, before the caller hears of it;
 * `onExists` runs when `exists` has its answer and before the answer is handed back, as a process of the agent's that
 * acts right after the plugin looked. The files a write was handed are kept as they were handed, so that a test can look
 * at their bytes after the call.
 */
export class GatedDrop extends DropStore {
  onWrite?: () => Promise<unknown> | void;
  onWritten?: () => void;
  onSweep?: () => Promise<unknown> | void;
  onRelease?: (requestId: string) => Promise<unknown> | void;
  onExists?: (answer: boolean) => void;
  readonly handed: DropFile[][] = [];

  override async write(requestId: string, files: readonly DropFile[], beforeEffect?: () => void, onLeftover?: (name: string) => void): Promise<void> {
    this.handed.push([...files]);
    await this.onWrite?.();
    await super.write(requestId, files, beforeEffect, onLeftover);
    this.onWritten?.();
  }

  override async sweep(stillWanted?: StillWanted): Promise<SweepResult> {
    await this.onSweep?.();
    return super.sweep(stillWanted);
  }

  override async release(requestId: string): Promise<Removal> {
    await this.onRelease?.(requestId);
    return super.release(requestId);
  }

  override async exists(requestId: string): Promise<boolean> {
    const answer = await super.exists(requestId);
    this.onExists?.(answer);
    return answer;
  }
}

export interface HarnessOptions {
  onChange?: (record: RequestRecord) => unknown;
  maxStoredBytes?: number;
  shutdownBoundMs?: number;
  dropTtlMs?: number;
  /** How the drop store opens each file of a set: a test hands in one that fails at some point. */
  openFile?: OpenFile;
}

export function harness(dataDir = tempDir(), options: HarnessOptions = {}) {
  const clock = { now: 1_700_000_000_000 };
  const changes: RequestRecord[] = [];
  /** What each change was said to be, in step with `changes`. */
  const kinds: RecordChange[] = [];
  const forgotten: string[] = [];
  /** Both, in the order they were told: `<state> <id>` for a change, `forgotten <id>` for a request that left the history. */
  const told: string[] = [];
  const dropRoot = join(dataDir, "drop");
  const drop = new GatedDrop(dropRoot, { openFile: options.openFile });
  const registry = new Registry({
    dataDir,
    drop,
    maxStoredBytes: options.maxStoredBytes,
    shutdownBoundMs: options.shutdownBoundMs,
    dropTtlMs: options.dropTtlMs,
    onChange: (record, change) => {
      changes.push(record);
      kinds.push(change);
      told.push(`${record.state} ${record.id}`);
      return options.onChange?.(record) as void;
    },
    onForget: (requestId) => {
      forgotten.push(requestId);
      told.push(`forgotten ${requestId}`);
    },
    now: () => clock.now,
  });
  live.push({ registry, changes, dataDir });
  return { dataDir, dropRoot, drop, registry, changes, kinds, forgotten, told, clock };
}

export type Harness = ReturnType<typeof harness>;

/** Who asks. The registry keeps the working directory as text and never looks at it on disk. */
export function agent(id = "agent-1"): AgentIdentity {
  return { agentId: id, cwd: `/work/${id}`, title: "Deploy helper" };
}

/** A text field, and an optional one. */
export const asking = { reason: "keys for the integration test", fields: [{ key: "API_KEY" }, { key: "PEM", optional: true }] };
/** A text field and a file field. */
export const withFile = { reason: "a key and a key file", fields: [{ key: "API_KEY" }, { key: "P12", kind: "file" }] };

// ---------------------------------------------------------------------------------------------------------------------
// No typed value in anything the registry says. A test types a value by sealing it (`sealed`, `submit`), and every
// harness is searched, when its test is over, for every value its registry was given: the notices of a change it told,
// the answers `submit` got and the state file, as typed and as JSON spells it. A path that leaks is therefore found by
// the test that walks it, whether or not that test thought of looking.
// ---------------------------------------------------------------------------------------------------------------------

const watches = new WeakMap<Registry, { typed: Set<string>; said: string[] }>();
/** The registries this test made, with the notices each was given. */
const live: Array<{ registry: Registry; changes: RequestRecord[]; dataDir: string }> = [];
const watchOf = (registry: Registry) => {
  let watch = watches.get(registry);
  if (watch === undefined) watches.set(registry, (watch = { typed: new Set(), said: [] }));
  return watch;
};

/** Registers what a test is about to type: a text as typed, a file as it travels and, when it is text, as it reads. */
function typing(registry: Registry, values: readonly PayloadEntry[]): void {
  const watch = watchOf(registry);
  for (const entry of values) {
    if ("value" in entry) {
      // A field left empty holds nothing typed.
      if (entry.value !== "") watch.typed.add(searchable(entry.value));
      continue;
    }
    if (entry.file.length >= 6) watch.typed.add(entry.file);
    const text = Buffer.from(fromBase64Url(entry.file)).toString("utf8");
    if ([...text].length >= 6 && Buffer.from(text, "utf8").equals(Buffer.from(fromBase64Url(entry.file)))) watch.typed.add(text);
  }
}

/** Keeps what the registry answered a submission with, to be searched with the rest; hands it back. */
export function said<T>(registry: Registry, answer: T): T {
  watchOf(registry).said.push(JSON.stringify(answer));
  return answer;
}

/** The text of a regular file, or nothing when there is none at the path. */
export const read = (path: string): string => (existsSync(path) && lstatSync(path).isFile() ? readFileSync(path, "utf8") : "");

/** Every typed value found in anything the registries of this test said: the notices, the answers and the state file. */
function registryLeaks(entries: ReadonlyArray<{ registry: Registry; changes: readonly RequestRecord[]; dataDir: string }>): string[] {
  return entries.flatMap(({ registry, changes, dataDir }) => {
    const watch = watches.get(registry);
    if (watch === undefined) return [];
    return leaksOf(watch.typed, [...changes.map((change) => JSON.stringify(change)), ...watch.said, read(join(dataDir, "requests.json"))]);
  });
}

afterEach(() => {
  const entries = live.splice(0);
  expect(registryLeaks(entries)).toEqual([]);
});

/** What the app does: seal to the request's key, bound to the request and to the digest of what it asked for. */
export function sealed(registry: Registry, requestId: string, values: PayloadEntry[], digest?: string) {
  typing(registry, values);
  const record = registry.get(requestId) as RequestRecord;
  return seal(fromBase64Url(record.publicKey), encodeValues(values), buildAad(record.id, digest ?? record.requestDigest));
}

/** Seals and sends. */
export async function submit(registry: Registry, requestId: string, values: PayloadEntry[]): Promise<FulfillResult> {
  return said(registry, await registry.fulfill(requestId, sealed(registry, requestId, values)));
}

/** A request made and delivered: `API_KEY` alone, for `agentId`. */
export async function deliverOne(h: Harness, agentId = "agent-1", value = `${CANARY}-${agentId}`): Promise<string> {
  const { requestId } = await h.registry.create(agent(agentId), asking);
  expect(await submit(h.registry, requestId, [{ key: "API_KEY", value }])).toEqual({ ok: true, state: "delivered" });
  return requestId;
}

/** A promise the test settles by hand, as a write on a disk that stalls would settle when the disk comes back. */
export function gate() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
}

/** The records `requests.json` holds, as the registry saved them. */
export const stored = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "requests.json"), "utf8")) as RequestRecord[];
