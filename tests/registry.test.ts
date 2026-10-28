import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DROP_SWEEP_BOUND_MS,
  HISTORY,
  MAX_REQUESTS_BYTES,
  MAX_RETRIES,
  Registry,
  SHUTDOWN_BOUND_MS,
  TTL_MS,
  requestDigestOf,
  type AgentIdentity,
  type FulfillResult,
  type RecordChange,
  type RequestRecord,
} from "../server/core/registry";
import { RecordSchema } from "../server/core/registry-store";
import { buildView } from "../server/core/view";
import { DropStore, filePath, setPath } from "../server/io/drop";
import { PASEO_STOP_WINDOW_MS } from "../server/paseo/plugin";
import { fromBase64Url, toBase64Url, utf8 } from "../shared/bytes";
import { DROP_TTL_MS, LIMITS } from "../shared/limits";
import { InputRequestSchema } from "../shared/request";
import { hasUnsafeCharacters } from "../shared/sanitize";
import { buildAad, encodeValues, seal } from "../shared/seal";
import { RequestViewSchema } from "../shared/view";
import { codeOfAsync, rejectionOf, tempDir } from "./helpers";
import { CANARY, GatedDrop, agent, asking, deliverOne, gate, harness, read, said, sealed, stored, submit, withFile, type Harness } from "./registry-harness";

const BIDI = String.fromCodePoint(0x202e);
/** The bytes of a file of the human's, a .p12 say: binary, with every byte value a text could not carry in it. */
const BINARY = Uint8Array.from([0x30, 0x82, 0x00, 0xff, 0x0a, 0x0d, 0x80, 0x7f, 0x00, 0x01]);

/** The data directory is read-only for the length of `body` and writable again after it, whatever happens. */
async function whileLocked<T>(directory: string, body: () => Promise<T>): Promise<T> {
  chmodSync(directory, 0o500);
  try {
    return await body();
  } finally {
    chmodSync(directory, 0o700);
  }
}

/** Records every rejection nobody handled while it is installed. */
function watchUnhandled() {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  return { seen, stop: () => process.off("unhandledRejection", listener) };
}

const settle = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const idOf = (n: number) => `r_${n.toString(16).padStart(32, "0")}`;
const keysOf = (registry: Registry) => (registry as unknown as { keys: Map<string, Uint8Array> }).keys;
const contentOf = (h: Harness, requestId: string, key: string): Buffer => readFileSync(filePath(h.dropRoot, requestId, key));
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Closed records exactly as the registry wrote them, with the times asked for: `firstTime` for the first, a millisecond later for each next. */
async function seedClosed(dataDir: string, count: number, firstTime: number): Promise<void> {
  const donor = harness(dataDir);
  const { requestId } = await donor.registry.create(agent(), asking);
  await donor.registry.decline(requestId);
  const declined = stored(dataDir)[0] as RequestRecord;
  const records = Array.from({ length: count }, (_, index) => ({
    ...declined,
    id: idOf(index + 1),
    createdAt: firstTime + index,
    updatedAt: firstTime + index,
  }));
  writeFileSync(join(dataDir, "requests.json"), JSON.stringify(records), { mode: 0o600 });
}

describe("create", () => {
  it("opens one pending request per agent and keeps agents independent", async () => {
    const { registry, changes } = harness();
    const first = agent("agent-1");
    const created = await registry.create(first, asking);
    expect(created).toEqual({ status: "pending", requestId: expect.stringMatching(/^r_[0-9a-f]{32}$/), next: "End your turn now. You will receive a message when the user has submitted. Do not poll." });
    expect(changes.at(-1)).toMatchObject({ id: created.requestId, state: "pending", agentId: "agent-1" });
    expect(await codeOfAsync(registry.create(first, asking))).toBe("request_already_pending");
    expect((await registry.create(agent("agent-2"), asking)).status).toBe("pending");
  });

  it("starts a request with nothing written, no deadline and nothing fulfilled", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create(agent(), asking);
    expect(registry.get(requestId)).toMatchObject({
      state: "pending",
      retries: 0,
      tamper: false,
      errorCode: null,
      fulfilledDigest: null,
      written: null,
      deleteBy: null,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(Object.keys(registry.get(requestId) as object)).not.toContain("releasedBy");
  });

  it("binds a digest of the keys it asked for and whether each is optional, and of nothing else", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create(agent(), asking);
    // Written by hand here: the canonical form, keys sorted, no whitespace.
    const expected = sha256('{"declared":[{"key":"API_KEY","optional":false},{"key":"PEM","optional":true}]}');
    expect(registry.get(requestId)?.requestDigest).toBe(expected);
    expect(requestDigestOf(InputRequestSchema.parse(asking))).toBe(expected);
    // The reason, the labels, the kind and the format are not bound: the daemon checks the kind itself, the app the format.
    const dressed = InputRequestSchema.parse({ reason: "other", fields: [{ key: "API_KEY", label: "a hint", kind: "text" }, { key: "PEM", optional: true, kind: "file", format: "pem" }] });
    expect(requestDigestOf(dressed)).toBe(expected);
    // Whether a key is optional is, and so is each key, and their order.
    expect(requestDigestOf(InputRequestSchema.parse({ fields: [{ key: "API_KEY" }, { key: "PEM" }] }))).not.toBe(expected);
    expect(requestDigestOf(InputRequestSchema.parse({ fields: [{ key: "PEM", optional: true }, { key: "API_KEY" }] }))).not.toBe(expected);
    expect(requestDigestOf(InputRequestSchema.parse({}))).toBe(sha256('{"declared":[]}'));
  });

  it("refuses a malformed request, and keys that differ only in letter case with the schema's words", async () => {
    const { registry, changes } = harness();
    expect(await codeOfAsync(registry.create(agent(), { fields: [{ key: "A-B" }] }))).toBe("invalid_request");
    expect((await rejectionOf(registry.create(agent(), { fields: [{ key: "API_KEY" }, { key: "api_key" }] }))).message).toBe(
      "invalid_request: request: field keys must differ in more than letter case",
    );
    expect((await rejectionOf(registry.create(agent(), { sink: { kind: "dotenv", path: ".env", dialect: "dotenv" }, fields: [{ key: "A" }] }))).message).toBe(
      'invalid_request: request: Unrecognized key: "sink"',
    );
    expect(changes).toEqual([]);
    expect(keysOf(registry).size).toBe(0);
  });

  it("does not let a delivered request block the next one: only a pending one does", async () => {
    const h = harness();
    await deliverOne(h);
    const next = await h.registry.create(agent(), asking);
    expect(next.status).toBe("pending");
    expect(await codeOfAsync(h.registry.create(agent(), asking))).toBe("request_already_pending");
  });

  it("refuses an unknown request id when asked for a view or a submission", async () => {
    const { registry } = harness();
    expect((await rejectionOf(async () => buildView(registry, idOf(1)))).message).toBe("invalid_request: unknown request");
    const { requestId } = await registry.create(agent(), asking);
    const envelope = sealed(registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);
    expect(await registry.fulfill(idOf(1), envelope)).toEqual({ ok: false, code: "invalid_request", retryable: false });
    expect(registry.get(requestId)?.state).toBe("pending");
  });

  it("opens two requests started together for one agent as one pending and one refusal", async () => {
    const { registry } = harness();
    const who = agent();
    const results = await Promise.allSettled([registry.create(who, asking), registry.create(who, asking)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("pending");
    expect(((results[1] as PromiseRejectedResult).reason as { code?: string }).code).toBe("request_already_pending");
  });
});

// What is stored is what is shown: a request whose view the dialog's contract would refuse is never created, so no card
// can stand in the timeline that nobody can open, answer or decline.
describe("create, a request the dialog could not show", () => {
  it("holds the view of every request to the dialog's contract before it creates it, and names the part that does not fit", async () => {
    const h = harness();
    const unfit = vi.spyOn(RequestViewSchema, "safeParse").mockReturnValue({ success: false, error: { issues: [{ path: ["fields", 0, "label"] }] } } as never);
    try {
      expect((await rejectionOf(h.registry.create(agent(), asking))).message).toBe("invalid_request: the request cannot be shown in the dialog (fields.0.label)");
    } finally {
      unfit.mockRestore();
    }
    expect(h.changes).toEqual([]);
    expect((h.registry as unknown as { records: Map<string, unknown> }).records.size).toBe(0);
    expect(keysOf(h.registry).size).toBe(0);
    expect(existsSync(join(h.dataDir, "requests.json"))).toBe(false);
    // With the contract's own answer, the same request is made, and its view is one the dialog takes.
    const { requestId } = await h.registry.create(agent(), asking);
    expect(RequestViewSchema.safeParse(buildView(h.registry, requestId)).success).toBe(true);
  });
});

describe("create, text the agent supplied", () => {
  it("names what was wrong without repeating invisible characters from the caller's own input", async () => {
    const { registry } = harness();
    const error = await rejectionOf(registry.create(agent(), { ...asking, [`x${BIDI}y`]: 1 }));
    expect(error.code).toBe("invalid_request");
    expect(hasUnsafeCharacters(error.message)).toBe(false);
    expect(error.message).toContain('"x y"');
  });

  it("caps the text of a refusal", async () => {
    const { registry } = harness();
    const noise = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`unexpected_property_${index}`, 1]));
    const error = await rejectionOf(registry.create(agent(), { ...asking, ...noise }));
    expect(error.code).toBe("invalid_request");
    expect(error.message.startsWith("invalid_request: request: Unrecognized key")).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual("invalid_request: ".length + 1024);
    expect(error.message.length).toBeGreaterThan(1000);
  });

  it("reports the first five problems of a request and no more", async () => {
    const { registry } = harness();
    const error = await rejectionOf(registry.create(agent(), { fields: Array.from({ length: 10 }, (_, index) => ({ key: `not a key ${index}` })) }));
    expect(error.message.startsWith("invalid_request: fields.0.key: ")).toBe(true);
    expect(error.message.match(/fields\.\d+\.key/g)).toHaveLength(5);
  });

  it("stores the reason, the labels and the title without characters that hide or reorder text, and the record survives a restart", async () => {
    const first = harness();
    const who = { ...agent(), title: `Deploy${BIDI} helper` };
    const { requestId } = await first.registry.create(who, {
      reason: `line one\nline two${BIDI}`,
      fields: [{ key: "API_KEY", label: `Stripe${BIDI} key` }, { key: "OPTIONAL", label: BIDI }],
    });
    const record = first.registry.get(requestId) as RequestRecord;
    expect(record.request.reason).toBe("line one line two");
    expect(record.request.fields).toEqual([{ key: "API_KEY", label: "Stripe key" }, { key: "OPTIONAL" }]);
    expect(record.agentTitle).toBe("Deploy helper");
    expect(JSON.stringify(first.changes)).not.toContain(BIDI);

    const second = harness(first.dataDir);
    await second.registry.load();
    expect(second.registry.get(requestId)).toMatchObject({ state: "expired", agentTitle: "Deploy helper" });
  });

  it("caps the title", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create({ ...agent(), title: "t".repeat(300) }, asking);
    expect(registry.get(requestId)?.agentTitle).toBe("t".repeat(200));
  });

  it("keeps no title when nothing visible is left of it", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create({ ...agent(), title: BIDI }, asking);
    expect(registry.get(requestId)?.agentTitle).toBeNull();
  });
});

describe("create, who is asking", () => {
  const identities: Array<[string, () => AgentIdentity]> = [
    ["an agent id that is empty", () => ({ ...agent(), agentId: "" })],
    ["an agent id of 300 characters", () => ({ ...agent(), agentId: "a".repeat(300) })],
    ["an agent id with a bidi control character", () => ({ ...agent(), agentId: `agent${BIDI}` })],
    ["a working directory with a bidi control character", () => ({ ...agent(), cwd: `/work/work${BIDI}dir` })],
    ["a working directory that is not absolute", () => ({ ...agent(), cwd: "relative/dir" })],
  ];

  it.each(identities)("refuses %s, and keeps no key of it", async (_name, identity) => {
    const { registry, changes } = harness();
    expect((await rejectionOf(registry.create(identity(), asking))).message).toBe("invalid_request: the agent's identity cannot be stored");
    expect(changes).toEqual([]);
    expect(keysOf(registry).size).toBe(0);
  });

  it("stores whatever it accepts in a form the next start reads back", async () => {
    const first = harness();
    const who = { agentId: "a".repeat(256), cwd: agent().cwd, title: "t".repeat(300) };
    const { requestId } = await first.registry.create(who, asking);
    expect(first.registry.get(requestId)?.agentTitle).toBe("t".repeat(200));
    const second = harness(first.dataDir);
    await second.registry.load();
    expect(second.registry.get(requestId)).toMatchObject({ state: "expired", agentId: "a".repeat(256) });
    expect(second.registry.health()).toMatchObject({ stored: "ok", dropped: 0 });
  });
});

describe("fulfill, the set it writes", () => {
  it("writes text and a binary file byte for byte, as a set that only this user can read", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), withFile);
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }, { key: "P12", file: toBase64Url(BINARY) }])).toEqual({ ok: true, state: "delivered" });
    expect(contentOf(h, requestId, "API_KEY").equals(Buffer.from(CANARY, "utf8"))).toBe(true);
    expect(contentOf(h, requestId, "P12").equals(Buffer.from(BINARY))).toBe(true);
    expect(readdirSync(setPath(h.dropRoot, requestId)).sort()).toEqual(["API_KEY", "P12"]);
    expect(statSync(setPath(h.dropRoot, requestId)).mode & 0o777).toBe(0o700);
    for (const key of ["API_KEY", "P12"]) expect(statSync(filePath(h.dropRoot, requestId, key)).mode & 0o777).toBe(0o600);
    // Only the set: nothing staged is left beside it.
    expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${requestId}`]);
  });

  it("reads delivered, with the keys in the order they were written and a deadline DROP_TTL_MS after the write", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    h.clock.now += 5_000;
    expect(await submit(h.registry, requestId, [{ key: "MINE", value: "first-typed" }, { key: "API_KEY", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    expect(h.registry.get(requestId)).toMatchObject({
      state: "delivered",
      written: ["MINE", "API_KEY"],
      deleteBy: h.clock.now + DROP_TTL_MS,
      fulfilledDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      errorCode: null,
      tamper: false,
    });
    expect(DROP_TTL_MS).toBe(15 * 60 * 1000);
    expect(h.told.at(-1)).toBe(`delivered ${requestId}`);
    expect(h.kinds.at(-1)).toBe("state");
    expect(stored(h.dataDir).find((record) => record.id === requestId)).toMatchObject({ state: "delivered", written: ["MINE", "API_KEY"] });
    // The key that opened the submission is gone with it.
    expect(keysOf(h.registry).has(requestId)).toBe(false);
  });

  it("takes the time the set may stay for from its options", async () => {
    const h = harness(tempDir(), { dropTtlMs: 40 });
    const requestId = await deliverOne(h);
    expect(h.registry.get(requestId)?.deleteBy).toBe(h.clock.now + 40);
  });

  it("gives an optional field left empty no file", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }, { key: "PEM", value: "" }])).toEqual({ ok: true, state: "delivered" });
    expect(readdirSync(setPath(h.dropRoot, requestId))).toEqual(["API_KEY"]);
    expect(h.registry.get(requestId)?.written).toEqual(["API_KEY"]);
  });

  it("rejects a row that differs from a key only in letter case, and a file for a text field, and writes nothing", async () => {
    const h = harness();
    const first = await h.registry.create(agent("a"), asking);
    expect(await submit(h.registry, first.requestId, [{ key: "API_KEY", value: CANARY }, { key: "api_key", value: `${CANARY}-row` }])).toEqual({
      ok: false,
      code: "invalid_request",
      retryable: false,
      detail: "API_KEY and api_key differ only in letter case",
    });
    expect(h.registry.get(first.requestId)).toMatchObject({ state: "rejected", errorCode: "invalid_request", written: null, deleteBy: null });

    const second = await h.registry.create(agent("b"), withFile);
    expect(await submit(h.registry, second.requestId, [{ key: "API_KEY", value: CANARY }, { key: "P12", value: `${CANARY}-text` }])).toEqual({
      ok: false,
      code: "invalid_request",
      retryable: false,
      detail: "P12 must be a file",
    });
    expect(h.registry.get(second.requestId)).toMatchObject({ state: "rejected", errorCode: "invalid_request" });
    // No set, and nothing staged for one.
    for (const id of [first.requestId, second.requestId]) expect(existsSync(setPath(h.dropRoot, id))).toBe(false);
    expect(existsSync(h.dropRoot) ? readdirSync(h.dropRoot) : []).toEqual([]);
    expect(h.drop.handed).toEqual([]);
  });

  it("rejects a submission that would write nothing before anything is written", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), { fields: [{ key: "A", optional: true }, { key: "F", optional: true, kind: "file" }] });
    expect(await submit(h.registry, requestId, [])).toEqual({ ok: false, code: "invalid_request", retryable: false, detail: "nothing to write" });
    expect(h.registry.get(requestId)).toMatchObject({ state: "rejected", errorCode: "invalid_request" });
    expect(h.drop.handed).toEqual([]);
  });

  it("rejects a payload it cannot read, with nothing of it in the answer", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const record = h.registry.get(requestId) as RequestRecord;
    // Sealed for this request, so it opens; what is inside is no payload.
    const garbage = utf8.encode(`${CANARY} is not a payload`.padEnd(1024, " "));
    const envelope = seal(fromBase64Url(record.publicKey), garbage, buildAad(requestId, record.requestDigest));
    expect(said(h.registry, await h.registry.fulfill(requestId, envelope))).toEqual({ ok: false, code: "invalid_request", retryable: false });
    expect(h.registry.get(requestId)).toMatchObject({ state: "rejected", errorCode: "invalid_request" });
  });

  it("answers an envelope sealed to another digest with decrypt_failed, which may be tried again, and closes the request at the third", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const wrongDigest = "0".repeat(64);
    for (let attempt = 1; attempt < MAX_RETRIES; attempt++) {
      expect(await h.registry.fulfill(requestId, sealed(h.registry, requestId, [{ key: "API_KEY", value: CANARY }], wrongDigest))).toEqual({
        ok: false,
        code: "decrypt_failed",
        retryable: true,
      });
      expect(h.registry.get(requestId)).toMatchObject({ state: "pending", retries: attempt });
    }
    expect(await h.registry.fulfill(requestId, sealed(h.registry, requestId, [{ key: "API_KEY", value: CANARY }], wrongDigest))).toEqual({ ok: false, code: "retry_limit", retryable: false });
    expect(h.registry.get(requestId)).toMatchObject({ state: "rejected", errorCode: "retry_limit", retries: MAX_RETRIES });
    expect(keysOf(h.registry).has(requestId)).toBe(false);
    expect(h.drop.handed).toEqual([]);
  });

  it("treats another request's envelope as a decrypt failure", async () => {
    const h = harness();
    const a = await h.registry.create(agent("a"), asking);
    const b = await h.registry.create(agent("b"), asking);
    expect(await h.registry.fulfill(a.requestId, sealed(h.registry, b.requestId, [{ key: "API_KEY", value: "typed-v" }]))).toEqual({ ok: false, code: "decrypt_failed", retryable: true });
    expect(h.registry.get(a.requestId)?.state).toBe("pending");
  });

  it("is idempotent for the same submission, and a second, different one is tampering that leaves the first bytes as they were", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const good = sealed(h.registry, requestId, [{ key: "API_KEY", value: CANARY }]);
    expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
    expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
    expect(h.registry.get(requestId)?.tamper).toBe(false);

    const other = seal(new Uint8Array(32).fill(9), encodeValues([{ key: "API_KEY", value: "forged-value" }]), buildAad(requestId, "x"));
    expect(await h.registry.fulfill(requestId, other)).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(h.registry.get(requestId)).toMatchObject({ state: "delivered", tamper: true });
    expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe(CANARY);
    expect(h.drop.handed).toHaveLength(1);
  });

  it("calls a different submission to a released request tampering too, and answers its own repeat", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const good = sealed(h.registry, requestId, [{ key: "API_KEY", value: CANARY }]);
    expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
    await h.registry.shutdown();
    const next = harness(h.dataDir);
    await next.registry.load();
    expect(next.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(await next.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "released" });
    expect(await next.registry.fulfill(requestId, sealed(next.registry, requestId, [{ key: "API_KEY", value: "second-typed" }]))).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(next.registry.get(requestId)).toMatchObject({ state: "released", tamper: true });
    expect(next.kinds.at(-1)).toBe("tamper");
  });

  it("rejects the request with write_failed when the set's path is taken, and leaves what is there", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    mkdirSync(h.dropRoot, { mode: 0o700 });
    writeFileSync(setPath(h.dropRoot, requestId), "SOMEONE ELSE'S", { mode: 0o600 });
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }])).toEqual({ ok: false, code: "write_failed", retryable: false, detail: "ENOTDIR" });
    expect(h.registry.get(requestId)).toMatchObject({ state: "rejected", errorCode: "write_failed", written: null, deleteBy: null });
    expect(readFileSync(setPath(h.dropRoot, requestId), "utf8")).toBe("SOMEONE ELSE'S");
    expect(readdirSync(h.dropRoot)).toEqual([`si-secret-${requestId}`]);
  });

  it("wipes the bytes it handed to the store, after a write that worked and after one that failed", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent("a"), withFile);
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }, { key: "P12", file: toBase64Url(BINARY) }])).toMatchObject({ ok: true });
    const failing = await h.registry.create(agent("b"), asking);
    writeFileSync(setPath(h.dropRoot, failing.requestId), "taken", { mode: 0o600 });
    expect(await submit(h.registry, failing.requestId, [{ key: "API_KEY", value: CANARY }])).toMatchObject({ ok: false, code: "write_failed" });
    expect(h.drop.handed).toHaveLength(2);
    for (const files of h.drop.handed) {
      for (const file of files) {
        expect(file.bytes.length, file.key).toBeGreaterThan(0);
        expect(file.bytes.every((byte) => byte === 0), file.key).toBe(true);
      }
    }
    // What was written is the bytes as they were before the wipe.
    expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe(CANARY);
  });
});

describe("closing without a submission", () => {
  it("declines, cancels only for the owner, and never calls a late submission tampering", async () => {
    const { registry } = harness();
    const declined = await registry.create(agent("a"), asking);
    const envelope = sealed(registry, declined.requestId, [{ key: "API_KEY", value: "typed-v" }]);
    expect((await registry.decline(declined.requestId)).state).toBe("declined");
    expect(await registry.fulfill(declined.requestId, envelope)).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(registry.get(declined.requestId)?.tamper).toBe(false);

    const open = await registry.create(agent("b"), asking);
    expect(await codeOfAsync(registry.cancel("someone-else", open.requestId))).toBe("request_closed");
    expect((await registry.cancel("b", open.requestId)).state).toBe("cancelled");
    expect(await codeOfAsync(registry.decline(open.requestId))).toBe("request_closed");
  });

  it("neither declines nor cancels a request whose files were delivered", async () => {
    const h = harness();
    const requestId = await deliverOne(h);
    expect(await codeOfAsync(h.registry.decline(requestId))).toBe("request_closed");
    expect(await codeOfAsync(h.registry.cancel("agent-1", requestId))).toBe("request_closed");
    expect(h.registry.get(requestId)?.state).toBe("delivered");
  });

  it("expires a request after eight hours without flagging the human who answers late", async () => {
    const { registry, clock } = harness();
    const { requestId } = await registry.create(agent(), asking);
    const envelope = sealed(registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);
    clock.now += TTL_MS - 1;
    await registry.expire();
    expect(registry.get(requestId)?.state).toBe("pending");
    clock.now += 2;
    await registry.expire();
    expect(registry.get(requestId)).toMatchObject({ state: "expired", expiredBy: "time" });
    expect(await registry.fulfill(requestId, envelope)).toMatchObject({ code: "request_closed" });
    expect(registry.get(requestId)?.tamper).toBe(false);
  });

  it("expires a request past its time when the human answers, without waiting for the timer", async () => {
    const { registry, clock, changes } = harness();
    const { requestId } = await registry.create(agent(), asking);
    const envelope = sealed(registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);
    clock.now += TTL_MS + 1;
    expect(await registry.fulfill(requestId, envelope)).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(registry.get(requestId)).toMatchObject({ state: "expired", expiredBy: "time", tamper: false });
    expect(changes.at(-1)).toMatchObject({ id: requestId, state: "expired" });
  });
});

describe("what a change is said to be", () => {
  it("says a state for a new request and for every way it ends, the flag when it is raised, and something else for a counted attempt", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    expect(await h.registry.fulfill(requestId, sealed(h.registry, requestId, [{ key: "API_KEY", value: "typed-v" }], "0".repeat(64)))).toMatchObject({ code: "decrypt_failed" });
    const good = sealed(h.registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);
    expect(await h.registry.fulfill(requestId, good)).toMatchObject({ ok: true, state: "delivered" });
    expect(await h.registry.fulfill(requestId, good)).toMatchObject({ ok: true }); // a repeat changes nothing
    const other = sealed(h.registry, requestId, [{ key: "API_KEY", value: "other-typed" }]);
    await h.registry.fulfill(requestId, other);
    await h.registry.fulfill(requestId, other); // flagged already: nothing more to say
    const told = () => h.changes.map((record, index) => `${record.state}${record.tamper ? "+tamper" : ""}/${record.retries}:${h.kinds[index]}`);
    expect(told()).toEqual(["pending/0:state", "pending/1:other", "delivered/1:state", "delivered+tamper/1:tamper"]);

    await h.registry.decline((await h.registry.create(agent("declined"), asking)).requestId);
    await h.registry.cancel("cancelled", (await h.registry.create(agent("cancelled"), asking)).requestId);
    const wrong = await h.registry.create(agent("wrong"), withFile);
    await submit(h.registry, wrong.requestId, [{ key: "API_KEY", value: "typed-v" }, { key: "P12", value: "typed-w" }]);
    await h.registry.create(agent("old"), asking);
    h.clock.now += TTL_MS + 1;
    // The tick: the old request expires, and the delivered set, far past its deadline, goes by its time.
    await h.registry.expire();
    expect(told().slice(4)).toEqual([
      "pending/0:state",
      "declined/0:state",
      "pending/0:state",
      "cancelled/0:state",
      "pending/0:state",
      "rejected/0:state",
      "pending/0:state",
      "released+tamper/1:state",
      "expired/0:state",
    ]);
  });

  it("says a state for what the load itself ended, and nothing for a record that was closed when it was saved", async () => {
    const first = harness();
    const declined = (await first.registry.create(agent("declined"), asking)).requestId;
    await first.registry.decline(declined);
    const delivered = await deliverOne(first, "delivered");
    const open = (await first.registry.create(agent("open"), asking)).requestId;

    const second = harness(first.dataDir);
    await second.registry.load();
    expect(second.changes.map((record, index) => `${record.id}:${record.state}:${second.kinds[index]}`).sort()).toEqual(
      [`${delivered}:released:state`, `${open}:expired:state`].sort(),
    );
    expect(second.registry.get(declined)?.state).toBe("declined");
  });

  it("tells when a request leaves the history, once, and never for one that is still there", async () => {
    const h = harness(tempDir(), { maxStoredBytes: 3000 });
    const ids: string[] = [];
    for (let index = 0; index < 8; index++) {
      h.clock.now += 1;
      const { requestId } = await h.registry.create(agent(`a-${index}`), asking);
      await h.registry.decline(requestId);
      ids.push(requestId);
    }
    expect(h.forgotten.length).toBeGreaterThan(0);
    expect(new Set(h.forgotten).size).toBe(h.forgotten.length);
    for (const id of ids) expect(h.registry.get(id) === undefined, id).toBe(h.forgotten.includes(id));
    // The oldest go first.
    expect(h.forgotten).toEqual(ids.slice(0, h.forgotten.length));
  });

  it("tells that a request is gone after it told of the change that pushed it out, also when that change is the request's own end", async () => {
    // Room for one record and not for two: a request that stays open leaves none for one that closes beside it.
    const measured = harness();
    await measured.registry.create(agent("open"), asking);
    const one = Buffer.byteLength(readFileSync(join(measured.dataDir, "requests.json")));
    const h = harness(tempDir(), { maxStoredBytes: Math.floor(one * 1.5) });
    const open = (await h.registry.create(agent("open"), asking)).requestId;
    const closing = (await h.registry.create(agent("shut"), asking)).requestId;
    expect(h.forgotten).toEqual([]); // two open requests: neither may go, and the file cannot hold both
    expect(h.registry.health().persistence).toBe("failing");

    await h.registry.decline(closing);
    // It left the history with the very change that closed it. Whoever keeps something for it heard of the change
    // first, and then that it is gone: told the other way round, what the change made them keep would never go.
    expect(h.registry.get(closing)).toBeUndefined();
    expect(h.told).toEqual([`pending ${open}`, `pending ${closing}`, `declined ${closing}`, `forgotten ${closing}`]);
    expect(stored(h.dataDir).map((record) => record.id)).toEqual([open]);
    expect(h.registry.health().persistence).toBe("ok");
  });
});

describe("start-up", () => {
  it("sweeps drop/ before it reads the requests, and reads a delivered request back as released by the restart", async () => {
    const first = harness();
    const requestId = await deliverOne(first);
    mkdirSync(join(first.dropRoot, "left-by-a-killed-write.tmp"));
    expect(readdirSync(first.dropRoot).sort()).toEqual(["left-by-a-killed-write.tmp", `si-secret-${requestId}`]);

    const order: string[] = [];
    const dataDir = first.dataDir;
    const drop = new GatedDrop(join(dataDir, "drop"));
    drop.onSweep = () => void order.push("sweep");
    const changes: Array<[string, RecordChange]> = [];
    const registry = new Registry({
      dataDir,
      drop,
      onChange: (record, change) => void changes.push([`${record.state}:${record.releasedBy ?? "-"}`, change]),
      now: () => first.clock.now,
      get maxStoredBytes() {
        order.push("requests.json");
        return undefined;
      },
    });
    expect(await registry.load()).toBe(true);
    // Swept, and only then read (and saved, which reads the bound a second time).
    expect(order).toEqual(["sweep", "requests.json", "requests.json"]);
    expect(readdirSync(join(dataDir, "drop"))).toEqual([]);
    expect(registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "restart", written: ["API_KEY"], fulfilledDigest: expect.any(String) });
    expect(changes).toEqual([["released:restart", "state"]]);
    expect(stored(dataDir)[0]).toMatchObject({ id: requestId, state: "released", releasedBy: "restart" });
    expect(registry.health()).toEqual({ persistence: "ok", drop: "ok", stored: "ok", dropped: 0 });
  });

  it("reads a pending request back as expired by the restart, because its key is gone", async () => {
    const first = harness();
    const { requestId } = await first.registry.create(agent(), asking);
    const second = harness(first.dataDir);
    await second.registry.load();
    expect(second.registry.get(requestId)).toMatchObject({ state: "expired", expiredBy: "restart" });
    expect(second.changes.at(-1)).toMatchObject({ id: requestId, state: "expired" });
    expect(second.kinds.at(-1)).toBe("state");
  });

  it("keeps how a request expired, by its time or by a restart, and reads it back", async () => {
    const first = harness();
    const timed = (await first.registry.create(agent("timed"), asking)).requestId;
    first.clock.now += TTL_MS + 1;
    await first.registry.expire();
    const open = (await first.registry.create(agent("open"), asking)).requestId;
    expect(first.registry.get(timed)).toMatchObject({ state: "expired", expiredBy: "time" });
    expect(first.registry.get(open)?.expiredBy).toBeUndefined();

    const second = harness(first.dataDir);
    second.clock.now = first.clock.now;
    await second.registry.load();
    expect(second.registry.get(timed)).toMatchObject({ state: "expired", expiredBy: "time" });
    expect(second.registry.get(open)).toMatchObject({ state: "expired", expiredBy: "restart" });
    // And a third start reads the markers back as they were saved, and tells nobody a second time.
    const third = harness(first.dataDir);
    await third.registry.load();
    expect(third.registry.get(open)).toMatchObject({ state: "expired", expiredBy: "restart" });
    expect(third.changes).toEqual([]);
  });

  it("drops a record v1 kept, counts it, and does not save it again", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    await donor.registry.create(agent(), asking);
    const good = stored(dataDir)[0] as RequestRecord;
    const { requestDigest: _digest, written: _written, deleteBy: _deleteBy, ...shared } = good;
    const receipt = { kind: "dotenv", relativePath: ".env.local", written: ["API_KEY"], skipped: [], added: ["API_KEY"], overwritten: [] };
    const v1 = {
      ...shared,
      id: idOf(1),
      agentId: "v1-agent",
      request: { reason: "", sink: { kind: "dotenv", path: ".env.local", dialect: "dotenv" }, fields: [{ key: "API_KEY" }], allowExtraRows: false },
      sinkDigest: "c".repeat(64),
      receipt,
      state: "written",
      fulfilledDigest: "c".repeat(64),
    };
    const v1File = { ...v1, id: idOf(2), request: { reason: "", sink: { kind: "file", path: "key.pem" }, fields: [], allowExtraRows: false }, receipt: null, state: "pending", fulfilledDigest: null };
    writeFileSync(join(dataDir, "requests.json"), JSON.stringify([v1, good, v1File]), { mode: 0o600 });
    const { registry, changes } = harness(dataDir);
    await registry.load();
    expect(registry.get(idOf(1))).toBeUndefined();
    expect(registry.get(idOf(2))).toBeUndefined();
    expect(registry.health()).toEqual({ persistence: "ok", drop: "ok", stored: "ok", dropped: 2 });
    expect(changes.map((record) => record.id)).toEqual([good.id]);
    expect(stored(dataDir).map((record) => record.id)).toEqual([good.id]);
    expect(readFileSync(join(dataDir, "requests.json"), "utf8")).not.toContain("sinkDigest");
  });

  it("fails, and touches nothing, when drop/ is a link", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    await donor.registry.create(agent(), asking);
    const saved = readFileSync(join(dataDir, "requests.json"), "utf8");
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "keep"), "KEEP", { mode: 0o600 });
    mkdirSync(join(elsewhere, "si-secret-planted"));
    symlinkSync(elsewhere, join(dataDir, "drop"));

    const h = harness(dataDir);
    expect(await rejectionOf(h.registry.load())).toEqual({ code: "service_unavailable", message: "service_unavailable: the drop directory is not a private directory of this user" });
    expect(readdirSync(elsewhere).sort()).toEqual(["keep", "si-secret-planted"]);
    expect(readFileSync(join(elsewhere, "keep"), "utf8")).toBe("KEEP");
    expect(lstatSync(join(dataDir, "drop")).isSymbolicLink()).toBe(true);
    // Nothing was loaded, saved or told.
    expect(h.changes).toEqual([]);
    expect(readFileSync(join(dataDir, "requests.json"), "utf8")).toBe(saved);
    expect(h.registry.get((JSON.parse(saved) as RequestRecord[])[0]?.id as string)).toBeUndefined();
  });

  it("says that drop/ is failing when the sweep leaves something it cannot remove, and starts all the same", async () => {
    const h = harness();
    const stuck = join(h.dropRoot, "si-secret-stuck");
    mkdirSync(stuck, { recursive: true, mode: 0o700 });
    writeFileSync(join(stuck, "KEY"), "x", { mode: 0o600 });
    chmodSync(stuck, 0o500);
    try {
      expect(await h.registry.load()).toBe(true);
      expect(h.registry.health()).toEqual({ persistence: "ok", drop: "failing", stored: "ok", dropped: 0 });
      expect(existsSync(join(stuck, "KEY"))).toBe(true);
    } finally {
      chmodSync(stuck, 0o700);
    }
  });

  it("sweeps once, when it is asked to or when it loads, and never a second time", async () => {
    const dataDir = tempDir();
    const dropRoot = join(dataDir, "drop");
    const leave = (name: string): string => {
      mkdirSync(join(dropRoot, name), { recursive: true, mode: 0o700 });
      writeFileSync(join(dropRoot, name, "KEY"), CANARY, { mode: 0o600 });
      return join(dropRoot, name);
    };
    const first = leave("si-secret-first");

    const { registry } = harness(dataDir);
    const swept = registry.sweep();
    expect(registry.sweep()).toBe(swept);
    await swept;
    expect(existsSync(first)).toBe(false);
    expect(registry.health().drop).toBe("ok");

    // What appears afterwards belongs to a delivery of this run: the load does not sweep again.
    const second = leave("si-secret-second");
    await registry.load();
    expect(existsSync(second)).toBe(true);

    // An instance that is only loaded sweeps as part of that.
    const next = harness(dataDir);
    await next.registry.load();
    expect(existsSync(second)).toBe(false);
  });

  it("reports a healthy start", async () => {
    const { registry } = harness();
    await registry.load();
    expect(registry.health()).toEqual({ persistence: "ok", drop: "ok", stored: "ok", dropped: 0 });
  });
});

describe("start-up, hostile state", () => {
  /** A record exactly as the registry wrote it, taken from a real run. */
  async function honest(dataDir = tempDir()): Promise<RequestRecord> {
    const donor = harness(dataDir);
    await donor.registry.create(agent(), asking);
    return stored(dataDir)[0] as RequestRecord;
  }
  const file = (dataDir: string) => join(dataDir, "requests.json");
  const INFINITY = "@@infinity@@";
  /** `1e999` is the one way a JSON text names a number that is not finite. */
  const write = (dataDir: string, records: unknown[]) =>
    writeFileSync(file(dataDir), JSON.stringify(records).replaceAll(`"${INFINITY}"`, "1e999"), { mode: 0o600 });
  const SOME_DIGEST = "c".repeat(64);
  /** What a delivered record holds besides a pending one's. */
  const deliveredParts = { state: "delivered", fulfilledDigest: SOME_DIGEST, written: ["API_KEY"], deleteBy: 1_700_000_900_000 };

  const refused: Array<[string, (record: RequestRecord) => unknown]> = [
    ["a state that does not exist", (record) => ({ ...record, state: "approved" })],
    // The states v1 had, on a record that is otherwise as a delivered one is.
    ...["written", "running", "succeeded", "failed", "outcome_unknown"].map(
      (state): [string, (record: RequestRecord) => unknown] => [`a state of v1: ${state}`, (record) => ({ ...record, ...deliveredParts, state })],
    ),
    ["a request that fails the schema", (record) => ({ ...record, request: { ...record.request, fields: [{ key: "not a key" }] } })],
    ["a request whose keys differ only in letter case", (record) => ({ ...record, request: { ...record.request, fields: [{ key: "API_KEY" }, { key: "api_key" }] } })],
    ["a format on a text field", (record) => ({ ...record, request: { ...record.request, fields: [{ key: "API_KEY", format: "pem" }] } })],
    ["an unknown property inside the request", (record) => ({ ...record, request: { ...record.request, extra: 1 } })],
    ["a destination, as v1 had", (record) => ({ ...record, request: { ...record.request, sink: { kind: "dotenv", path: ".env", dialect: "dotenv" } } })],
    ["an id of the wrong shape", (record) => ({ ...record, id: "../../escape" })],
    ["an id that is the right shape in the wrong case", (record) => ({ ...record, id: idOf(0xabc).toUpperCase().replace("R_", "r_") })],
    ["an unknown property on the record", (record) => ({ ...record, extra: 1 })],
    ["the digest of v1's destination", (record) => ({ ...record, sinkDigest: SOME_DIGEST })],
    ["v1's receipt", (record) => ({ ...record, receipt: null })],
    ["no digest of what was asked for", (record) => ({ ...record, requestDigest: undefined })],
    ["a digest of what was asked for that is not one", (record) => ({ ...record, requestDigest: "not-a-digest" })],
    ["an agent id that is empty", (record) => ({ ...record, agentId: "" })],
    ["a bidi control character in the agent id", (record) => ({ ...record, agentId: `agent${BIDI}` })],
    ["a bidi control character in the working directory", (record) => ({ ...record, agentCwd: `/tmp/work${BIDI}` })],
    ["a bidi control character in the title", (record) => ({ ...record, agentTitle: `Deploy ${BIDI}txt` })],
    ["a bidi control character in the reason", (record) => ({ ...record, request: { ...record.request, reason: `keys ${BIDI}txt` } })],
    ["a bidi control character in a label", (record) => ({ ...record, request: { ...record.request, fields: [{ key: "API_KEY", label: `Key ${BIDI}` }] } })],
    ["a number that is not finite", (record) => ({ ...record, createdAt: INFINITY })],
    ["a number that is not an integer", (record) => ({ ...record, updatedAt: 1.5 })],
    ["a creation time that is not an integer", (record) => ({ ...record, createdAt: 1.5 })],
    ["a time before the epoch", (record) => ({ ...record, updatedAt: -5 })],
    ["a flag that is no boolean", (record) => ({ ...record, tamper: "yes" })],
    ["a fulfilled digest that is not one", (record) => ({ ...record, ...deliveredParts, fulfilledDigest: "not-a-digest" })],
    ["an agent title beyond the cap", (record) => ({ ...record, agentTitle: "t".repeat(201) })],
    ["a working directory beyond the cap", (record) => ({ ...record, agentCwd: `/${"d".repeat(4096)}` })],
    ["a working directory with a NUL in it", (record) => ({ ...record, agentCwd: "/tmp/a\u0000b" })],
    ["a retry count beyond the limit", (record) => ({ ...record, retries: MAX_RETRIES + 1 })],
    ["a public key that is not one", (record) => ({ ...record, publicKey: "short" })],
    ["an error code that does not exist", (record) => ({ ...record, errorCode: "boom" })],
    ["an agent id of a megabyte", (record) => ({ ...record, agentId: "a".repeat(1024 * 1024) })],
    ["a working directory that is not absolute", (record) => ({ ...record, agentCwd: "relative/dir" })],
    ["a way of expiring that does not exist", (record) => ({ ...record, state: "expired", expiredBy: "boredom" })],
    ["a way of expiring on a request that is still open", (record) => ({ ...record, expiredBy: "restart" })],
    ["a way of expiring on a request that ended another way", (record) => ({ ...record, state: "declined", expiredBy: "time" })],
    // What a delivery leaves, and when it may be there.
    ["a delivered record with no fulfilled digest", (record) => ({ ...record, ...deliveredParts, fulfilledDigest: null })],
    ["a delivered record with no keys written", (record) => ({ ...record, ...deliveredParts, written: null })],
    ["a delivered record with an empty list of keys written", (record) => ({ ...record, ...deliveredParts, written: [] })],
    ["a delivered record with no deadline", (record) => ({ ...record, ...deliveredParts, deleteBy: null })],
    ["a released record with no deadline", (record) => ({ ...record, ...deliveredParts, state: "released", releasedBy: "agent", deleteBy: null })],
    ["a released record that does not say how", (record) => ({ ...record, ...deliveredParts, state: "released" })],
    ["a way of releasing that does not exist", (record) => ({ ...record, ...deliveredParts, state: "released", releasedBy: "magic" })],
    ["a way of releasing on a delivered record", (record) => ({ ...record, ...deliveredParts, releasedBy: "agent" })],
    ["a way of releasing on a request that ended another way", (record) => ({ ...record, state: "declined", releasedBy: "agent" })],
    ["keys written on a pending request", (record) => ({ ...record, written: ["API_KEY"] })],
    ["a deadline on a pending request", (record) => ({ ...record, deleteBy: 1_700_000_900_000 })],
    ["a fulfilled digest on a pending request", (record) => ({ ...record, fulfilledDigest: SOME_DIGEST })],
    ["keys written on a rejected request", (record) => ({ ...record, state: "rejected", errorCode: "write_failed", written: ["API_KEY"] })],
    ["a deadline on a declined request", (record) => ({ ...record, state: "declined", deleteBy: 1_700_000_900_000 })],
    ["a deadline that is not an integer", (record) => ({ ...record, ...deliveredParts, deleteBy: 1.5 })],
    ["a deadline before the epoch", (record) => ({ ...record, ...deliveredParts, deleteBy: -1 })],
    ["a key written that is no key", (record) => ({ ...record, ...deliveredParts, written: ["not a key"] })],
    ["a key written that is reserved", (record) => ({ ...record, ...deliveredParts, written: ["__proto__"] })],
    ["keys written that differ only in letter case", (record) => ({ ...record, ...deliveredParts, written: ["API_KEY", "api_key"] })],
    ["more keys written than a request may have", (record) => ({ ...record, ...deliveredParts, written: Array.from({ length: LIMITS.fields + 1 }, (_, index) => `K${index}`) })],
  ];

  it("loads the same records as written: the rows above are refused for what they change alone", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    write(dataDir, [
      good,
      { ...good, id: idOf(1), ...deliveredParts },
      { ...good, id: idOf(2), ...deliveredParts, state: "released", releasedBy: "turn" },
      { ...good, id: idOf(3), state: "rejected", errorCode: "write_failed" },
      { ...good, id: idOf(4), state: "expired", expiredBy: "time" },
    ]);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.health().dropped).toBe(0);
    expect(registry.get(good.id)?.state).toBe("expired");
    expect(registry.get(idOf(1))).toMatchObject({ state: "released", releasedBy: "restart", written: ["API_KEY"] });
    expect(registry.get(idOf(2))).toMatchObject({ state: "released", releasedBy: "turn" });
    expect(registry.get(idOf(3))).toMatchObject({ state: "rejected", errorCode: "write_failed" });
    expect(registry.get(idOf(4))).toMatchObject({ state: "expired", expiredBy: "time" });
  });

  it.each(refused)("drops a record with %s and loads the one that is fine", async (_name, damage) => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    const bad = damage({ ...good, id: idOf(1) }) as { id: string };
    write(dataDir, [good, bad]);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.get(good.id)?.state).toBe("expired");
    expect(registry.get(bad.id)).toBeUndefined();
    expect(stored(dataDir).map((record) => record.id)).toEqual([good.id]);
  });

  it("loads a record whose request carries nothing the schema fills in for itself", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    write(dataDir, [{ ...good, request: { fields: good.request.fields } }]);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.get(good.id)?.request).toEqual({ reason: "", fields: good.request.fields });
  });

  it("starts from nothing when requests.json is not JSON, and works afterwards", async () => {
    const dataDir = tempDir();
    writeFileSync(file(dataDir), "this is {not json", { mode: 0o600 });
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.health()).toMatchObject({ stored: "unreadable", dropped: 0 });
    const { requestId } = await registry.create(agent(), asking);
    expect(stored(dataDir).map((record) => record.id)).toEqual([requestId]);
    expect(registry.health().persistence).toBe("ok");
  });

  it("starts from nothing when requests.json is JSON but no list, and says so", async () => {
    const dataDir = tempDir();
    const text = JSON.stringify({ records: [await honest()] });
    writeFileSync(file(dataDir), text, { mode: 0o600 });
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.health()).toMatchObject({ stored: "unreadable" });
    // What could not be read is not replaced until something is saved.
    expect(readFileSync(file(dataDir), "utf8")).toBe(text);
  });

  it("does not erase a requests.json that cannot be read, and says so", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    const text = readFileSync(file(dataDir), "utf8");
    chmodSync(file(dataDir), 0o000);
    try {
      const { registry, changes } = harness(dataDir);
      await registry.load();
      expect(registry.health()).toEqual({ persistence: "ok", drop: "ok", stored: "unreadable", dropped: 0 });
      expect(registry.get(good.id)).toBeUndefined();
      expect(changes).toEqual([]);
    } finally {
      chmodSync(file(dataDir), 0o600);
    }
    expect(readFileSync(file(dataDir), "utf8")).toBe(text);
  });

  it("says how many entries of the file were not loaded", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    write(dataDir, [good, null, { ...good, id: "nonsense" }, { ...good, id: idOf(2), state: "approved" }, { ...good }]);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.health()).toMatchObject({ stored: "ok", dropped: 4 });
    expect(registry.get(good.id)?.state).toBe("expired");
  });

  it("does not read a requests.json over the cap, though every record in it is valid", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    writeFileSync(file(dataDir), JSON.stringify([good]) + " ".repeat(MAX_REQUESTS_BYTES), { mode: 0o600 });
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.get(good.id)).toBeUndefined();
    expect(registry.health().stored).toBe("unreadable");
  });

  it("reads a requests.json exactly at the cap", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    const text = JSON.stringify([good]);
    writeFileSync(file(dataDir), text + " ".repeat(MAX_REQUESTS_BYTES - Buffer.byteLength(text)), { mode: 0o600 });
    expect(lstatSync(file(dataDir)).size).toBe(MAX_REQUESTS_BYTES);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.get(good.id)?.state).toBe("expired");
  });

  it("does not follow a link in place of requests.json, and leaves what it points to alone", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    const elsewhere = join(tempDir(), "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify([good]), { mode: 0o600 });
    const replaced = join(dataDir, "requests.json");
    rmSync(replaced);
    symlinkSync(elsewhere, replaced);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.get(good.id)).toBeUndefined();
    expect(registry.health().stored).toBe("unreadable");
    expect(JSON.parse(readFileSync(elsewhere, "utf8"))).toEqual([good]);
    // The first thing saved replaces the link itself, never what it points to.
    await registry.create(agent(), asking);
    expect(lstatSync(replaced).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(elsewhere, "utf8"))).toEqual([good]);
  });

  it("starts when a directory stands where requests.json goes, and says it cannot save", async () => {
    const dataDir = tempDir();
    mkdirSync(file(dataDir));
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.health()).toEqual({ persistence: "ok", drop: "ok", stored: "unreadable", dropped: 0 });
    const { requestId } = await registry.create(agent(), asking);
    expect(registry.get(requestId)?.state).toBe("pending");
    expect(registry.health().persistence).toBe("failing");
  });

  it("does not wait on a pipe in place of requests.json", async () => {
    const dataDir = tempDir();
    execFileSync("mkfifo", [file(dataDir)]);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.health().stored).toBe("unreadable");
  });

  it("looks only at the last entries of a long list, so a hostile file cannot make start-up validate millions", async () => {
    const dataDir = tempDir();
    const good = await honest(dataDir);
    write(dataDir, [good, ...Array.from({ length: 2 * HISTORY }, () => null)]);
    const { registry } = harness(dataDir);
    await registry.load();
    expect(registry.get(good.id)).toBeUndefined();
    // The one the window left out, and the 2 * HISTORY it holds, none of which is a record.
    expect(registry.health()).toMatchObject({ stored: "ok", dropped: 2 * HISTORY + 1 });
  });
});

describe("saving state never decides an outcome", () => {
  it("keeps a delivered set delivered when requests.json cannot be saved, and tells a repeat from a forgery", async () => {
    const dataDir = tempDir();
    const h = harness(dataDir);
    const { requestId } = await h.registry.create(agent(), asking);
    const good = sealed(h.registry, requestId, [{ key: "API_KEY", value: CANARY }]);
    // drop/ is there before the data directory is locked: what is locked is where requests.json is saved.
    mkdirSync(h.dropRoot, { mode: 0o700 });

    await whileLocked(dataDir, async () => {
      expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
      expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe(CANARY);
      expect(h.registry.get(requestId)?.state).toBe("delivered");
      expect(h.changes.at(-1)).toMatchObject({ id: requestId, state: "delivered" });
      expect(h.registry.health().persistence).toBe("failing");

      expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
      expect(h.registry.get(requestId)?.tamper).toBe(false);

      const other = sealed(h.registry, requestId, [{ key: "API_KEY", value: "forged-value" }]);
      expect(await h.registry.fulfill(requestId, other)).toEqual({ ok: false, code: "request_closed", retryable: false });
      expect(h.registry.get(requestId)?.tamper).toBe(true);
      expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe(CANARY);
    });

    // The next commit saves everything, the earlier change included.
    expect(stored(dataDir)[0]).toMatchObject({ id: requestId, state: "pending" });
    await h.registry.create(agent("agent-2"), asking);
    expect(h.registry.health().persistence).toBe("ok");
    expect(stored(dataDir).find((record) => record.id === requestId)).toMatchObject({ state: "delivered", tamper: true });
  });

  it("leaves every result as it was when onChange throws", async () => {
    const onChange = vi.fn(() => {
      throw new Error("the timeline is down");
    });
    const h = harness(tempDir(), { onChange });
    const { requestId } = await h.registry.create(agent(), asking);
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    expect(h.registry.get(requestId)?.state).toBe("delivered");
    expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe(CANARY);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(h.registry.health().persistence).toBe("ok");
    const spare = await h.registry.create(agent("agent-2"), asking);
    expect((await h.registry.decline(spare.requestId)).state).toBe("declined");
  });

  it("leaves no rejection unhandled when onChange is async and fails", async () => {
    const watch = watchUnhandled();
    try {
      // Not a `vi.fn`: the mock watches the promise it returns, and a watched rejection is a handled one.
      let calls = 0;
      const h = harness(tempDir(), {
        onChange: async () => {
          calls += 1;
          throw new Error("the timeline is down");
        },
      });
      const { requestId } = await h.registry.create(agent(), asking);
      expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: "typed-v" }])).toEqual({ ok: true, state: "delivered" });
      await settle(50);
      expect(calls).toBe(2);
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it("tries a failed save again from expire, and from shutdown", async () => {
    for (const retry of ["expire", "shutdown"] as const) {
      const dataDir = tempDir();
      const { registry } = harness(dataDir);
      const { requestId } = await whileLocked(dataDir, async () => {
        const created = await registry.create(agent(), asking);
        expect(registry.health().persistence).toBe("failing");
        return created;
      });
      expect(existsSync(join(dataDir, "requests.json"))).toBe(false);
      await (retry === "expire" ? registry.expire() : registry.shutdown());
      expect(registry.health().persistence).toBe("ok");
      expect(stored(dataDir).map((record) => record.id)).toEqual([requestId]);
    }
  });
});

describe("memory and keys", () => {
  const BASE = 1_700_000_000_000;

  it("drops the oldest closed requests from memory and from the file, and never an open one", async () => {
    const dataDir = tempDir();
    await seedClosed(dataDir, HISTORY, BASE - 1_000_000);
    const h = harness(dataDir);
    await h.registry.load();
    expect(stored(dataDir)).toHaveLength(HISTORY);

    h.clock.now = BASE - 2_000_000;
    const open = await h.registry.create(agent("open"), asking);
    h.clock.now = BASE;
    const newer: string[] = [];
    for (const name of ["b", "c", "d"]) {
      const created = await h.registry.create(agent(name), asking);
      await h.registry.decline(created.requestId);
      newer.push(created.requestId);
    }

    for (const gone of [1, 2, 3]) expect(h.registry.get(idOf(gone))).toBeUndefined();
    expect(h.registry.get(idOf(4))).toBeDefined();
    for (const id of newer) expect(h.registry.get(id)?.state).toBe("declined");
    expect(h.registry.get(open.requestId)?.state).toBe("pending");
    const ids = stored(dataDir).map((record) => record.id);
    expect(ids).toHaveLength(HISTORY + 1);
    expect(ids).toContain(open.requestId);
    expect(ids).not.toContain(idOf(1));
    expect(ids).not.toContain(idOf(3));
  });

  it("keeps a delivered request as it keeps an open one: in memory and in the file, however many close after it", async () => {
    const dataDir = tempDir();
    await seedClosed(dataDir, HISTORY, BASE - 1_000_000);
    const h = harness(dataDir);
    await h.registry.load();
    h.clock.now = BASE - 2_000_000;
    const delivered = await deliverOne(h, "delivered");
    h.clock.now = BASE;
    for (const name of ["b", "c", "d"]) await h.registry.decline((await h.registry.create(agent(name), asking)).requestId);
    expect(h.registry.get(delivered)?.state).toBe("delivered");
    expect(stored(dataDir).map((record) => record.id)).toContain(delivered);
    expect(h.forgotten).not.toContain(delivered);
  });

  it("loads at most HISTORY records from a file that holds more", async () => {
    const dataDir = tempDir();
    await seedClosed(dataDir, HISTORY + 20, BASE - 1_000_000);
    const h = harness(dataDir);
    await h.registry.load();
    expect(h.registry.get(idOf(20))).toBeUndefined();
    expect(h.registry.get(idOf(21))?.state).toBe("declined");
    expect(stored(dataDir)).toHaveLength(HISTORY);
  });

  it("keeps a request that is delivered after more than HISTORY newer ones were closed, and answers its repeat", async () => {
    const dataDir = tempDir();
    await seedClosed(dataDir, HISTORY, BASE - 1_000_000);
    const h = harness(dataDir);
    await h.registry.load();
    h.clock.now = BASE - 2_000_000;
    const { requestId } = await h.registry.create(agent(), asking);
    h.clock.now = BASE;
    const envelope = sealed(h.registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);

    expect(await h.registry.fulfill(requestId, envelope)).toEqual({ ok: true, state: "delivered" });
    expect(h.registry.get(requestId)?.state).toBe("delivered");
    expect(await h.registry.fulfill(requestId, envelope)).toEqual({ ok: true, state: "delivered" });
    expect(stored(dataDir).map((record) => record.id)).toContain(requestId);
  });

  it("reports a request that was open at the restart, and keeps it, though it is older than every other record", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const { requestId } = await donor.registry.create(agent(), asking);
    const open = stored(dataDir)[0] as RequestRecord;
    const records = [
      { ...open, createdAt: BASE - 5_000_000, updatedAt: BASE - 5_000_000 },
      ...Array.from({ length: HISTORY }, (_, index) => ({
        ...open,
        id: idOf(index + 1),
        state: "declined",
        createdAt: BASE - 1_000_000 + index,
        updatedAt: BASE - 1_000_000 + index,
      })),
    ];
    writeFileSync(join(dataDir, "requests.json"), JSON.stringify(records), { mode: 0o600 });
    const h = harness(dataDir);
    await h.registry.load();
    expect(h.registry.get(requestId)?.state).toBe("expired");
    expect(h.registry.get(idOf(1))).toBeUndefined();
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]).toMatchObject({ id: requestId, state: "expired" });
  });

  it("answers a submission to a pending request with request_closed after shutdown, and holds no key", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create(agent(), asking);
    const envelope = sealed(registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);
    const held = [...keysOf(registry).values()];
    expect(held).toHaveLength(1);
    expect((held[0] as Uint8Array).some((byte) => byte !== 0)).toBe(true);

    await registry.shutdown();
    expect(keysOf(registry).size).toBe(0);
    expect((held[0] as Uint8Array).every((byte) => byte === 0)).toBe(true);
    expect(await registry.fulfill(requestId, envelope)).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(registry.get(requestId)?.state).toBe("pending");
  });

  it("opens no new request after shutdown, because its key would outlive it", async () => {
    const { registry } = harness();
    await registry.shutdown();
    expect(await codeOfAsync(registry.create(agent(), asking))).toBe("service_unavailable");
    expect(keysOf(registry).size).toBe(0);
  });

  it("hands out copies, so what a caller does to them changes nothing", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create(agent(), asking);
    const got = registry.get(requestId) as RequestRecord;
    got.state = "delivered";
    got.tamper = true;
    got.request.reason = "changed";
    got.request.fields.push({ key: "INJECTED" });
    const declined = await registry.decline(requestId);
    declined.state = "pending";
    declined.request.fields.length = 0;

    expect(registry.get(requestId)).toMatchObject({
      state: "declined",
      tamper: false,
      request: { reason: asking.reason, fields: [{ key: "API_KEY" }, { key: "PEM", optional: true }] },
    });
  });
});

describe("concurrent submissions", () => {
  it("writes once when two different valid submissions arrive together, and flags the second", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const first = sealed(h.registry, requestId, [{ key: "API_KEY", value: "first-typed" }]);
    const second = sealed(h.registry, requestId, [{ key: "API_KEY", value: "second-typed" }]);

    const results = await Promise.all([h.registry.fulfill(requestId, first), h.registry.fulfill(requestId, second)]);
    expect(results[0]).toEqual({ ok: true, state: "delivered" });
    expect(results[1]).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(h.registry.get(requestId)?.tamper).toBe(true);
    expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe("first-typed");
  });
});

describe("shutdown", () => {
  const savedState = (dataDir: string, id: string) => stored(dataDir).find((record) => record.id === id);

  it("releases every delivered set as stop in one save, then empties drop/", async () => {
    // At each notice of a release, what the file says of the sets: one save for all of them comes before the first.
    const dataDir = tempDir();
    const savedReleases: number[] = [];
    const h = harness(dataDir, {
      onChange: (record) => {
        if (record.state === "released") savedReleases.push(stored(dataDir).filter((saved) => saved.state === "released").length);
      },
    });
    const ids = [await deliverOne(h, "agent-a"), await deliverOne(h, "agent-b"), await deliverOne(h, "agent-c")];
    const open = (await h.registry.create(agent("agent-d"), asking)).requestId;
    // What a write that was killed half-way could leave.
    mkdirSync(join(h.dropRoot, `si-secret-${idOf(9)}.0123456789abcdef.tmp`));
    // The sweep comes after the releases and their save.
    let atSweep: string[] = [];
    h.drop.onSweep = () => void (atSweep = stored(dataDir).filter((saved) => ids.includes(saved.id)).map((saved) => `${saved.state} ${saved.releasedBy}`));
    const saves = vi.spyOn(h.registry as unknown as { persist: () => Promise<void> }, "persist");
    await h.registry.shutdown();
    expect(saves).toHaveBeenCalledTimes(1);
    for (const id of ids) {
      expect(h.registry.get(id)).toMatchObject({ state: "released", releasedBy: "stop" });
      expect(savedState(h.dataDir, id)).toMatchObject({ state: "released", releasedBy: "stop" });
    }
    expect(savedReleases).toEqual([3, 3, 3]);
    expect(atSweep).toEqual(["released stop", "released stop", "released stop"]);
    expect(h.registry.get(open)?.state).toBe("pending");
    expect(readdirSync(h.dropRoot)).toEqual([]);
    expect(h.told.filter((line) => line.startsWith("released")).sort()).toEqual(ids.map((id) => `released ${id}`).sort());
    expect(h.registry.health()).toMatchObject({ persistence: "ok", drop: "ok" });
  });

  it("says agent of a set that was deleted before the stop came to it", async () => {
    const h = harness();
    const requestId = await deliverOne(h);
    rmSync(setPath(h.dropRoot, requestId), { recursive: true });
    await h.registry.shutdown();
    expect(h.registry.get(requestId)).toMatchObject({ state: "released", releasedBy: "agent" });
  });

  it("takes a set the stop's own sweep removed for the stop's doing, when its release was under way as the sweep began", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 50 });
    const first = await deliverOne(h, "agent-a");
    const second = await deliverOne(h, "agent-b");
    // The release of the first set is held where it begins, past the queue's bound: the sweep begins meanwhile and takes
    // both sets. When the release goes on, its set is not there.
    const held = gate();
    let reached = false;
    h.drop.onRelease = () => {
      reached = true;
      return held.held;
    };
    const shutdown = h.registry.shutdown();
    try {
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });
      await vi.waitFor(() => expect(readdirSync(h.dropRoot)).toEqual([]), { timeout: 5000 });
    } finally {
      held.open();
    }
    await shutdown;
    await vi.waitFor(() => expect(h.registry.get(first)?.state).toBe("released"), { timeout: 5000 });
    // Gone, but by the stop: not the agent's doing. The releases end there, and the second is left as it was.
    expect(h.registry.get(first)).toMatchObject({ state: "released", releasedBy: "stop" });
    expect(h.registry.get(second)?.state).toBe("delivered");
  });

  it("keeps a set it cannot remove delivered, and says that drop/ is failing", async () => {
    const h = harness();
    const requestId = await deliverOne(h);
    const set = setPath(h.dropRoot, requestId);
    chmodSync(set, 0o500);
    try {
      await h.registry.shutdown();
      expect(h.registry.get(requestId)?.state).toBe("delivered");
      expect(h.registry.health().drop).toBe("failing");
      expect(existsSync(join(set, "API_KEY"))).toBe(true);
    } finally {
      chmodSync(set, 0o700);
    }
  });

  it("sweeps drop/ within its bound even when the queue never ends", async () => {
    const h = harness(tempDir(), { shutdownBoundMs: 50 });
    const first = await deliverOne(h, "agent-a");
    const stuck = gate();
    try {
      // B's write is held where it begins: B sits in the queue, and everything behind it, the releases of the stop too.
      const b = (await h.registry.create(agent("agent-b"), asking)).requestId;
      let reached = false;
      h.drop.onWrite = () => {
        reached = true;
        return stuck.held;
      };
      const fulfilled = h.registry.fulfill(b, sealed(h.registry, b, [{ key: "API_KEY", value: `${CANARY}-b` }]));
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });

      expect(await promptlyOrHung(h.registry.shutdown(), 5000)).toBe("ended");
      // The release never had its turn, and the sweep went through drop/ all the same.
      expect(readdirSync(h.dropRoot)).toEqual([]);
      expect(h.registry.get(first)?.state).toBe("delivered");

      // B is let go long after: it is turned back before anything is written, and stays as it was.
      stuck.open();
      expect(await fulfilled).toEqual({ ok: false, code: "request_closed", retryable: false });
      expect(readdirSync(h.dropRoot)).toEqual([]);
      expect(h.registry.get(b)).toMatchObject({ state: "pending", written: null });
    } finally {
      stuck.open();
    }
  });

  it("gives the sweep half a second at most, and a sweep that comes to its turn after it removes nothing", async () => {
    expect(DROP_SWEEP_BOUND_MS).toBe(500);
    const h = harness();
    mkdirSync(join(h.dropRoot, "si-secret-late"), { recursive: true, mode: 0o700 });
    const stuck = gate();
    h.drop.onSweep = () => stuck.held;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let ended = false;
    let shutdown: Promise<void>;
    try {
      shutdown = h.registry.shutdown().then(() => {
        ended = true;
      });
      await vi.advanceTimersByTimeAsync(DROP_SWEEP_BOUND_MS - 1);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // The sweep comes to its turn long after: by then drop/ may be another plugin's, and nothing is removed.
    stuck.open();
    await settle(50);
    expect(readdirSync(h.dropRoot)).toEqual(["si-secret-late"]);
  });

  it("is turned back before it takes effect when shutdown began while the set was being written, and the request stays pending", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), withFile);
    let shutdown: Promise<void> | undefined;
    // Begun, and not waited for: the write goes on while the shutdown waits for it in the queue.
    h.drop.onWrite = () => void (shutdown ??= h.registry.shutdown());
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }, { key: "P12", file: toBase64Url(BINARY) }])).toEqual({
      ok: false,
      code: "request_closed",
      retryable: false,
    });
    expect(shutdown).toBeDefined();
    await shutdown;
    expect(h.registry.get(requestId)).toMatchObject({ state: "pending", retries: 0, fulfilledDigest: null, written: null, deleteBy: null });
    expect(savedState(h.dataDir, requestId)?.state).toBe("pending");
    expect(h.told).toEqual([`pending ${requestId}`]);
    expect(readdirSync(h.dropRoot)).toEqual([]);
    // What it was handed was wiped all the same.
    for (const file of h.drop.handed[0] ?? []) expect(file.bytes.every((byte) => byte === 0)).toBe(true);

    // The successor reads it back as expired by the restart: nothing was delivered.
    const next = harness(h.dataDir);
    await next.registry.load();
    expect(next.registry.get(requestId)).toMatchObject({ state: "expired", expiredBy: "restart" });
  });

  it("takes effect when nothing is shutting down: the place the test acts in changes nothing by itself", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    let reached = 0;
    h.drop.onWrite = () => void (reached += 1);
    expect(await submit(h.registry, requestId, [{ key: "API_KEY", value: CANARY }])).toEqual({ ok: true, state: "delivered" });
    expect(reached).toBe(1);
    expect(contentOf(h, requestId, "API_KEY").toString("utf8")).toBe(CANARY);
  });

  it("wipes every key at once, though a write stuck in the queue never ends, and returns within its bound", async () => {
    const BOUND = 300;
    const h = harness(tempDir(), { shutdownBoundMs: BOUND });
    const stuck = gate();
    try {
      const open = (await h.registry.create(agent("open"), asking)).requestId;
      const b = (await h.registry.create(agent("b"), asking)).requestId;
      const envelope = sealed(h.registry, b, [{ key: "API_KEY", value: CANARY }]);
      const held = [...keysOf(h.registry).values()];
      expect(held).toHaveLength(2);

      // B's write is stuck where it begins: it sits in the queue, and everything else behind it.
      let reached = false;
      h.drop.onWrite = () => {
        reached = true;
        return stuck.held;
      };
      const fulfilled = h.registry.fulfill(b, envelope);
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });

      // The bound is a timer of the registry's, and the test moves it: no clock is read.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let ended = false;
        const shutdown = h.registry.shutdown().then(() => {
          ended = true;
        });
        // At once, before the queue has moved and before B is let go:
        expect(keysOf(h.registry).size).toBe(0);
        for (const key of held) expect(key.every((byte) => byte === 0)).toBe(true);

        // With B still stuck, the bound is what ends the wait for the queue: not a millisecond before it.
        await vi.advanceTimersByTimeAsync(BOUND - 1);
        expect(ended).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(DROP_SWEEP_BOUND_MS);
        await shutdown;
      } finally {
        vi.useRealTimers();
      }

      // B is let go long after: it finds the registry stopped, and is turned back before anything is written.
      stuck.open();
      expect(await fulfilled).toEqual({ ok: false, code: "request_closed", retryable: false });
      expect(existsSync(setPath(h.dropRoot, b))).toBe(false);
      expect(keysOf(h.registry).size).toBe(0);
      expect(h.registry.get(b)).toMatchObject({ state: "pending", retries: 0, fulfilledDigest: null });
      expect(h.registry.get(open)?.state).toBe("pending");
      expect(savedState(h.dataDir, b)?.state).toBe("pending");
    } finally {
      stuck.open();
      await h.registry.shutdown();
    }
  });

  it("tells nobody of a change whose save was still under way when shutdown ended", async () => {
    const dataDir = tempDir();
    const h = harness(dataDir, { shutdownBoundMs: 50 });
    const { requestId } = await h.registry.create(agent(), asking);
    const turns = async (count: number): Promise<void> => {
      for (let turn = 0; turn < count; turn++) await Promise.resolve();
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let declining: Promise<RequestRecord>;
    try {
      declining = h.registry.decline(requestId);
      // Only promises are waited for here, never the disk: the decline has changed the record and its save is out.
      await turns(20);
      expect(h.registry.get(requestId)?.state).toBe("declined");
      expect(stored(dataDir)[0]?.state).toBe("pending");
      let ended = false;
      void h.registry.shutdown().then(() => {
        ended = true;
      });
      // The wait for the queue passes its bound with that save still under way; then the sweep, which waits for the
      // disk as well, passes its own. Neither clock is moved by the disk, and the disk is not given a turn meanwhile.
      vi.advanceTimersByTime(50);
      await turns(50);
      vi.advanceTimersByTime(DROP_SWEEP_BOUND_MS);
      await turns(50);
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect((await declining).state).toBe("declined");
    // The save had begun and landed. Telling of it would be the act of an instance that is done: nobody was told.
    expect(stored(dataDir)[0]?.state).toBe("declined");
    expect(h.changes.map((record) => record.state)).toEqual(["pending"]);
  });

  it("empties drop/ within the two seconds Paseo gives a stop though a task in the queue never ends, and calls no set the agent's doing for it", async () => {
    // The default bounds: the queue is waited for one second, and the sweep has half a second after that, so the stop
    // has swept drop/ before Paseo's SIGTERM, with room for the rest of the plugin's stop (`DISPOSE_BOUND_MS`).
    expect(SHUTDOWN_BOUND_MS).toBe(1000);
    expect(SHUTDOWN_BOUND_MS + DROP_SWEEP_BOUND_MS).toBeLessThan(PASEO_STOP_WINDOW_MS);
    const h = harness(); // no bound of the test's own
    const first = await deliverOne(h, "agent-a");
    // Its message was handed over and its agent's turn began: the end of that turn would take the set.
    h.registry.messageSent(first);
    h.registry.turnStarted("agent-a");
    const stuck = gate();
    try {
      // B's write is held where it begins: B sits in the queue, and everything behind it.
      const b = (await h.registry.create(agent("agent-b"), asking)).requestId;
      const envelope = sealed(h.registry, b, [{ key: "API_KEY", value: `${CANARY}-b` }]);
      let reached = false;
      h.drop.onWrite = () => {
        reached = true;
        return stuck.held;
      };
      const fulfilled = h.registry.fulfill(b, envelope);
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 5000 });
      // Behind B, asked before the stop: a look at the request, a tick, and the end of the turn. Each of them would call a
      // set that is gone the agent's doing.
      const behind = [h.registry.check(first), h.registry.expire(), h.registry.turnEnded("agent-a")];
      const sweeps = vi.spyOn(h.drop, "sweep");

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let shutdown: Promise<void>;
      try {
        shutdown = h.registry.shutdown();
        // The queue has its whole bound, and not a millisecond more.
        await vi.advanceTimersByTimeAsync(SHUTDOWN_BOUND_MS - 1);
        expect(sweeps).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(sweeps).toHaveBeenCalledTimes(1);
      } finally {
        // The sweep works on the real disk; its own bound is the test's to keep from passing.
        vi.useRealTimers();
      }
      await shutdown;
      expect(readdirSync(h.dropRoot)).toEqual([]);
      // The release never had its turn: the record is as the queue left it, and the next start reads it back.
      expect(h.registry.get(first)?.state).toBe("delivered");

      // B is let go long after, and with it what waited behind it, the stop's own releases last: none of it calls the
      // set the agent's doing, though the set is not there.
      stuck.open();
      expect(await fulfilled).toEqual({ ok: false, code: "request_closed", retryable: false });
      expect((await Promise.all(behind))[0]).toMatchObject({ id: first, state: "delivered" });
      expect(h.registry.get(first)?.state).toBe("delivered");
      expect(h.registry.get(b)).toMatchObject({ state: "pending", written: null });
      expect(savedState(h.dataDir, first)?.state).toBe("delivered");
      expect(h.told.filter((line) => line.startsWith("released"))).toEqual([]);

      const next = harness(h.dataDir);
      await next.registry.load();
      expect(next.registry.get(first)).toMatchObject({ state: "released", releasedBy: "restart" });
    } finally {
      stuck.open();
    }
  });

  it("does its work once, however often it is called", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const held = [...keysOf(h.registry).values()];
    const sweeps = vi.spyOn(h.drop, "sweep");
    const first = h.registry.shutdown();
    expect(h.registry.shutdown()).toBe(first);
    await first;
    await h.registry.shutdown();
    expect(keysOf(h.registry).size).toBe(0);
    for (const key of held) expect(key.every((byte) => byte === 0)).toBe(true);
    expect(h.registry.get(requestId)?.state).toBe("pending");
    expect(sweeps).toHaveBeenCalledTimes(1);
  });
});

/** "ended" when the promise settles within `milliseconds`, "hung" when it does not. */
async function promptlyOrHung(promise: Promise<unknown>, milliseconds: number): Promise<"ended" | "hung"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => "ended" as const),
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("start-up, times and duplicates", () => {
  const FAR = Number.MAX_SAFE_INTEGER - 1000;
  const write = (dataDir: string, records: unknown[]) => writeFileSync(join(dataDir, "requests.json"), JSON.stringify(records), { mode: 0o600 });

  it("is not kept from recording new requests by 200 forged closed records dated far in the future", async () => {
    const dataDir = tempDir();
    await seedClosed(dataDir, HISTORY, FAR);
    const h = harness(dataDir);
    await h.registry.load();
    h.clock.now += 1000;

    const { requestId } = await h.registry.create(agent("delivered"), asking);
    const good = sealed(h.registry, requestId, [{ key: "API_KEY", value: CANARY }]);
    expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
    expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
    const other = sealed(h.registry, requestId, [{ key: "API_KEY", value: "other-typed" }]);
    expect(await h.registry.fulfill(requestId, other)).toEqual({ ok: false, code: "request_closed", retryable: false });
    expect(h.registry.get(requestId)?.tamper).toBe(true);

    // A delivered request is open, and leaves the history no room to make: one that closes does.
    await h.registry.decline((await h.registry.create(agent("declined"), asking)).requestId);
    expect(h.registry.health().persistence).toBe("ok");
    // The forged ones are what leaves: the oldest, now that their dates are the present.
    expect(h.registry.get(idOf(1))).toBeUndefined();
  });

  it("still expires, and reports, an open record dated in the future", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const { requestId } = await donor.registry.create(agent(), asking);
    const open = stored(dataDir)[0] as RequestRecord;
    write(dataDir, [{ ...open, createdAt: FAR, updatedAt: FAR }]);
    const h = harness(dataDir);
    await h.registry.load();
    expect(h.registry.get(requestId)).toMatchObject({ state: "expired", createdAt: h.clock.now, updatedAt: h.clock.now });
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]).toMatchObject({ id: requestId, state: "expired" });
  });

  it("keeps the first of two records with one id, and reports only that one", async () => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const { requestId } = await donor.registry.create(agent(), asking);
    const open = stored(dataDir)[0] as RequestRecord;
    write(dataDir, [{ ...open, agentTitle: "First" }, { ...open, agentTitle: "Second" }]);
    const h = harness(dataDir);
    await h.registry.load();
    expect(h.registry.get(requestId)?.agentTitle).toBe("First");
    expect(h.changes.map((record) => record.agentTitle)).toEqual(["First"]);
    expect(h.registry.health().dropped).toBe(1);
  });

  /**
   * The cost that matters: every entry of a list of empty objects is an issue to build and then to throw away (half a second
   * for a file of 2 MiB). It is proved by what the schema is given, not by how long the load takes: the record with the huge
   * list is set aside before the schema sees it, so the schema is asked about the good record and not about that one.
   */
  const hugeLists: Array<[string, (record: RequestRecord, list: string) => unknown]> = [
    ["fields", (record, list) => ({ ...record, request: { ...record.request, fields: list } })],
    ["the keys written", (record, list) => ({ ...record, state: "delivered", fulfilledDigest: "c".repeat(64), deleteBy: 1, written: list })],
  ];

  it.each(hugeLists)("sets aside a record with millions of entries in %s without checking each one", async (_name, build) => {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    await donor.registry.create(agent(), asking);
    const good = stored(dataDir)[0] as RequestRecord;
    const entries = Math.floor((MAX_REQUESTS_BYTES - 4 * JSON.stringify(good).length) / 3);
    const list = `[${"{},".repeat(entries - 1)}{}]`;
    const text = JSON.stringify([good, build({ ...good, id: idOf(1) }, "@@LIST@@")]).replace('"@@LIST@@"', list);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_REQUESTS_BYTES);
    writeFileSync(join(dataDir, "requests.json"), text, { mode: 0o600 });

    const h = harness(dataDir);
    const schema = vi.spyOn(RecordSchema, "safeParse");
    let asked: unknown[];
    try {
      await h.registry.load();
      // Read before the spy is restored: restoring clears what it recorded.
      asked = schema.mock.calls.map(([candidate]) => (candidate as { id?: unknown }).id);
    } finally {
      schema.mockRestore();
    }
    expect(asked, "the spy sees the schema at work").toContain(good.id);
    expect(asked, "the schema is not run for the record with the huge list").not.toContain(idOf(1));
    expect(h.registry.get(good.id)?.state).toBe("expired");
    expect(h.registry.get(idOf(1))).toBeUndefined();
    expect(h.registry.health()).toMatchObject({ stored: "ok", dropped: 1 });
  });
});

describe("saved state fits the cap the reader holds it to", () => {
  /** One typical record saved, and how many bytes the file takes for `count` of them. */
  async function fileSizeFor(count: number): Promise<number> {
    const h = harness();
    const who = agent();
    for (let index = 0; index < count; index++) {
      h.clock.now += 1000;
      await h.registry.decline((await h.registry.create(who, asking)).requestId);
    }
    return statSync(join(h.dataDir, "requests.json")).size;
  }

  it("leaves the oldest closed records out until the rest fits, at the byte", async () => {
    const three = await fileSizeFor(3);
    for (const [limit, kept] of [[three, 3], [three - 1, 2]] as const) {
      const h = harness(tempDir(), { maxStoredBytes: limit });
      const who = agent();
      const ids: string[] = [];
      for (let index = 0; index < 5; index++) {
        h.clock.now += 1000;
        const { requestId } = await h.registry.create(who, asking);
        await h.registry.decline(requestId);
        ids.push(requestId);
      }
      const size = statSync(join(h.dataDir, "requests.json")).size;
      expect(size).toBeLessThanOrEqual(limit);
      expect(stored(h.dataDir).map((record) => record.id)).toEqual(ids.slice(-kept));
      expect(ids.slice(0, -kept).map((id) => h.registry.get(id))).toEqual(Array(5 - kept).fill(undefined));
      expect(h.registry.health().persistence).toBe("ok");

      const restarted = harness(h.dataDir, { maxStoredBytes: limit });
      await restarted.registry.load();
      expect(restarted.registry.health()).toMatchObject({ stored: "ok", dropped: 0 });
      expect(ids.slice(-kept).map((id) => restarted.registry.get(id)?.state)).toEqual(Array(kept).fill("declined"));
    }
  });

  it("keeps every open record, and says it cannot save, when they alone do not fit", async () => {
    const one = await fileSizeFor(1);
    const h = harness(tempDir(), { maxStoredBytes: Math.floor(one * 2.5) });
    const first = (await h.registry.create(agent("a"), asking)).requestId;
    const second = (await h.registry.create(agent("b"), asking)).requestId;
    expect(h.registry.health().persistence).toBe("ok");
    const third = (await h.registry.create(agent("c"), asking)).requestId;
    expect(h.registry.health().persistence).toBe("failing");
    expect([first, second, third].map((id) => h.registry.get(id)?.state)).toEqual(["pending", "pending", "pending"]);
    expect(statSync(join(h.dataDir, "requests.json")).size).toBeLessThanOrEqual(Math.floor(one * 2.5));
    expect(stored(h.dataDir).map((record) => record.id)).toEqual([first, second]);

    await h.registry.decline(third);
    expect(h.registry.health().persistence).toBe("ok");
    expect(stored(h.dataDir).map((record) => record.id)).toEqual([first, second]);
    expect(h.registry.get(third)).toBeUndefined();
  });
});

describe("what fulfill takes", () => {
  it("answers invalid_request, and touches nothing, for an argument that is not what it should be", async () => {
    const h = harness();
    const { requestId } = await h.registry.create(agent(), asking);
    const good = sealed(h.registry, requestId, [{ key: "API_KEY", value: "typed-v" }]);
    const before = h.changes.length;
    const call = (id: unknown, envelope: unknown) => (h.registry.fulfill as (...args: unknown[]) => Promise<FulfillResult>)(id, envelope);
    const refused = { ok: false, code: "invalid_request", retryable: false };

    expect(await call(requestId, null)).toEqual(refused);
    expect(await call(requestId, undefined)).toEqual(refused);
    expect(await call(requestId, "envelope")).toEqual(refused);
    expect(await call(requestId, { ...good, ct: 5 })).toEqual(refused);
    expect(await call(requestId, { ...good, epk: undefined })).toEqual(refused);
    expect(await call(requestId, { ...good, nonce: [] })).toEqual(refused);
    expect(await call(requestId, { ...good, v: "1" })).toEqual(refused);
    expect(await call(42, good)).toEqual(refused);
    expect(h.registry.get(requestId)).toMatchObject({ state: "pending", retries: 0 });
    expect(h.changes.length).toBe(before);
    expect(await h.registry.fulfill(requestId, good)).toEqual({ ok: true, state: "delivered" });
  });
});

describe("after shutdown", () => {
  it("does not try a failed save again, for a file a successor may be holding", async () => {
    const dataDir = tempDir();
    const { registry } = harness(dataDir);
    await whileLocked(dataDir, async () => {
      await registry.create(agent(), asking);
      // Shutdown tries once more; the directory is still locked.
      await registry.shutdown();
    });
    expect(registry.health().persistence).toBe("failing");
    await registry.expire();
    expect(existsSync(join(dataDir, "requests.json"))).toBe(false);
  });

  it("neither saves nor notifies, so a successor's file is not overwritten", async () => {
    const h = harness();
    const open = (await h.registry.create(agent("open"), asking)).requestId;

    await h.registry.shutdown();

    // The next instance starts on the file, expires what was open and saves that.
    const successor = harness(h.dataDir);
    await successor.registry.load();
    const saved = readFileSync(join(h.dataDir, "requests.json"), "utf8");
    expect(stored(h.dataDir).find((record) => record.id === open)?.state).toBe("expired");

    const told = h.changes.length;
    expect((await h.registry.decline(open)).state).toBe("declined");
    expect(h.registry.get(open)?.state).toBe("declined");
    expect(h.changes.length).toBe(told);
    expect(readFileSync(join(h.dataDir, "requests.json"), "utf8")).toBe(saved);
  });
});

// The sweep and the load are steps of the plugin's start-up. A start-up that hangs is waited for and then left, and the
// plugin marks its registry stopped at that moment; the step can still come back, long after, when another plugin has
// been started on the same directory. What that plugin has there then (a set it delivered, its saved requests) must be
// as the old instance's step finds it.
describe("a registry that was stopped: what its sweep and its load still do", () => {
  /** A data directory as a plugin that is working leaves it: a request that is open, and a set that was delivered. */
  async function world(act: { onSweep?: (registry: Registry) => void; onStoredRead?: (registry: Registry) => void } = {}) {
    const dataDir = tempDir();
    const donor = harness(dataDir);
    const { requestId } = await donor.registry.create(agent(), asking);
    const delivered = join(dataDir, "drop", `si-secret-${idOf(7)}`);
    mkdirSync(delivered, { recursive: true, mode: 0o700 });
    writeFileSync(join(delivered, "API_KEY"), CANARY, { mode: 0o600 });
    const saved = readFileSync(join(dataDir, "requests.json"), "utf8");

    const changes: RequestRecord[] = [];
    const drop = new GatedDrop(join(dataDir, "drop"));
    const registry: Registry = new Registry({
      dataDir,
      drop,
      onChange: (record) => void changes.push(record),
      now: () => 1_700_000_000_000,
      get maxStoredBytes() {
        act.onStoredRead?.(registry);
        return undefined;
      },
    });
    drop.onSweep = () => act.onSweep?.(registry);
    /** What is on disk, in one look: the delivered set and the saved requests. */
    const disk = () => ({
      delivered: existsSync(join(delivered, "API_KEY")),
      requests: readFileSync(join(dataDir, "requests.json"), "utf8") === saved ? "as saved" : readFileSync(join(dataDir, "requests.json"), "utf8"),
    });
    return { dataDir, registry, changes, requestId, disk };
  }
  const UNTOUCHED = { delivered: true, requests: "as saved" };

  it("sweeps nothing once it is stopped, and does not as much as hold drop/", async () => {
    let asked = 0;
    const w = await world({ onSweep: () => void (asked += 1) });
    const hold = vi.spyOn(DropStore.prototype, "hold");
    w.registry.stop();
    await w.registry.sweep();
    expect(w.disk()).toEqual(UNTOUCHED);
    // A sweep that gets its turn after the stop does not begin: drop/ may be the next plugin's by then.
    expect(asked).toBe(0);
    expect(hold).not.toHaveBeenCalled();
    hold.mockRestore();
    expect(w.registry.health().drop).toBe("ok");
  });

  it("removes nothing when it is stopped while the sweep is under way", async () => {
    // Stopped where the sweep begins: it is past the look at whether it may begin.
    const w = await world({ onSweep: (registry) => registry.stop() });
    await w.registry.sweep();
    expect(w.disk()).toEqual(UNTOUCHED);
  });

  it("loads nothing once it is stopped: no request is kept, saved or told of, and it says that it did not load", async () => {
    const w = await world();
    w.registry.stop();
    expect(await w.registry.load()).toBe(false);
    expect(w.registry.get(w.requestId)).toBeUndefined();
    expect(w.changes).toEqual([]);
    expect(w.disk()).toEqual(UNTOUCHED);
  });

  it("loads nothing when it is stopped while the load reads the requests: what it read is neither kept, saved nor told of", async () => {
    // Stopped where the load reads how much of the file it may read, which is as it begins to read it.
    let reads = 0;
    const w = await world({ onStoredRead: (registry) => void ((reads += 1) === 1 && registry.stop()) });
    // The sweep is done first and in full, as by a start-up that got that far before the plugin was stopped.
    await w.registry.sweep();
    expect(w.disk()).toEqual({ delivered: false, requests: "as saved" });
    expect(await w.registry.load()).toBe(false);
    expect(reads).toBe(1);
    expect(w.registry.get(w.requestId)).toBeUndefined();
    expect(w.changes).toEqual([]);
    expect(w.disk().requests).toBe("as saved");
  });

  it("sweeps and loads as ever when nothing stops it, and says that it loaded: the places the tests act in change nothing by themselves", async () => {
    const seen: string[] = [];
    const w = await world({ onSweep: () => void seen.push("sweep"), onStoredRead: () => void seen.push("requests") });
    expect(await w.registry.load()).toBe(true);
    // The load reads its bound once for the read and once for the save.
    expect(seen).toEqual(["sweep", "requests", "requests"]);
    expect(w.registry.get(w.requestId)).toMatchObject({ state: "expired", expiredBy: "restart" });
    expect(w.changes.map((record) => record.state)).toEqual(["expired"]);
    expect(w.disk()).toMatchObject({ delivered: false });
    expect(stored(w.dataDir).map((record) => record.state)).toEqual(["expired"]);
  });

  it("stop is what shutdown does first: nothing new starts, and the shutdown that follows still wipes and ends", async () => {
    const { registry } = harness();
    const { requestId } = await registry.create(agent(), asking);
    const keys = keysOf(registry);
    const held = keys.get(requestId) as Uint8Array;
    registry.stop();
    const refused = await registry.create(agent("late"), asking).then(
      () => "created",
      (error: Error & { code?: string }) => `${error.code}: ${error.message}`,
    );
    expect(refused).toBe("service_unavailable: service_unavailable: the plugin is shutting down");
    // The mark alone wipes nothing; the shutdown does.
    expect(keys.size).toBe(1);
    await registry.shutdown();
    expect(keys.size).toBe(0);
    expect(held.every((byte) => byte === 0)).toBe(true);
    expect(registry.get(requestId)?.state).toBe("pending");
  });
});

describe("what leaves the registry", () => {
  /** Everything a caller, a timeline or a disk could keep, but the set in drop/: the canary may be in none of it. */
  async function everything(h: Harness, collected: string[]): Promise<string> {
    const ids = [...new Set(h.changes.map((record) => record.id))];
    const pieces = [...collected, JSON.stringify(h.changes), read(join(h.dataDir, "requests.json")), ...ids.map((id) => JSON.stringify(h.registry.get(id)))];
    for (const id of ids) pieces.push(JSON.stringify(buildView(h.registry, id)));
    return pieces.join("\n");
  }

  /** Runs the call and keeps what came back, or what was thrown, as text. */
  async function note<T>(collected: string[], call: Promise<T> | (() => T)): Promise<T> {
    try {
      const result = await (typeof call === "function" ? call() : call);
      collected.push(JSON.stringify(result));
      return result;
    } catch (error) {
      collected.push(`${(error as Error).name}: ${(error as Error).message}\n${(error as Error).stack ?? ""}`);
      return undefined as T;
    }
  }

  /** Every path a typed value could leak on. Returns what the callers saw. */
  async function scenario(h: Harness): Promise<string[]> {
    const collected: string[] = [];
    const { registry } = h;
    const create = (name: string, request: unknown) => note(collected, registry.create(agent(name), request));

    // One request: a decrypt failure, the delivery of a text and a file, a repeat, a forgery.
    const delivered = (await create("delivered", withFile)).requestId;
    const foreign = seal(new Uint8Array(32).fill(5), encodeValues([{ key: "API_KEY", value: CANARY }]), buildAad("x", "y"));
    await note(collected, registry.fulfill(delivered, foreign));
    const own = sealed(registry, delivered, [{ key: "API_KEY", value: CANARY }, { key: "P12", file: toBase64Url(utf8.encode(`{"secret":"${CANARY}"}`)) }]);
    await note(collected, registry.fulfill(delivered, own));
    await note(collected, registry.fulfill(delivered, own));
    await note(collected, submit(registry, delivered, [{ key: "API_KEY", value: `${CANARY}-forged` }, { key: "P12", file: toBase64Url(BINARY) }]));

    // Requests nobody can fix: a case collision, a kind mismatch, a payload that is no payload, one that runs out of tries.
    const collision = (await create("collision", asking)).requestId;
    await note(collected, submit(registry, collision, [{ key: "API_KEY", value: CANARY }, { key: "api_key", value: `${CANARY}-row` }]));
    const kind = (await create("kind", withFile)).requestId;
    await note(collected, submit(registry, kind, [{ key: "API_KEY", value: CANARY }, { key: "P12", value: `${CANARY}-text` }]));
    const garbled = (await create("garbled", asking)).requestId;
    const record = registry.get(garbled) as RequestRecord;
    await note(collected, registry.fulfill(garbled, seal(fromBase64Url(record.publicKey), utf8.encode(`${CANARY}`.padEnd(1024, " ")), buildAad(garbled, record.requestDigest))));
    const tired = (await create("tired", asking)).requestId;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await note(collected, registry.fulfill(tired, sealed(registry, tired, [{ key: "API_KEY", value: CANARY }], "0".repeat(64))));
    }

    // A write onto a path that is taken.
    const taken = (await create("taken", asking)).requestId;
    mkdirSync(h.dropRoot, { recursive: true, mode: 0o700 });
    writeFileSync(setPath(h.dropRoot, taken), "taken", { mode: 0o600 });
    await note(collected, submit(registry, taken, [{ key: "API_KEY", value: CANARY }]));

    // Calls that throw: another agent's cancel, a decline of a request that was delivered, a view of nothing, a bad request.
    await note(collected, registry.cancel("someone-else", delivered));
    await note(collected, registry.decline(delivered));
    await note(collected, () => buildView(registry, idOf(9)));
    await note(collected, registry.create(agent("invalid"), { fields: [{ key: "A" }], sink: { kind: "dotenv" } }));
    return collected;
  }

  const stateOf = (h: Harness, state: string, agentId: string) => h.changes.find((record) => record.state === state && record.agentId === agentId)?.id ?? "";

  it("is in no result, change, error, record, view or state file, on success and on each refusal", async () => {
    const h = harness();
    const collected = await scenario(h);
    const leaked = await everything(h, collected);

    expect(leaked).not.toContain(CANARY);
    // The scenario really went down every path: these are the words each one leaves behind.
    for (const word of ["decrypt_failed", "retry_limit", "write_failed", "request_closed", "invalid_request", "differ only in letter case", "must be a file", "API_KEY"]) {
      expect(leaked).toContain(word);
    }
    expect(h.registry.get(stateOf(h, "delivered", "delivered"))).toMatchObject({ state: "delivered", tamper: true, retries: 1 });
    expect(h.registry.get(stateOf(h, "rejected", "taken"))).toMatchObject({ state: "rejected", errorCode: "write_failed" });
    // The one place the value is: the set that was delivered.
    const set = setPath(h.dropRoot, stateOf(h, "delivered", "delivered"));
    expect(readFileSync(join(set, "API_KEY"), "utf8")).toBe(CANARY);
    expect(readFileSync(join(set, "P12"), "utf8")).toBe(`{"secret":"${CANARY}"}`);
  });

  it("reads every kind of record back as it was after a restart, but a delivered one, which the restart released", async () => {
    // The delivered set's deadline lies beyond the eight hours the clock is moved below: the restart is what takes it.
    const h = harness(tempDir(), { dropTtlMs: 2 * TTL_MS });
    try {
      await scenario(h);
      const declined = (await h.registry.create(agent("declined"), asking)).requestId;
      await h.registry.decline(declined);
      const cancelled = (await h.registry.create(agent("cancelled"), asking)).requestId;
      await h.registry.cancel("cancelled", cancelled);
      await h.registry.create(agent("expired"), asking);
      h.clock.now += TTL_MS + 1;
      await h.registry.expire();

      const ids = [...new Set(h.changes.map((record) => record.id))];
      const before = ids.map((id) => h.registry.get(id) as RequestRecord);
      expect(new Set(before.map((record) => record.state))).toEqual(new Set(["delivered", "rejected", "declined", "cancelled", "expired"]));
      expect(before.some((record) => record.state === "rejected" && record.errorCode === "retry_limit")).toBe(true);
      expect(before.some((record) => record.state === "rejected" && record.errorCode === "invalid_request")).toBe(true);
      expect(before.some((record) => record.tamper)).toBe(true);

      const restarted = harness(h.dataDir);
      restarted.clock.now = h.clock.now;
      await restarted.registry.load();
      expect(restarted.registry.health()).toEqual({ persistence: "ok", drop: "ok", stored: "ok", dropped: 0 });
      const after = ids.map((id) => restarted.registry.get(id) as RequestRecord);
      const expected = before.map((record) => (record.state === "delivered" ? { ...record, state: "released", releasedBy: "restart", updatedAt: restarted.clock.now } : record));
      expect(after).toEqual(expected);
      expect(restarted.changes.map((record) => record.state)).toEqual(["released"]);
    } finally {
      await h.registry.shutdown();
    }
  });

  it("is in none of it while requests.json cannot be saved either", async () => {
    const dataDir = tempDir();
    const h = harness(dataDir);
    mkdirSync(h.dropRoot, { mode: 0o700 });
    const collected = await whileLocked(dataDir, () => scenario(h));
    const leaked = await everything(h, collected);
    expect(leaked).not.toContain(CANARY);
    for (const word of ["retry_limit", "write_failed", "API_KEY"]) expect(leaked).toContain(word);
    expect(h.registry.health().persistence).toBe("failing");
  });
});
