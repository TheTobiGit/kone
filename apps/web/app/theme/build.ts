import { mixHex, readableInk, rotateHue, withLightness } from "./color";
import { ANSI, BOOST, DIFF, HUES, STATUS, SYNTAX } from "./semantics";
import type {
  AnsiPalette,
  ThemeColors,
  ThemeDefinition,
  ThemeExtras,
  ThemeHues,
  ThemeScheme,
} from "./roles";

/**
 * Growing a theme from the colours somebody actually chose.
 *
 * A theme is authored as a *spec*: the handful of decisions a designer wants to
 * make, and nothing else. `ground` and `accent` are the only required fields;
 * every other slot has a derivation behind it, so a two-line theme is a complete
 * one. Naming a slot is how you overrule the derivation for that slot alone —
 * the rest of the palette keeps deriving around the value you supplied.
 *
 * That shape is deliberate, and it is the reason this file exists rather than a
 * table of 47 hexes per theme. It is the same shape a theme-builder UI needs: a
 * form where every field is optional, each one previews immediately, and leaving
 * a field blank produces a sensible colour instead of a hole. When that UI is
 * built it should collect a `SchemeSpec` and call `buildScheme` — there is
 * nothing else to add, and nothing here assumes the spec came from source code.
 *
 * The derivation ratios are kone's own grammar. They are tuned so kone's
 * hand-picked values fall out of them within a point or two, which is what keeps
 * a generated theme from reading as a foreign dialect of the interface.
 */

/** One appearance's worth of authored intent. Only `ground` and `accent` required. */
export interface SchemeSpec {
  /** The page itself. Every surface is positioned relative to this. */
  ground: string;
  /** The primary voice — the colour the theme is recognised by. */
  accent: string;

  // ── Surfaces ──────────────────────────────────────────────────────────────
  sunken?: string;
  raised?: string;
  raisedHigh?: string;
  /** The rail down the side. Name it to move the sidebar off the surface ladder. */
  strip?: string;
  /** Docked panes and drawers. Defaults to sitting exactly on `raised`. */
  panel?: string;
  /** The inside of an input. */
  field?: string;
  /** A small removable token sitting on a field. */
  chip?: string;

  // ── Text ──────────────────────────────────────────────────────────────────
  ink?: string;
  inkSoft?: string;
  muted?: string;
  faint?: string;
  placeholder?: string;

  // ── The three voices ──────────────────────────────────────────────────────
  /** Text that has to stay legible on top of `accent`. Measured if omitted. */
  accentInk?: string;
  /**
   * The second voice. Omitted, it is the accent's split-complement at the same
   * perceived weight — a real counter-hue rather than a tint, so a green-led
   * theme does not become an interface made of green.
   */
  accentSecondary?: string;
  accentSecondaryInk?: string;
  /** The third and quietest voice: marks, live glows, search matches. */
  highlight?: string;

  // ── Domain identity ───────────────────────────────────────────────────────
  /** Project-board graphics. Defaults to the primary voice. */
  folder?: string;
  /** File cards and file glyphs. Defaults to the second voice, so the two differ. */
  file?: string;
  /** The conversation's own presence. Defaults to the primary voice. */
  agent?: string;
  /** The lit state of fast/turbo mode. */
  boost?: string;

  // ── Semantics. Omitted, these keep their conventional values. ─────────────
  ok?: string;
  warn?: string;
  danger?: string;
  diffAdd?: string;
  diffDel?: string;
  diffAddSoft?: string;
  diffDelSoft?: string;

  // ── Code and terminal ─────────────────────────────────────────────────────
  codeBg?: string;
  /** Name this to give the terminal a background of its own, off the app ground. */
  termBg?: string;
  termInk?: string;
  termCursor?: string;

  // ── Extras (canvas, xterm, highlighter) ───────────────────────────────────
  /** Three stops, dark end to light end. Must be literal hex; the shader parses hex only. */
  plasma?: readonly [string, string, string];
  /** Partial is fine — unnamed slots keep their conventional value. */
  ansi?: Partial<AnsiPalette>;
  syntax?: string;

  /**
   * The escape hatch: literal role values that beat everything above. For the
   * rare case a palette needs one surface that no ratio would have produced.
   */
  roles?: Partial<ThemeColors>;
}

type SpecMeta = {
  id: string;
  label: string;
  blurb: string;
  /** Merged over the shared table; omit unless the palette really needs it. */
  hues?: Partial<ThemeHues>;
};

/**
 * A theme as authored. The union is the light/dark policy expressed in the type
 * system: an adaptive theme has to supply both palettes, and a fixed theme
 * cannot supply a second one it would never render.
 */
export type ThemeSpec = SpecMeta &
  (
    | { kind: "system" | "adaptive"; light: SchemeSpec; dark: SchemeSpec }
    | { kind: "fixed"; appearance: ThemeScheme; palette: SchemeSpec }
  );

// ── Relational values ───────────────────────────────────────────────────────
// These describe a *proportion of another role* rather than a colour, so one
// string serves every theme: swapping the ground moves the surface, but the
// sentence stays true. They also mean an authored override to `ink` or `accent`
// propagates without the theme having to restate anything.
const REL = {
  band: "color-mix(in srgb, var(--ink) 2%, var(--ground))",
  line: "color-mix(in srgb, var(--ink) 10%, transparent)",
  lineSoft: "color-mix(in srgb, var(--ink) 6%, transparent)",
  selected: "color-mix(in oklab, var(--accent) 12%, transparent)",
  focus: "var(--accent)",
  accentWash: "color-mix(in oklab, var(--accent) 10%, transparent)",
  accentSecondaryWash: "color-mix(in oklab, var(--accent-2) 10%, transparent)",
  // The highlight wash carries more weight than the accent's: its whole job is
  // to be a visible mark behind text rather than a tint under a row. It is the
  // one wash that cannot be a single number for both schemes — the same fraction
  // that reads as a clear mark over a dark surface disappears into a near-white
  // one, so light is given the heavier pour.
  highlightWash: (light: boolean) =>
    `color-mix(in oklab, var(--highlight) ${light ? 34 : 22}%, transparent)`,
  panel: "var(--raised)",
  termBg: "var(--ground)",
  termInk: "var(--ink)",
  termCursor: "var(--accent)",
  termSelection: "color-mix(in oklab, var(--accent) 24%, transparent)",
} as const;

/**
 * The second voice, when a theme didn't name one.
 *
 * 152° rather than a straight 180° flip: a split-complement keeps the pair
 * clearly distinct while avoiding the mechanical, slightly sour look of exact
 * opposites. Lightness and chroma are held, so the two voices carry equal weight
 * and neither reads as the weaker one.
 */
function counterHue(accent: string): string {
  return rotateHue(accent, 152);
}

/**
 * The third voice, when a theme didn't name one. A short warm rotation off the
 * accent, pushed to a high lightness — a mark wants to read as *illuminated*
 * rather than as another coloured thing on the page.
 */
function glow(accent: string, scheme: ThemeScheme): string {
  return withLightness(rotateHue(accent, 74), scheme === "light" ? 0.86 : 0.8);
}

export function buildScheme(spec: SchemeSpec, scheme: ThemeScheme): ThemeColors {
  const g = spec.ground;
  const a = spec.accent;
  const status = STATUS[scheme];
  const diff = DIFF[scheme];

  const light = scheme === "light";

  // The text ladder. Ink is placed first because everything soft is a retreat
  // from ink back toward the ground, which is what keeps the steps even when a
  // theme overrides ink alone.
  const ink = spec.ink ?? mixHex(g, light ? "#000000" : "#ffffff", light ? 0.84 : 0.96);
  const inkSoft = spec.inkSoft ?? mixHex(ink, g, light ? 0.21 : 0.22);
  const muted = spec.muted ?? mixHex(ink, g, light ? 0.56 : 0.45);
  const faint = spec.faint ?? mixHex(ink, g, light ? 0.66 : 0.58);
  // Placeholder is the one step not measured against the ground: it is read on
  // the field, which in light sits above the ground rather than below it. Mixed
  // as far back as the rest of the ladder it would land a shade off the input
  // and stop being text, so light keeps it nearer the ink than the step order
  // alone suggests.
  const placeholder = spec.placeholder ?? mixHex(ink, g, light ? 0.62 : 0.7);

  // The surface ladder. In light it climbs toward white; in dark it lifts out of
  // the ground toward the ink, which is why the two halves are not symmetrical.
  const raised = spec.raised ?? (light ? mixHex(g, "#ffffff", 0.85) : mixHex(g, ink, 0.07));
  const raisedHigh = spec.raisedHigh ?? (light ? "#ffffff" : mixHex(g, ink, 0.11));
  const sunken = spec.sunken ?? (light ? mixHex(g, ink, 0.06) : mixHex(g, "#000000", 0.45));
  const field = spec.field ?? (light ? "var(--raised-high)" : mixHex(g, ink, 0.045));
  const chip = spec.chip ?? (light ? mixHex(g, "#ffffff", 0.6) : mixHex(g, ink, 0.1));
  // A sidebar reads as a different *place*, so it steps away from the ground
  // rather than up the content ladder: inward in light, downward in dark.
  const strip =
    spec.strip ??
    (light
      ? "color-mix(in srgb, var(--ink) 3%, var(--ground))"
      : "color-mix(in srgb, var(--sunken) 55%, var(--ground))");

  const accentSecondary = spec.accentSecondary ?? counterHue(a);
  const highlight = spec.highlight ?? glow(a, scheme);

  return {
    sunken,
    ground: g,
    band: REL.band,
    raised,
    raisedHigh,
    overlay: light
      ? "color-mix(in srgb, var(--ink) 28%, transparent)"
      : "color-mix(in srgb, #000 56%, transparent)",
    strip,
    panel: spec.panel ?? REL.panel,
    field,
    chip,

    ink,
    inkSoft,
    muted,
    faint,
    placeholder,

    line: REL.line,
    lineSoft: REL.lineSoft,

    hover: light
      ? "color-mix(in srgb, var(--ink) 4%, transparent)"
      : "color-mix(in srgb, var(--ink) 6%, transparent)",
    press: light
      ? "color-mix(in srgb, var(--ink) 8%, transparent)"
      : "color-mix(in srgb, var(--ink) 10%, transparent)",
    selected: REL.selected,
    focus: REL.focus,

    accent: a,
    // Measured rather than assumed: a pale accent needs dark ink on it, and a
    // theme that picked a pale accent should not have to remember to say so.
    accentInk: spec.accentInk ?? readableInk(a, mixHex(a, "#000000", 0.88), "#ffffff"),
    accentWash: REL.accentWash,

    accentSecondary,
    accentSecondaryInk:
      spec.accentSecondaryInk ??
      readableInk(accentSecondary, mixHex(accentSecondary, "#000000", 0.88), "#ffffff"),
    accentSecondaryWash: REL.accentSecondaryWash,

    highlight,
    highlightWash: REL.highlightWash(light),

    folder: spec.folder ?? a,
    file: spec.file ?? accentSecondary,
    agent: spec.agent ?? a,
    boost: spec.boost ?? BOOST,

    ok: spec.ok ?? status.ok!,
    warn: spec.warn ?? status.warn!,
    danger: spec.danger ?? status.danger!,

    diffAdd: spec.diffAdd ?? diff.diffAdd!,
    diffDel: spec.diffDel ?? diff.diffDel!,
    diffAddSoft: spec.diffAddSoft ?? diff.diffAddSoft!,
    diffDelSoft: spec.diffDelSoft ?? diff.diffDelSoft!,

    codeBg:
      spec.codeBg ??
      (light
        ? "color-mix(in srgb, var(--ink) 3%, var(--raised))"
        : "color-mix(in srgb, var(--ink) 4.5%, var(--raised))"),
    termBg: spec.termBg ?? REL.termBg,
    termInk: spec.termInk ?? REL.termInk,
    termCursor: spec.termCursor ?? REL.termCursor,
    termSelection: REL.termSelection,

    ...spec.roles,
  };
}

export function buildExtras(spec: SchemeSpec, scheme: ThemeScheme): ThemeExtras {
  const { ground: g, accent: a } = spec;

  // Every plasma stop is a literal hex on purpose: the shader parses hex
  // directly and silently falls back on anything else, so a `var()` here would
  // fail invisibly. The ramp starts *at* the ground so the glow rises out of the
  // page rather than sitting on top of it.
  const plasma: [string, string, string] =
    scheme === "light"
      ? [g, mixHex(g, a, 0.18), mixHex(g, a, 0.45)]
      : [g, mixHex(g, a, 0.05), mixHex(g, a, 0.29)];

  return {
    ansi: { ...ANSI[scheme], ...spec.ansi },
    syntax: spec.syntax ?? SYNTAX[scheme],
    plasma: spec.plasma ?? plasma,
  };
}

export function buildTheme(spec: ThemeSpec): ThemeDefinition {
  const hues: ThemeHues = {
    families: { ...HUES.families, ...spec.hues?.families },
    orbStates: { ...HUES.orbStates, ...spec.hues?.orbStates },
  };

  const base = { id: spec.id, label: spec.label, blurb: spec.blurb, hues };

  // A fixed theme ships exactly one scheme. Nothing fabricates the other: the
  // accessors in `roles.ts` fall back to `appearance`, so a single-scheme table
  // is safe everywhere, and the absence is what proves the theme never renders
  // an appearance nobody designed.
  if (spec.kind === "fixed") {
    return {
      ...base,
      kind: "fixed",
      appearance: spec.appearance,
      colors: { [spec.appearance]: buildScheme(spec.palette, spec.appearance) },
      extras: { [spec.appearance]: buildExtras(spec.palette, spec.appearance) },
    };
  }

  return {
    ...base,
    kind: spec.kind,
    appearance: "light",
    colors: {
      light: buildScheme(spec.light, "light"),
      dark: buildScheme(spec.dark, "dark"),
    },
    extras: {
      light: buildExtras(spec.light, "light"),
      dark: buildExtras(spec.dark, "dark"),
    },
  };
}
