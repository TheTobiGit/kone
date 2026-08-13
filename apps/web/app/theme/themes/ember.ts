import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Ember — warm all the way down, cooled on purpose in two places.
 *
 * A cream-and-terracotta light over a dusk-brown dark, the accent glowing
 * ember-orange in both. Left alone a palette this warm goes flat, so the second
 * voice is a deep teal and it is where the file surfaces live: the cool hue is
 * what makes the warmth read as warm.
 */
export const EMBER_THEME: ThemeDefinition = buildTheme({
  id: "ember",
  label: "Ember",
  blurb: "Terracotta and cream, cut with deep teal. Light and dark.",
  kind: "adaptive",
  light: {
    ground: "#fff6ef",
    accent: "#c4602f",
    accentSecondary: "#2a7d7a",
    highlight: "#f2c96b",
    folder: "#b08630",
    file: "#3f7c78",
  },
  dark: {
    ground: "#30231e",
    accent: "#f39a62",
    accentSecondary: "#62c2bd",
    highlight: "#e8c274",
    folder: "#dcb063",
    file: "#7fbdb8",
  },
});
