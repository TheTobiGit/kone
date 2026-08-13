import { buildTheme } from "../build";

/**
 * Forge — a workshop at last light.
 *
 * The surfaces are low-chroma umber darks, oiled and worn rather than grey;
 * they are what makes the room feel warm before any colour is spent. Copper is
 * the identity because it is the one saturated hue that reads as both precious
 * and utilitarian, and the teal across from it is a cold breath meant to keep
 * the room from overheating. Rose is held back for the tender signals — live
 * glows and search matches — and folders read as brass objects against
 * parchment files. The whole palette holds together only while the ground
 * keeps its warmth; the moment it drifts to grey-brown it becomes generic dark
 * UI with an orange button.
 */
export const FORGE_THEME = buildTheme({
  id: "forge",
  label: "Forge",
  blurb: "A workshop at last light. Ember surfaces, copper tools, one cold teal.",
  kind: "fixed",
  appearance: "dark",
  hues: { orbStates: { thinking: "#f2a9b8" } },
  palette: {
    ground: "#13110e",
    sunken: "#0b0a08",
    raised: "#201d17",
    raisedHigh: "#282420",
    ink: "#f4f0e8",
    inkSoft: "#c9c2b4",
    muted: "#9a9384",
    faint: "#716b5e",
    accent: "#e8925c",
    accentInk: "#241408",
    accentSecondary: "#5bc8c2",
    accentSecondaryInk: "#0c1f1d",
    highlight: "#f2a9b8",
    folder: "#e3c37d",
    file: "#cfc4a8",
    ok: "#6fbf7f",
    warn: "#cf8f3d",
    danger: "#d96a5e",
    diffAdd: "#6fbf7f",
    diffDel: "#d96a5e",
    codeBg: "#1a1712",
    termBg: "#0d0b09",
    termInk: "#ddd6c6",
    plasma: ["#0c0a08", "#2a1a0e", "#7c3f1d"],
    ansi: {
      black: "#34302a",
      red: "#e07a6a",
      green: "#7bbf8a",
      yellow: "#dab166",
      blue: "#7ea6c9",
      magenta: "#cc94a3",
      cyan: "#5bc8c2",
      white: "#ddd6c6",
      brightBlack: "#56504a",
      brightRed: "#f08d7d",
      brightGreen: "#8ed39e",
      brightYellow: "#ecc986",
      brightBlue: "#93bcdd",
      brightMagenta: "#e0aebb",
      brightCyan: "#7adbd5",
      brightWhite: "#f4f0e8",
    },
  },
});
