import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Ocean — cool blue warmed at the edges.
 *
 * Light is a washed sky with a nautical accent; dark sinks to deep water lit by
 * aqua. Coral is the counter-hue in both, which is what keeps the palette from
 * reading as cold: the warm voice lands on folders and on anything that wants to
 * be found, while files stay steel and recede.
 */
export const OCEAN_THEME: ThemeDefinition = buildTheme({
  id: "ocean",
  label: "Ocean",
  blurb: "Deep water blue with a coral counterweight. Light and dark.",
  kind: "adaptive",
  light: {
    ground: "#f2f7fb",
    accent: "#2878b8",
    accentSecondary: "#c4693f",
    highlight: "#f2d08a",
    folder: "#c4693f",
    file: "#5f7d92",
  },
  dark: {
    ground: "#1b2938",
    accent: "#70b9ee",
    accentSecondary: "#f0a077",
    highlight: "#e8c06a",
    folder: "#f0a077",
    file: "#a8bccc",
  },
});
