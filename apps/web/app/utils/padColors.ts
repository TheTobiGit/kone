// The pad's two colour ranges: a highlighter and a text colour.
//
// Neither is a literal colour here. A mark in the document carries only its
// *name* — `<mark data-hl="moss">`, `<span data-tc="sky">` — and the pad's
// stylesheet resolves that name to a wash or a hue per colour scheme. Two things
// fall out of that: the same saved document reads correctly on the light and the
// dark ground (an inline `rgba()` could only ever suit one of them), and nothing
// in the document carries an inline `style`, which is what made Chromium start
// stamping `color: …` onto everything typed after a highlight.
//
// So a swatch here is a `var()` reference into that same palette — the picker
// dot and the mark it paints can't drift apart. The copper of kone's own accent
// leads both rows.

export type PadColor = {
  id: string;
  label: string;
  /** What the picker's dot paints — a reference into the pad palette. */
  swatch: string;
};

export const PAD_HIGHLIGHTS: PadColor[] = [
  { id: "copper", label: "Copper", swatch: "var(--pad-hl-copper-dot)" },
  { id: "amber", label: "Amber", swatch: "var(--pad-hl-amber-dot)" },
  { id: "moss", label: "Moss", swatch: "var(--pad-hl-moss-dot)" },
  { id: "sky", label: "Sky", swatch: "var(--pad-hl-sky-dot)" },
  { id: "orchid", label: "Orchid", swatch: "var(--pad-hl-orchid-dot)" },
];

export const PAD_TEXT_COLORS: PadColor[] = [
  { id: "default", label: "Default", swatch: "var(--ink)" },
  { id: "copper", label: "Copper", swatch: "var(--pad-tc-copper)" },
  { id: "moss", label: "Moss", swatch: "var(--pad-tc-moss)" },
  { id: "sky", label: "Sky", swatch: "var(--pad-tc-sky)" },
  { id: "orchid", label: "Orchid", swatch: "var(--pad-tc-orchid)" },
  { id: "ash", label: "Ash", swatch: "var(--pad-tc-ash)" },
];

export function highlightById(id: string): PadColor {
  return PAD_HIGHLIGHTS.find((c) => c.id === id) ?? PAD_HIGHLIGHTS[0]!;
}

export function textColorById(id: string): PadColor {
  return PAD_TEXT_COLORS.find((c) => c.id === id) ?? PAD_TEXT_COLORS[0]!;
}

/** Guard against a stale marker (or a hand-edited document) naming a pen that
 *  no longer exists — an unknown name would resolve to no colour at all. */
export function isHighlightId(id: string): boolean {
  return PAD_HIGHLIGHTS.some((c) => c.id === id);
}

export function isTextColorId(id: string): boolean {
  return PAD_TEXT_COLORS.some((c) => c.id === id);
}
