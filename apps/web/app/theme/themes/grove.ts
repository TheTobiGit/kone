import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Grove — forest and copper, morning paper and night undergrowth.
 *
 * The two schemes are the same room at two times of day: the surface ladder,
 * the three voices and their jobs hold still, only the light moves. That is why
 * the accent must remain recognisably the same pigment in both — a yellow-green
 * forest deep enough in light to hold light ink on it, lifted to a leaf in dark.
 * Copper is the only warm counter, spent where something warm has actually
 * happened, and honey is the mark voice — search matches, badge dots, the lit
 * state of expense — never the button. The ground is stone-paper with a whisper
 * of moss in light, a near-black olive in dark: the weather around the accent,
 * not a green room of its own.
 */
export const GROVE_THEME: ThemeDefinition = buildTheme({
  id: "grove",
  label: "Grove",
  blurb: "Forest and copper, morning paper and night undergrowth.",
  kind: "adaptive",
  hues: { orbStates: { thinking: "#c4961c" } },
  light: {
    ground: "#f4f5f1",
    sunken: "#e6e8e2",
    raised: "#fafaf7",
    raisedHigh: "#ffffff",

    ink: "#1c221e",
    inkSoft: "#3a433c",
    muted: "#656e66",
    faint: "#858e86",
    placeholder: "#7a847c",

    // Deep enough that the light ink on it stays legible at type sizes, which
    // is what lets the accent carry the app's strongest interactive surfaces.
    accent: "#2f6b38",
    accentInk: "#f4faf4",
    accentSecondary: "#b4562e",
    accentSecondaryInk: "#fff4ed",
    highlight: "#c4961c",

    // Folders take the copper and files a cool slate, so the two kinds of
    // object part ways by hue rather than by shade.
    folder: "#a87c28",
    file: "#5c7382",

    // The lit state of expense borrows the honey voice — a brighter glow than
    // the folder amber it neighbours, never a second button colour.
    boost: "#c4961c",

    // ok is teal rather than the forest green: a status must not share the
    // identity colour, or "this worked" and "this is Grove" become the same
    // signal and every accent-tinted interactive thing starts reading as a
    // success.
    ok: "#0b7a62",
    warn: "#a56a12",
    danger: "#c2303a",
    diffAdd: "#0b7a62",
    diffDel: "#c2303a",

    codeBg: "#eef0ea",
    termBg: "#eceee8",
    termInk: "#2a322c",

    plasma: ["#f4f5f1", "#e4eadc", "#c5d4b4"],

    ansi: {
      black: "#4a4e48",
      red: "#c2303a",
      green: "#2a6a38",
      yellow: "#a56a12",
      blue: "#2f5f8a",
      magenta: "#8a3a6a",
      cyan: "#0b7a62",
      white: "#5c635c",
      brightBlack: "#7a847c",
      brightRed: "#d14548",
      brightGreen: "#3d8a48",
      brightYellow: "#c4961c",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c8b",
      brightCyan: "#1a9480",
      brightWhite: "#1c221e",
    },
  },
  dark: {
    ground: "#111410",
    sunken: "#0b0d0a",
    raised: "#1b1f19",
    raisedHigh: "#232822",

    ink: "#e9eee8",
    inkSoft: "#c2cbc0",
    muted: "#929c93",
    faint: "#6c756d",
    placeholder: "#6a736b",

    // The same yellow-green forest lifted toward a leaf so it reads as coloured
    // light rather than paint. It stays green-of-forest, not mint: mint would
    // be a different pigment — colder, paler — and the identity would change
    // with the clock.
    accent: "#7ab56a",
    accentInk: "#142014",
    accentSecondary: "#d4865a",
    accentSecondaryInk: "#2a140c",
    highlight: "#e0b445",

    folder: "#d4a45a",
    file: "#8aa0ae",

    boost: "#e0b445",

    ok: "#4ec9a8",
    warn: "#d4a04a",
    danger: "#e86b6b",
    diffAdd: "#4ec9a8",
    diffDel: "#e86b6b",

    codeBg: "#161a15",
    termBg: "#0d100c",
    termInk: "#d4ddd3",

    plasma: ["#111410", "#1a2418", "#3d5a32"],

    ansi: {
      black: "#2a2e28",
      red: "#e87979",
      green: "#7ab56a",
      yellow: "#e0b445",
      blue: "#7aa2c8",
      magenta: "#c792ea",
      cyan: "#4ec9a8",
      white: "#d4ddd3",
      brightBlack: "#4a5248",
      brightRed: "#ff8f8f",
      brightGreen: "#8ec97a",
      brightYellow: "#f0c86a",
      brightBlue: "#9fb8dc",
      brightMagenta: "#d8aef4",
      brightCyan: "#6edbb8",
      brightWhite: "#e9eee8",
    },
  },
});
