/**
 * The theme library: kone's built-ins plus user-created themes and imported themes,
 * kept alive across restarts.
 *
 * The registry uses reactive refs so every caller shares one copy of all themes —
 * the appearance pane, active-theme resolution, and the boot script's stored table.
 *
 * Storage keys:
 * - `kone:custom-themes` — user-authored themes created in the theme editor.
 * - `kone:imported-themes` — external VS Code / OpenVSX imported themes.
 * - `kone:theme-boot` — the five boot colours per custom/imported theme.
 */
import { computed, shallowRef } from "vue";
import type { ThemeDefinition, ThemeKind, ThemeScheme } from "./roles";
import { buildTheme, extractThemeSpec, type ThemeSpec } from "./build";
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, bootEntryFor, type ThemeBootEntry } from "./themes";

const STORAGE_CUSTOM = "kone:custom-themes";
const STORAGE_IMPORTED = "kone:imported-themes";
const STORAGE_BOOT = "kone:theme-boot";

const custom = shallowRef<ThemeDefinition[]>([]);
const imported = shallowRef<ThemeDefinition[]>([]);

// ── Storage ─────────────────────────────────────────────────────────────────
function readStoredThemes(key: string): ThemeDefinition[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredTheme);
  } catch {
    return [];
  }
}

interface StoredThemeFields {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  appearance?: unknown;
  colors?: unknown;
}

function isStoredTheme(value: unknown): value is ThemeDefinition {
  if (typeof value !== "object" || value === null) return false;
  const t = value as StoredThemeFields;
  return (
    typeof t.id === "string" &&
    typeof t.label === "string" &&
    (t.kind === "adaptive" || t.kind === "fixed") &&
    (t.appearance === "light" || t.appearance === "dark") &&
    typeof t.colors === "object" &&
    t.colors !== null
  );
}

function writeCustom(): void {
  try {
    localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(custom.value));
  } catch {
    // Storage unavailable
  }
}

function writeImported(): void {
  try {
    localStorage.setItem(STORAGE_IMPORTED, JSON.stringify(imported.value));
  } catch {
    // Storage unavailable
  }
}

function writeBootTable(): void {
  try {
    const table: Record<string, ThemeBootEntry> = {};
    for (const theme of [...custom.value, ...imported.value]) {
      table[theme.id] = bootEntryFor(theme);
    }
    localStorage.setItem(STORAGE_BOOT, JSON.stringify(table));
  } catch {
    // Cold start fallback
  }
}

// ── The registry ────────────────────────────────────────────────────────────
/** Every theme the library holds, built-ins first in their authored order. */
export const themes = computed<readonly ThemeDefinition[]>(() => [
  ...BUILT_IN_THEMES,
  ...custom.value,
  ...imported.value,
]);

export function hydrateThemes(): void {
  if (import.meta.server) return;
  custom.value = readStoredThemes(STORAGE_CUSTOM);
  imported.value = readStoredThemes(STORAGE_IMPORTED);
  writeBootTable();
}

/** Backwards-compatible alias for hydrateThemes. */
export const hydrateImportedThemes = hydrateThemes;

export function findTheme(id: string | null | undefined): ThemeDefinition | null {
  if (!id) return null;
  return themes.value.find((theme) => theme.id === id) ?? null;
}

/** The theme to render when the stored preference names one the library no
 *  longer holds (removed theme, or a built-in that went away). */
export function resolveTheme(id: string | null | undefined): ThemeDefinition {
  return findTheme(id) ?? findTheme(DEFAULT_THEME_ID) ?? BUILT_IN_THEMES[0]!;
}

// ── Custom Themes ───────────────────────────────────────────────────────────
export function saveCustomTheme(spec: ThemeSpec): ThemeDefinition {
  const definition: ThemeDefinition = {
    ...buildTheme(spec),
    custom: true,
    spec,
  };
  const byId = new Map(custom.value.map((t) => [t.id, t]));
  byId.set(definition.id, definition);
  custom.value = [...byId.values()];
  writeCustom();
  writeBootTable();
  return definition;
}

export function updateCustomTheme(id: string, spec: ThemeSpec): ThemeDefinition {
  const definition: ThemeDefinition = {
    ...buildTheme({ ...spec, id }),
    custom: true,
    spec: { ...spec, id },
  };
  const byId = new Map(custom.value.map((t) => [t.id, t]));
  byId.set(id, definition);
  custom.value = [...byId.values()];
  writeCustom();
  writeBootTable();
  return definition;
}

export function removeCustomTheme(id: string): void {
  custom.value = custom.value.filter((theme) => theme.id !== id);
  writeCustom();
  writeBootTable();
}

export function isCustom(id: string): boolean {
  return custom.value.some((theme) => theme.id === id);
}

// ── Imports ─────────────────────────────────────────────────────────────────
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

/** Export a theme as structured JSON ready for file download or sharing. */
export function exportThemeJson(theme: ThemeDefinition): string {
  const spec = theme.spec ?? extractThemeSpec(theme);
  const payload = {
    koneTheme: true,
    version: 1,
    id: theme.id,
    label: theme.label,
    blurb: theme.blurb,
    kind: theme.kind,
    appearance: theme.appearance,
    spec,
  };
  return JSON.stringify(payload, null, 2);
}

// ── Presentation ────────────────────────────────────────────────────────────
export type ThemeGroup = {
  key: string;
  label: string;
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
  const builtIns = all.filter((t) => !isCustom(t.id) && !isImported(t.id));
  const customOnes = custom.value;
  const importedOnes = imported.value;

  const groups: ThemeGroup[] = [];

  if (customOnes.length > 0) {
    groups.push({
      key: "custom",
      label: "Custom",
      note: "Created and tuned by you. Editable anytime.",
      themes: customOnes,
    });
  }

  groups.push(
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
  );

  if (importedOnes.length > 0) {
    groups.push({
      key: "imported",
      label: "Imported",
      note: "From VS Code colour-theme files on this machine. Imported themes can be removed.",
      themes: importedOnes,
    });
  }

  return groups.filter((group) => group.themes.length > 0);
}

/** The ids an incoming batch must not take: built-ins plus earlier imports & custom. */
export function reservedThemeIds(): Set<string> {
  return new Set(themes.value.map((theme) => theme.id));
}

