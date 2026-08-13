import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Iris — dusty violet and antique gold.
 *
 * One bloom, two times of day. The pigment is the same in both schemes: a deep
 * iris that holds light ink in the stone daylight, and that same dusty violet
 * lifted to hold dark ink in the indigo night. Violet is the interactive voice
 * — selected, pressed, live — while antique gold owns folders and the second
 * voice, and steel owns files. Putting the objects on gold and steel is what
 * keeps violet from ever meaning "document"; it stays free to mean *you are
 * here*.
 *
 * The light ground is cool stone with a whisper of violet, not a violet page.
 * A purple page would make the accent weather into the furniture: once every
 * surface is violet-tinged, the iris stops being a voice and becomes paint the
 * interface sits on. Stone lets the accent speak over the room instead.
 *
 * The dark accent is dusty rather than neon on purpose. A neon lavender is a
 * different pigment — it throws light rather than colour, and a room washed in
 * it loses the indigo warmth and turns cold. Dust keeps the accent the same
 * bloom as the day half, just lit from the dark.
 *
 * The mark voice is a honey brighter than the folder gold so a search match or
 * the thinking orb reads as lit, never as one more folder.
 */
export const IRIS_THEME: ThemeDefinition = buildTheme({
  id: "iris",
  label: "Iris",
  blurb: "Dusty violet and antique gold, stone daylight and indigo night.",
  kind: "adaptive",
  hues: { orbStates: { thinking: "#c49628" } },
  light: {
    ground: "#f5f4f6",
    sunken: "#e8e6ec",
    raised: "#faf9fb",
    raisedHigh: "#ffffff",

    ink: "#221e2a",
    inkSoft: "#3e3848",
    muted: "#6a6374",
    faint: "#8a8394",
    placeholder: "#7e7788",

    accent: "#5a3fa0",
    accentInk: "#f6f3ff",
    // A hair deeper than the folder's antique gold: the light ink on it needs
    // a 4.5:1 floor, and the gold is already at the pale edge of its family.
    accentSecondary: "#906a1c",
    accentSecondaryInk: "#fff8e8",
    highlight: "#c49628",

    // The object split: gold holds folders, steel holds files, so the two kinds
    // of thing separate by hue the way everything else in the theme does.
    folder: "#9a7420",
    file: "#4f738c",

    boost: "#c49628",
    ok: "#1a7a58",
    warn: "#a56a12",
    danger: "#c23048",
    diffAdd: "#1a7a58",
    diffDel: "#c23048",

    codeBg: "#eeeef2",
    termBg: "#eceaf0",
    termInk: "#322c3a",

    plasma: ["#f5f4f6", "#e4dcec", "#c4b4dc"],

    ansi: {
      black: "#3e3a46",
      red: "#c23048",
      green: "#1a7a58",
      yellow: "#9a7420",
      blue: "#4f738c",
      magenta: "#5a3fa0",
      cyan: "#2a7a8a",
      white: "#5c5666",
      brightBlack: "#7e7788",
      brightRed: "#d1455c",
      brightGreen: "#2a9470",
      brightYellow: "#c49628",
      brightBlue: "#6a8eaa",
      brightMagenta: "#7a5cb8",
      brightCyan: "#3a94a4",
      brightWhite: "#221e2a",
    },
  },
  dark: {
    ground: "#131018",
    sunken: "#0c0a12",
    raised: "#1e1a28",
    raisedHigh: "#262232",

    ink: "#eeeaf4",
    inkSoft: "#c6c0d4",
    muted: "#958eaa",
    faint: "#6e6880",
    placeholder: "#6c6680",

    accent: "#9b86d4",
    accentInk: "#1a1428",
    accentSecondary: "#d4b05a",
    accentSecondaryInk: "#2a1e0c",
    highlight: "#e0c06a",

    // Gold lifts with the night the way the violet does, and stays one warm
    // family up from the honey that marks things as lit.
    folder: "#d4b05a",
    file: "#8aacc4",

    boost: "#e0c06a",
    ok: "#4ec9a8",
    warn: "#d4a04a",
    danger: "#e86b78",
    diffAdd: "#4ec9a8",
    diffDel: "#e86b78",

    codeBg: "#18141f",
    termBg: "#0e0c14",
    termInk: "#dcd6e8",

    plasma: ["#131018", "#1e1830", "#4a3878"],

    ansi: {
      black: "#2a2634",
      red: "#e87979",
      green: "#4ec9a8",
      yellow: "#e0c06a",
      blue: "#8aacc4",
      magenta: "#9b86d4",
      cyan: "#6ec4c0",
      white: "#dcd6e8",
      brightBlack: "#4a4658",
      brightRed: "#ff8f8f",
      brightGreen: "#6edbb8",
      brightYellow: "#f0d48a",
      brightBlue: "#a8c4d8",
      brightMagenta: "#b8a4e8",
      brightCyan: "#8ed8d4",
      brightWhite: "#eeeaf4",
    },
  },
});
