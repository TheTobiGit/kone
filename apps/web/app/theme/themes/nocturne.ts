import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Nocturne — violet-black night shift.
 *
 * The ground is a violet-tinted near-black, kept almost free of saturation so
 * the accent reads as coloured light in a dark room rather than paint on a wall.
 * Amber is the warm counterweight the violet needs to keep from going cold and
 * dead, while cyan stays the scarce third voice, spent only on live and moving
 * signals. The palette's one rule is economy: violet must never wash across
 * every surface, and amber must never creep into the conversation thread.
 */
export const NOCTURNE_THEME: ThemeDefinition = buildTheme({
  id: "nocturne",
  label: "Nocturne",
  blurb: "Violet-black night shift. Amber for warmth, cyan for anything live.",
  kind: "fixed",
  appearance: "dark",
  hues: { orbStates: { thinking: "#6fd9ec" } },
  palette: {
    ground: "#0f1018",
    sunken: "#090910",
    raised: "#1a1c2e",
    raisedHigh: "#222438",

    ink: "#f0f1f6",
    inkSoft: "#c3c6d6",
    muted: "#9498ae",
    faint: "#6d7186",

    accent: "#a78bfa",
    accentInk: "#17122e",
    accentSecondary: "#f2c063",
    accentSecondaryInk: "#2a1d0e",
    highlight: "#6fd9ec",

    // Folders take the warm voice and files a cool slate, so the two kinds of
    // object are told apart by hue rather than by shade.
    folder: "#e8c06a",
    file: "#a8b0d0",

    // warn sits deeper than folder on purpose: a state should read heavier than
    // a decorated surface, not share its cheer.
    ok: "#5cdb8a",
    warn: "#e5b04e",
    danger: "#ef6f6f",
    diffAdd: "#5cdb8a",
    diffDel: "#ef6f6f",

    codeBg: "#131523",
    termBg: "#0b0c13",
    termInk: "#d6d9e4",

    plasma: ["#0c0d17", "#221a3c", "#523a8e"],

    ansi: {
      black: "#2a2d3a",
      red: "#e87979",
      green: "#7bd88f",
      yellow: "#e5c07b",
      blue: "#8b9df2",
      magenta: "#c792ea",
      cyan: "#6fd9ec",
      white: "#d6d9e4",
      brightBlack: "#4a4e5f",
      brightRed: "#ff8f8f",
      brightGreen: "#8ce9a5",
      brightYellow: "#f2d18f",
      brightBlue: "#9fb1ff",
      brightMagenta: "#d8aef4",
      brightCyan: "#8fe6f5",
      brightWhite: "#f0f1f6",
    },
  },
});
