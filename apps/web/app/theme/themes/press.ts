import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Press — a print room after hours, neutral stone furniture with every colour
 * spent as ink on top of it. Rose is the masthead, chartreuse the correction
 * mark, amber the highlighter: three editorial voices only a ground with no hue
 * allegiance can host. The ink is a warm paper white — the one warmth in the
 * room — folders are cream stock, and files are the cool printed page.
 */
export const PRESS_THEME: ThemeDefinition = buildTheme({
  id: "press",
  label: "Press",
  blurb: "A print room after hours. Neutral stone furniture; all the colour is in the ink.",
  kind: "fixed",
  appearance: "dark",
  hues: { orbStates: { thinking: "#e8a94e" } },
  palette: {
    ground: "#101214",
    sunken: "#0b0c0d",
    raised: "#1b1e23",
    raisedHigh: "#22262c",

    ink: "#f2f1ef",
    inkSoft: "#c6c7c8",
    muted: "#98999c",
    faint: "#6f7175",

    accent: "#ef6398",
    accentInk: "#2b0d1a",
    accentSecondary: "#b5da43",
    accentSecondaryInk: "#232b07",
    highlight: "#e8a94e",

    // Cream stock reads as paper set down on the desk; the cool file keeps the
    // two object kinds apart by hue.
    folder: "#e8dfc5",
    file: "#b3bcc9",

    // Warn is pulled one note duller than the highlighter so a mark that means
    // "look" and a mark that means "careful" can never be confused.
    ok: "#57b97f",
    warn: "#d4923c",
    danger: "#e8695f",
    diffAdd: "#57b97f",
    diffDel: "#e8695f",

    codeBg: "#15171b",
    termBg: "#0c0d10",
    termInk: "#e2e1de",

    plasma: ["#0c0d10", "#241318", "#5c2a44"],
    ansi: {
      black: "#2e3136",
      red: "#e8715f",
      green: "#6fc289",
      yellow: "#dcae5a",
      blue: "#7f9fd9",
      magenta: "#e07bb0",
      cyan: "#6cc3c9",
      white: "#e2e1de",
      brightBlack: "#4b4f56",
      brightRed: "#f5876f",
      brightGreen: "#87d69f",
      brightYellow: "#f0c97e",
      brightBlue: "#9db5ea",
      brightMagenta: "#ee96c4",
      brightCyan: "#84d6dc",
      brightWhite: "#f2f1ef",
    },
  },
});
