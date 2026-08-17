import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Synara — electric cobalt on crisp daylight, slate indigo over obsidian night.
 *
 * Light is a crisp, bright paper ground with sharp graphite ink and an electric
 * cobalt accent. Violet serves as the second voice for file identities, while
 * amber marks search matches and glows.
 *
 * Dark is an obsidian ground with slate indigo for focus and controls, lifted by
 * soft violet highlights and bright status indicators.
 */
export const SYNARA_THEME: ThemeDefinition = buildTheme({
  id: "synara",
  label: "Synara",
  blurb: "Electric cobalt on crisp daylight, slate indigo over obsidian night.",
  kind: "adaptive",
  hues: {
    orbStates: { thinking: "#d97706" },
  },
  light: {
    ground: "#fcfcfc",
    sunken: "#ebebeb",
    raised: "#ffffff",
    raisedHigh: "#ffffff",

    ink: "#262626",
    inkSoft: "#4d4d4d",
    muted: "#787878",
    faint: "#a3a3a3",
    placeholder: "#8c8c8c",

    accent: "#526fff",
    accentInk: "#ffffff",
    accentSecondary: "#924ff7",
    accentSecondaryInk: "#ffffff",
    highlight: "#d97706",

    folder: "#526fff",
    file: "#924ff7",
    boost: "#d97706",

    ok: "#00a240",
    warn: "#d97706",
    danger: "#ba2623",
    diffAdd: "#00a240",
    diffDel: "#ba2623",

    field: "#ffffff",
    chip: "#f0f2fe",
    codeBg: "#f5f6fa",
    termBg: "#fcfcfc",
    termInk: "#262626",
    termCursor: "#526fff",

    strip: "#f5f5f7",

    plasma: ["#fcfcfc", "#eef1ff", "#d5dcff"],

    ansi: {
      black: "#262626",
      red: "#ba2623",
      green: "#00a240",
      yellow: "#d97706",
      blue: "#526fff",
      magenta: "#924ff7",
      cyan: "#0284c7",
      white: "#787878",
      brightBlack: "#8c8c8c",
      brightRed: "#dc2626",
      brightGreen: "#16a34a",
      brightYellow: "#f59e0b",
      brightBlue: "#6366f1",
      brightMagenta: "#a855f7",
      brightCyan: "#0ea5e9",
      brightWhite: "#171717",
    },
  },
  dark: {
    ground: "#0e0e0e",
    sunken: "#050505",
    raised: "#181818",
    raisedHigh: "#222222",

    ink: "#f5f5f5",
    inkSoft: "#d4d4d4",
    muted: "#a3a3a3",
    faint: "#737373",
    placeholder: "#666666",

    accent: "#6073cc",
    accentInk: "#ffffff",
    accentSecondary: "#ad7bf9",
    accentSecondaryInk: "#160e24",
    highlight: "#f5b44a",

    folder: "#6073cc",
    file: "#ad7bf9",
    boost: "#f5b44a",

    ok: "#40c977",
    warn: "#f5b44a",
    danger: "#fa423e",
    diffAdd: "#40c977",
    diffDel: "#fa423e",

    field: "#141414",
    chip: "#1d1d24",
    codeBg: "#141414",
    termBg: "#0e0e0e",
    termInk: "#f5f5f5",
    termCursor: "#6073cc",

    strip: "#090909",

    plasma: ["#0e0e0e", "#141724", "#252b4a"],

    ansi: {
      black: "#1e1e1e",
      red: "#fa423e",
      green: "#40c977",
      yellow: "#f5b44a",
      blue: "#6073cc",
      magenta: "#ad7bf9",
      cyan: "#38bdf8",
      white: "#d4d4d4",
      brightBlack: "#525252",
      brightRed: "#ff6b6b",
      brightGreen: "#5eead4",
      brightYellow: "#fde047",
      brightBlue: "#818cf8",
      brightMagenta: "#c084fc",
      brightCyan: "#67e8f9",
      brightWhite: "#f5f5f5",
    },
  },
});
