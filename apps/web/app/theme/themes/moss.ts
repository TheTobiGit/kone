import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Moss — a greenhouse after dark.
 *
 * The room is iron fittings and green-black glass: the surfaces are pushed just
 * off black into the moss, never toward olive-grey, so the mint accent reads as
 * the one living thing in it. Terracotta carries the counter-weight — the rust
 * that belongs in the moss — and violet stays the third voice alone, which is
 * what lets a live state bloom in a colour nothing else in the palette uses.
 */
export const MOSS_THEME: ThemeDefinition = buildTheme({
  id: "moss",
  label: "Moss",
  blurb: "A greenhouse after dark. Mint growth, olive-gold fittings, terracotta rust.",
  kind: "fixed",
  appearance: "dark",
  hues: { orbStates: { thinking: "#b39df2" } },
  palette: {
    ground: "#0f1211",
    sunken: "#0a0c0b",
    raised: "#1a1f1c",
    raisedHigh: "#212723",

    ink: "#eef2ec",
    inkSoft: "#c4cdc2",
    muted: "#96a098",
    faint: "#6d756e",

    accent: "#66d98a",
    accentInk: "#0d1f14",
    accentSecondary: "#d9845c",
    accentSecondaryInk: "#2a160c",
    highlight: "#b39df2",

    folder: "#d8c173",
    file: "#bccdba",

    // A step deeper than the accent: a passing check should read as settled
    // ground, never as the room's own mint identity.
    ok: "#4fae75",
    warn: "#d8a855",
    danger: "#e06d5e",
    diffAdd: "#4fae75",
    diffDel: "#e06d5e",

    codeBg: "#141a17",
    termBg: "#0b0e0c",
    termInk: "#dde5dc",

    plasma: ["#0b0e0c", "#152a1d", "#3d7a4e"],

    ansi: {
      black: "#2c332e",
      red: "#e07462",
      green: "#6fce8f",
      yellow: "#dcb25f",
      blue: "#86a5e0",
      magenta: "#b39df2",
      cyan: "#6fc4c0",
      white: "#dde5dc",
      brightBlack: "#4a524d",
      brightRed: "#f08979",
      brightGreen: "#83e2a4",
      brightYellow: "#eecf7d",
      brightBlue: "#9db9ee",
      brightMagenta: "#c9b6f5",
      brightCyan: "#88dcd7",
      brightWhite: "#eef2ec",
    },
  },
});
