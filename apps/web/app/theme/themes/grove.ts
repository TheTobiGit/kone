import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Grove — forest green led, but not made of green.
 *
 * The identity is the deep forest accent; everything the accent doesn't own goes
 * to copper, its split-complement, and to a honey highlight between them. Folders
 * take the copper and files take a cool slate, so the two kinds of object are
 * told apart by hue rather than by shade, and the green stays a voice instead of
 * becoming the weather.
 */
export const GROVE_THEME: ThemeDefinition = buildTheme({
  id: "grove",
  label: "Grove",
  blurb: "Forest green against copper and honey. Light and dark.",
  kind: "adaptive",
  light: {
    ground: "#f2f8f4",
    accent: "#19734a",
    accentSecondary: "#b4623a",
    highlight: "#f0c96a",
    folder: "#a9702f",
    file: "#64798a",
  },
  dark: {
    ground: "#1d2b24",
    accent: "#69d69a",
    accentSecondary: "#e09a6a",
    highlight: "#e6b85c",
    folder: "#d9a35f",
    file: "#9fb2c0",
  },
});
