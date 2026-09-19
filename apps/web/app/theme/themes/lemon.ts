import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Lemon — warm paper by day, pine-black by night.
 *
 * The light ground is a warm paper cream with olive in it, flat enough to read
 * all day without turning to sand. Deep pine carries the identity and is dark
 * enough to hold light ink at type sizes, so it doubles as the strongest
 * interactive surface. Fired clay is the warm counter across from the pine, and
 * lemon-gold is the mark voice — matches, glows, the thinking state — brighter
 * than any object so a mark never reads as furniture.
 *
 * The dark half is the same room after hours: pine-black olive grounds, the pine
 * lifted to sage so it reads as coloured light rather than paint, the clay
 * warmed to ember. The sidebar drops below the canvas in dark and sits a step
 * deeper than the page in light, so it stays a different place in both. Status
 * green is kept teal-leaning and apart from the pine on purpose: a state must
 * not share the identity pigment, or every primary surface starts reading as a
 * success.
 */
export const LEMON_THEME: ThemeDefinition = buildTheme({
  id: "lemon",
  label: "Lemon",
  blurb: "Warm paper and deep pine by day, pine-black and sage by night.",
  kind: "adaptive",
  hues: { orbStates: { thinking: "#b5891f" } },
  light: {
    ground: "#faf6eb",
    sunken: "#e9e2cf",
    raised: "#fffdf6",
    raisedHigh: "#ffffff",

    ink: "#292b21",
    inkSoft: "#43463a",
    muted: "#6c6e5e",
    faint: "#8c8d7a",
    placeholder: "#a3a294",

    // Deep enough to hold the light ink on it at type sizes, which is what lets
    // the pine carry the strongest interactive surfaces.
    accent: "#2e3d31",
    accentInk: "#f7f9f2",
    accentSecondary: "#a8542a",
    accentSecondaryInk: "#fbf1e9",
    highlight: "#c9971f",

    // Brass folders against sage-slate files, so the two kinds of object part
    // ways by hue rather than by shade.
    folder: "#a37d2a",
    file: "#6e7f72",

    boost: "#c9971f",

    ok: "#2e7d4f",
    warn: "#9a5f0a",
    danger: "#b3271e",
    diffAdd: "#2e7d4f",
    diffDel: "#b3271e",

    strip: "#f2ebd8",
    field: "#ffffff",
    chip: "#e9e7d8",

    codeBg: "#f3eee0",
    termBg: "#f1ebda",
    termInk: "#38392e",
    termCursor: "#2e3d31",

    plasma: ["#faf6eb", "#e9e4d0", "#cfc69c"],

    ansi: {
      black: "#4a4a3e",
      red: "#b3271e",
      green: "#2e7d4f",
      yellow: "#9a5f0a",
      blue: "#3a5c82",
      magenta: "#8a3b6c",
      cyan: "#0f6b6e",
      white: "#6b6a58",
      brightBlack: "#857e68",
      brightRed: "#d14532",
      brightGreen: "#3e8f60",
      brightYellow: "#c9971f",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c8b",
      brightCyan: "#2e8a90",
      brightWhite: "#292b21",
    },
  },
  dark: {
    ground: "#141711",
    sunken: "#0c0e0a",
    raised: "#1e221b",
    raisedHigh: "#272c23",

    ink: "#ece9db",
    inkSoft: "#cfc9b6",
    muted: "#a3a08c",
    faint: "#71705e",
    placeholder: "#6a6858",

    // The same pine lifted toward sage so it reads as coloured light over the
    // pine-black. It stays green-of-pine, not mint: mint would be a different
    // pigment and the identity would change with the clock.
    accent: "#93b981",
    accentInk: "#142013",
    accentSecondary: "#d4865a",
    accentSecondaryInk: "#2a140c",
    highlight: "#e0b445",

    folder: "#d4a45a",
    file: "#8aa092",

    boost: "#e0b445",

    // Teal-leaning rather than the sage: a passing state must stay visibly
    // apart from the lifted pine, or identity and status collapse into one.
    ok: "#4ec9a8",
    warn: "#d4a04a",
    danger: "#e87979",
    diffAdd: "#4ec9a8",
    diffDel: "#e87979",

    strip: "#0f120d",
    field: "#1a1e17",
    chip: "#2b3126",

    codeBg: "#181c15",
    termBg: "#0e110c",
    termInk: "#d8d4c2",
    termCursor: "#93b981",

    plasma: ["#141711", "#1c2418", "#3d5a32"],

    ansi: {
      black: "#2a2e26",
      red: "#e87979",
      green: "#4ec9a8",
      yellow: "#e0b445",
      blue: "#7aa2c8",
      magenta: "#c792ea",
      cyan: "#4ec9a8",
      white: "#d8d4c2",
      brightBlack: "#4a5244",
      brightRed: "#ff8f8f",
      brightGreen: "#8ed39e",
      brightYellow: "#f0c86a",
      brightBlue: "#9fb8dc",
      brightMagenta: "#d8aef4",
      brightCyan: "#6edbb8",
      brightWhite: "#ece9db",
    },
  },
});
