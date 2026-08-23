/**
 * Best-effort import of a VS Code colour theme (`*-color-theme.json`) into a
 * kone `SchemeSpec`.
 *
 * A VS Code theme describes editor chrome, not an app palette: it carries a few
 * hundred workbench keys, leaves most of them unset, and freely uses 8-digit
 * hex with alpha for overlays. So the conversion extracts the handful of
 * decisions a kone spec is actually made of — the canvas, the accent, the rail,
 * the terminal — and lets `buildScheme` grow everything else around them.
 *
 * Two rules keep an import honest:
 *
 * 1. Anything the file omits keeps the derived value. There is no fallback to
 *    another theme's table, because a gap in the file is not a request for a
 *    guess — it is the theme author saying "the usual is fine".
 * 2. A foreground only wins when it stays legible on the surface it lands on.
 *    A theme tuned for its own chrome can be unreadable on kone's, and an
 *    imported palette must not ship text that fails the moment it renders.
 */
import { contrast, luminance, mixHex, toHex } from "./color";
import { buildTheme, type SchemeSpec } from "./build";
import type { AnsiPalette, ThemeDefinition, ThemeScheme } from "./roles";

type VsCodeRgb = { r: number; g: number; b: number };
type VsCodeRgba = VsCodeRgb & { a: number };

const rgbHex = (c: VsCodeRgb): string => toHex([c.r / 255, c.g / 255, c.b / 255] as const);

/** Anything theme JSON text can decode to; the record guard narrows further. */
export type ThemeJsonValue =
  | string
  | number
  | boolean
  | null
  | ThemeJsonObject
  | ThemeJsonValue[];

/** A parsed theme/manifest object still mid-validation: every field is a JSON
 *  value until a guard proves otherwise. */
export interface ThemeJsonObject {
  [key: string]: ThemeJsonValue;
}

export function isRecord(value: unknown): value is ThemeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** sRGB transfer function, and its inverse, shared by the wide-gamut path. */
function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * `color(display-p3 r g b / a)` shows up in themes authored for wide-gamut
 * displays. Out-of-gamut colours clip to the sRGB edge, which is what a browser
 * on an sRGB screen shows anyway.
 */
function parseColorFunction(value: string): VsCodeRgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const [space, body] = [match[1]!.toLowerCase(), match[2]!];
  const [channelPart, alphaPart] = body.split("/");
  const channels = channelPart!
    .trim()
    .split(/\s+/)
    .map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part)));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const alphaRaw = alphaPart?.trim();
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith("%")
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
  if (!Number.isFinite(alpha)) return null;

  // SAFETY: the length + Number.isFinite checks above pin channels to three numbers.
  const [red, green, blue] = channels as [number, number, number];
  if (space === "srgb") {
    return { r: red * 255, g: green * 255, b: blue * 255, a: Math.max(0, Math.min(1, alpha)) };
  }
  const linearRed = decodeGamma(red);
  const linearGreen = decodeGamma(green);
  const linearBlue = decodeGamma(blue);
  // Display P3 linear -> sRGB linear.
  const srgbRed =
    encodeGamma(1.2249401762805 * linearRed - 0.2249401762805 * linearGreen) * 255;
  const srgbGreen =
    encodeGamma(-0.042056961239 * linearRed + 1.042056961239 * linearGreen) * 255;
  const srgbBlue =
    encodeGamma(
      -0.0196375547643 * linearRed - 0.0786360655012 * linearGreen + 1.0982736202656 * linearBlue,
    ) * 255;
  return {
    r: srgbRed,
    g: srgbGreen,
    b: srgbBlue,
    a: Math.max(0, Math.min(1, alpha)),
  };
}

/** VS Code accepts #RGB, #RGBA, #RRGGBB and #RRGGBBAA; some themes also use
 *  CSS `color()` notation for wide-gamut palettes. */
export function parseVsCodeColor(value: unknown): VsCodeRgba | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("color(")) return parseColorFunction(trimmed);
  const hex = trimmed.replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) =>
    part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

/** Overlays are semi-transparent in VS Code; kone's roles are opaque colours,
 *  so they are composited onto whatever surface they sit on. */
function flattenOver(color: VsCodeRgba, base: VsCodeRgb): string {
  const target = { r: color.r, g: color.g, b: color.b };
  if (color.a >= 1) return rgbHex(target);
  return mixHex(rgbHex(base), rgbHex(target), color.a);
}

/**
 * A VS Code theme is recognised by its workbench colours: the keys are dotted
 * paths (`editor.background`), which kone's own theme data never uses.
 */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasWorkbenchColors =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** One imported file, after parsing: the authored decisions the kone spec is
 *  built from, plus the file stem so a label collision can be untangled later. */
export interface VsCodeImportEntry {
  label: string;
  appearance: ThemeScheme;
  palette: SchemeSpec;
  sourceStem: string;
}

const ACCENT_KEYS = [
  "focusBorder",
  "button.background",
  "textLink.foreground",
  "activityBarBadge.background",
  "progressBar.background",
  "badge.background",
] as const;

const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof AnsiPalette)[];

/** Judge label candidates by their humanized form: a displayName of "---"
 *  humanizes to nothing and must fall through to the name. */
function resolveThemeLabel(value: ThemeJsonObject): string {
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== "string") continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, 48);
  }
  return "VS Code theme";
}

/** How light or dark a theme is, when the file doesn't say. */
function resolveAppearance(value: ThemeJsonObject, canvasHex: string): ThemeScheme {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "light" || type === "hc-light") return "light";
  if (type === "dark" || type === "hc-black") return "dark";
  // Unlabelled themes (and the odd custom `type`) follow the editor surface.
  return luminance(canvasHex) < 0.179 ? "dark" : "light";
}

/**
 * Parse one VS Code theme file into an import entry. Throws with a readable
 * reason when the file cannot become a kone theme at all.
 */
export function parseVsCodeThemeEntry(value: unknown, sourceStem: string): VsCodeImportEntry {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  const colors: ThemeJsonObject = isRecord(value.colors) ? value.colors : {};

  /** First key that carries a usable colour, in priority order. */
  const pick = (...keys: ReadonlyArray<string>): VsCodeRgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error(
      'That VS Code theme has no "editor.background" colour, so there is nothing to build a palette from.',
    );
  }
  const canvas: VsCodeRgb = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b };
  const canvasHex = rgbHex(canvas);
  const appearance = resolveAppearance(value, canvasHex);

  const accentColor = pick(...ACCENT_KEYS);
  const accentHex = accentColor ? flattenOver(accentColor, canvas) : null;

  // The rail and the terminal move off the ground only when the file actually
  // named them; kone's own derivations are the fallback for both. The terminal
  // background carries its own base for flattening, because a theme may give it
  // a different colour from the canvas and its foregrounds are read on it.
  const termBgColor = pick("terminal.background", "panel.background");
  const termBg: VsCodeRgb = termBgColor ? { r: termBgColor.r, g: termBgColor.g, b: termBgColor.b } : canvas;
  const termBgHex = rgbHex(termBg);

  /** First of `keys` that stays readable (4.5:1) on `surface`, flattened onto it. */
  const readableOn = (surface: VsCodeRgb, ...keys: ReadonlyArray<string>): string | null => {
    const surfaceHex = rgbHex(surface);
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (!parsed) continue;
      const candidate = flattenOver(parsed, surface);
      if (contrast(candidate, surfaceHex) >= 4.5) return candidate;
    }
    return null;
  };

  const palette: SchemeSpec = {
    ground: canvasHex,
    accent: accentHex ?? canvasHex,
  };

  const strip = pick("sideBar.background", "activityBar.background");
  if (strip) palette.strip = flattenOver(strip, canvas);
  const widgetBg = pick("editorWidget.background", "dropdown.background");
  if (widgetBg) palette.panel = flattenOver(widgetBg, canvas);
  const inputBg = pick("input.background");
  if (inputBg) palette.field = flattenOver(inputBg, canvas);
  if (termBgColor) palette.termBg = termBgHex;

  const ink = readableOn(canvas, "editor.foreground", "foreground");
  if (ink) palette.ink = ink;
  const muted = readableOn(canvas, "descriptionForeground");
  if (muted) palette.muted = muted;
  const placeholder = readableOn(canvas, "input.placeholderForeground");
  if (placeholder) palette.placeholder = placeholder;

  const termInk = readableOn(termBg, "terminal.foreground");
  if (termInk) palette.termInk = termInk;
  const termCursor = pick("terminalCursor.foreground", "editorCursor.foreground");
  if (termCursor) palette.termCursor = flattenOver(termCursor, termBg);
  const termSelection = pick("terminal.selectionBackground", "editor.selectionBackground");
  if (termSelection) palette.roles = { termSelection: flattenOver(termSelection, termBg) };

  const danger = readableOn(canvas, "editorError.foreground", "errorForeground");
  if (danger) palette.danger = danger;
  const warn = readableOn(canvas, "editorWarning.foreground");
  if (warn) palette.warn = warn;

  // VS Code keeps the terminal's 16 colours in the workbench table, so a theme
  // that named its terminal gets them back — read on the terminal background
  // actually in play rather than the canvas.
  const ansi: Partial<Record<keyof AnsiPalette, string>> = {};
  for (const slot of ANSI_SLOTS) {
    const key = `terminal.ansi${slot.charAt(0).toUpperCase()}${slot.slice(1)}`;
    const parsed = parseVsCodeColor(colors[key]);
    if (parsed) ansi[slot] = flattenOver(parsed, termBg);
  }
  if (Object.keys(ansi).length > 0) palette.ansi = { ...ansi };

  return {
    label: resolveThemeLabel(value),
    appearance,
    palette,
    sourceStem,
  };
}

/** `The quick brown` -> `the-quick-brown`; anything un-sluggable is dropped. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "imported-theme";
}

type ImportCandidate =
  | {
      kind: "fixed";
      label: string;
      appearance: ThemeScheme;
      palette: SchemeSpec;
      sourceStem: string;
      sources: string[];
    }
  | {
      kind: "adaptive";
      label: string;
      light: SchemeSpec;
      dark: SchemeSpec;
      sourceStem: string;
      sources: string[];
    };

/** The appearance words that say "this file is one half of a pair". */
const APPEARANCE_WORD = /\b(?:light|dark)\b/gi;

/**
 * Extensions ship a family of themes (GitHub: dark, light, dark-colorblind, …).
 * When several are imported together, a light and a dark file whose names differ
 * only by the appearance word become one adaptive theme; everything else stays
 * its own single-appearance theme.
 *
 * A pair is only made when it is unambiguous — exactly one light and one dark —
 * and when it would not collide with an id that already exists. Ambiguous or
 * colliding families stay separate singles rather than being guessed at.
 */
function pairCandidates(
  entries: VsCodeImportEntry[],
  takenIds: ReadonlySet<string>,
): ImportCandidate[] {
  const stripAppearance = (label: string) =>
    label.replace(APPEARANCE_WORD, " ").replace(/\s+/g, " ").trim();

  type Group = { light: VsCodeImportEntry[]; dark: VsCodeImportEntry[]; order: number };
  const groups = new Map<string, Group>();
  const singles: Array<{ entry: VsCodeImportEntry; order: number }> = [];
  entries.forEach((entry, order) => {
    const key = stripAppearance(entry.label);
    if (key === entry.label || key.length === 0) {
      singles.push({ entry, order });
      return;
    }
    const group = groups.get(key) ?? { light: [], dark: [], order };
    group[entry.appearance].push(entry);
    groups.set(key, group);
  });

  const out: Array<{ candidate: ImportCandidate; order: number }> = [];
  for (const [key, group] of groups) {
    if (group.light.length === 1 && group.dark.length === 1 && !takenIds.has(slugify(key))) {
      out.push({
        order: group.order,
        candidate: {
          kind: "adaptive",
          label: key,
          light: group.light[0]!.palette,
          dark: group.dark[0]!.palette,
          sourceStem: group.light[0]!.sourceStem,
          sources: [group.light[0]!.sourceStem, group.dark[0]!.sourceStem],
        },
      });
      continue;
    }
    for (const entry of [...group.light, ...group.dark]) {
      singles.push({ entry, order: group.order });
    }
  }

  return [
    ...singles.map(({ entry, order }) => ({
      order,
      candidate: {
        kind: "fixed",
        label: entry.label,
        appearance: entry.appearance,
        palette: entry.palette,
        sourceStem: entry.sourceStem,
        sources: [entry.sourceStem],
      } satisfies ImportCandidate,
    })),
    ...out,
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ candidate }) => candidate);
}

const IMPORT_BLURB = "Imported from a VS Code theme.";

/** What an id supplier gets to decide from: the resolved label, the final kind,
 *  and the source stems that went into it (two for a light/dark pair). */
export type ImportIdCandidate = {
  label: string;
  kind: "fixed" | "adaptive";
  sources: readonly string[];
};

export type ImportBuildOptions = {
  /**
   * Supply a deterministic id instead of slugging the label. Marketplace
   * imports use this so re-importing the same extension updates the theme in
   * place instead of minting "Dracula 2". The ids it returns must already be
   * unique — nothing here is re-checked against `takenIds`.
   */
  idFor?: (candidate: ImportIdCandidate) => string;
  /** The one-liner the appearance pane shows for the built themes. */
  blurb?: string;
};

/**
 * Turn parsed entries into built theme definitions: pair the family, resolve
 * id collisions against everything already in the library, and build.
 *
 * `takenIds` holds the built-in ids plus any previously imported ones, so a
 * re-import of an existing family gets a fresh id instead of silently merging
 * into (or clobbering) the theme it came from.
 */
export function buildImportedThemes(
  entries: VsCodeImportEntry[],
  takenIds: ReadonlySet<string>,
  options?: ImportBuildOptions,
): ThemeDefinition[] {
  // With a deterministic id supplier, the slug no longer decides identity, so
  // a family is free to pair even when its stripped name slugs to a taken id.
  const candidates = pairCandidates(entries, options?.idFor ? new Set<string>() : takenIds);
  const usedIds = new Set(takenIds);
  const seenLabels = new Set<string>();

  /** A colliding label is re-tried from the file stem first ("Dracula" from
   *  dracula-soft.json becomes "Dracula Soft"), then numbered. Pairs are never
   *  renamed — a family whose name is taken stays two singles instead. */
  const fromStem = (candidate: ImportCandidate): ImportCandidate => {
    const stem = humanizeThemeName(candidate.sourceStem);
    if (stem && stem.toLowerCase() !== candidate.label.toLowerCase()) {
      return { ...candidate, label: stem };
    }
    return candidate;
  };

  const build = (candidate: ImportCandidate, id: string): ThemeDefinition => {
    const base = {
      id,
      label: candidate.label,
      blurb: options?.blurb ?? IMPORT_BLURB,
    };
    if (candidate.kind === "adaptive") {
      return buildTheme({
        ...base,
        kind: "adaptive",
        light: candidate.light,
        dark: candidate.dark,
      });
    }
    return buildTheme({
      ...base,
      kind: "fixed",
      appearance: candidate.appearance,
      palette: candidate.palette,
    });
  };

  const themes: ThemeDefinition[] = [];
  for (const original of candidates) {
    if (options?.idFor) {
      let candidate = original;
      if (seenLabels.has(candidate.label)) candidate = fromStem(candidate);
      for (let suffix = 2; seenLabels.has(candidate.label) && suffix < 100; suffix += 1) {
        candidate = { ...candidate, label: `${original.label} ${suffix}` };
      }
      seenLabels.add(candidate.label);
      const id = options.idFor({ label: candidate.label, kind: candidate.kind, sources: candidate.sources });
      themes.push(build(candidate, id));
      usedIds.add(id);
      continue;
    }

    let candidate = original;
    if (seenLabels.has(candidate.label) || usedIds.has(slugify(candidate.label))) {
      candidate = fromStem(candidate);
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      if (!seenLabels.has(candidate.label) && !usedIds.has(slugify(candidate.label))) break;
      candidate = { ...candidate, label: `${original.label} ${suffix}` };
    }
    // The id is derived from the final label here, where it is known to be
    // unique, rather than guessed at earlier.
    const themeWithId = build(candidate, slugify(candidate.label));
    seenLabels.add(candidate.label);
    usedIds.add(themeWithId.id);
    themes.push(themeWithId);
  }
  return themes;
}
