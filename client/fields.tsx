import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { checkedFile, fileLine, fromPasted, takeFile, type FileValue } from "./file-entry";
import type { FormRow } from "./form-state";
import { A11Y, KEY_PLACEHOLDER, eye } from "./presentation";
import type { Tone } from "./tone";
import { canPickFiles, pickFile, useFileDrop } from "./web";

export const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * What stops an input from suggesting, completing or remembering what is typed in it. Every one of these exists on the
 * SDK's `TextInput` (React Native's own props).
 */
const PRIVATE_INPUT = {
  autoCapitalize: "none",
  autoCorrect: false,
  autoComplete: "off",
  spellCheck: false,
  textContentType: "none",
  importantForAutofill: "no",
} as const;

/** The box of a row: red when the row has a line under it, dashed while a file row waits for its file. */
function boxStyle(colors: Tone, error: boolean, dashed = false) {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 42,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 9,
    borderStyle: dashed ? "dashed" : "solid",
    borderColor: error ? colors.danger : colors.border,
    backgroundColor: colors.surface,
  } as const;
}

interface IconButtonProps {
  icon: string;
  label: string;
  /** What a screen reader says after the label: the agent's label of the field the button is for. None when empty. */
  hint?: string;
  color: string;
  onPress(): void;
  disabled?: boolean;
  /** A background for a button that stands by itself, as «+» and «→» do. */
  fill?: string;
  /** While what it started is under way: it shows an indicator in place of its icon, and takes no press. */
  busy?: boolean;
}

/** A control with an icon and no words: what it does is its accessibility label, in Ukrainian, and the field it is for its hint. */
export function IconButton({ icon, label, hint, color, onPress, disabled = false, fill, busy = false }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint === undefined || hint === "" ? undefined : hint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={6}
      style={{ width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: fill ?? "transparent", opacity: disabled && !busy ? 0.4 : 1 }}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={16} color={color} />}
    </Pressable>
  );
}

/**
 * Props that have a screen reader say a line the moment it appears, as a problem: the line under a row, and the one at
 * the top of the form. The role `alert` is a live region in the web build (the desktop app), and Android reads a polite
 * live region as it changes. iOS has no live region: VoiceOver reads the line when it comes to it.
 */
export const ANNOUNCED = { accessibilityRole: "alert", accessibilityLiveRegion: "polite" } as const;

/** A line under a row, in the colour of a problem, said to a screen reader as it appears. */
export function RowLine({ text, colors }: { text: string; colors: Tone }) {
  return (
    <Text {...ANNOUNCED} style={{ color: colors.danger, fontSize: 12, marginLeft: 4 }}>
      {text}
    </Text>
  );
}

/** The key of a field the agent asked for, inside the box on the left: dimmer when the field may stay empty. */
function KeyText({ row, colors }: { row: FormRow; colors: Tone }) {
  return (
    <Text numberOfLines={1} style={{ color: colors.muted, opacity: row.optional ? 0.55 : 1, fontFamily: MONO, fontSize: 12, flexShrink: 1, maxWidth: "45%" }}>
      {row.key}
    </Text>
  );
}

/** The name of a key the human adds. A name is not a secret, so it is shown as typed; a screen reader is told what it is. */
function NameInput({ row, colors, locked, onName }: { row: FormRow; colors: Tone; locked: boolean; onName(key: string): void }) {
  return (
    <TextInput
      value={row.key}
      onChangeText={onName}
      accessibilityLabel={A11Y.name}
      placeholder={KEY_PLACEHOLDER}
      placeholderTextColor={colors.muted}
      editable={!locked}
      {...PRIVATE_INPUT}
      autoCapitalize="characters"
      style={{ width: 120, paddingVertical: 8, paddingRight: 8, borderRightWidth: 1, borderRightColor: colors.border, color: colors.text, fontFamily: MONO, fontSize: 12 }}
    />
  );
}

interface RowProps {
  row: FormRow;
  /** The agent's label, which a screen reader reads as the hint of the row's controls. It is shown nowhere. */
  hint: string;
  /** The line under the row, from `checkForm`, or null. */
  error: string | null;
  colors: Tone;
  /** While the form is being sent: the row is faint and takes nothing. */
  locked: boolean;
  onName(key: string): void;
  onRemove(): void;
}

interface TextRowProps extends RowProps {
  onText(text: string): void;
  onToFile(): void;
}

/**
 * A row for a line of text: the key (or, in a row of the human's, the name they type), the value hidden on one line,
 * and the eye that shows it on the same line. A row of the human's has a paperclip that makes it a file row, and «✕».
 * A value of several lines goes through a file row, where its line breaks are kept. While the form is locked no control
 * of the row takes a press, the eye included.
 */
export function TextRow({ row, hint, error, colors, locked, onText, onName, onToFile, onRemove }: TextRowProps) {
  const [shown, setShown] = useState(false);
  const look = eye(shown);
  const text = row.value.kind === "text" ? row.value.text : "";
  return (
    <View style={{ gap: 4, opacity: locked ? 0.5 : 1 }}>
      <View style={boxStyle(colors, error !== null)}>
        {row.declared ? <KeyText row={row} colors={colors} /> : <NameInput row={row} colors={colors} locked={locked} onName={onName} />}
        <TextInput
          value={text}
          onChangeText={onText}
          secureTextEntry={!shown}
          editable={!locked}
          accessibilityLabel={row.key.trim() === "" ? undefined : row.key.trim()}
          accessibilityHint={hint === "" ? undefined : hint}
          {...PRIVATE_INPUT}
          style={{ flex: 1, paddingVertical: 8, color: colors.text, fontFamily: MONO, fontSize: 13 }}
        />
        <IconButton icon={look.icon} label={look.label} color={colors.muted} disabled={locked} onPress={() => setShown((current) => !current)} />
        {row.declared ? null : (
          <>
            <IconButton icon="Paperclip" label={A11Y.pick} color={colors.muted} disabled={locked} onPress={onToFile} />
            <IconButton icon="X" label={A11Y.remove} color={colors.muted} disabled={locked} onPress={onRemove} />
          </>
        )}
      </View>
      {error === null ? null : <RowLine text={error} colors={colors} />}
    </View>
  );
}

interface FileRowProps extends RowProps {
  /** A file picked, dropped or pasted. The form takes it only into an empty row, and wipes any it does not take. */
  onFile(file: FileValue): void;
  onClearFile(): void;
}

/**
 * A row for a whole file. Empty, it has the paperclip (where the app can pick files), the clipboard, which opens an area
 * under the row to paste into, and it takes a file dropped on it. Filled, it shows the file's name, size and check, and
 * «✕» to take it out. Its content is never shown; the paste area shows what is pasted while it is open, and when it
 * loses focus its text becomes the file and the area closes. The agent's label is the hint of each of its controls.
 */
export function FileRow({ row, hint, error, colors, locked, onName, onFile, onClearFile, onRemove }: FileRowProps) {
  const box = useRef<View>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const file = row.value.kind === "file" ? row.value.file : null;
  const line = useMemo(() => (file === null ? null : fileLine(file, row.format, checkedFile(file, row.format))), [file, row.format]);

  // A file is handed on only while the row is unlocked and mounted, and wiped otherwise (`takeFile`).
  const take = (value: FileValue) =>
    takeFile(value, !locked && alive.current, (taken) => {
      // Whatever filled the row, the paste area closes, and what was pasted into it is let go.
      setPasting(false);
      setPasted("");
      onFile(taken);
    });
  useFileDrop(box, take);
  const pick = () => {
    void pickFile().then((value) => {
      if (value !== null) take(value);
    });
  };
  const endPaste = () => {
    const value = fromPasted(pasted);
    setPasted("");
    setPasting(false);
    if (value !== null) take(value);
  };

  return (
    <View style={{ gap: 4, opacity: locked ? 0.5 : 1 }}>
      <View ref={box} style={boxStyle(colors, error !== null, file === null)}>
        {row.declared ? <KeyText row={row} colors={colors} /> : <NameInput row={row} colors={colors} locked={locked} onName={onName} />}
        {row.format === "any" ? null : <Text style={{ color: colors.muted, opacity: 0.7, fontFamily: MONO, fontSize: 11 }}>{row.format}</Text>}
        {line === null ? (
          <>
            <View style={{ flex: 1 }} />
            {canPickFiles ? <IconButton icon="Paperclip" label={A11Y.pick} hint={hint} color={colors.muted} disabled={locked} onPress={pick} /> : null}
            <IconButton icon="ClipboardPaste" label={A11Y.paste} hint={hint} color={colors.muted} disabled={locked} onPress={() => setPasting(true)} />
          </>
        ) : (
          <>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 12 }}>
              {line}
            </Text>
            <IconButton icon="X" label={A11Y.removeFile} hint={hint} color={colors.muted} disabled={locked} onPress={onClearFile} />
          </>
        )}
        {row.declared ? null : <IconButton icon="X" label={A11Y.remove} color={colors.muted} disabled={locked} onPress={onRemove} />}
      </View>
      {pasting ? (
        <TextInput
          value={pasted}
          onChangeText={setPasted}
          onBlur={endPaste}
          accessibilityLabel={A11Y.pasteArea}
          accessibilityHint={hint === "" ? undefined : hint}
          multiline
          autoFocus
          editable={!locked}
          {...PRIVATE_INPUT}
          style={{ minHeight: 96, padding: 8, borderWidth: 1, borderRadius: 9, borderColor: colors.accent, color: colors.text, fontFamily: MONO, fontSize: 12, textAlignVertical: "top" }}
        />
      ) : null}
      {error === null ? null : <RowLine text={error} colors={colors} />}
    </View>
  );
}
