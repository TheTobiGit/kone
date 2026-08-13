import { computed, readonly, ref, watch } from "vue";
import { applyThemeColors } from "~/theme/apply";
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
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, resolveTheme } from "~/theme/themes";

const STORAGE_THEME = "kone:theme";
const STORAGE_APPEARANCE = "kone:appearance";

// ── Module-scope singleton ──────────────────────────────────────────────────
// The state lives here, not in the composable, so every caller shares one copy:
// a theme change in the appearance pane is instantly visible to the canvas
// shaders and the terminal the moment the ref flips. Nothing is applied at
// import time — initTheme() owns the first paint and the plugin calls it.

/** True when the OS reports dark, driven by the single shared media listener. */
const systemDark = ref(false);

const themeId = ref<string>(DEFAULT_THEME_ID);

/**
 * What the user last asked the appearance control for. Kept even while a fixed
 * theme is ignoring it, so switching back to an adaptive theme returns to the
 * mode they chose rather than silently resetting them to `system`.
 */
const mode = ref<AppearanceMode>("system");

const theme = computed<ThemeDefinition>(() => resolveTheme(themeId.value));

/**
 * The appearance actually being painted. A fixed theme answers with the one
 * scheme it was designed as and never consults `mode` — selecting such a theme
 * is itself the decision to stop following the system.
 */
const scheme = computed<ThemeScheme>(() =>
  schemeFor(theme.value, mode.value, systemDark.value),
);

/** True while the active theme is overriding the appearance control. */
const modeLocked = computed<boolean>(() => locksAppearance(theme.value));

const extras = computed<ThemeExtras>(() => extrasFor(theme.value, scheme.value));

// ── System scheme listener ──────────────────────────────────────────────────
let mediaQuery: MediaQueryList | null = null;
let mediaBound = false;

/** Register the one shared (prefers-color-scheme) listener, at most once. */
function bindMediaListener(): void {
  if (mediaBound || typeof window === "undefined") return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemDark.value = mediaQuery.matches;
  mediaQuery.addEventListener("change", (event) => {
    systemDark.value = event.matches;
  });
  mediaBound = true;
}

// Bound once for the module's lifetime. In SSR there is no window, so the
// listener waits until a client caller runs initTheme().
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
    // Storage may be unavailable (private mode, file://). The session still
    // works — the preference just doesn't survive a reload.
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────
/** Paint the active theme onto <html>. Idempotent. */
function apply(): void {
  const active = theme.value;
  applyThemeColors(colorsFor(active, scheme.value), scheme.value, active.id);
}

// Every state change — a setTheme/setMode call or the OS flipping dark on a
// system-following user — lands here. Flush is sync so the swap happens before
// the next frame rather than on a batched tick.
watch([theme, scheme], apply, { flush: "sync" });

// ── Public API ──────────────────────────────────────────────────────────────
function setTheme(id: string): void {
  themeId.value = id;
  writeStored(STORAGE_THEME, id);
}

function setMode(next: AppearanceMode): void {
  mode.value = next;
  writeStored(STORAGE_APPEARANCE, next);
}

/**
 * Read persisted preferences, paint the first theme and ensure the system
 * listener is live. Safe to call more than once. This is the only entry point
 * that applies without a prior user action — the plugin calls it on boot.
 */
export function initTheme(): void {
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
    themes: BUILT_IN_THEMES,
    setTheme,
    setMode,
  };
}
