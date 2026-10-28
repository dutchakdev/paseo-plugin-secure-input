import { describe, expect, it } from "vitest";
import { markLost, remember, type SealedSubmission } from "../client/envelope-cache";
import { afterCheckFailed, afterFulfill, afterLostReply, afterMismatch, afterReadClosed, afterSealFailure, type FulfillResult } from "../client/outcome";
import { sealEntries } from "../client/sealing";
import { submitEntries, type SubmitDeps, type SubmitInput } from "../client/submit";
import { fromBase64Url, toBase64Url, utf8 } from "../shared/bytes";
import { buildAad, decodeValues, generateRequestKeyPair, open, type PayloadEntry, type SealedEnvelope } from "../shared/seal";
import type { RequestView } from "../shared/view";
import { REQUEST_ID, file, text, viewOf } from "./view-fixtures";

const CANARY = "CANARY-31b8-never-sent-as-text";

const entriesOne: PayloadEntry[] = [{ key: "A", value: `one-${CANARY}` }];
const entriesTwo: PayloadEntry[] = [{ key: "A", value: `two-${CANARY}` }];

/** The envelope the n-th seal makes: distinguishable, and not a real ciphertext. */
const envelopeNo = (n: number): SealedEnvelope => ({ v: 1, epk: "E".repeat(43), nonce: "N".repeat(16), ct: `ct${n}`.padEnd(30, "c") });

interface Harness {
  deps: SubmitDeps;
  events: string[];
  gets: Array<{ requestId: string }>;
  fulfills: unknown[];
  seals: Array<{ entries: readonly PayloadEntry[] }>;
}

/** Hand-written stand-ins for the RPCs and the sealer, which is what the module takes. */
function harness(parts: { get?: SubmitDeps["get"]; fulfill?: SubmitDeps["fulfill"]; seal?: SubmitDeps["seal"]; fresh?: RequestView } = {}): Harness {
  const events: string[] = [];
  const gets: Harness["gets"] = [];
  const fulfills: unknown[] = [];
  const seals: Harness["seals"] = [];
  const deps: SubmitDeps = {
    async get(input) {
      events.push("get");
      gets.push(input);
      return parts.get ? parts.get(input) : (parts.fresh ?? viewOf());
    },
    async fulfill(input) {
      events.push("fulfill");
      fulfills.push(input);
      return parts.fulfill ? parts.fulfill(input) : { ok: true, state: "delivered" };
    },
    seal(view, entries) {
      events.push("seal");
      seals.push({ entries });
      return parts.seal ? parts.seal(view, entries) : envelopeNo(seals.length);
    },
  };
  return { deps, events, gets, fulfills, seals };
}

function input(overrides: Partial<SubmitInput> = {}): SubmitInput {
  return { requestId: REQUEST_ID, view: viewOf(), entries: entriesOne, cache: null, ...overrides };
}

const targetOf = (view: RequestView) => ({ requestId: view.id, publicKey: view.publicKey, requestDigest: view.requestDigest });

/** What the form holds after a submission whose reply never came. */
function lostCache(view: RequestView, entries: PayloadEntry[]): SealedSubmission {
  return markLost(remember(targetOf(view), entries, envelopeNo(0)));
}

const OTHER_ID = "r_ffffffffffffffffffffffffffffffff";

describe("the submit sequence", () => {
  it("seals the entries once, sends the request id and the envelope and nothing else, and closes", async () => {
    const h = harness();
    const outcome = await submitEntries(h.deps, input());
    expect(h.seals).toEqual([{ entries: entriesOne }]);
    expect(h.fulfills).toStrictEqual([{ requestId: REQUEST_ID, envelope: envelopeNo(1) }]);
    expect(outcome).toEqual({ next: afterFulfill({ ok: true, state: "delivered" }), cache: null, view: null });
    expect(h.events).toEqual(["seal", "fulfill"]);
  });

  it("sends no value but inside the envelope, and returns none but in the kept entries", async () => {
    const h = harness({ fulfill: async () => ({ ok: false, code: "write_failed", retryable: true }) });
    const outcome = await submitEntries(h.deps, input());
    expect(JSON.stringify(h.fulfills)).not.toContain("CANARY");
    expect(JSON.stringify({ next: outcome.next, view: outcome.view })).not.toContain("CANARY");
  });

  it("sends nothing, reads nothing and keeps the cache when the view it was given is of another request", async () => {
    const h = harness();
    const cache = remember(targetOf(viewOf()), entriesOne, envelopeNo(7));
    const outcome = await submitEntries(h.deps, input({ view: viewOf({ id: OTHER_ID }), cache }));
    expect(h.events).toEqual([]);
    expect(outcome).toEqual({ next: afterMismatch(), cache, view: null });
  });
});

describe("the submit sequence: reuse or seal", () => {
  it("sends the kept envelope as it is when the entries are unchanged", async () => {
    const h = harness();
    const cache = remember(targetOf(viewOf()), entriesOne, envelopeNo(7));
    const outcome = await submitEntries(h.deps, input({ cache }));
    expect(h.seals).toEqual([]);
    expect(h.fulfills).toStrictEqual([{ requestId: REQUEST_ID, envelope: envelopeNo(7) }]);
    expect(outcome.next.close).toBe(true);
  });

  it("seals anew when a value, a key, a file, the kind of an entry, the order or the number of entries changed", async () => {
    const kept: PayloadEntry[] = [{ key: "A", value: "AQID" }, { key: "SA", file: "AQID" }];
    const cache = remember(targetOf(viewOf()), kept, envelopeNo(7));
    const changed: PayloadEntry[][] = [
      [{ key: "A", value: "AQIE" }, { key: "SA", file: "AQID" }],
      [{ key: "B", value: "AQID" }, { key: "SA", file: "AQID" }],
      [{ key: "A", value: "AQID" }, { key: "SA", file: "AQIE" }],
      [{ key: "A", file: "AQID" }, { key: "SA", file: "AQID" }],
      [{ key: "SA", file: "AQID" }, { key: "A", value: "AQID" }],
      [...kept, { key: "C", value: "c" }],
      kept.slice(0, 1),
    ];
    for (const entries of changed) {
      const h = harness();
      await submitEntries(h.deps, input({ entries, cache }));
      expect(h.seals, JSON.stringify(entries)).toHaveLength(1);
      expect(h.fulfills).toStrictEqual([{ requestId: REQUEST_ID, envelope: envelopeNo(1) }]);
    }
  });

  it("seals anew for a cache that was made for another request, key or digest", async () => {
    for (const other of [{ requestId: OTHER_ID }, { publicKey: "Q".repeat(43) }, { requestDigest: "e".repeat(64) }]) {
      const h = harness();
      const cache = remember({ ...targetOf(viewOf()), ...other }, entriesOne, envelopeNo(7));
      await submitEntries(h.deps, input({ cache }));
      expect(h.seals, JSON.stringify(other)).toHaveLength(1);
    }
  });

  it("does not send when sealing is not possible, whether the sealer says so or throws, and keeps what it had", async () => {
    const cache = remember(targetOf(viewOf()), entriesOne, envelopeNo(7));
    for (const seal of [() => null, () => { throw new Error("library text"); }] as Array<SubmitDeps["seal"]>) {
      const h = harness({ seal });
      const outcome = await submitEntries(h.deps, input({ entries: entriesTwo, cache }));
      expect(h.fulfills).toEqual([]);
      expect(outcome).toEqual({ next: afterSealFailure(), cache, view: null });
    }
  });
});

describe("the submit sequence: a reply that never came", () => {
  it("keeps the envelope it sealed, marked as of unknown outcome, and asks to press «→» again", async () => {
    const h = harness({ fulfill: async () => { throw new Error("socket closed"); } });
    const outcome = await submitEntries(h.deps, input());
    expect(outcome.next).toEqual(afterLostReply());
    expect(outcome.cache?.envelope).toEqual(envelopeNo(1));
    expect(outcome.cache?.lostReply).toBe(true);
    expect(outcome.view).toBeNull();
  });

  it("sends the identical envelope when the human presses again with the same values, without reading the request first", async () => {
    const first = await submitEntries(harness({ fulfill: async () => { throw new Error("timeout"); } }).deps, input());
    const again = harness();
    const second = await submitEntries(again.deps, input({ cache: first.cache }));
    expect(again.events).toEqual(["fulfill"]);
    expect(again.fulfills).toStrictEqual([{ requestId: REQUEST_ID, envelope: envelopeNo(1) }]);
    expect(second.cache).toBeNull();
  });
});

describe("the submit sequence: values changed after a reply that never came", () => {
  const view = viewOf();
  const doubtful = (): SealedSubmission => lostCache(view, entriesOne);

  it("reads the request first, and sends nothing new if it cannot", async () => {
    const h = harness({ get: async () => { throw new Error("offline"); } });
    const cache = doubtful();
    const outcome = await submitEntries(h.deps, input({ view, entries: entriesTwo, cache }));
    expect(h.events).toEqual(["get"]);
    expect(h.gets).toEqual([{ requestId: REQUEST_ID }]);
    expect(outcome).toEqual({ next: afterCheckFailed(), cache, view: null });
  });

  it("shows the request closed, and drops the envelope, when it no longer waits: the first submission may have landed", async () => {
    for (const state of ["delivered", "released", "rejected", "declined", "cancelled", "expired"] as const) {
      const fresh = viewOf({ state });
      const h = harness({ fresh });
      const outcome = await submitEntries(h.deps, input({ view, entries: entriesTwo, cache: doubtful() }));
      expect(h.events, state).toEqual(["get"]);
      expect(outcome, state).toEqual({ next: afterReadClosed(), cache: null, view: fresh });
    }
  });

  it("refuses to go on when what it read is the view of another request", async () => {
    const h = harness({ fresh: viewOf({ id: OTHER_ID }) });
    const cache = doubtful();
    const outcome = await submitEntries(h.deps, input({ view, entries: entriesTwo, cache }));
    expect(h.events).toEqual(["get"]);
    expect(outcome).toEqual({ next: afterMismatch(), cache, view: null });
  });

  it("seals and sends the new entries when the request still waits", async () => {
    const h = harness({ fresh: viewOf() });
    const outcome = await submitEntries(h.deps, input({ view, entries: entriesTwo, cache: doubtful() }));
    expect(h.events).toEqual(["get", "seal", "fulfill"]);
    expect(h.seals[0]?.entries).toEqual(entriesTwo);
    expect(outcome).toEqual({ next: afterFulfill({ ok: true, state: "delivered" }), cache: null, view: null });
  });

  it("does not read when the values are the same, or when the last answer was a refusal that recorded nothing", async () => {
    const same = harness();
    await submitEntries(same.deps, input({ view, entries: entriesOne, cache: doubtful() }));
    expect(same.events).toEqual(["fulfill"]);

    const refused = harness({ fulfill: async () => ({ ok: false, code: "write_failed", retryable: true }) });
    const first = await submitEntries(refused.deps, input({ view }));
    expect(first.cache?.lostReply).toBe(false);
    const next = harness();
    await submitEntries(next.deps, input({ view, entries: entriesTwo, cache: first.cache }));
    expect(next.events).toEqual(["seal", "fulfill"]);
  });

  it("settles the doubt when the identical envelope is answered, even with a refusal", async () => {
    const h = harness({ fulfill: async () => ({ ok: false, code: "write_failed", retryable: true }) });
    const outcome = await submitEntries(h.deps, input({ view, entries: entriesOne, cache: doubtful() }));
    expect(outcome.cache?.lostReply).toBe(false);
  });
});

describe("the submit sequence: what the plugin answers", () => {
  it("keeps the envelope after a refusal that keeps the request open, with the doubt settled, and reads nothing", async () => {
    const result: FulfillResult = { ok: false, code: "write_failed", retryable: true, detail: "ENOSPC" };
    const h = harness({ fulfill: async () => result });
    const outcome = await submitEntries(h.deps, input());
    expect(outcome).toEqual({ next: afterFulfill(result), cache: remember(targetOf(viewOf()), entriesOne, envelopeNo(1)), view: null });
    expect(h.gets).toEqual([]);
  });

  // The plugin could not give a sound answer to a submission (its handler's fixed answer). Whether the plugin took the
  // submission is not known, so the form does not take the request for closed.
  describe("an answer that says the plugin could not answer", () => {
    const unanswered: FulfillResult = { ok: false, code: "service_unavailable", retryable: true };

    it("keeps the form and the envelope, reads nothing, and holds the outcome to be unknown", async () => {
      const h = harness({ fulfill: async () => unanswered });
      const outcome = await submitEntries(h.deps, input());
      expect(outcome.next).toEqual(afterFulfill(unanswered));
      expect(outcome.next).toMatchObject({ closed: false, clearForm: false, dropEnvelope: false, close: false, outcomeUnknown: true });
      expect(outcome.view).toBeNull();
      expect(outcome.cache).toEqual(markLost(remember(targetOf(viewOf()), entriesOne, envelopeNo(1))));
      expect(h.events).toEqual(["seal", "fulfill"]);
    });

    it("sends the very same envelope when the human presses again with the same values, and does not read or seal first", async () => {
      const kept = (await submitEntries(harness({ fulfill: async () => unanswered }).deps, input())).cache;
      const second = harness();
      const outcome = await submitEntries(second.deps, input({ cache: kept }));
      expect(second.events).toEqual(["fulfill"]);
      expect(second.fulfills).toStrictEqual([{ requestId: REQUEST_ID, envelope: envelopeNo(1) }]);
      expect(outcome.next).toEqual(afterFulfill({ ok: true, state: "delivered" }));
    });

    it("reads the request before it seals other values, as after a reply that never came: the first submission may have landed", async () => {
      const view = viewOf();
      const kept = (await submitEntries(harness({ fulfill: async () => unanswered }).deps, input({ view }))).cache;
      const closed = viewOf({ state: "delivered" });
      const second = harness({ fresh: closed });
      const outcome = await submitEntries(second.deps, input({ view, entries: entriesTwo, cache: kept }));
      expect(second.events).toEqual(["get"]);
      expect(second.fulfills).toEqual([]);
      expect(outcome).toEqual({ next: afterReadClosed(), cache: null, view: closed });
    });
  });

  it("drops the envelope after a failed decryption, so that the next press seals anew", async () => {
    const h = harness({ fulfill: async () => ({ ok: false, code: "decrypt_failed", retryable: true }) });
    const outcome = await submitEntries(h.deps, input());
    expect(outcome).toEqual({ next: afterFulfill({ ok: false, code: "decrypt_failed", retryable: true }), cache: null, view: null });
    expect(h.gets).toEqual([]);
    const again = harness();
    await submitEntries(again.deps, input({ cache: outcome.cache }));
    expect(again.events).toEqual(["seal", "fulfill"]);
  });

  it("shows the request closed after a refusal that closed it, drops the envelope, keeps the input and reads nothing", async () => {
    for (const code of ["retry_limit", "request_closed", "invalid_request", "write_failed"] as const) {
      const h = harness({ fulfill: async () => ({ ok: false, code, retryable: false }) });
      const outcome = await submitEntries(h.deps, input());
      expect(outcome, code).toEqual({ next: afterFulfill({ ok: false, code, retryable: false }), cache: null, view: null });
      expect(outcome.next, code).toMatchObject({ closed: true, clearForm: false });
      expect(h.gets, code).toEqual([]);
    }
  });

  it("does not read the request again after an accepted submission", async () => {
    const h = harness();
    await submitEntries(h.deps, input());
    expect(h.gets).toEqual([]);
  });
});

describe("the submit sequence with the real sealer", () => {
  it("seals what the request's key opens, bound to the view's id and digest, with the file entry in its payload", async () => {
    const pair = generateRequestKeyPair();
    const bound = viewOf({ publicKey: toBase64Url(pair.publicKey), fields: [text("API_KEY"), file("P12")] });
    const p12 = Uint8Array.from([0x30, 0x82, 0x00, 0xff, 0x0a]);
    const entries: PayloadEntry[] = [{ key: "API_KEY", value: `key-${CANARY}` }, { key: "P12", file: toBase64Url(p12) }];
    const opened: PayloadEntry[][] = [];
    const sent: unknown[] = [];
    const deps: SubmitDeps = {
      get: async () => bound,
      fulfill: async (call) => {
        sent.push(call);
        opened.push(decodeValues(open(pair.secretKey, call.envelope, buildAad(bound.id, bound.requestDigest))));
        expect(() => open(pair.secretKey, call.envelope, buildAad(bound.id, "e".repeat(64)))).toThrow();
        return { ok: true, state: "delivered" };
      },
      seal: sealEntries,
    };
    const outcome = await submitEntries(deps, input({ view: bound, entries }));
    expect(outcome.next.close).toBe(true);
    expect(opened).toEqual([entries]);
    const [, carried] = opened[0] ?? [];
    expect(carried !== undefined && "file" in carried ? fromBase64Url(carried.file) : null).toEqual(p12);
    expect(Object.keys(sent[0] as object)).toEqual(["requestId", "envelope"]);
    expect(JSON.stringify(sent)).not.toContain(CANARY);
    expect(JSON.stringify(sent)).not.toContain(toBase64Url(utf8.encode(`key-${CANARY}`)));
  });
});
