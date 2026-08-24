/**
 * kone's theme vocabulary.
 *
 * A role is a *job* a colour does in the interface — the canvas, the ink on it,
 * the wash under a hovered row, the graphic that says "this is a folder" — never
 * a hue. Components reference roles and nothing else, so a theme swap is a data
 * change rather than a code change.
 *
 * The catalog stays small on principle: every role here has to be worth choosing
 * a value for in every theme, forever. When a component needs a shade rather
 * than a job, it reaches it with `color-mix()` over a role instead of asking for
 * a new one.
 *
 * What earns a role is a *distinct voice* — something a theme should be able to
 * point somewhere else on purpose. That is why there are three accent voices and
 * three domain-identity roles: a palette whose whole interface is tints of one
 * colour is a palette that was never really designed, and the vocabulary should
 * make the better version expressible.
 */

export const THEME_ROLES = [
  // Surfaces, from the bottom of the stack up. `strip` and `panel` are chrome
  // rather than content: the rail down the side and the docked panes. They sit
  // in the ladder but a theme is free to move either off it — a sidebar that
  // reads deeper than the page is a real design choice, not a mistake.
  "sunken",
  "ground",
  "band",
  "raised",
  "raisedHigh",
  "overlay",
  "strip",
  "panel",

  // Two surfaces that are neither content nor chrome: the inside of an input,
  // and the small removable token that sits on one. Both were already being
  // hand-painted per scheme in the composer, which is the tell that they are
  // jobs in their own right — a field that reads as "type here" is not just the
  // raised surface at another opacity.
  "field",
  "chip",

  // Text, in descending emphasis. `placeholder` is last because it is the only
  // one that must NOT look like text you can read — it is a prompt, and a theme
  // that makes it too strong makes every empty field look filled.
  "ink",
  "inkSoft",
  "muted",
  "faint",
  "placeholder",

  // Hairlines. kone leans on surface steps rather than borders, so there are
  // only two: one you are meant to notice and one you are not.
  "line",
  "lineSoft",

  // Interaction feedback.
  "hover",
  "press",
  "selected",
  "focus",

  // The primary voice: the brand accent, the ink that stays legible on top of
  // it, and its wash.
  "accent",
  "accentInk",
  "accentWash",

  // The second voice. Not a shade of the accent — a different hue that the
  // palette chose to sit beside it, so a theme can be green-led without every
  // surface turning green. Where it is allowed to appear is the theme's call.
  "accentSecondary",
  "accentSecondaryInk",
  "accentSecondaryWash",

  // The third voice, and the quietest: marks, live glows, search matches. It
  // exists so "something is happening here" doesn't have to borrow the accent.
  "highlight",
  "highlightWash",

  // Domain identity — the colours that say what *kind* of thing you are looking
  // at, in the parts of kone that have no equivalent in an ordinary app.
  // `folder` carries the project board's graphics, `file` the change cards and
  // file glyphs, `agent` the conversation's own presence. They are roles rather
  // than hardcoded hues precisely so a theme can decide that files are cream and
  // folders are brass, instead of both being the accent.
  "folder",
  "file",
  "agent",

  // The lit state of a boost — fast mode, turbo, "spend more to go quicker".
  // It is a role rather than a literal because three separate components were
  // each hardcoding the same gold, and because it is the one signal in kone that
  // means *expense* rather than success or failure.
  "boost",

  // Status. Kept close to convention — these carry meaning outside kone.
  "ok",
  "warn",
  "danger",

  // Diffstat. `diffAdd`/`diffDel` are the crisp pair used for numbers, dots and
  // badges; the `-Soft` pair is the warmer, lower-contrast one used in meta rows.
  "diffAdd",
  "diffDel",
  "diffAddSoft",
  "diffDelSoft",

  // Code and terminal surfaces. The terminal's 16-colour ANSI set is not a role
  // — it lives in the theme's `extras`, where it can stay a table.
  "codeBg",
  "termBg",
  "termInk",
  "termCursor",
  "termSelection",
] as const;

export type ThemeRole = (typeof THEME_ROLES)[number];

/**
 * A complete set of role values. Each value is any CSS colour expression — a
 * hex literal, an `rgb()` with alpha, or a `color-mix()` over another role.
 * Derived values are allowed on purpose: a theme should be able to say "2% ink
 * over the ground" once instead of hand-picking the result per scheme.
 */
export type ThemeColors = Readonly<Record<ThemeRole, string>>;

/** The two appearances an interface can render. */
export type ThemeScheme = "light" | "dark";

/** What the user chose for the appearance control. `system` follows the OS. */
export type AppearanceMode = ThemeScheme | "system";

/**
 * How a theme answers the light/dark question.
 *
 * - `system` — kone's own appearance. Ships both schemes and follows the OS (or
 *   the user's override). There is exactly one of these and it is the default.
 * - `adaptive` — a custom theme with two deliberately designed palettes, one per
 *   scheme, switching the same way `system` does.
 * - `fixed` — a theme designed as *one* appearance. It ships a single scheme and
 *   renders it whatever the OS is doing. A dark theme someone tuned for hours
 *   should not be guessed at in light mode; it should stay the theme it is.
 */
export type ThemeKind = "system" | "adaptive" | "fixed";

/** The 16 ANSI slots xterm expects, in its own naming. */
export type AnsiPalette = Readonly<{
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}>;

/**
 * Colour a theme owns that cannot be a CSS custom property, because it is read
 * by a canvas, a WebGL uniform, an xterm config or a highlighter — code that
 * never sees a stylesheet. Keeping it in the theme definition is what stops the
 * painted surfaces drifting away from the CSS ones.
 */
export type ThemeExtras = Readonly<{
  /** xterm's 16-colour set for this scheme. */
  ansi: AnsiPalette;
  /** The Shiki theme whose syntax colours sit correctly on `codeBg`. */
  syntax: string;
  /** The three-stop gradient the plasma shader mixes, dark end to light end. */
  plasma: readonly [string, string, string];
}>;

/**
 * Hues that identify a *kind of thing* rather than a surface: the tool families
 * and the turn-orb states. They are scheme-independent by design — a family hue
 * is part of how a tool is recognised, alongside its glyph and label, so it
 * holds still when the appearance changes.
 *
 * Every theme inherits kone's table unless it says otherwise. That default is
 * the ruling that tool identity outlives a theme swap; the override exists
 * because a palette far enough from kone's can need its own tuning to stay
 * legible, and that judgement belongs to the theme.
 */
export type ThemeHues = Readonly<{
  /** Tool families. `del` and `neutral` defer to roles, so they may be `var()`. */
  families: Readonly<Record<string, string>>;
  /** Turn-orb states, including the two non-family ones (`working`, `thinking`). */
  orbStates: Readonly<Record<string, string>>;
}>;

/**
 * A theme as the runtime consumes it.
 *
 * `colors` and `extras` are keyed by scheme but only guaranteed to hold the
 * schemes the theme actually ships — a `fixed` theme has exactly one. Nothing
 * reads them directly; `colorsFor`/`extrasFor` below are the accessors, and they
 * are what make a single-scheme theme safe to hand to code that was written when
 * every theme had two.
 */
export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  /** One line for the appearance pane — what the theme is, not how it works. */
  blurb: string;
  kind: ThemeKind;
  /**
   * The scheme the theme is designed around. For `fixed` this is the only
   * scheme it has and the one it always renders; for `system`/`adaptive` it is
   * the fallback when a requested scheme is somehow absent.
   */
  appearance: ThemeScheme;
  colors: Readonly<Partial<Record<ThemeScheme, ThemeColors>>>;
  extras: Readonly<Partial<Record<ThemeScheme, ThemeExtras>>>;
  hues: ThemeHues;
  /**
   * The marketplace extension this came from ("dracula-theme.theme-dracula"),
   * when it was imported from one. Lets the picker hide what's already here.
   */
  source?: string;
  /** True when the theme was authored by the user in the theme editor. */
  custom?: boolean;
  /** The authored spec the theme was built from, if preserved for editing. */
  spec?: unknown;
}>;

/**
 * Which scheme a theme renders, given what the user asked for.
 *
 * This is the whole light/dark policy in one function. A fixed theme ignores the
 * mode entirely — that is what makes it fixed — so selecting one is also the act
 * of opting out of the appearance control. Everything else follows the mode, and
 * `system` asks the OS.
 */
export function schemeFor(
  theme: ThemeDefinition,
  mode: AppearanceMode,
  systemDark: boolean,
): ThemeScheme {
  if (theme.kind === "fixed") return theme.appearance;
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

/** True when picking this theme takes the appearance control out of play. */
export function locksAppearance(theme: ThemeDefinition): boolean {
  return theme.kind === "fixed";
}

/** Role table for a scheme, falling back to the one the theme was designed as. */
export function colorsFor(theme: ThemeDefinition, scheme: ThemeScheme): ThemeColors {
  return theme.colors[scheme] ?? theme.colors[theme.appearance]!;
}

/** Canvas/terminal colour for a scheme, with the same fallback as `colorsFor`. */
export function extrasFor(theme: ThemeDefinition, scheme: ThemeScheme): ThemeExtras {
  return theme.extras[scheme] ?? theme.extras[theme.appearance]!;
}

/** The schemes a theme actually ships, in ladder order. */
export function schemesOf(theme: ThemeDefinition): readonly ThemeScheme[] {
  if (theme.kind === "fixed") return [theme.appearance];
  return (["light", "dark"] as const).filter((s) => theme.colors[s] != null);
}

/**
 * Role → custom property. Written out rather than derived from the role name so
 * the property names stay stable if a role is ever renamed, and so the existing
 * vocabulary (`--ground`, `--ink-soft`, `--accent`) survives untouched.
 */
export const THEME_VARIABLES = {
  sunken: "--sunken",
  ground: "--ground",
  band: "--band",
  raised: "--raised",
  raisedHigh: "--raised-high",
  overlay: "--overlay",
  strip: "--strip",
  panel: "--panel",
  field: "--field",
  chip: "--chip",

  ink: "--ink",
  inkSoft: "--ink-soft",
  muted: "--muted",
  faint: "--faint",
  placeholder: "--placeholder",

  line: "--line",
  lineSoft: "--line-soft",

  hover: "--hover",
  press: "--press",
  selected: "--selected",
  focus: "--focus",

  accent: "--accent",
  accentInk: "--accent-ink",
  accentWash: "--accent-wash",

  accentSecondary: "--accent-2",
  accentSecondaryInk: "--accent-2-ink",
  accentSecondaryWash: "--accent-2-wash",

  highlight: "--highlight",
  highlightWash: "--highlight-wash",

  folder: "--folder",
  file: "--file",
  agent: "--agent",
  boost: "--boost",

  ok: "--ok",
  warn: "--warn",
  danger: "--danger",

  diffAdd: "--diff-add",
  diffDel: "--diff-del",
  diffAddSoft: "--diff-add-soft",
  diffDelSoft: "--diff-del-soft",

  codeBg: "--code-bg",
  termBg: "--term-bg",
  termInk: "--term-ink",
  termCursor: "--term-cursor",
  termSelection: "--term-selection",
} satisfies Readonly<Record<ThemeRole, string>>;
