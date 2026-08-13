import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Tide — deep water at dusk, one lit channel across it.
 *
 * The surfaces are low-chroma blue-blacks that sit below the waterline, so the
 * whole room reads as submerged. Azure is the only colour allowed to stay lit
 * above it; coral is the warm harbour light coming back across the blue, and
 * lime is spent only on the most urgent marks — a signal flare, not a second
 * accent. Folders keep a warm gold and files a cool periwinkle so the two kinds
 * of object still separate by hue on all that cold water. The palette lives on
 * scarcity: if coral, lime and azure each show up everywhere it reads as
 * confetti instead of a tide with one lit channel.
 */
export const TIDE_THEME: ThemeDefinition = buildTheme({
  id: "tide",
  label: "Tide",
  blurb: "Deep water at dusk. Azure above the waterline, coral on the horizon.",
  kind: "fixed",
  appearance: "dark",
  hues: {
    orbStates: { thinking: "#aede4a" },
  },
  palette: {
    ground: "#0d1116",
    sunken: "#080b0f",
    raised: "#171d2a",
    raisedHigh: "#1e2535",

    ink: "#eef2f6",
    inkSoft: "#c2ccd8",
    muted: "#93a1b0",
    faint: "#69788a",

    accent: "#56bdf5",
    accentInk: "#0a1a2c",
    accentSecondary: "#f08a6e",
    accentSecondaryInk: "#33120a",
    highlight: "#aede4a",

    folder: "#e3c477",
    file: "#a9b8d8",

    ok: "#4fc08a",
    // One notch under the folder gold so it reads as status, not as an object.
    warn: "#e0ab4e",
    // Shares coral's family so an error and the warm landing stay on speaking terms.
    danger: "#ee6d62",
    diffAdd: "#4fc08a",
    diffDel: "#ee6d62",

    codeBg: "#10161f",
    termBg: "#0a0e14",
    termInk: "#dde5ee",

    plasma: ["#0a0e14", "#102741", "#2e6fa8"],
    ansi: {
      black: "#2b3644",
      red: "#ee7a6a",
      green: "#67cc8f",
      yellow: "#e6bc63",
      blue: "#6d9ee8",
      magenta: "#bf8ee8",
      cyan: "#5fd0d8",
      white: "#dde5ee",
      brightBlack: "#4a5a6d",
      brightRed: "#ff9384",
      brightGreen: "#7fe0a7",
      brightYellow: "#f6d488",
      brightBlue: "#86b1f2",
      brightMagenta: "#d5a8f0",
      brightCyan: "#7de3ea",
      brightWhite: "#eef2f6",
    },
  },
});
