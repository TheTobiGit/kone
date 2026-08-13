import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Fresco — blush plaster and brick red.
 *
 * The warmest ground in the set, a blush plaster that makes the whole app feel
 * handcrafted rather than manufactured. Brick red is the identity: a confident
 * warm red that still holds light text cleanly, so the app's loudest voice is
 * also its most human one. Slate blue is brick's cool complement and does all
 * the structural, technical narration — code, metadata, settings — so warmth
 * and machinery never blur together, while gold sits beside the brick as the
 * mark voice. The one rule is how the colour is spent: the ground has to stay
 * a whisper, or the warmth turns into aggression.
 */
export const FRESCO_THEME: ThemeDefinition = buildTheme({
  id: "fresco",
  label: "Fresco",
  blurb: "Blush plaster and brick red. Handmade rather than manufactured.",
  kind: "fixed",
  appearance: "light",
  hues: { orbStates: { thinking: "#b07e1c" } },
  palette: {
    ground: "#f5eeea",
    sunken: "#e9e1dc",
    raised: "#f9f5f2",
    raisedHigh: "#fdfbf8",

    ink: "#2a211f",
    inkSoft: "#463b36",
    muted: "#6e6159",
    faint: "#8b7e75",

    accent: "#9c3f2a",
    accentInk: "#fbf2ed",
    accentSecondary: "#4a6479",
    accentSecondaryInk: "#eff3f6",
    highlight: "#b07e1c",

    // Folders are the warm object in tan-gold and files the cool one in slate,
    // so the two are told apart by hue rather than by shade.
    folder: "#a37d36",
    file: "#6e7d8e",

    // danger is pulled toward crimson and away from the brick accent, so a
    // destructive action can never be mistaken for the primary one.
    ok: "#267346",
    warn: "#92530a",
    danger: "#bd2440",
    diffAdd: "#267346",
    diffDel: "#bd2440",

    codeBg: "#f6f1ec",
    termBg: "#efe7e1",
    termInk: "#3d342e",

    ansi: {
      black: "#4a4038",
      red: "#b03424",
      green: "#267346",
      yellow: "#92530a",
      blue: "#3a5c82",
      magenta: "#8a3b6c",
      cyan: "#0f6b6e",
      white: "#6b6257",
      brightBlack: "#83786c",
      brightRed: "#d14532",
      brightGreen: "#3e8f60",
      brightYellow: "#a8760d",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c8b",
      brightCyan: "#2e8a90",
      brightWhite: "#2b2620",
    },
  },
});
