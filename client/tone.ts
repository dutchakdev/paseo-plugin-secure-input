import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Colors = PluginSurfaceProps["theme"]["colors"];

/** The colours a component draws with. Every `Text` takes its colour from here, so every colour comes from the theme. */
export interface Tone {
  surface: string;
  raised: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
}

/** Tokens added after SDK 0.8 can be missing on an older app. Fall back instead of rendering `undefined`. */
export function tone(colors: Colors): Tone {
  const optional = colors as Partial<Colors>;
  return {
    surface: colors.surface0,
    raised: optional.surface1 ?? colors.surface0,
    text: colors.foreground,
    muted: colors.foregroundMuted,
    accent: colors.accent,
    onAccent: colors.accentForeground,
    border: optional.border ?? "rgba(127,127,127,0.28)",
    success: optional.statusSuccess ?? colors.accent,
    // Of the three the muted colour is left: the accent stands for success and the plain text for danger, and the words
    // beside a dot say what it means all the same.
    warning: optional.statusWarning ?? colors.foregroundMuted,
    danger: optional.statusDanger ?? colors.foreground,
  };
}
