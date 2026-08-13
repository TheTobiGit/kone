import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Ocean — the same harbour at two times of day.
 *
 * Both schemes are cut from the same pigment: a steel-water blue that holds
 * light ink in daylight and, lifted, reads as coloured light over near-black
 * water at night — never a sky. Coral is the one warm counter, and it owns the
 * folders, so the blue never has to mean "object". Honey is the mark voice —
 * search highlights, badges, the boost light — so marks never borrow the
 * accent. The light ground is cool paper, not a sky wash; the dark ground is
 * near-black water, not a mid blue-grey room.
 */
export const OCEAN_THEME: ThemeDefinition = buildTheme({
  id: "ocean",
  label: "Ocean",
  blurb: "Deep water and coral, paper daylight and night harbour.",
  kind: "adaptive",
  hues: { orbStates: { thinking: "#c49218" } },
  light: {
    ground: "#f3f5f6",
    sunken: "#e5eaee",
    raised: "#f8fafb",
    raisedHigh: "#ffffff",
    ink: "#1c242c",
    inkSoft: "#3a4550",
    muted: "#5f6d7a",
    faint: "#7e8b96",
    placeholder: "#74828e",
    accent: "#1c6288",
    accentInk: "#f3f9fc",
    // Sits a notch deeper than the plain coral so the light ink on it stays
    // readable at type sizes; the same value does the folder glyph, which shares
    // the ink-pair floor.
    accentSecondary: "#b9502e",
    accentSecondaryInk: "#fff5f0",
    highlight: "#c49218",
    folder: "#b9502e",
    file: "#5a7384",
    boost: "#c49218",
    ok: "#0e7a5c",
    warn: "#a56a12",
    danger: "#c23048",
    diffAdd: "#0e7a5c",
    diffDel: "#c23048",
    codeBg: "#eef2f4",
    termBg: "#e8eef2",
    termInk: "#2a3540",
    plasma: ["#f3f5f6", "#dce8f0", "#b7cfe0"],
    ansi: {
      black: "#3e464e",
      red: "#c23048",
      green: "#0e7a5c",
      yellow: "#a56a12",
      blue: "#1c6288",
      magenta: "#8a3a6e",
      cyan: "#0e7490",
      white: "#5a6570",
      brightBlack: "#74828e",
      brightRed: "#d1455c",
      brightGreen: "#1a9480",
      brightYellow: "#c49218",
      brightBlue: "#3a82b0",
      brightMagenta: "#a75c8b",
      brightCyan: "#2a8aa0",
      brightWhite: "#1c242c",
    },
  },
  dark: {
    ground: "#0c1318",
    sunken: "#080c10",
    raised: "#171e26",
    raisedHigh: "#1e2630",
    ink: "#e8eef3",
    inkSoft: "#c0ccd6",
    muted: "#8e9eab",
    faint: "#667888",
    placeholder: "#647686",
    // Steel-water, not sky: a sky accent would be a different, brighter pigment
    // that glows instead of holding the surface — and it would steal the
    // highlight's job, leaving honey nothing to mark.
    accent: "#5aa4c6",
    accentInk: "#0a1a24",
    accentSecondary: "#e07a58",
    accentSecondaryInk: "#2c120c",
    highlight: "#e0b24a",
    folder: "#e07a58",
    file: "#8aa3b5",
    boost: "#e0b24a",
    ok: "#4ec9a6",
    warn: "#d4a04a",
    danger: "#e86b78",
    diffAdd: "#4ec9a6",
    diffDel: "#e86b78",
    codeBg: "#121920",
    termBg: "#0a1014",
    termInk: "#d0dbe4",
    plasma: ["#0c1318", "#12202c", "#1e4a66"],
    ansi: {
      black: "#243038",
      red: "#e87979",
      green: "#4ec9a6",
      yellow: "#e0b24a",
      blue: "#5aa4c6",
      magenta: "#c792ea",
      cyan: "#5ec4d4",
      white: "#d0dbe4",
      brightBlack: "#4a5a66",
      brightRed: "#ff8f8f",
      brightGreen: "#6edbb8",
      brightYellow: "#f0c86a",
      brightBlue: "#7ab8d8",
      brightMagenta: "#d8aef4",
      brightCyan: "#7ed4e4",
      brightWhite: "#e8eef3",
    },
  },
});
