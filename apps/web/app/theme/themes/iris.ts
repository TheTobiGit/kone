import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Iris — violet with antique gold.
 *
 * A lavender-white light and an indigo dark, the accent pulled from the same
 * bloom in both. Violet and gold is the oldest of the warm-cool splits and it
 * does the same work here it always has: the gold carries folders and marks, a
 * cooler blue carries files, and the violet is left to mean *selected* rather
 * than meaning everything.
 */
export const IRIS_THEME: ThemeDefinition = buildTheme({
  id: "iris",
  label: "Iris",
  blurb: "Violet lit by antique gold. Light and dark.",
  kind: "adaptive",
  light: {
    ground: "#f7f4fc",
    accent: "#7254b9",
    accentSecondary: "#a07a26",
    highlight: "#f0d68a",
    folder: "#a07a26",
    file: "#4f7fa8",
  },
  dark: {
    ground: "#29243b",
    accent: "#ad92f5",
    accentSecondary: "#dcb75a",
    highlight: "#ecd28c",
    folder: "#dcb75a",
    file: "#8fb4d4",
  },
});
