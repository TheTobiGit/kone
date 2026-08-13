import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Atelier — a sunlit drafting table.
 *
 * The cream ground carries the warmth of paper while staying neutral enough
 * that a whole day of code on it still reads as paper rather than sand. Petrol
 * teal does all the identity work, and it is deep enough to hold light text, so
 * it doubles as the strongest interactive surface in the app. Clay is deliberate
 * heat against that cool: it appears rarely, and only when something warm has
 * actually happened. Brass is the mark voice — search matches, badge dots, the
 * folder glyph — while files stay cool slate so the two kinds of object part
 * ways at a glance. The one rule is that clay must never climb to primary-button
 * level; the moment it does, the interface stops being one identity and becomes
 * a teal app and a terracotta app arguing.
 */
export const ATELIER_THEME: ThemeDefinition = buildTheme({
  id: "atelier",
  label: "Atelier",
  blurb: "A sunlit drafting table. Warm paper, petrol teal, clay when something runs.",
  kind: "fixed",
  appearance: "light",
  hues: { orbStates: { thinking: "#d18a1e" } },
  palette: {
    ground: "#f6f2ea",
    sunken: "#ece5d6",
    raised: "#faf7f0",
    raisedHigh: "#fffcf5",

    ink: "#26231f",
    inkSoft: "#403c33",
    muted: "#6b6455",
    faint: "#8a8272",

    // Deep enough that the light ink on it stays legible at type sizes, which is
    // what lets the accent carry the app's strongest interactive surfaces.
    accent: "#0a5c61",
    accentInk: "#f3faf7",
    accentSecondary: "#a84f2a",
    accentSecondaryInk: "#fbf1e9",
    highlight: "#d18a1e",

    // Warm for folders, cool slate for files — the two kinds of object separate
    // by hue rather than by shade.
    folder: "#ae7f27",
    file: "#55707f",

    ok: "#2a7a4a",
    warn: "#a15c07",
    danger: "#b3271e",
    diffAdd: "#2a7a4a",
    diffDel: "#b3271e",

    codeBg: "#f4efe3",
    termBg: "#f1ebdd",
    termInk: "#3a362c",

    ansi: {
      black: "#4a443a",
      red: "#b3271e",
      green: "#267042",
      yellow: "#96540a",
      blue: "#2e5c9e",
      magenta: "#8e3a6e",
      cyan: "#0f6b75",
      white: "#6e675a",
      brightBlack: "#857d6c",
      brightRed: "#d14532",
      brightGreen: "#3e8f60",
      brightYellow: "#a8760d",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c8b",
      brightCyan: "#2e8a90",
      brightWhite: "#2b2720",
    },
  },
});
