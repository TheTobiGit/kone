/**
 * The theme library: kone's built-ins plus the themes the user imported, kept
 * alive across restarts.
 *
 * The registry is one mutable module-scope ref so every caller shares one copy
 * of the imported list — the appearance pane, the active-theme resolution, and
 * the boot script's stored table all answer the same question "what themes
 * exist?" from the same place. Imported themes are persisted as built
 * definitions (every role resolved to a literal or a `var()`, so nothing here
 * depends on the source file surviving).
 *
 * Two storage keys belong to this module:
 * - `kone:imported-themes` — the definitions themselves.
 * - `kone:theme-boot` — the five boot colours per imported theme, in the same
 *   shape the build-time boot table uses. The boot script runs before the
 *   bundle, so it cannot build a theme from its spec; this table is what lets
 *   an imported theme paint its own first frame.
 */
import { computed, shallowRef } from "vue";
import type { ThemeDefinition, ThemeKind, ThemeScheme } from "./roles";
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, bootEntryFor, type ThemeBootEntry } from "./themes";

const STORAGE_IMPORTED = "kone:imported-themes";
const STORAGE_BOOT = "kone:theme-boot";

const imported = shallowRef<ThemeDefinition[]>([]);

// ── Storage ─────────────────────────────────────────────────────────────────
function readImported(): ThemeDefinition[] {
  try {
    const raw = localStorage.getItem(STORAGE_IMPORTED);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredTheme);
  } catch {
    return [];
  }
}

/** The minimum a stored definition needs to be trusted; anything else is a
 *  damaged write (or a file from an older kone) and is dropped rather than
 *  painted. */
function isStoredTheme(value: unknown): value is ThemeDefinition {
  if (typeof value !== "object" || value === null) return false;
  // SAFETY: the typeof-object + null checks on this line are the narrowing itself.
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.label === "string" &&
    (t.kind === "adaptive" || t.kind === "fixed") &&
    (t.appearance === "light" || t.appearance === "dark") &&
    typeof t.colors === "object" &&
    t.colors !== null
  );
}

function writeImported(): void {
  try {
    localStorage.setItem(STORAGE_IMPORTED, JSON.stringify(imported.value));
  } catch {
    // Storage may be unavailable (private mode). Imports then live for the
    // session only, which is the same deal the theme preference itself gets.
  }
}

function writeBootTable(): void {
  try {
    const table: Record<string, ThemeBootEntry> = {};
    for (const theme of imported.value) table[theme.id] = bootEntryFor(theme);
    localStorage.setItem(STORAGE_BOOT, JSON.stringify(table));
  } catch {
    // A cold start then paints kone's colours for imported themes — the same
    // fallback the boot script has for every unknown id.
  }
}

// ── The registry ────────────────────────────────────────────────────────────
/** Every theme the library holds, built-ins first in their authored order. */
export const themes = computed<readonly ThemeDefinition[]>(() => [
  ...BUILT_IN_THEMES,
  ...imported.value,
]);

export function hydrateImportedThemes(): void {
  if (import.meta.server) return;
  if (imported.value.length > 0) return;
  imported.value = readImported();
  // Rewritten once per boot so a stale boot table (an import removed outside
  // this module) cannot drift from the definitions actually in play.
  writeBootTable();
}

export function findTheme(id: string | null | undefined): ThemeDefinition | null {
  if (!id) return null;
  return themes.value.find((theme) => theme.id === id) ?? null;
}

/** The theme to render when the stored preference names one the library no
 *  longer holds (removed import, or a built-in that went away). */
export function resolveTheme(id: string | null | undefined): ThemeDefinition {
  return findTheme(id) ?? findTheme(DEFAULT_THEME_ID) ?? BUILT_IN_THEMES[0]!;
}

/**
 * Add definitions to the library, replacing any earlier import that carries
 * the same id. Replacement rather than duplication is what lets a marketplace
 * re-import update the theme in place, and keeps one id meaning one theme.
 */
export function registerImportedThemes(definitions: readonly ThemeDefinition[]): void {
  const byId = new Map(imported.value.map((theme) => [theme.id, theme]));
  for (const definition of definitions) byId.set(definition.id, definition);
  imported.value = [...byId.values()];
  writeImported();
  writeBootTable();
}

export function removeImportedTheme(id: string): void {
  imported.value = imported.value.filter((theme) => theme.id !== id);
  writeImported();
  writeBootTable();
}

export function isImported(id: string): boolean {
  return imported.value.some((theme) => theme.id === id);
}

// ── Presentation ────────────────────────────────────────────────────────────
/**
 * The list split the way it is presented. Grouping is part of the choice rather
 * than decoration: a fixed theme behaves differently from an adaptive one, and
 * the only honest place to say so is next to the themes it applies to.
 * Imported themes get their own group — the "where did this come from" is part
 * of what a user needs to know to manage them, and only they can be removed.
 */
export type ThemeGroup = {
  key: string;
  label: string;
  /** One line explaining what selecting anything in this group does. */
  note: string;
  themes: readonly ThemeDefinition[];
};

function byKind(
  list: readonly ThemeDefinition[],
  kind: ThemeKind,
  appearance?: ThemeScheme,
): readonly ThemeDefinition[] {
  return list.filter(
    (t) => t.kind === kind && (appearance === undefined || t.appearance === appearance),
  );
}

export function themeGroups(): readonly ThemeGroup[] {
  const all = themes.value;
  const builtIns = all.filter((t) => !isImported(t.id));
  const importedOnes = all.filter((t) => isImported(t.id));
  return [
    {
      key: "adaptive",
      label: "Adaptive",
      note: "A designed light palette and a designed dark one. Follows your appearance setting.",
      themes: byKind(builtIns, "adaptive"),
    },
    {
      key: "dark",
      label: "Dark",
      note: "Designed as dark. Stays dark whatever your system is set to.",
      themes: byKind(builtIns, "fixed", "dark"),
    },
    {
      key: "light",
      label: "Light",
      note: "Designed as light. Stays light whatever your system is set to.",
      themes: byKind(builtIns, "fixed", "light"),
    },
    {
      key: "imported",
      label: "Imported",
      note: "From VS Code colour-theme files on this machine. Imported themes can be removed.",
      themes: importedOnes,
    },
  ].filter((group) => group.themes.length > 0);
}

/** The ids an incoming batch must not take: built-ins plus earlier imports. */
export function reservedThemeIds(): Set<string> {
  return new Set(themes.value.map((theme) => theme.id));
}
