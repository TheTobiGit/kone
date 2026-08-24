import { computed, readonly, ref, watch } from "vue";
import { applyThemeColors } from "~/theme/apply";
import {
  buildImportedThemes,
  isRecord,
  isVsCodeThemeFile,
  parseVsCodeThemeEntry,
  type ThemeJsonValue,
  type VsCodeImportEntry,
} from "~/theme/import-vscode";
import {
  exportThemeJson,
  hydrateThemes,
  isCustom,
  isImported,
  registerImportedThemes,
  removeCustomTheme as dropCustomTheme,
  removeImportedTheme as dropImportedTheme,
  reservedThemeIds,
  resolveTheme,
  saveCustomTheme as storeCustomTheme,
  themes as libraryThemes,
  updateCustomTheme as editCustomTheme,
} from "~/theme/library";
import {
  colorsFor,
  extrasFor,
  locksAppearance,
  schemeFor,
  type AppearanceMode,
  type ThemeDefinition,
  type ThemeExtras,
  type ThemeScheme,
} from "~/theme/roles";
import type { ThemeSpec } from "~/theme/build";
import { DEFAULT_THEME_ID } from "~/theme/themes";

const STORAGE_THEME = "kone:theme";
const STORAGE_APPEARANCE = "kone:appearance";

// ── Module-scope singleton ──────────────────────────────────────────────────
/** True when the OS reports dark, driven by the single shared media listener. */
const systemDark = ref(false);

const themeId = ref<string>(DEFAULT_THEME_ID);

/**
 * What the user last asked the appearance control for. Kept even while a fixed
 * theme is ignoring it, so switching back to an adaptive theme returns to the
 * mode they chose rather than silently resetting them to `system`.
 */
const mode = ref<AppearanceMode>("system");

/** Temporary theme applied to the document while editing a custom theme in-place. */
const previewOverride = ref<ThemeDefinition | null>(null);
const previewSchemeOverride = ref<ThemeScheme | null>(null);

const activeState = computed(() => {
  const activeTheme = previewOverride.value ?? resolveTheme(themeId.value);
  const activeScheme =
    previewSchemeOverride.value ??
    schemeFor(activeTheme, mode.value, systemDark.value);
  const colors = colorsFor(activeTheme, activeScheme);
  const locked = locksAppearance(activeTheme);
  const themeExtras = extrasFor(activeTheme, activeScheme);
  return {
    theme: activeTheme,
    scheme: activeScheme,
    colors,
    locked,
    extras: themeExtras,
  };
});

const theme = computed<ThemeDefinition>(() => activeState.value.theme);

/**
 * The appearance actually being painted. A fixed theme answers with the one
 * scheme it was designed as and never consults `mode` — selecting such a theme
 * is itself the decision to stop following the system.
 */
const scheme = computed<ThemeScheme>(() => activeState.value.scheme);

/** True while the active theme is overriding the appearance control. */
const modeLocked = computed<boolean>(() => activeState.value.locked);

const extras = computed<ThemeExtras>(() => activeState.value.extras);

// ── System scheme listener ──────────────────────────────────────────────────
let mediaQuery: MediaQueryList | null = null;
let mediaBound = false;

/** Register the one shared (prefers-color-scheme) listener, at most once. */
function bindMediaListener(): void {
  if (mediaBound || !("window" in globalThis)) return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemDark.value = mediaQuery.matches;
  mediaQuery.addEventListener("change", (event) => {
    systemDark.value = event.matches;
  });
  mediaBound = true;
}

bindMediaListener();

// ── Persistence ─────────────────────────────────────────────────────────────
function readStoredThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_THEME) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function readStoredMode(): AppearanceMode {
  try {
    const stored = localStorage.getItem(STORAGE_APPEARANCE);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
    return "system";
  } catch {
    return "system";
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────
/** Paint the active theme onto <html>. Idempotent. */
function apply(): void {
  const state = activeState.value;
  applyThemeColors(state.colors, state.scheme, state.theme.id);
}

watch(activeState, apply, { flush: "sync" });

// ── Public API ──────────────────────────────────────────────────────────────
function setTheme(id: string): void {
  previewOverride.value = null;
  previewSchemeOverride.value = null;
  themeId.value = id;
  writeStored(STORAGE_THEME, id);
}

function setMode(next: AppearanceMode): void {
  mode.value = next;
  writeStored(STORAGE_APPEARANCE, next);
}

/** Temporarily paint a draft theme onto the entire app during theme editing. */
function previewTheme(draft: ThemeDefinition | null, previewScheme?: ThemeScheme | null): void {
  previewOverride.value = draft;
  previewSchemeOverride.value = previewScheme ?? null;
}

function cancelPreview(): void {
  previewOverride.value = null;
  previewSchemeOverride.value = null;
}

function saveCustomTheme(spec: ThemeSpec): ThemeDefinition {
  const created = storeCustomTheme(spec);
  setTheme(created.id);
  return created;
}

function updateCustomTheme(id: string, spec: ThemeSpec): ThemeDefinition {
  const updated = editCustomTheme(id, spec);
  setTheme(updated.id);
  return updated;
}

function removeCustomTheme(id: string): void {
  dropCustomTheme(id);
  if (themeId.value === id) {
    themeId.value = DEFAULT_THEME_ID;
    writeStored(STORAGE_THEME, DEFAULT_THEME_ID);
  }
}

/** One file that failed to become a theme, with a reason the pane can show. */
export interface ThemeImportFailure {
  name: string;
  reason: string;
}

/** The outcome of an import: what joined the library and what was refused. */
export interface ThemeImportResult {
  added: ThemeDefinition[];
  failures: ThemeImportFailure[];
}

/**
 * Import one or more VS Code colour-theme files or kone theme JSON files.
 */
async function importThemes(files: File[]): Promise<ThemeImportResult> {
  const entries: VsCodeImportEntry[] = [];
  const failures: ThemeImportFailure[] = [];
  const directCustomAdded: ThemeDefinition[] = [];

  for (const file of files) {
    const stem = file.name.replace(/\.[^.]+$/, "");
    let json: ThemeJsonValue;
    try {
      // SAFETY: JSON.parse yields any; isVsCodeThemeFile and isRecord validate before use.
      json = JSON.parse(await file.text()) as ThemeJsonValue;
    } catch {
      failures.push({ name: file.name, reason: "That file isn't valid JSON." });
      continue;
    }

    // Check if file is a native kone theme export
    if (
      isRecord(json) &&
      "koneTheme" in json &&
      isRecord(json.spec)
    ) {
      try {
        const specPayload: unknown = json.spec;
        // SAFETY: json.spec was verified as a record object; storeCustomTheme validates its spec contents.
        const spec = specPayload as ThemeSpec;
        const importedCustom = storeCustomTheme(spec);
        directCustomAdded.push(importedCustom);
        continue;
      } catch (err) {
        failures.push({
          name: file.name,
          reason: err instanceof Error ? err.message : "Invalid kone theme JSON format.",
        });
        continue;
      }
    }

    if (!isVsCodeThemeFile(json)) {
      failures.push({ name: file.name, reason: "That file isn't a VS Code colour theme or kone theme." });
      continue;
    }
    try {
      entries.push(parseVsCodeThemeEntry(json, stem));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "That file couldn't be read.";
      failures.push({ name: file.name, reason });
    }
  }

  const added = [
    ...directCustomAdded,
    ...buildImportedThemes(entries, reservedThemeIds()),
  ];
  if (entries.length > 0) {
    const vscodeThemes = added.filter((t) => !directCustomAdded.includes(t));
    registerImportedThemes(vscodeThemes);
  }
  return { added, failures };
}

/** Remove an imported theme. If it was the active one, kone's own appearance
 *  takes over — the removed theme can't keep painting. */
function removeImportedTheme(id: string): void {
  dropImportedTheme(id);
  if (themeId.value === id) {
    themeId.value = DEFAULT_THEME_ID;
    writeStored(STORAGE_THEME, DEFAULT_THEME_ID);
  }
}

/**
 * Read persisted preferences, restore library, paint the first theme.
 */
export function initTheme(): void {
  hydrateThemes();
  bindMediaListener();
  themeId.value = readStoredThemeId();
  mode.value = readStoredMode();
  apply();
}

export function useTheme() {
  return {
    themeId: readonly(themeId),
    mode: readonly(mode),
    scheme,
    modeLocked,
    theme,
    extras,
    themes: libraryThemes,
    setTheme,
    setMode,
    previewTheme,
    cancelPreview,
    saveCustomTheme,
    updateCustomTheme,
    removeCustomTheme,
    importThemes,
    removeImportedTheme,
    isImported,
    isCustom,
    exportThemeJson,
  };
}

