import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Herbarium — green linen and pine.
 *
 * The ground is linen with a green cast: warm enough to feel alive, low-chroma
 * enough that text sits on it comfortably all day. Pine carries the identity,
 * and because it runs deep it keeps interactive weight without ever drifting
 * toward mint, while plum is the floral counter-note — a pairing that occurs in
 * actual plants, which is what makes it read as natural rather than assembled.
 * Apricot is the only pure warmth, and it is reserved for marks and glows. The
 * one rule is that the greens stay out of the status row: `ok` must remain
 * visibly apart from the accent, and plum must never become a link colour, or
 * identity, status and highlights stop being distinguishable.
 */
export const HERBARIUM_THEME: ThemeDefinition = buildTheme({
  id: "herbarium",
  label: "Herbarium",
  blurb: "Green linen and pine. The quietest light in the set.",
  kind: "fixed",
  appearance: "light",
  hues: { orbStates: { thinking: "#c26f24" } },
  palette: {
    ground: "#f0f2e8",
    sunken: "#e3e7d9",
    raised: "#f7f8f1",
    raisedHigh: "#fcfdf7",

    ink: "#20251e",
    inkSoft: "#3b4234",
    muted: "#5f6654",
    faint: "#7f8571",

    accent: "#1c5e40",
    accentInk: "#f2f7ed",
    accentSecondary: "#7c3a63",
    accentSecondaryInk: "#f8eef4",
    highlight: "#c26f24",

    // Folders read botanical-warm in olive-gold and files leaf-cool in sage,
    // so the two kinds of object are told apart by hue rather than by shade.
    folder: "#8c7a35",
    file: "#7e8c78",

    // ok is kept apart from the pine accent: a status has to be recognised at
    // a glance, and a state that mimics the identity colour would not be.
    ok: "#227246",
    warn: "#9a5b0b",
    danger: "#b03424",
    diffAdd: "#227246",
    diffDel: "#b03424",

    codeBg: "#f3f4ec",
    termBg: "#ecefe2",
    termInk: "#39402f",

    ansi: {
      black: "#474d3c",
      red: "#b03424",
      green: "#227246",
      yellow: "#92530a",
      blue: "#2e5c8f",
      magenta: "#8a3b6c",
      cyan: "#0f6b6e",
      white: "#5f6452",
      brightBlack: "#7e8571",
      brightRed: "#d14532",
      brightGreen: "#3e8f60",
      brightYellow: "#a8760d",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c8b",
      brightCyan: "#2e8a90",
      brightWhite: "#2b3025",
    },
  },
});
