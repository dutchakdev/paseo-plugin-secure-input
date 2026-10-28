import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { declineRequest, fulfillRequest, getRequest } from "../shared/contracts";
import { LIMITS } from "../shared/limits";
import type { RequestView } from "../shared/view";
import { applyOutcome, applyRead, arrowAction, declineAction, openedDialog, type DialogState } from "./dialog-state";
import { keepAfter, type SealedSubmission } from "./envelope-cache";
import { takeFile, wipeFile, type FileValue } from "./file-entry";
import { ANNOUNCED, FileRow, IconButton, MONO, RowLine, TextRow } from "./fields";
import { addRow, checkForm, clearFile, fillFile, formFromView, removeRow, setName, setText, toFileRow, wipeForm, type FormState } from "./form-state";
import { afterDecline, afterLostReply } from "./outcome";
import { A11Y, FORM_BADGE, dialogScreen, formTitle } from "./presentation";
import { sealEntries } from "./sealing";
import { submitEntries, type SubmitDeps, type SubmitOutcome } from "./submit";
import { tone } from "./tone";
import { canPickFiles, pickFile, useFileDrop } from "./web";

interface DialogProps extends PluginHostProps {
  requestId: string;
  /** A fresh number each time the form opens. The pill keys the form by the request and this, so every opening of every request starts from nothing. */
  session: number;
  onClose(): void;
}

/**
 * A value the component renders as it was last set, and that its handlers read as it is now: a press, a blur and a
 * file that arrives late all act on the latest form, not on the one of the render they were made in.
 */
function useHeld<T>(initial: () => T): [T, { readonly current: T }, (next: T) => void] {
  const ref = useRef<{ current: T } | null>(null);
  if (ref.current === null) ref.current = { current: initial() };
  const held = ref.current;
  const [value, setValue] = useState<T>(held.current);
  const set = useCallback(
    (next: T) => {
      held.current = next;
      setValue(next);
    },
    [held],
  );
  return [value, held, set];
}

/**
 * The form over the chat. It holds what the human types and the files they give, reads the request once
 * when it opens, and does what `outcome.ts`, `submit.ts` and `dialog-state.ts` decide. However it goes (closed by the
 * human, by an answer, or unmounted with its row by the chat's list), it takes no file's bytes along: they are wiped.
 */
export function RequestDialog({ requestId, session, onClose, theme, layout }: DialogProps) {
  const colors = tone(theme.colors);
  const get = useRpc(getRequest);
  const fulfill = useRpc(fulfillRequest);
  const decline = useRpc(declineRequest);
  const [state, stateRef, setState] = useHeld<DialogState>(openedDialog);
  const [form, formRef, setForm] = useHeld<FormState>(() => ({ rows: [] }));
  /** What is under way: «→» (a reading or a submission), or «✕». Nothing else is taken meanwhile. */
  const [busy, setBusy] = useState<"arrow" | "decline" | null>(null);
  const working = useRef(false);
  /** The envelope of the last submission with the entries it was sealed from. Component memory only; gone with the form. */
  const sealed = useRef<SealedSubmission | null>(null);
  const mounted = useRef(true);
  /** The number the next row of the human's is given. Never one that was given before, so no row takes another's place. */
  const nextRow = useRef(1);
  const body = useRef<View>(null);
  const latestGet = useRef(get);
  latestGet.current = get;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      wipeForm(formRef.current);
      sealed.current = null;
    };
  }, [formRef]);

  /** A change to the form, made on the latest form and once: a change that wipes a file wipes it here. */
  const update = (change: (current: FormState) => FormState) => {
    const next = change(formRef.current);
    if (next !== formRef.current) setForm(next);
  };

  /** A reading of the request, and the form for its fields when it is the first view the form holds. */
  const land = useCallback(
    (loaded: RequestView | null) => {
      if (!mounted.current) return;
      const before = stateRef.current;
      const after = applyRead(before, requestId, loaded);
      setState(after);
      if (before.view === null && after.view !== null) setForm(formFromView(after.view));
    },
    [requestId, stateRef, setState, setForm],
  );

  // Read once per opening. There is no interval and no refetch on focus: nothing may change on screen while the human types.
  useEffect(() => {
    let current = true;
    latestGet.current({ requestId }).then(
      (loaded) => {
        if (current) land(loaded);
      },
      () => {
        if (current) land(null);
      },
    );
    return () => {
      current = false;
    };
  }, [requestId, session, land]);

  function close() {
    wipeForm(formRef.current);
    sealed.current = null;
    onClose();
  }

  /** Does exactly what the outcome says. */
  function perform(outcome: SubmitOutcome) {
    if (!mounted.current) return;
    sealed.current = outcome.cache;
    setState(applyOutcome(stateRef.current, outcome));
    if (outcome.next.clearForm) {
      wipeForm(formRef.current);
      setForm({ rows: [] });
    }
    if (outcome.next.close) close();
  }

  /** One thing at a time. A task never rejects; if one fails all the same, the form asks for «→» again and keeps everything. */
  async function run(kind: "arrow" | "decline", task: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    try {
      await task();
    } catch {
      if (mounted.current) setState(applyOutcome(stateRef.current, { next: afterLostReply(), view: null }));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const deps: SubmitDeps = { get, fulfill, seal: sealEntries };

  function pressArrow() {
    const { entries } = checkForm(formRef.current);
    const action = arrowAction(stateRef.current, entries !== null);
    if (action === "read") {
      void run("arrow", async () => {
        let loaded: RequestView | null;
        try {
          loaded = await get({ requestId });
        } catch {
          loaded = null;
        }
        land(loaded);
      });
    } else if (action === "submit") {
      const view = stateRef.current.view;
      if (view === null || entries === null) return;
      void run("arrow", async () => perform(await submitEntries(deps, { requestId, view, entries, cache: sealed.current })));
    }
  }

  function pressDecline() {
    if (working.current) return;
    if (declineAction(stateRef.current) === "close") return close();
    void run("decline", async () => {
      let succeeded = false;
      try {
        await decline({ requestId });
        succeeded = true;
      } catch {
        // Closed by someone else, or the plugin is unreachable: the form says so with its line, and the pill shows the real state.
      }
      const next = afterDecline(succeeded);
      perform({ next, cache: keepAfter(sealed.current, next), view: null });
    });
  }

  /** A file for a row: taken only while the form is on screen and nothing is under way, and only into an empty file row; any other is wiped (`takeFile`, `fillFile`). */
  const took = (id: string) => (file: FileValue) => takeFile(file, mounted.current && !working.current, (taken) => update((current) => fillFile(current, id, taken)));

  /** The paperclip of a text row of the human's: the row becomes a file row, and where the app can pick a file, it is picked now. */
  const toFile = (id: string) => {
    update((current) => toFileRow(current, id));
    if (canPickFiles) {
      void pickFile().then((file) => {
        if (file !== null) took(id)(file);
      });
    }
  };

  // A file dropped on the form but not on a file row is taken by nothing, and goes nowhere else either.
  useFileDrop(body, wipeFile);

  const checked = useMemo(() => checkForm(form), [form]);
  const labels = useMemo(() => new Map((state.view?.fields ?? []).map((field) => [field.key, field.label] as const)), [state.view]);
  const screen = dialogScreen(state);
  const locked = busy !== null;
  const arrowReady = busy === null && arrowAction(state, checked.entries !== null) !== null;

  return (
    <Modal title={formTitle(form.rows.length)} icon={<Icon name="ShieldCheck" size={18} color={colors.accent} />} open onOpenChange={(open) => (open ? undefined : close())}>
      {/* The host's own scrolling body: the sheet on a phone, with its swipe down and its keyboard handling, and on the desktop a box no taller than the form. */}
      <Modal.Content contentContainerStyle={{ padding: layout.compact ? 16 : 20, gap: 0 }}>
        <View ref={body} style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: colors.accent, fontFamily: MONO, fontSize: 11 }}>{FORM_BADGE}</Text>
            </View>
            <View style={{ flex: 1 }} />
            <IconButton icon="X" label={A11Y.decline} color={colors.muted} disabled={locked} onPress={pressDecline} />
          </View>

          {state.top === null ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="CircleAlert" size={14} color={colors.danger} />
              <Text {...ANNOUNCED} style={{ color: colors.danger, fontSize: 12, flexShrink: 1 }}>
                {state.top}
              </Text>
            </View>
          )}

          {screen === "form"
            ? form.rows.map((row) => {
                const error = checked.errors.get(row.id) ?? null;
                const onName = (key: string) => update((current) => setName(current, row.id, key));
                const onRemove = () => update((current) => removeRow(current, row.id));
                return row.value.kind === "text" ? (
                  <TextRow
                    key={row.id}
                    row={row}
                    hint={row.declared ? (labels.get(row.key) ?? "") : ""}
                    error={error}
                    colors={colors}
                    locked={locked}
                    onText={(text) => update((current) => setText(current, row.id, text))}
                    onName={onName}
                    onToFile={() => toFile(row.id)}
                    onRemove={onRemove}
                  />
                ) : (
                  <FileRow
                    key={row.id}
                    row={row}
                    hint={row.declared ? (labels.get(row.key) ?? "") : ""}
                    error={error}
                    colors={colors}
                    locked={locked}
                    onName={onName}
                    onFile={took(row.id)}
                    onClearFile={() => update((current) => clearFile(current, row.id))}
                    onRemove={onRemove}
                  />
                );
              })
            : null}

          {screen === "loading" ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
              {screen === "form" ? (
                <IconButton
                  icon="Plus"
                  label={A11Y.add}
                  color={colors.muted}
                  fill={colors.raised}
                  disabled={locked || form.rows.length >= LIMITS.fields}
                  onPress={() => update((current) => addRow(current, nextRow.current++))}
                />
              ) : null}
              <View style={{ flex: 1, alignItems: "center" }}>{screen === "form" && checked.total !== null ? <RowLine text={checked.total} colors={colors} /> : null}</View>
              <IconButton
                icon="ArrowRight"
                label={A11Y.submit}
                color={colors.onAccent}
                fill={colors.accent}
                busy={busy === "arrow"}
                disabled={!arrowReady}
                onPress={pressArrow}
              />
            </View>
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
}
