import {
  DEFAULT_MONO_STACK,
  DEFAULT_SANS_STACK,
  DEFAULT_SERIF_STACK,
  cssFontFamilies,
} from "./typography";

/**
 * The faces text can wear, as a picker rather than a text field. A row names a
 *  job (interface, wordmark, code, composer); this module answers what can fill
 *  it: the shipped default, the platform's own face, a curated face when it's
 *  actually installed, and — through the Local Font Access API — everything
 *  else on the machine.
 */

export type FontKind = "sans" | "serif" | "mono" | "composer";

/** One pickable face. `id` is the stored value: "" is the shipped default,
 *  anything else a family name prepended to its kind's stack. */
export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

const SYSTEM_SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const SYSTEM_SERIF = 'ui-serif, Georgia, "Times New Roman", serif';

/** Well-known faces worth offering when they're actually on the machine.
 *  Listed under the kind whose stack they'd join; availability is probed at
 *  runtime so a missing face never shows. */
const CURATED_NAMES = {
  sans: ["Inter", "Helvetica Neue", "Arial", "SF Pro"],
  serif: ["New York", "Georgia", "Times New Roman", "Palatino"],
  mono: ["SF Mono", "Menlo", "Consolas", "JetBrains Mono", "Fira Code", "Roboto Mono"],
  composer: ["Inter", "Helvetica Neue", "Arial", "SF Pro"],
} satisfies Record<FontKind, string[]>;

function defaultOption(kind: FontKind): FontOption {
  if (kind === "serif") return { id: "", label: "Default", stack: DEFAULT_SERIF_STACK };
  if (kind === "mono") return { id: "", label: "Default", stack: DEFAULT_MONO_STACK };
  return { id: "", label: "Default", stack: DEFAULT_SANS_STACK };
}

function systemOption(kind: FontKind): FontOption {
  if (kind === "serif") return { id: "ui-serif", label: "System", stack: SYSTEM_SERIF };
  if (kind === "mono") return { id: "ui-monospace", label: "System", stack: DEFAULT_MONO_STACK };
  return { id: "system-ui", label: "System", stack: SYSTEM_SANS };
}

/** The full stack a row or specimen wears for a stored value: the family over
 *  its kind's shipped stack, so coverage never regresses. */
export function stackFor(kind: FontKind, name: string): string {
  const quoted = cssFontFamilies(name) ?? name;
  if (kind === "serif") return `${quoted}, ${DEFAULT_SERIF_STACK}`;
  if (kind === "mono") return `${quoted}, ${DEFAULT_MONO_STACK}`;
  return `${quoted}, ${DEFAULT_SANS_STACK}`;
}

/**
 * The curated shelf for a kind: default, system, then the well-known faces
 * that probed as installed. Curated keeps its order; installed order follows
 * the machine.
 */
export function curatedOptions(kind: FontKind): FontOption[] {
  const options = [defaultOption(kind), systemOption(kind)];
  for (const name of CURATED_NAMES[kind]) {
    if (!isFontFamilyAvailable(name)) continue;
    if (options.some((o) => o.id === name)) continue;
    options.push({ id: name, label: name, stack: stackFor(kind, name) });
  }
  return options;
}

/** What the rows show for a stored value: Default for empty, the name itself
 *  otherwise. A picked system font is just its family name. */
export function fontLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "Default" : trimmed;
}

// ── availability probing ────────────────────────────────────────────────────
// Canvas metric probing instead of document.fonts.check(): check() reports true
// for families that aren't installed at all, so it can't filter a list. A
// family exists when falling back to at least one generic changes the measured
// advance. Unmeasurable environments answer false, so nothing is offered that
// can't be shown.

const PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";

function probeContext(): CanvasRenderingContext2D | null {
  if (!("document" in globalThis)) return null;
  try {
    return document.createElement("canvas").getContext("2d");
  } catch {
    return null;
  }
}

function probeWidth(
  context: CanvasRenderingContext2D,
  fontList: string,
): number | null {
  try {
    context.font = `16px ${fontList}`;
    return context.measureText(PROBE_TEXT).width;
  } catch {
    return null;
  }
}

export function isFontFamilyAvailable(family: string): boolean {
  const list = cssFontFamilies(family);
  if (list === null) return false;
  const context = probeContext();
  if (!context) return false;
  for (const generic of ["monospace", "serif", "sans-serif"]) {
    const baseline = probeWidth(context, generic);
    const candidate = probeWidth(context, `${list}, ${generic}`);
    if (baseline === null || candidate === null) return false;
    if (candidate !== baseline) return true;
  }
  return false;
}

// ── monospace probing ───────────────────────────────────────────────────────
// Cell-grid surfaces (code, terminal) need every glyph on the same advance: a
// proportional face draws narrower than the lattice the cursor sits on. The
// mono picker only lists families that pass, so it can't be pointed at a face
// that breaks code. Unmeasurable environments answer true, so a missing canvas
// never blocks a legitimate font.

const MONO_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"];
const MONO_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "];
const MONO_TOLERANCE = 0.01;

const monospaceCache = new Map<string, boolean>();

function advancesEqual(advances: number[]): boolean {
  const reference = advances[0];
  if (reference === undefined || reference <= 0) return true;
  return advances.every(
    (advance) => Number.isFinite(advance) && Math.abs(advance - reference) < MONO_TOLERANCE,
  );
}

export function isMonospaceFamily(family: string): boolean {
  const list = cssFontFamilies(family);
  if (list === null) return true;
  const cached = monospaceCache.get(list);
  if (cached !== undefined) return cached;
  const context = probeContext();
  if (!context) return true;
  let result = true;
  try {
    for (const variant of MONO_VARIANTS) {
      context.font = `${variant} 32px ${list}, monospace`;
      const advances = MONO_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!advancesEqual(advances)) {
        result = false;
        break;
      }
    }
  } catch {
    result = true;
  }
  monospaceCache.set(list, result);
  return result;
}

// ── installed fonts ─────────────────────────────────────────────────────────
// The Local Font Access API (Chromium, Electron): every family on the machine,
// behind a permission prompt. Called from the picker's open gesture so the
// prompt lands inside user activation.

export interface InstalledFontState {
  families: string[];
  status: "granted" | "denied" | "unsupported";
}

interface LocalFontEntry {
  family: string;
}

interface LocalFontsWindow {
  queryLocalFonts?: () => Promise<LocalFontEntry[]>;
}

let installedCache: InstalledFontState | null = null;

export function clearInstalledFontCache(): void {
  installedCache = null;
}

function localFontsQuery(): (() => Promise<LocalFontEntry[]>) | null {
  if (!("window" in globalThis)) return null;
  // SAFETY: queryLocalFonts is a Chromium-only API absent from lib.dom; the
  // optional call below is the existence check before use.
  const win = globalThis.window as LocalFontsWindow | undefined;
  const query = win?.queryLocalFonts;
  return query ?? null;
}

export async function queryInstalledFontFamilies(): Promise<InstalledFontState> {
  if (installedCache) return installedCache;
  const query = localFontsQuery();
  if (!query) {
    installedCache = { families: [], status: "unsupported" };
    return installedCache;
  }
  try {
    const fonts = await query();
    const families = [...new Set(fonts.map((font) => font.family))]
      .filter((family) => !family.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    if (families.length === 0) return { families: [], status: "denied" };
    installedCache = { families, status: "granted" };
    return installedCache;
  } catch {
    return { families: [], status: "denied" };
  }
}
