import { describe, expect, it, vi } from "vitest";
import { checkFile, checkedFile, encodedFile, fileLine, fromPasted, sizeText, takeFile, wipeFile, type FileCheck, type FileValue } from "../client/file-entry";
import { toBase64Url, utf8 } from "../shared/bytes";
import { LIMITS } from "../shared/limits";

const CANARY = "CANARY-9e2b-file-content";

describe("the check of a file, in the app, before anything is sealed", () => {
  it("checks JSON and PEM, and the size first", () => {
    expect(checkFile({ name: "a", bytes: utf8.encode("{nope") }, "json")).toEqual({ ok: false, message: "Це не JSON" });
    expect(checkFile({ name: "k", bytes: utf8.encode("-----BEGIN PRIVATE KEY-----\r\nAAA\r\n-----END PRIVATE KEY-----\r\n") }, "pem")).toEqual({ ok: true });
    expect(checkFile({ name: "b", bytes: new Uint8Array(128 * 1024 + 1) }, "any")).toEqual({ ok: false, message: "Не довше 128 КіБ" });
    expect(checkFile({ name: "p12", bytes: Uint8Array.from([0x30, 0x82, 0xff]) }, "any")).toEqual({ ok: true });
  });

  it("takes JSON that parses, and nothing else as JSON", () => {
    const json = (content: string) => checkFile({ name: "sa.json", bytes: utf8.encode(content) }, "json");
    for (const good of ['{"type":"service_account"}', "[1, 2]", "  {}\n", "42", '"text"', "null"]) expect(json(good), good).toEqual({ ok: true });
    for (const bad of ["", " ", "{", "{'a': 1}", "{} {}", "a: 1"]) expect(json(bad), JSON.stringify(bad)).toEqual({ ok: false, message: "Це не JSON" });
    // Bytes that are not UTF-8 are not JSON, however they would parse once mended.
    expect(checkFile({ name: "x", bytes: Uint8Array.from([0x7b, 0x7d, 0xff]) }, "json")).toEqual({ ok: false, message: "Це не JSON" });
  });

  it("takes PEM that has a BEGIN line and an END line, with either line ending, and nothing short of both", () => {
    const pem = (content: string) => checkFile({ name: "key.pem", bytes: utf8.encode(content) }, "pem");
    expect(pem("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")).toEqual({ ok: true });
    expect(pem("Bag Attributes\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toEqual({ ok: true });
    for (const bad of [
      "",
      "MIIB",
      "-----BEGIN KEY-----\nabc\n",
      "abc\n-----END KEY-----\n",
      "-----BEGIN KEY----- trailing\nabc\n-----END KEY-----\n",
      " -----BEGIN KEY-----\nabc\n-----END KEY-----\n",
      "-----BEGIN -----\nabc\n-----END -----\n",
    ]) {
      expect(pem(bad), JSON.stringify(bad)).toEqual({ ok: false, message: "Це не PEM" });
    }
    // A PEM in bytes that are not UTF-8 is no PEM.
    const broken = Uint8Array.from([...utf8.encode("-----BEGIN KEY-----\n"), 0xc3, 0x28, ...utf8.encode("\n-----END KEY-----\n")]);
    expect(checkFile({ name: "k", bytes: broken }, "pem")).toEqual({ ok: false, message: "Це не PEM" });
  });

  it("checks nothing but the size of a file of any format, binary included", () => {
    expect(checkFile({ name: "e", bytes: new Uint8Array(0) }, "any")).toEqual({ ok: true });
    expect(checkFile({ name: "z", bytes: new Uint8Array(LIMITS.fileBytes) }, "any")).toEqual({ ok: true });
    expect(checkFile({ name: "z", bytes: new Uint8Array(LIMITS.fileBytes + 1) }, "any")).toEqual({ ok: false, message: "Не довше 128 КіБ" });
  });

  it("holds every format to the size first, at the bound the plugin itself holds a file to", () => {
    expect(LIMITS.fileBytes).toBe(128 * 1024);
    const big = utf8.encode(`[${"1,".repeat(LIMITS.fileBytes / 2)}1]`);
    expect(big.length).toBeGreaterThan(LIMITS.fileBytes);
    expect(checkFile({ name: "big.json", bytes: big }, "json")).toEqual({ ok: false, message: "Не довше 128 КіБ" });
    const pem = utf8.encode(`-----BEGIN KEY-----\n${"A".repeat(LIMITS.fileBytes)}\n-----END KEY-----\n`);
    expect(checkFile({ name: "big.pem", bytes: pem }, "pem")).toEqual({ ok: false, message: "Не довше 128 КіБ" });
  });

  it("leaves the bytes it checks as they were, and says nothing of what they hold", () => {
    const bytes = utf8.encode(`{"secret":"${CANARY}"`);
    const before = bytes.slice();
    const check = checkFile({ name: "a.json", bytes }, "json");
    expect(bytes).toEqual(before);
    expect(JSON.stringify(check)).not.toContain("CANARY");
  });
});

describe("a file that begins with a byte order mark", () => {
  const BOM = [0xef, 0xbb, 0xbf];

  it("is checked as the bytes the daemon writes, BOM and all: JSON or PEM behind one is neither", () => {
    const json = Uint8Array.from([...BOM, 0x7b, 0x7d]);
    // What a reader of the file the daemon writes gets: the BOM is its first character, and JSON refuses that.
    expect(() => JSON.parse(Buffer.from(json).toString("utf8"))).toThrow(SyntaxError);
    expect(checkFile({ name: "sa.json", bytes: json }, "json")).toEqual({ ok: false, message: "Це не JSON" });
    expect(checkFile({ name: "sa.json", bytes: json.subarray(BOM.length) }, "json")).toEqual({ ok: true });
    const pem = utf8.encode("-----BEGIN KEY-----\nAAA\n-----END KEY-----\n");
    expect(checkFile({ name: "k.pem", bytes: Uint8Array.from([...BOM, ...pem]) }, "pem")).toEqual({ ok: false, message: "Це не PEM" });
    expect(checkFile({ name: "k.pem", bytes: pem }, "pem")).toEqual({ ok: true });
    // A file of any format is not looked into, and goes as it is, the BOM included.
    expect(checkFile({ name: "x", bytes: json }, "any")).toEqual({ ok: true });
    expect([...Buffer.from(encodedFile({ name: "x", bytes: json }), "base64url")]).toEqual([...BOM, 0x7b, 0x7d]);
  });
});

describe("what is kept of a file while the form holds it", () => {
  it("checks a file once for each format and encodes it once, and keeps both until the file is wiped", () => {
    const value: FileValue = { name: "sa.json", bytes: utf8.encode('{"a":1}') };
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (let round = 0; round < 3; round++) expect(checkedFile(value, "json")).toEqual({ ok: true });
      expect(checkedFile(value, "pem")).toEqual({ ok: false, message: "Це не PEM" });
      expect(parse.mock.calls.filter(([text]) => text === '{"a":1}')).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
    const encoded = encodedFile(value);
    expect(encoded).toBe(toBase64Url(utf8.encode('{"a":1}')));
    // Kept, not made again: nothing of a file changes but its wipe, and what is kept of it is what it was.
    value.bytes[0] = 0x5b;
    expect(encodedFile(value)).toBe(encoded);
    expect(checkedFile(value, "json")).toEqual({ ok: true });
    // Wiped: its bytes are zeros, and nothing made of them is kept any more.
    wipeFile(value);
    expect(value.bytes.every((byte) => byte === 0)).toBe(true);
    expect(encodedFile(value)).toBe(toBase64Url(new Uint8Array(value.bytes.length)));
    expect(checkedFile(value, "json")).toEqual({ ok: false, message: "Це не JSON" });
  });
});

describe("a file the form is given", () => {
  it("is handed on while the form may take it, and wiped otherwise, also when what takes it throws", () => {
    const taken: FileValue[] = [];
    const kept: FileValue = { name: "a.json", bytes: utf8.encode("{}") };
    takeFile(kept, true, (value) => void taken.push(value));
    expect(taken).toEqual([kept]);
    expect(kept.bytes.every((byte) => byte === 0)).toBe(false);
    const refused: FileValue = { name: "b.json", bytes: utf8.encode(`{"k":"${CANARY}"}`) };
    takeFile(refused, false, (value) => void taken.push(value));
    expect(taken).toHaveLength(1);
    expect(refused.bytes.every((byte) => byte === 0)).toBe(true);
    const thrown: FileValue = { name: "c.json", bytes: utf8.encode(`{"k":"${CANARY}"}`) };
    expect(() =>
      takeFile(thrown, true, () => {
        throw new Error("the form could not take it");
      }),
    ).not.toThrow();
    expect(thrown.bytes.every((byte) => byte === 0)).toBe(true);
  });
});

describe("the line that stands for a file in its row", () => {
  it("describes a file by its name or as pasted, its size and its check, never by its content", () => {
    expect(fileLine({ name: null, bytes: new Uint8Array(2150) }, "json", { ok: true })).toBe("вставлено · 2,1 КіБ · json ✓");
    expect(fileLine({ name: "key.pem", bytes: new Uint8Array(900) }, "pem", { ok: false, message: "Це не PEM" })).toBe("key.pem · 900 байтів · pem ✗");
  });

  it("has no mark for a file of any format, which nothing checks but its size", () => {
    expect(fileLine({ name: "cert.p12", bytes: new Uint8Array(1) }, "any", { ok: true })).toBe("cert.p12 · 1 байт");
    expect(fileLine({ name: "big.bin", bytes: new Uint8Array(LIMITS.fileBytes + 1) }, "any", { ok: false, message: "Не довше 128 КіБ" })).toBe("big.bin · 128,0 КіБ");
  });

  it("never holds a byte of the file, whatever the file holds", () => {
    const file: FileValue = { name: "sa.json", bytes: utf8.encode(`{"k":"${CANARY}"}`) };
    for (const check of [{ ok: true }, { ok: false, message: "Це не JSON" }] as FileCheck[]) {
      expect(fileLine(file, "json", check)).not.toContain("CANARY");
    }
    expect(fileLine({ name: null, bytes: utf8.encode(CANARY) }, "any", { ok: true })).toBe("вставлено · 24 байти");
  });

  it("shows a name the human picked without what could hide or reorder it", () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(fileLine({ name: `invoice${rlo}fdp.exe`, bytes: new Uint8Array(3) }, "any", { ok: true })).toBe("invoice fdp.exe · 3 байти");
    // A name with nothing left once it is cleaned is not shown as an empty first part.
    expect(fileLine({ name: rlo, bytes: new Uint8Array(3) }, "any", { ok: true })).toBe("3 байти");
  });

  it("says a size in bytes below a KiB, and in KiB with one decimal comma above", () => {
    expect([0, 1, 2, 5, 21, 22, 1023].map(sizeText)).toEqual(["0 байтів", "1 байт", "2 байти", "5 байтів", "21 байт", "22 байти", "1023 байти"]);
    expect([1024, 1075, 2150, 10_240, LIMITS.fileBytes].map(sizeText)).toEqual(["1,0 КіБ", "1,0 КіБ", "2,1 КіБ", "10,0 КіБ", "128,0 КіБ"]);
  });
});

describe("pasting into a file row", () => {
  it("turns pasted text into a file, an empty paste into nothing, and checks its format", () => {
    expect(fromPasted("")).toBeNull();
    const pasted = fromPasted("-----BEGIN KEY-----\nabc\n-----END KEY-----\n");
    expect(pasted?.name).toBeNull();
    expect(checkFile(pasted!, "pem")).toEqual({ ok: true });
    expect(checkFile(fromPasted("not json")!, "json")).toEqual({ ok: false, message: "Це не JSON" });
  });

  it("keeps every byte that was pasted, line breaks included, and adds none", () => {
    const content = 'line one\r\nline two\n{"k": "ключ"}\n';
    expect(fromPasted(content)).toEqual({ name: null, bytes: utf8.encode(content) });
    expect(fromPasted(" ")).toEqual({ name: null, bytes: Uint8Array.from([0x20]) });
  });

  // On the phone the paste area is opened and then left with nothing in it, with text of the wrong format, or with
  // half of what was meant. None of it throws, and none of it is a file that passes for the format.
  it("leaves a row empty after an empty paste, and marks wrong or half-pasted text for what it is, without throwing", () => {
    const halfPem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r";
    const halfJson = '{"type": "service_account", "private_key": "-----BEGIN';
    expect(() => fromPasted("")).not.toThrow();
    expect(fromPasted("")).toBeNull();
    expect(checkFile(fromPasted(halfPem)!, "pem")).toEqual({ ok: false, message: "Це не PEM" });
    expect(checkFile(fromPasted(halfJson)!, "json")).toEqual({ ok: false, message: "Це не JSON" });
    expect(checkFile(fromPasted("plain words")!, "pem")).toEqual({ ok: false, message: "Це не PEM" });
    expect(fileLine(fromPasted(halfJson)!, "json", checkFile(fromPasted(halfJson)!, "json"))).toBe("вставлено · 54 байти · json ✗");
  });

  it("makes the bytes of a paste and nothing else", () => {
    const encode = vi.spyOn(utf8, "encode");
    try {
      fromPasted("abc");
      expect(encode).toHaveBeenCalledTimes(1);
    } finally {
      encode.mockRestore();
    }
  });
});
