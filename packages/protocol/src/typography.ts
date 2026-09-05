/**
 * The typography prefs both ends of the app:state mirror agree on.
 *
 * The renderer owns these values — it persists them, paints them, and pushes
 * them across IPC — and the shell keeps a copy so gateway tools can describe
 * what is on screen. The bounds live here so the two ends can never disagree
 * about what a valid size is: the renderer clamps with `resolveTypographyPrefs`
 * before pushing, and the shell normalizes with the same function instead of
 * carrying its own copy of the ranges.
 *
 * Everything here stays environment-agnostic (no DOM, no node builtins) so the
 * main process and the renderer import it directly.
 */

/** The faces text can wear. `composer` is the input well's face. */
export type TypographyFamilyKind = "sans" | "serif" | "mono" | "composer";

/** The sizes text can take. `interface` drives the root font size. */
export type TypographySizeKind = "interface" | "composer" | "code";

/** Everything the typography layer owns. Strings are custom family names the
 *  user typed; an empty string means the shipped default stack. */
export interface TypographyPrefs {
  sans: string;
  serif: string;
  mono: string;
  composer: string;
  sizeInterface: number;
  sizeComposer: number;
  sizeCode: number;
  lineHeightBody: number;
  measure: number;
  smoothing: boolean;
}

/** What storage or a steering patch may carry: any subset of the prefs, as
 *  read from an older build or a mutation that names only what it changes. */
export interface TypographyStoredCandidate extends Partial<TypographyPrefs> {
}

export const DEFAULT_TYPOGRAPHY_PREFS: Readonly<TypographyPrefs> = {
  sans: "",
  serif: "",
  mono: "",
  composer: "",
  sizeInterface: 16,
  sizeComposer: 14,
  sizeCode: 12,
  lineHeightBody: 1.55,
  measure: 68,
  smoothing: true,
};

export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const MIN_COMPOSER_FONT_SIZE = 12;
export const MAX_COMPOSER_FONT_SIZE = 20;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const MIN_LINE_HEIGHT_BODY = 1.35;
export const MAX_LINE_HEIGHT_BODY = 1.8;
export const MIN_MEASURE = 55;
export const MAX_MEASURE = 80;

/** A family name past this is truncated, not refused: a pasted stack stays
 *  usable rather than failing the whole push. */
export const MAX_TYPOGRAPHY_FAMILY_LENGTH = 240;

function clampNumber(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampInterfaceFontSize(value: number): number {
  return Math.round(
    clampNumber(
      value,
      MIN_INTERFACE_FONT_SIZE,
      MAX_INTERFACE_FONT_SIZE,
      DEFAULT_TYPOGRAPHY_PREFS.sizeInterface,
    ),
  );
}

export function clampComposerFontSize(value: number): number {
  return Math.round(
    clampNumber(
      value,
      MIN_COMPOSER_FONT_SIZE,
      MAX_COMPOSER_FONT_SIZE,
      DEFAULT_TYPOGRAPHY_PREFS.sizeComposer,
    ),
  );
}

export function clampCodeFontSize(value: number): number {
  return Math.round(
    clampNumber(value, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_TYPOGRAPHY_PREFS.sizeCode),
  );
}

export function clampLineHeightBody(value: number): number {
  const clamped = clampNumber(
    value,
    MIN_LINE_HEIGHT_BODY,
    MAX_LINE_HEIGHT_BODY,
    DEFAULT_TYPOGRAPHY_PREFS.lineHeightBody,
  );
  return Math.round(clamped * 100) / 100;
}

export function clampMeasure(value: number): number {
  return Math.round(
    clampNumber(value, MIN_MEASURE, MAX_MEASURE, DEFAULT_TYPOGRAPHY_PREFS.measure),
  );
}

function isCandidate(value: TypographyStoredCandidate | null | undefined): value is TypographyStoredCandidate {
  return value instanceof Object;
}

function readFamily(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.length > MAX_TYPOGRAPHY_FAMILY_LENGTH
    ? trimmed.slice(0, MAX_TYPOGRAPHY_FAMILY_LENGTH)
    : trimmed;
}

function readSize(
  value: number | undefined,
  clamp: (n: number) => number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return clamp(value);
}

function readLineHeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TYPOGRAPHY_PREFS.lineHeightBody;
  }
  return clampLineHeightBody(value);
}

function readMeasure(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TYPOGRAPHY_PREFS.measure;
  }
  return clampMeasure(value);
}

/**
 * Resolve stored or steered prefs into a complete, clamped set. Partial input
 * is expected: storage from an older build, or a steering mutation that names
 * only what it changes. Anything absent or unreadable falls back to the
 * shipped default rather than to a guess.
 */
export function resolveTypographyPrefs(
  input?: TypographyStoredCandidate | null,
): TypographyPrefs {
  if (!isCandidate(input)) return { ...DEFAULT_TYPOGRAPHY_PREFS };
  return {
    sans: readFamily(input.sans),
    serif: readFamily(input.serif),
    mono: readFamily(input.mono),
    composer: readFamily(input.composer),
    sizeInterface: readSize(
      input.sizeInterface,
      clampInterfaceFontSize,
      DEFAULT_TYPOGRAPHY_PREFS.sizeInterface,
    ),
    sizeComposer: readSize(
      input.sizeComposer,
      clampComposerFontSize,
      DEFAULT_TYPOGRAPHY_PREFS.sizeComposer,
    ),
    sizeCode: readSize(input.sizeCode, clampCodeFontSize, DEFAULT_TYPOGRAPHY_PREFS.sizeCode),
    lineHeightBody: readLineHeight(input.lineHeightBody),
    measure: readMeasure(input.measure),
    smoothing: input.smoothing === false ? false : true,
  };
}
