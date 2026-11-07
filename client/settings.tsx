import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { clearDrop, readDiagnostics, selfTestBegin, selfTestFinish, type Diagnostics } from "../shared/contracts";
import { PASEO_SINCE, PLUGIN_VERSION } from "../shared/limits";
import { SETTINGS_BADGE, canDeleteAll, dotColor, statusRows, type StatusRow } from "./diagnostics-rows";
import { MONO } from "./fields";
import { messages, type Translate } from "./messages";
import { IDLE, RUNNING, runSelfTest, selfTestText, type SelfTestState } from "./self-test";
import { tone, type Tone } from "./tone";

/** How often the state is read again while the screen is open: a set that arrives or goes shows without leaving the screen. */
const REFRESH_MS = 5_000;

/** The shield, the name, and the version of the plugin with the Paseo it needs. */
function Header({ colors }: { colors: Tone }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}>
        <Icon name="ShieldCheck" size={20} color={colors.onAccent} />
      </View>
      <View style={{ flexShrink: 1 }}>
        <Text style={{ color: colors.text, fontWeight: "700", fontSize: 16 }}>secure-input</Text>
        <Text style={{ color: colors.muted, fontFamily: MONO, fontSize: 12 }}>{`v${PLUGIN_VERSION} · ${PASEO_SINCE}`}</Text>
      </View>
    </View>
  );
}

/**
 * Seals in the app, opens on the daemon: the same path a real value takes, with a dummy payload of the largest size a
 * submission can have. It runs on the press and not on the render. What a run comes to, and what is said of it, is
 * `self-test.ts`'s to decide; a spinner stands in the place of the result while it runs.
 */
function Encryption({ t, colors }: { t: Translate; colors: Tone }) {
  const begin = useRpc(selfTestBegin);
  const finish = useRpc(selfTestFinish);
  const [state, setState] = useState<SelfTestState>(IDLE);
  const running = state.kind === "running";

  async function run() {
    // At once: the screen says that it is running, not what the run before it found.
    setState(RUNNING);
    setState(await runSelfTest({ begin, finish, now: Date.now }));
  }

  return (
    <SettingsSection title={t("settings.encryption")}>
      <SettingsCard>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, alignItems: "flex-start" }}>
          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ color: colors.accent, fontFamily: MONO, fontSize: 11 }}>{SETTINGS_BADGE}</Text>
          </View>
        </View>
        <SettingsAction label={t("settings.thisDevice")} actionLabel={t("settings.check")} disabled={running} onPress={() => void run()} />
        {state.kind === "idle" ? null : (
          <SettingsRow label={t("settings.result")}>
            {running ? (
              <ActivityIndicator size="small" color={colors.muted} accessibilityLabel={t("selfTest.running")} />
            ) : (
              <Text style={{ color: state.kind === "passed" ? colors.success : colors.danger, fontFamily: MONO, fontSize: 12 }}>{selfTestText(t, state)}</Text>
            )}
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

/** A coloured dot and the value of a row. The dot is the colour of its state; the words say the same. */
function StatusValue({ row, colors }: { row: StatusRow; colors: Tone }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor(row.dot, colors) }} />
      <Text selectable style={{ color: colors.muted, fontFamily: MONO, fontSize: 12, flexShrink: 1 }}>
        {row.value}
      </Text>
    </View>
  );
}

/**
 * The four rows. The explanation is under a red row only (`error` of the row). Read-only: the RPC behind it is open to
 * agents too. A failed reading leaves the last answer in `data`; it is shown, and said to be old, instead of passing for current.
 */
function Status({ t, data, failed, colors }: { t: Translate; data: Diagnostics | undefined; failed: boolean; colors: Tone }) {
  const stale = <SettingsRow key="stale" label={t("settings.refresh")} error={t("settings.refreshFailed")} />;
  const rows: ReactElement[] =
    data === undefined
      ? [<SettingsRow key="reading" label={t(failed ? "settings.readFailed" : "settings.loading")} />]
      : [
          ...(failed ? [stale] : []),
          ...statusRows(t, data).map((row) => (
            <SettingsRow key={row.label} label={t(row.label)} error={row.explanation}>
              <StatusValue row={row} colors={colors} />
            </SettingsRow>
          )),
        ];
  return (
    <SettingsSection title={t("settings.status")}>
      <SettingsCard>{rows}</SettingsCard>
    </SettingsSection>
  );
}

/**
 * Deletes every set of files at once, and reads the state again. What the plugin could not remove shows in the rows that
 * are read. When the clear call fails (the plugin is stopping, `drop/` could not be swept), earlier removals may have
 * succeeded; one fixed line under the button, `settings.deleteFailed`, says that it failed until a press succeeds. The words of the
 * failure are not the screen's to show.
 */
function DeleteAll({ t, refresh }: { t: Translate; refresh(): Promise<unknown> }) {
  const clear = useRpc(clearDrop);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await clear({});
      setRefused(false);
    } catch {
      // The rows below, read again, say what is left.
      setRefused(true);
    }
    try {
      await refresh();
    } catch {
      // The reading failed: the rows say so, as old.
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ marginTop: 12 }}>
      <SettingsCard>
        <SettingsAction label={t("settings.deleteAll")} actionLabel={t("settings.delete")} error={refused ? t("settings.deleteFailed") : null} disabled={busy} onPress={() => void run()} />
      </SettingsCard>
    </View>
  );
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const colors = tone(theme.colors);
  const read = useRpc(readDiagnostics);
  const query = useQuery({ queryKey: ["secure-input", "diagnostics"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
  const data = query.data;

  return (
    <>
      <Header colors={colors} />
      <Encryption t={t} colors={colors} />
      <Status t={t} data={data} failed={query.isError} colors={colors} />
      {data !== undefined && canDeleteAll(data) ? <DeleteAll t={t} refresh={() => query.refetch()} /> : null}
    </>
  );
}
