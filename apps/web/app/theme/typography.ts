/**
 * kone's typography vocabulary.
 *
 * A preference here names a *job* text does in the interface — the UI face, the
 * display serif, the code face, the composer's input face — never a single
 * hard-coded stack. Components reference the CSS variables this module writes
 * and nothing else, so a family or size change is a data change rather than a
 * code change.
 *
 * The catalog stays small on principle: every knob here has to be worth
 * persisting, validating and steering forever. When a surface needs a size
 * rather than a job, it derives it from a token instead of asking for a new
 * preference.
 *
 * The prefs model itself — the bounds, the clamps, the resolver — lives in the
 * shared protocol package so the shell's mirror normalizes with the very same
 * function instead of carrying its own copy of the ranges. This module keeps
 * only what paints: the shipped stacks and the root applier. Import the model
 * from here or from the protocol directly.
 */

export {
  DEFAULT_TYPOGRAPHY_PREFS,
  MAX_CODE_FONT_SIZE,
  MAX_COMPOSER_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_LINE_HEIGHT_BODY,
  MAX_MEASURE,
  MAX_TYPOGRAPHY_FAMILY_LENGTH,
  MIN_CODE_FONT_SIZE,
  MIN_COMPOSER_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_LINE_HEIGHT_BODY,
  MIN_MEASURE,
  clampCodeFontSize,
  clampComposerFontSize,
  clampInterfaceFontSize,
  clampLineHeightBody,
  clampMeasure,
  resolveTypographyPrefs,
} from "@kone/protocol/typography";
export type {
  TypographyFamilyKind,
  TypographyPrefs,
  TypographySizeKind,
  TypographyStoredCandidate,
} from "@kone/protocol/typography";
import {
  clampCodeFontSize,
  clampComposerFontSize,
  clampInterfaceFontSize,
  clampLineHeightBody,
  clampMeasure,
  resolveTypographyPrefs,
} from "@kone/protocol/typography";
import type { TypographyPrefs } from "@kone/protocol/typography";

export const TYPOGRAPHY_STORAGE_KEY = "kone.typography.prefs";

/** Shipped stacks. A custom family is always prepended to its matching stack
 *  so glyph coverage never regresses when the user names a face that lacks a
 *  glyph the interface needs. */
export const DEFAULT_SANS_STACK =
  '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif';
export const DEFAULT_SERIF_STACK = '"Fraunces", ui-serif, Georgia, "Times New Roman", serif';
export const DEFAULT_MONO_STACK =
  'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

function quoteFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

/**
 * Normalize a user-entered family (a single name or a comma-separated list)
 * into a safe CSS font-family list, or null when the input is effectively
 * empty. Empty means the shipped default stack, not a missing value.
 */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

/** Minimal root surface the applier needs. Narrower than HTMLElement so tests
 *  can hand it a stub without a DOM. */
export interface TypographyRoot {
  style: {
    fontSize: string;
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
}

/**
 * Paint resolved prefs onto the root element. Unset families remove the
 * override so the stylesheet defaults stay in charge. Sizes are always
 * written: the interface size drives the root font size (and with it every
 * rem-based dimension), while the composer and code sizes stay in absolute
 * pixels so they do not scale twice.
 */
export function applyTypographyVariables(root: TypographyRoot, prefs: TypographyPrefs): void {
  const resolved = resolveTypographyPrefs(prefs);
  const families: ReadonlyArray<readonly [variable: string, custom: string, fallback: string]> = [
    ["--font-sans", resolved.sans, DEFAULT_SANS_STACK],
    ["--font-serif", resolved.serif, DEFAULT_SERIF_STACK],
    ["--font-mono", resolved.mono, DEFAULT_MONO_STACK],
    ["--font-composer", resolved.composer, "var(--font-sans)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list === null) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(variable, `${list}, ${fallback}`);
    }
  }

  root.style.fontSize = `${clampInterfaceFontSize(resolved.sizeInterface)}px`;
  root.style.setProperty(
    "--font-size-composer",
    `${clampComposerFontSize(resolved.sizeComposer)}px`,
  );
  const code = clampCodeFontSize(resolved.sizeCode);
  root.style.setProperty("--font-size-code", `${code}px`);
  // The diff surfaces read their own hook for code text; keep them with code.
  root.style.setProperty("--diffs-font-size", `${code}px`);
  root.style.setProperty("--line-height-body", `${clampLineHeightBody(resolved.lineHeightBody)}`);
  root.style.setProperty("--measure", `${clampMeasure(resolved.measure)}ch`);

  if (resolved.smoothing) {
    root.style.setProperty("-webkit-font-smoothing", "antialiased");
  } else {
    root.style.removeProperty("-webkit-font-smoothing");
  }
}

/** Remove every runtime-owned typography property, handing the surface back to
 *  the stylesheet fallback. */
export function clearTypographyVariables(root: TypographyRoot): void {
  root.style.removeProperty("--font-sans");
  root.style.removeProperty("--font-serif");
  root.style.removeProperty("--font-mono");
  root.style.removeProperty("--font-composer");
  root.style.removeProperty("--font-size-composer");
  root.style.removeProperty("--font-size-code");
  root.style.removeProperty("--diffs-font-size");
  root.style.removeProperty("--line-height-body");
  root.style.removeProperty("--measure");
  root.style.removeProperty("-webkit-font-smoothing");
}
