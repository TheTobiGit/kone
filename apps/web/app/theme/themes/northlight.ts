import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * Northlight — cool porcelain and indigo for precise, technical work.
 *
 * The ground is the flattest, most even surface in the set: a near-neutral cool
 * porcelain that holds almost no hue, so the eye never has to negotiate with it
 * during long diffing and review sessions. Indigo carries the identity at
 * exactly the depth where it still reads as colour rather than navy. Warmth is
 * rationed — the amber second voice is scarce, and the folder is the one warm
 * object on an otherwise cool board, which is what keeps it separable from the
 * cool-slate files. The failure mode is letting the gold leak into everyday
 * controls; spend it on domain objects and states only.
 */
export const NORTHLIGHT_THEME: ThemeDefinition = buildTheme({
  id: "northlight",
  label: "Northlight",
  blurb: "Cool porcelain and indigo. Warmth kept scarce on purpose.",
  kind: "fixed",
  appearance: "light",
  hues: { orbStates: { thinking: "#268e63" } },
  palette: {
    ground: "#f0f3f4",
    sunken: "#e4e9eb",
    raised: "#f7f9fa",
    raisedHigh: "#fcfdfe",

    ink: "#1d2129",
    inkSoft: "#3a3f47",
    muted: "#5d636d",
    faint: "#7e848e",

    accent: "#3947b3",
    accentInk: "#f7f8ff",
    accentSecondary: "#985f00",
    accentSecondaryInk: "#fff6e9",
    highlight: "#268e63",

    // Folders take the warm voice and files a cool slate, so the two kinds of
    // object are told apart by hue rather than by shade.
    folder: "#8a6a1f",
    file: "#7b8da6",

    // warn sits deeper than the amber second voice on purpose: a state should
    // read heavier than a decorated surface, not share its glow.
    ok: "#237a57",
    warn: "#8a5300",
    danger: "#b4231f",
    diffAdd: "#237a57",
    diffDel: "#b4231f",

    codeBg: "#f4f6f8",
    termBg: "#ecf0f3",
    termInk: "#33383f",

    ansi: {
      black: "#4e545c",
      red: "#b4231f",
      green: "#237a57",
      yellow: "#8f5b0a",
      blue: "#2e5c9e",
      magenta: "#8e3a6e",
      cyan: "#0f6b75",
      white: "#5e656c",
      brightBlack: "#7c838d",
      brightRed: "#d14432",
      brightGreen: "#3e8f63",
      brightYellow: "#a8760d",
      brightBlue: "#4a74b8",
      brightMagenta: "#a95c8e",
      brightCyan: "#2e8a95",
      brightWhite: "#2b2f36",
    },
  },
});
