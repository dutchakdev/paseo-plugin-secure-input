import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeCode } from "../client/codes";
import { DELETE_ALL, SETTINGS_BADGE, canDeleteAll, clockTime, dotColor, statusRows, type StatusRow } from "../client/diagnostics-rows";
import type { Tone } from "../client/tone";
import { DiagnosticsSchema, type Diagnostics } from "../shared/contracts";
import { ERROR_CODES } from "../shared/errors";

const healthy: Diagnostics = {
  attached: true,
  dataDir: "/home/u/.paseo/secure-input",
  registry: { persistence: "ok", drop: "ok", stored: "ok", dropped: 0 },
  outbox: { persistence: "ok", unsaved: 0, dropped: 0 },
  requests: { pending: 0, delivered: 0, nextDeleteBy: null },
  startup: null,
  cardsOwed: 0,
  messagesHeld: false,
  lastHookFailure: null,
};

const registry = (patch: Partial<Diagnostics["registry"]>): Diagnostics => ({ ...healthy, registry: { ...healthy.registry, ...patch } });
const outbox = (patch: Partial<Diagnostics["outbox"]>): Diagnostics => ({ ...healthy, outbox: { ...healthy.outbox, ...patch } });
const requests = (patch: Partial<Diagnostics["requests"]>): Diagnostics => ({ ...healthy, requests: { ...healthy.requests, ...patch } });

type Label = StatusRow["label"];

/** The row of the screen with this label. */
function row(data: Diagnostics, label: Label): StatusRow {
  const found = statusRows(data).find((candidate) => candidate.label === label);
  if (found === undefined) throw new Error(`no row ${label}`);
  return found;
}

/** A time of the day today in this machine's own zone, as the screen says it: the zone is not the test's to know. */
const at = (hours: number, minutes: number): number => new Date(2026, 9, 27, hours, minutes).getTime();

describe("the status rows", () => {
  it("is fed with data the contract accepts", () => {
    expect(DiagnosticsSchema.parse(healthy)).toEqual(healthy);
  });

  it("shows four rows in their order, all green for a healthy plugin", () => {
    expect(statusRows(healthy)).toEqual([
      { label: "Плагін", value: "Працює", dot: "ok", explanation: null },
      { label: "Секрети на сервері", value: "Немає", dot: "ok", explanation: null },
      { label: "Запити, що чекають", value: "Немає", dot: "ok", explanation: null },
      { label: "Помилки", value: "Немає", dot: "ok", explanation: null },
    ]);
  });

  it("explains a row exactly when it is red", () => {
    const states: Diagnostics[] = [
      healthy,
      { ...healthy, attached: false },
      { ...healthy, messagesHeld: true },
      { ...healthy, startup: { code: "write_failed", detail: "" } },
      requests({ delivered: 2, nextDeleteBy: at(14, 32) }),
      requests({ pending: 3 }),
      { ...registry({ drop: "failing" }), requests: { pending: 0, delivered: 1, nextDeleteBy: at(9, 5) } },
      registry({ persistence: "failing" }),
      { ...healthy, cardsOwed: 1 },
      { ...healthy, lastHookFailure: "agent.session_open: write_failed" },
    ];
    for (const data of states) {
      expect(statusRows(data).map((entry) => entry.label)).toEqual(["Плагін", "Секрети на сервері", "Запити, що чекають", "Помилки"]);
      for (const entry of statusRows(data)) expect(entry.explanation !== null, `${entry.label}: ${entry.value}`).toBe(entry.dot === "bad");
    }
  });

  describe("«Плагін»", () => {
    it("works when it started, has the daemon's API and sends messages", () => {
      expect(row(healthy, "Плагін")).toEqual({ label: "Плагін", value: "Працює", dot: "ok", explanation: null });
    });

    it("is starting while the daemon's API has not arrived or messages are held back, which is nothing to explain", () => {
      const starting = { label: "Плагін", value: "Запускається", dot: "warn", explanation: null };
      expect(row({ ...healthy, attached: false }, "Плагін")).toEqual(starting);
      expect(row({ ...healthy, messagesHeld: true }, "Плагін")).toEqual(starting);
      expect(row({ ...healthy, attached: false, messagesHeld: true }, "Плагін")).toEqual(starting);
    });

    it("did not start when its start-up failed: the sentence for the code, the code, and the fixed phrase", () => {
      const failed: Diagnostics = {
        ...healthy,
        startup: { code: "service_unavailable", detail: "the drop directory is not a private directory of this user" },
      };
      expect(row(failed, "Плагін")).toEqual({
        label: "Плагін",
        value: "Не запустився",
        dot: "bad",
        explanation: "Плагін зараз не може прийняти запит. (service_unavailable) — the drop directory is not a private directory of this user",
      });
    });

    it("has a sentence for every code the plugin has, and leaves out the dash when there is no phrase to put after it", () => {
      for (const code of ERROR_CODES) {
        expect(row({ ...healthy, startup: { code, detail: "a fixed phrase" } }, "Плагін").explanation, code).toBe(`${describeCode(code)} — a fixed phrase`);
        expect(row({ ...healthy, startup: { code, detail: "" } }, "Плагін").explanation, code).toBe(describeCode(code));
      }
      expect(row({ ...healthy, startup: { code: "write_failed", detail: "" } }, "Плагін").explanation).toBe("Файл не вдалося записати. (write_failed)");
    });

    it("says an unexpected failure in words of its own", () => {
      const unexpected = (detail: string): Diagnostics => ({ ...healthy, startup: { code: "unexpected", detail } });
      expect(row(unexpected("an unexpected error stopped the start-up"), "Плагін").explanation).toBe(
        "Непередбачена помилка. (unexpected) — an unexpected error stopped the start-up",
      );
      expect(row(unexpected(""), "Плагін")).toEqual({ label: "Плагін", value: "Не запустився", dot: "bad", explanation: "Непередбачена помилка. (unexpected)" });
    });

    it("puts a failed start before the states of a start that is still going", () => {
      const both: Diagnostics = { ...healthy, attached: false, messagesHeld: true, startup: { code: "write_failed", detail: "" } };
      expect(row(both, "Плагін")).toMatchObject({ value: "Не запустився", dot: "bad" });
    });
  });

  describe("«Секрети на сервері»", () => {
    const label = "Секрети на сервері";

    it("has none when no set is delivered", () => {
      expect(row(healthy, label)).toEqual({ label, value: "Немає", dot: "ok", explanation: null });
    });

    it("counts the delivered sets and says when the nearest one goes, by the clock of this machine", () => {
      expect(row(requests({ delivered: 1, nextDeleteBy: at(14, 32) }), label)).toEqual({
        label,
        value: "1 · найближчий зникне о 14:32",
        dot: "warn",
        explanation: null,
      });
      expect(row(requests({ delivered: 12, nextDeleteBy: at(0, 7) }), label).value).toBe("12 · найближчий зникне о 00:07");
    });

    it("counts them without a time when none is known, which the contract allows", () => {
      expect(row(requests({ delivered: 2, nextDeleteBy: null }), label)).toEqual({ label, value: "2", dot: "warn", explanation: null });
    });

    it("is red when the drop is failing, and sends the human to the button and to the directory", () => {
      const failing: Diagnostics = { ...registry({ drop: "failing" }), requests: { pending: 0, delivered: 3, nextDeleteBy: at(14, 32) } };
      expect(row(failing, label)).toEqual({
        label,
        value: "3 · не все видалено",
        dot: "bad",
        explanation: "Не вдалося видалити деякі файли. Натисніть «Видалити всі файли секретів зараз» або видаліть /home/u/.paseo/secure-input/drop.",
      });
      // The directory is the one the plugin was asked about.
      expect(row({ ...failing, dataDir: "/srv/paseo data/secure-input" }, label).explanation).toBe(
        "Не вдалося видалити деякі файли. Натисніть «Видалити всі файли секретів зараз» або видаліть /srv/paseo data/secure-input/drop.",
      );
    });

    it("is red with none counted as well: the sweep of a start can leave what it cannot remove", () => {
      expect(row(registry({ drop: "failing" }), label)).toMatchObject({ value: "0 · не все видалено", dot: "bad" });
    });

    it("names the button in the words the button has", () => {
      expect(DELETE_ALL).toBe("Видалити всі файли секретів зараз");
      expect(row(registry({ drop: "failing" }), label).explanation).toContain(`«${DELETE_ALL}»`);
    });
  });

  describe("«Запити, що чекають»", () => {
    const label = "Запити, що чекають";

    it("has none when nothing waits", () => {
      expect(row(healthy, label)).toEqual({ label, value: "Немає", dot: "ok", explanation: null });
    });

    it("counts them while some wait, which is a state to see and no fault", () => {
      expect(row(requests({ pending: 1 }), label)).toEqual({ label, value: "1", dot: "warn", explanation: null });
      expect(row(requests({ pending: 14 }), label)).toEqual({ label, value: "14", dot: "warn", explanation: null });
    });

    it("is never red, whatever else is the matter", () => {
      const worst: Diagnostics = {
        ...healthy,
        attached: false,
        startup: { code: "write_failed", detail: "" },
        registry: { persistence: "failing", drop: "failing", stored: "unreadable", dropped: 9 },
        outbox: { persistence: "failing", unsaved: 9, dropped: 9 },
        requests: { pending: 5, delivered: 2, nextDeleteBy: at(9, 5) },
        cardsOwed: 4,
        messagesHeld: true,
        lastHookFailure: "agent.session_open: write_failed",
      };
      expect(row(worst, label)).toEqual({ label, value: "5", dot: "warn", explanation: null });
    });
  });

  describe("«Помилки»", () => {
    const label = "Помилки";

    it("has none for a healthy plugin", () => {
      expect(row(healthy, label)).toEqual({ label, value: "Немає", dot: "ok", explanation: null });
    });

    it("says «Є» with the sentence of what is the matter", () => {
      const cases: Array<[string, Diagnostics, string]> = [
        ["the registry cannot save its state", registry({ persistence: "failing" }), "Не вдається зберегти стан запитів."],
        ["the file of requests cannot be read", registry({ stored: "unreadable" }), "Файл запитів не читається."],
        ["the outbox cannot save its messages", outbox({ persistence: "failing" }), "Не вдається зберегти повідомлення агентам."],
        ["a card is not on the chat", { ...healthy, cardsOwed: 3 }, "Картку не показано в чаті: 3."],
        ["a hook failed", { ...healthy, lastHookFailure: "agent.session_open: write_failed" }, "agent.session_open: Файл не вдалося записати. (write_failed)"],
      ];
      for (const [name, data, sentence] of cases) expect(row(data, label), name).toEqual({ label, value: "Є", dot: "bad", explanation: sentence });
    });

    it("says the first of them when there are several, in the order of the table", () => {
      let data: Diagnostics = {
        ...healthy,
        registry: { ...healthy.registry, persistence: "failing", stored: "unreadable" },
        outbox: { ...healthy.outbox, persistence: "failing" },
        cardsOwed: 2,
        lastHookFailure: "agent.session_open: write_failed",
      };
      const sentences: string[] = [];
      // One source taken away after another, from the first of the table to the last.
      const without: Array<(from: Diagnostics) => Diagnostics> = [
        (from) => ({ ...from, registry: { ...from.registry, persistence: "ok" } }),
        (from) => ({ ...from, registry: { ...from.registry, stored: "ok" } }),
        (from) => ({ ...from, outbox: { ...from.outbox, persistence: "ok" } }),
        (from) => ({ ...from, cardsOwed: 0 }),
        (from) => ({ ...from, lastHookFailure: null }),
      ];
      for (const remove of without) {
        sentences.push(row(data, label).explanation ?? "none");
        data = remove(data);
      }
      sentences.push(row(data, label).explanation ?? "none");
      expect(sentences).toEqual([
        "Не вдається зберегти стан запитів.",
        "Файл запитів не читається.",
        "Не вдається зберегти повідомлення агентам.",
        "Картку не показано в чаті: 2.",
        "agent.session_open: Файл не вдалося записати. (write_failed)",
        "none",
      ]);
      expect(row(data, label)).toEqual({ label, value: "Немає", dot: "ok", explanation: null });
    });

    it("says a hook that failed with the sentence of its code, also for an event handler and for an unexpected failure", () => {
      const failure = (kept: string) => row({ ...healthy, lastHookFailure: kept }, label).explanation;
      expect(failure("agent.archived: write_failed")).toBe("agent.archived: Файл не вдалося записати. (write_failed)");
      expect(failure("agent.session_open: unexpected")).toBe("agent.session_open: Непередбачена помилка. (unexpected)");
    });

    it("says a failure as it was kept when it does not have the shape of a hook and a code the plugin knows", () => {
      // A word that no hook remembers any more (v1's binding store had two) is no code either.
      for (const kept of ["agent.create: something_new", "no separator", "agent.create: constructor", ": write_failed", "agent.session_open: bindings_not_loaded"]) {
        expect(row({ ...healthy, lastHookFailure: kept }, label), kept).toEqual({ label, value: "Є", dot: "bad", explanation: kept });
      }
    });
  });
});

describe("the button that deletes every file", () => {
  it("is shown while a set is delivered", () => {
    expect(canDeleteAll(requests({ delivered: 1, nextDeleteBy: at(9, 5) }))).toBe(true);
    expect(canDeleteAll(requests({ delivered: 7, nextDeleteBy: null }))).toBe(true);
  });

  it("is shown while the drop is failing, though no set is delivered: the red row sends the human to it", () => {
    const failing = registry({ drop: "failing" });
    expect(failing.requests.delivered).toBe(0);
    expect(canDeleteAll(failing)).toBe(true);
    // The row that names the button, and the button, are there together.
    expect(row(failing, "Секрети на сервері")).toMatchObject({ value: "0 · не все видалено", dot: "bad" });
    expect(row(failing, "Секрети на сервері").explanation).toContain(`«${DELETE_ALL}»`);
    // And when both hold.
    expect(canDeleteAll({ ...failing, requests: { pending: 0, delivered: 2, nextDeleteBy: at(9, 5) } })).toBe(true);
  });

  it("is hidden when no set is delivered and the drop is not failing, whatever else waits or is the matter", () => {
    expect(canDeleteAll(healthy)).toBe(false);
    expect(canDeleteAll(requests({ pending: 4 }))).toBe(false);
    const elsewhere: Diagnostics = {
      ...healthy,
      attached: false,
      messagesHeld: true,
      startup: { code: "write_failed", detail: "" },
      registry: { persistence: "failing", drop: "ok", stored: "unreadable", dropped: 3 },
      outbox: { persistence: "failing", unsaved: 1, dropped: 1 },
      requests: { pending: 2, delivered: 0, nextDeleteBy: null },
      cardsOwed: 2,
      lastHookFailure: "agent.session_open: write_failed",
    };
    expect(canDeleteAll(elsewhere)).toBe(false);
  });

  it("is shown exactly when the row of the secrets is not «Немає»: there are files, or files that could not be removed", () => {
    for (const delivered of [0, 3]) {
      for (const drop of ["ok", "failing"] as const) {
        const data: Diagnostics = {
          ...healthy,
          registry: { ...healthy.registry, drop },
          requests: { pending: 0, delivered, nextDeleteBy: delivered > 0 ? at(9, 5) : null },
        };
        expect(canDeleteAll(data), `${delivered} delivered, drop ${drop}`).toBe(row(data, "Секрети на сервері").value !== "Немає");
      }
    }
  });
});

describe("the time of day", () => {
  it("is the hour and the minute on the clock of this machine, with two digits each", () => {
    expect(clockTime(new Date(2026, 9, 27, 9, 5).getTime())).toBe("09:05");
    expect(clockTime(at(14, 32))).toBe("14:32");
    expect(clockTime(at(0, 0))).toBe("00:00");
    expect(clockTime(at(23, 59))).toBe("23:59");
    // The seconds are not rounded into the minute.
    expect(clockTime(new Date(2026, 9, 27, 14, 32, 59, 999).getTime())).toBe("14:32");
  });
});

describe("what the screen draws with", () => {
  it("names the construction the plugin really seals with", () => {
    expect(SETTINGS_BADGE).toBe("X25519 · HKDF-SHA256 · ChaCha20-Poly1305");
  });

  it("gives each dot the colour of its state, from the theme", () => {
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
    expect(dotColor("ok", colors)).toBe("success");
    expect(dotColor("warn", colors)).toBe("warning");
    expect(dotColor("bad", colors)).toBe("danger");
  });
});

describe("everything the diagnostics contract holds is accounted for", () => {
  type Change = (data: Diagnostics) => Diagnostics;
  const failing = registry({ drop: "failing" });
  const waiting = requests({ delivered: 1, nextDeleteBy: at(14, 32) });

  /**
   * The fields the rows read, each with the state to start from and a change of that field alone, which must alter the
   * rows. The directory of the data is said only under a failing drop, so that is where it starts.
   */
  const READ: Record<string, { from: Diagnostics; change: Change }> = {
    attached: { from: healthy, change: (data) => ({ ...data, attached: false }) },
    dataDir: { from: failing, change: (data) => ({ ...data, dataDir: `${data.dataDir}/x` }) },
    "registry.persistence": { from: healthy, change: (data) => ({ ...data, registry: { ...data.registry, persistence: "failing" } }) },
    "registry.drop": { from: healthy, change: (data) => ({ ...data, registry: { ...data.registry, drop: "failing" } }) },
    "registry.stored": { from: healthy, change: (data) => ({ ...data, registry: { ...data.registry, stored: "unreadable" } }) },
    "outbox.persistence": { from: healthy, change: (data) => ({ ...data, outbox: { ...data.outbox, persistence: "failing" } }) },
    "requests.pending": { from: healthy, change: (data) => ({ ...data, requests: { ...data.requests, pending: 2 } }) },
    "requests.delivered": { from: healthy, change: (data) => ({ ...data, requests: { ...data.requests, delivered: 2 } }) },
    "requests.nextDeleteBy": { from: waiting, change: (data) => ({ ...data, requests: { ...data.requests, nextDeleteBy: at(15, 32) } }) },
    startup: { from: healthy, change: (data) => ({ ...data, startup: { code: "write_failed", detail: "" } }) },
    cardsOwed: { from: healthy, change: (data) => ({ ...data, cardsOwed: 3 }) },
    messagesHeld: { from: healthy, change: (data) => ({ ...data, messagesHeld: true }) },
    lastHookFailure: { from: healthy, change: (data) => ({ ...data, lastHookFailure: "agent.session_open: write_failed" }) },
  };

  /** The counts the contract keeps and the screen does not show: the four rows of the table have no place for them. */
  const UNREAD: Record<string, Diagnostics> = {
    "registry.dropped": registry({ dropped: 3 }),
    "outbox.unsaved": outbox({ unsaved: 3 }),
    "outbox.dropped": outbox({ dropped: 3 }),
  };

  /** Every field of the contract, nested ones as `parent.child`. */
  function fieldsOfContract(): string[] {
    return Object.entries(DiagnosticsSchema.shape).flatMap(([name, schema]) => (schema instanceof z.ZodObject ? Object.keys(schema.shape).map((child) => `${name}.${child}`) : [name]));
  }

  it("has a decision for exactly the fields the contract has, so that a new field cannot be forgotten", () => {
    expect([...Object.keys(READ), ...Object.keys(UNREAD)].sort()).toEqual(fieldsOfContract().sort());
  });

  it("shows a different screen when a field the rows read changes, and the data is still what the contract takes", () => {
    for (const [name, { from, change }] of Object.entries(READ)) {
      expect(DiagnosticsSchema.safeParse(from).success, name).toBe(true);
      expect(DiagnosticsSchema.safeParse(change(from)).success, name).toBe(true);
      expect(statusRows(change(from)), name).not.toEqual(statusRows(from));
    }
  });

  it("shows the same screen when a count it does not read changes", () => {
    for (const [name, data] of Object.entries(UNREAD)) {
      expect(DiagnosticsSchema.safeParse(data).success, name).toBe(true);
      expect(data, name).not.toEqual(healthy);
      expect(statusRows(data), name).toEqual(statusRows(healthy));
    }
  });
});
