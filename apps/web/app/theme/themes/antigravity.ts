import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Antigravity — clean studio daylight and deep obsidian night with electric blue.
 *
 * Light pairs a crisp, near-white studio ground with deep graphite ink and a
 * focused electric blue accent. Violet and amber provide balanced secondary and
 * highlight voices for structure and status.
 *
 * Dark balances an obsidian canvas with soft silver-grey ink, keeping the same
 * electric blue identity sharp and luminous across controls, focus rings, and
 * active indicators.
 */
export const ANTIGRAVITY_THEME: ThemeDefinition = buildTheme({
  id: "antigravity",
  label: "Antigravity",
  blurb: "Clean studio daylight and obsidian night, electric blue focus.",
  kind: "adaptive",
  hues: {
    orbStates: { thinking: "#007acc" },
  },
  light: {
    ground: "#f9f9f9",
    sunken: "#ebebeb",
    raised: "#ffffff",
    raisedHigh: "#ffffff",

    ink: "#101010",
    inkSoft: "#383838",
    muted: "#6e6e6e",
    faint: "#8e8e8e",
    placeholder: "#808080",

    accent: "#007acc",
    accentInk: "#ffffff",
    accentSecondary: "#7c3aed",
    accentSecondaryInk: "#ffffff",
    highlight: "#d97706",

    folder: "#007acc",
    file: "#7c3aed",
    boost: "#d97706",

    ok: "#059669",
    warn: "#d97706",
    danger: "#e11d48",
    diffAdd: "#059669",
    diffDel: "#e11d48",

    field: "#ffffff",
    chip: "#eef2f7",
    codeBg: "#f4f4f4",
    termBg: "#f9f9f9",
    termInk: "#101010",
    termCursor: "#007acc",

    strip: "#f2f2f2",

    plasma: ["#f9f9f9", "#e8f2fa", "#cce3f5"],

    ansi: {
      black: "#101010",
      red: "#cd3131",
      green: "#00a240",
      yellow: "#d97706",
      blue: "#007acc",
      magenta: "#7c3aed",
      cyan: "#0598bc",
      white: "#6e6e6e",
      brightBlack: "#8e8e8e",
      brightRed: "#e11d48",
      brightGreen: "#059669",
      brightYellow: "#f59e0b",
      brightBlue: "#2563eb",
      brightMagenta: "#9333ea",
      brightCyan: "#0891b2",
      brightWhite: "#101010",
    },
  },
  dark: {
    ground: "#101010",
    sunken: "#080808",
    raised: "#181818",
    raisedHigh: "#222222",

    ink: "#cccccc",
    inkSoft: "#a8a8a8",
    muted: "#787878",
    faint: "#6e6e6e",
    placeholder: "#626262",

    accent: "#007acc",
    accentInk: "#ffffff",
    accentSecondary: "#9d72e8",
    accentSecondaryInk: "#150d24",
    highlight: "#f5b44a",

    folder: "#569cd6",
    file: "#9d72e8",
    boost: "#f5b44a",

    ok: "#40c977",
    warn: "#f5b44a",
    danger: "#fa423e",
    diffAdd: "#40c977",
    diffDel: "#fa423e",

    field: "#161616",
    chip: "#1d1d24",
    codeBg: "#161616",
    termBg: "#101010",
    termInk: "#cccccc",
    termCursor: "#007acc",

    strip: "#0b0b0b",

    plasma: ["#101010", "#0c1b26", "#093859"],

    ansi: {
      black: "#1e1e1e",
      red: "#f44747",
      green: "#6a9955",
      yellow: "#dcdcaa",
      blue: "#569cd6",
      magenta: "#c586c0",
      cyan: "#4ec9b0",
      white: "#cccccc",
      brightBlack: "#787878",
      brightRed: "#ff6b6b",
      brightGreen: "#b5cea8",
      brightYellow: "#ce9178",
      brightBlue: "#9cdcfe",
      brightMagenta: "#dcb8ff",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    },
  },
});
