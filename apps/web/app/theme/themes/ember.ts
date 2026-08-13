import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Ember — the same hearth at two times of day.
 *
 * Light is apricot paper that has been sitting near a fire: warm cream
 * surfaces, a terracotta accent that still holds dark ink, and a quiet teal.
 * Dark is the hearth after the fire died down to coals — a near-black charcoal
 * with a redder cast, and the same terracotta lifted out of it, glowing ember
 * rather than the peach of a different pigment. Teal is spent on the file
 * surfaces so the warmth always has a cool thing to push against: without it
 * the room reads as one temperature and the accent stops reading as warm. The
 * one rule is that terracotta must never become the boost colour — boost is
 * honey's job, so a heated button and a spent-mode state never have to share a
 * hue.
 */
export const EMBER_THEME: ThemeDefinition = buildTheme({
  id: "ember",
  label: "Ember",
  blurb: "Terracotta and teal, apricot paper and charcoal ember.",
  kind: "adaptive",
  hues: {
    orbStates: { thinking: "#d4a018" },
  },
  light: {
    ground: "#faf0e6",
    sunken: "#efe2d4",
    raised: "#fdf6ee",
    raisedHigh: "#fffaf4",

    ink: "#2a1f18",
    inkSoft: "#4a3a30",
    muted: "#726258",
    faint: "#8f8074",
    placeholder: "#8a7a6e",

    // Terracotta, not brick: red enough to read as fire rather than pottery, but
    // still deep enough to hold near-white ink on a primary surface.
    accent: "#c45228",
    // Pure white rather than the warm off-white of the other washed surfaces:
    // the terracotta is saturated enough that even the warm tint takes it under
    // the 4.5 floor, so the ink on it has to carry the full weight.
    accentInk: "#ffffff",
    accentSecondary: "#2a7574",
    accentSecondaryInk: "#f0fafa",
    highlight: "#d4a018",

    // Warm ochre folders, quiet teal files — the two kinds of object part ways
    // by hue, and the teal is what lets the paper read as apricot.
    folder: "#b07c28",
    file: "#3d6e6c",
    boost: "#d4a018",

    // A passing check has to sit apart from identity. The teal is the app's
    // second voice, so an ok that borrowed it would read as "another teal
    // thing" instead of "this passed"; green is the one hue no other role in
    // this palette owns.
    ok: "#1a7a52",
    warn: "#b07018",
    danger: "#c23030",
    diffAdd: "#1a7a52",
    diffDel: "#c23030",

    codeBg: "#f4e9dc",
    termBg: "#f0e6d8",
    termInk: "#3a2e26",

    // The glow rises out of the paper itself: ground first, then a terracotta
    // blush, then the lit ember tip.
    plasma: ["#faf0e6", "#f0d8c4", "#e8b090"],

    ansi: {
      black: "#4a3e34",
      red: "#c23030",
      green: "#1a7a52",
      yellow: "#b07018",
      blue: "#2a5a8a",
      magenta: "#8a3a5a",
      cyan: "#2a7574",
      white: "#5c5048",
      brightBlack: "#8a7a6e",
      brightRed: "#d14540",
      brightGreen: "#2a9470",
      brightYellow: "#d4a018",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c7a",
      brightCyan: "#3a9490",
      brightWhite: "#2a1f18",
    },
  },
  dark: {
    ground: "#161210",
    sunken: "#0e0b0a",
    raised: "#221c19",
    raisedHigh: "#2c2420",

    ink: "#f3ece4",
    inkSoft: "#c9bfb4",
    muted: "#9a8e84",
    faint: "#726860",
    placeholder: "#6e645c",

    // Ember, not peach. Peach would be a different pigment — pinker and
    // lighter, a tint that has abandoned the fire for the candle — and on this
    // dark it would flatten straight into the honey highlight instead of
    // holding its own warm edge. Keeping the dark accent the same terracotta
    // lifted toward the glow means light and dark read as one material under
    // two lights, which is the whole point of an adaptive pair.
    accent: "#e07a48",
    accentInk: "#241208",
    accentSecondary: "#5aafa8",
    accentSecondaryInk: "#0c1e1c",
    highlight: "#e0b24a",

    folder: "#d4a058",
    file: "#7ab0aa",
    boost: "#e0b24a",

    ok: "#4ec99a",
    warn: "#d4a04a",
    danger: "#e86b6b",
    diffAdd: "#4ec99a",
    diffDel: "#e86b6b",

    codeBg: "#1c1614",
    termBg: "#120e0c",
    termInk: "#e0d6cc",

    // Dark end is the coals, not the dusk: a redder near-black so the room
    // still smells of fire, with the ember tip rising out of it.
    plasma: ["#161210", "#2a1810", "#6a3a22"],

    ansi: {
      black: "#2a2420",
      red: "#e87979",
      green: "#4ec99a",
      yellow: "#e0b24a",
      blue: "#7aa2c8",
      magenta: "#c792a0",
      cyan: "#5aafa8",
      white: "#e0d6cc",
      brightBlack: "#4a423c",
      brightRed: "#ff8f8f",
      brightGreen: "#6edbb0",
      brightYellow: "#f0c86a",
      brightBlue: "#9fb8dc",
      brightMagenta: "#d8aeb8",
      brightCyan: "#7ac8c2",
      brightWhite: "#f3ece4",
    },
  },
});
