import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Cirrus — a high-key sky, lit from above.
 *
 * The ground is the most saturated in the set, a true sky tint that makes every
 * surface read as sunlit rather than painted. Violet, coral and lime sit roughly
 * a third of the wheel apart, so each arrives from a different direction and
 * none can be mistaken for another: violet is the identity, cool and deep enough
 * to carry light text; coral is the warm counterweight; lime is the electric
 * live voice. The one rule is where lime is spent — it marks running and active
 * things, and never settles onto resting furniture.
 */
export const CIRRUS_THEME: ThemeDefinition = buildTheme({
  id: "cirrus",
  label: "Cirrus",
  blurb: "High-key sky. Violet, coral and lime, each arriving from a different direction.",
  kind: "fixed",
  appearance: "light",
  hues: { orbStates: { thinking: "#70951c" } },
  palette: {
    ground: "#e9f0f6",
    sunken: "#dde6ef",
    raised: "#f6f9fb",
    raisedHigh: "#fbfdfe",

    ink: "#1d2430",
    inkSoft: "#39424f",
    muted: "#5a6575",
    faint: "#7c8794",

    accent: "#5b3fa8",
    accentInk: "#f5f2fc",
    accentSecondary: "#ad4a2c",
    accentSecondaryInk: "#fcf3ef",
    highlight: "#70951c",

    // The board's objects take an earthier warm tone so they stay warm against
    // the cool sky, while files stay steel-blue to keep the two kinds distinct.
    folder: "#a05f34",
    file: "#6c89a0",

    // The status green is held well away from the lime highlight: one means
    // "this passed" and the other means "this is running", and a glance has to
    // separate them without reading the label.
    ok: "#23734a",
    warn: "#92530a",
    danger: "#b22f24",
    diffAdd: "#23734a",
    diffDel: "#b22f24",

    codeBg: "#f3f6f9",
    termBg: "#eaf0f5",
    termInk: "#333c48",

    ansi: {
      black: "#47505b",
      red: "#b22f24",
      green: "#23734a",
      yellow: "#92530a",
      blue: "#31578f",
      magenta: "#8a3b6c",
      cyan: "#0f6b6e",
      white: "#5a636e",
      brightBlack: "#7b8592",
      brightRed: "#d14532",
      brightGreen: "#3e8f60",
      brightYellow: "#a8760d",
      brightBlue: "#4a74af",
      brightMagenta: "#a75c8b",
      brightCyan: "#2e8a90",
      brightWhite: "#2a2f38",
    },
  },
});
