// The bead: a theme worn as an object rather than listed as values.
//
// A disc of the theme's own ground with its accent and secondary blurred into
// it from opposite corners — light *in* the ground, not a disc printed on it.
// Which corner depends on the scheme: a dark theme carries its accent low, a
// light one high, which is where each reads as lit rather than stained.
//
// One definition because the mark has to be the same wherever it appears — the
// appearance pane and a thread announcing a change are looking at the same
// theme, and a second recipe here is how two drawings of one thing drift apart.

import {
  colorsFor,
  schemesOf,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeScheme,
} from "./roles";

/** The two-gradient wash that fills a bead, as a `background-image`. */
export function beadWash(colors: ThemeColors, scheme: ThemeScheme): string {
  const accentAt = scheme === "dark" ? "30% 76%" : "70% 24%";
  const secondAt = scheme === "dark" ? "80% 20%" : "20% 80%";
  return [
    `radial-gradient(circle at ${accentAt} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} 62%, transparent) 30%, transparent 62%)`,
    `radial-gradient(circle at ${secondAt} in oklab, color-mix(in oklab, ${colors.accentSecondary} 42%, transparent) 0%, transparent 58%)`,
  ].join(", ");
}

/** One bead, ready to draw: the ground it sits in, the ink its hairline is cut
 *  from, and the wash that lights it. */
export interface Bead {
  key: ThemeScheme;
  ground: string;
  ink: string;
  wash: string;
}

export function beadFor(colors: ThemeColors, scheme: ThemeScheme): Bead {
  return { key: scheme, ground: colors.ground, ink: colors.ink, wash: beadWash(colors, scheme) };
}

/** A theme's beads — one per scheme it actually ships, so a fixed theme shows
 *  the single face it has rather than the same face twice. */
export function beadsOf(theme: ThemeDefinition): Bead[] {
  return schemesOf(theme).map((scheme) => beadFor(colorsFor(theme, scheme), scheme));
}
