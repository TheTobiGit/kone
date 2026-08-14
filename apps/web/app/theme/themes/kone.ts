import { ANSI, BOOST, DIFF, HUES, STATUS, SYNTAX } from "../semantics";
import type { ThemeDefinition } from "../roles";

/**
 * kone — the app's own appearance, and the reference every other theme is
 * measured against. Warm paper in light, near-black in dark, one warm accent.
 *
 * This is the only theme of kind `system`: it ships both schemes and follows the
 * OS the way the interface always has. It is also the only theme still authored
 * role by role instead of grown from a spec, and that is deliberate — switching
 * it on has to be visually invisible, so the values stay literal where they were
 * hand-picked and any later drift is a real regression rather than the migration.
 *
 * The roles added when the vocabulary grew are set here to the colour the
 * interface *already* paints in that spot — `strip` defers to the ground, `panel`
 * to the raised surface — so retokenising a component to the new role changes
 * nothing under kone while making the surface available to every other theme.
 */
export const KONE_THEME: ThemeDefinition = {
  id: "kone",
  label: "kone",
  blurb: "The app's own appearance. Follows your system light and dark.",
  kind: "adaptive",
  appearance: "light",

  colors: {
    light: {
      sunken: "#e9e8e5",
      ground: "#f6f5f3",
      band: "color-mix(in srgb, var(--ink) 2%, var(--ground))",
      raised: "#fffefb",
      raisedHigh: "#ffffff",
      overlay: "rgb(39 39 42 / 0.28)",
      strip: "var(--ground)",
      panel: "var(--raised)",
      field: "var(--raised-high)",
      chip: "#faf9f6",

      ink: "#27272a",
      inkSoft: "#52525b",
      muted: "#9c9a94",
      faint: "#b0afaa",
      placeholder: "#b7b4ae",

      line: "rgb(39 39 42 / 0.1)",
      lineSoft: "rgb(39 39 42 / 0.06)",

      hover: "rgb(39 39 42 / 0.04)",
      press: "rgb(39 39 42 / 0.08)",
      selected: "color-mix(in oklab, var(--accent) 12%, transparent)",
      focus: "var(--accent)",

      accent: "#d97757",
      accentInk: "#ffffff",
      accentWash: "color-mix(in oklab, var(--accent) 10%, transparent)",

      // The counter-hue to the terracotta: a deep teal, cool enough to be
      // unmistakably a second voice and dark enough to hold white on it.
      accentSecondary: "#2f7d78",
      accentSecondaryInk: "#ffffff",
      accentSecondaryWash: "color-mix(in oklab, var(--accent-2) 10%, transparent)",

      highlight: "#f0c674",
      highlightWash: "color-mix(in oklab, var(--highlight) 22%, transparent)",

      // The gold a folder glyph already carries, and a cool slate for files, so
      // the two kinds of object read as different at a glance.
      folder: "#c4a44a",
      file: "#7c8794",
      agent: "var(--accent)",
      boost: BOOST,

      ok: STATUS.light.ok!,
      warn: STATUS.light.warn!,
      danger: STATUS.light.danger!,

      diffAdd: DIFF.light.diffAdd!,
      diffDel: DIFF.light.diffDel!,
      diffAddSoft: DIFF.light.diffAddSoft!,
      diffDelSoft: DIFF.light.diffDelSoft!,

      codeBg: "color-mix(in srgb, var(--ink) 3%, var(--raised))",
      termBg: "var(--ground)",
      termInk: "var(--ink)",
      termCursor: "var(--accent)",
      termSelection: "color-mix(in oklab, var(--accent) 24%, transparent)",
    },

    dark: {
      sunken: "#000000",
      ground: "#070708",
      band: "color-mix(in srgb, var(--ink) 2%, var(--ground))",
      raised: "#18181a",
      raisedHigh: "#212124",
      overlay: "rgb(0 0 0 / 0.56)",
      strip: "var(--ground)",
      panel: "var(--raised)",
      field: "#101012",
      chip: "#202022",

      ink: "#f4f4f5",
      // Identical to `ink` on purpose-by-omission: this is a latent bug in
      // kone's own palette, left alone because fixing it would change what the
      // default theme renders. Every built theme derives a genuinely softer
      // value, so only kone is affected.
      inkSoft: "#f4f4f5",
      muted: "#8a8a90",
      faint: "#6b6b70",
      placeholder: "#6b6b72",

      line: "rgb(244 244 245 / 0.1)",
      lineSoft: "rgb(244 244 245 / 0.06)",

      hover: "rgb(244 244 245 / 0.06)",
      press: "rgb(244 244 245 / 0.1)",
      selected: "color-mix(in oklab, var(--accent) 12%, transparent)",
      focus: "var(--accent)",

      accent: "#d97757",
      accentInk: "#1b0f0a",
      accentWash: "color-mix(in oklab, var(--accent) 10%, transparent)",

      accentSecondary: "#5fc4bc",
      accentSecondaryInk: "#08201f",
      accentSecondaryWash: "color-mix(in oklab, var(--accent-2) 10%, transparent)",

      highlight: "#e0b153",
      highlightWash: "color-mix(in oklab, var(--highlight) 22%, transparent)",

      folder: "#c4a44a",
      file: "#9aa5b1",
      agent: "var(--accent)",
      boost: BOOST,

      ok: STATUS.dark.ok!,
      warn: STATUS.dark.warn!,
      danger: STATUS.dark.danger!,

      diffAdd: DIFF.dark.diffAdd!,
      diffDel: DIFF.dark.diffDel!,
      diffAddSoft: DIFF.dark.diffAddSoft!,
      diffDelSoft: DIFF.dark.diffDelSoft!,

      codeBg: "color-mix(in srgb, var(--ink) 4.5%, var(--raised))",
      termBg: "var(--ground)",
      termInk: "var(--ink)",
      termCursor: "var(--accent)",
      termSelection: "color-mix(in oklab, var(--accent) 24%, transparent)",
    },
  },

  extras: {
    light: {
      ansi: ANSI.light,
      syntax: SYNTAX.light,
      // The ambient floor glow. Its first stop is the ground itself, so the
      // gradient rises out of the page rather than sitting on top of it, and
      // warms toward the accent as it climbs.
      plasma: ["#f6f5f3", "#efe4dc", "#e4c1af"],
    },

    dark: {
      ansi: ANSI.dark,
      syntax: SYNTAX.dark,
      plasma: ["#070708", "#120d0a", "#43251a"],
    },
  },

  hues: HUES,
};
