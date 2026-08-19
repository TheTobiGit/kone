import type { AnsiPalette, ThemeHues, ThemeScheme } from "./roles";

/**
 * The parts of a palette that are *meaning* rather than taste.
 *
 * A theme may retint any of this, but none of it is retinted by default, and the
 * reason is the same each time: these colours are read for what they say, not for
 * how they sit. A "new file" green that drifted toward a theme's ground would
 * still be a green, but it would have stopped being *the* green — and a diffstat
 * whose add and delete both bend toward the palette is a diffstat you have to
 * think about. Convention is the feature.
 *
 * Everything here is lifted from kone's own theme, so the default appearance is
 * unchanged by the existence of this module.
 */

/** Status colours, in the two schemes they have to survive. */
export const STATUS = {
  light: {
    ok: "#059669",
    warn: "#a57c2b",
    danger: "#e11d48",
  },
  dark: {
    ok: "#34d399",
    warn: "#c99b45",
    danger: "#f43f5e",
  },
} satisfies Readonly<Record<ThemeScheme, Readonly<Record<string, string>>>>;

/**
 * Diffstat. The crisp pair carries numbers, dots and badges; the soft pair is the
 * warmer, lower-contrast one that meta rows use so a file listing doesn't read as
 * a scoreboard.
 */
export const DIFF = {
  light: {
    diffAdd: "#059669",
    diffDel: "#e11d48",
    diffAddSoft: "#5f9e6a",
    diffDelSoft: "#c2745c",
  },
  dark: {
    diffAdd: "#059669",
    diffDel: "#e11d48",
    diffAddSoft: "#7fb98a",
    diffDelSoft: "#dc8a6f",
  },
} satisfies Readonly<Record<ThemeScheme, Readonly<Record<string, string>>>>;

/**
 * The terminal's 16 slots. A theme inherits these unless it supplies its own:
 * programs choose ANSI slots by number for reasons of their own, and a palette
 * that retints all sixteen toward one hue makes `ls` harder to read, not prettier.
 */
export const ANSI = {
  light: {
    black: "#3f3f46",
    red: "#c81e3a",
    green: "#0f8a5f",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0e7490",
    white: "#52525b",
    brightBlack: "#71717a",
    brightRed: "#e11d48",
    brightGreen: "#059669",
    brightYellow: "#d97706",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#0891b2",
    brightWhite: "#27272a",
  },
  dark: {
    black: "#3b3b42",
    red: "#f2726f",
    green: "#4ec9a6",
    yellow: "#e5b567",
    blue: "#7aa2f7",
    magenta: "#c9a2f0",
    cyan: "#6bd6c6",
    white: "#d4d4d8",
    brightBlack: "#5b5b63",
    brightRed: "#ff8f8b",
    brightGreen: "#79e3c0",
    brightYellow: "#f2cd88",
    brightBlue: "#9cb8ff",
    brightMagenta: "#dcb8ff",
    brightCyan: "#8ce8da",
    brightWhite: "#ffffff",
  },
} satisfies Readonly<Record<ThemeScheme, AnsiPalette>>;

/**
 * The lit state of a boost — fast mode and its kin. Gold in both schemes because
 * it means *this costs more*, and that reading survives the appearance changing.
 * A theme may override it; most should not.
 */
export const BOOST = "#f5b300";

/** The Shiki theme that sits correctly on each scheme's `codeBg`. */
export const SYNTAX = {
  light: "light-plus",
  dark: "dark-plus",
} satisfies Readonly<Record<ThemeScheme, string>>;

/**
 * Tool-family and turn-orb hues. Mid-tone on purpose, so one table reads on a
 * warm-light ground and on a near-black one alike — a tool keeps its hue across
 * appearances, the same way it keeps its glyph and its label.
 */
export const HUES: ThemeHues = {
  families: {
    read: "#5b9dd9",
    write: "#8b7ff0",
    search: "#d99a4e",
    intel: "#48b0b8",
    run: "#4fae86",
    web: "#3fa9c9",
    agent: "#d97aa8",
    del: "var(--diff-del)",
    neutral: "var(--muted)",
  },
  orbStates: {
    working: "#71717a",
    thinking: "#8b5cf6",
    read: "#5b9dd9",
    write: "#8b7ff0",
    search: "#d99a4e",
    intel: "#48b0b8",
    run: "#4fae86",
    web: "#3fa9c9",
    agent: "#d97aa8",
    del: "#d96b6b",
    neutral: "#71717a",
  },
};
