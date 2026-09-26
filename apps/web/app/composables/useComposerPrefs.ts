import { useStorage } from "@vueuse/core";

// How the composer behaves under your hands — per-install feel knobs on the same
// shelf as the strip's centring (useStripPrefs) and the conversation displays
// (useResponsePrefs). One module-scope ref, so every composer on screen and the
// Composer settings page share one reactive value: flip a switch in the drawer
// and the composer behind it already obeys, with no reload and no props.
//
// Stored whole and merged over the defaults, so a knob added later reads its
// default rather than undefined.

/** Which key sends. "enter" sends on Enter (Shift+Enter breaks the line);
 *  "mod-enter" sends on ⌘/Ctrl+Enter and leaves a plain Enter as the newline —
 *  for writing long prompts without firing half of one. */
export type SendKey = "enter" | "mod-enter";

export type ComposerPrefs = {
  sendKey: SendKey;
  /** A printable keystroke anywhere on the page wakes the composer and lands
   *  in the field. */
  typeToWake: boolean;
  /** An unsent draft survives a reload, per project. */
  keepDrafts: boolean;
  /** A click away from the open card folds it back to the orb. Off, only
   *  Escape does. */
  foldOnBlur: boolean;
};

export const DEFAULT_COMPOSER_PREFS: ComposerPrefs = {
  sendKey: "enter",
  typeToWake: true,
  keepDrafts: true,
  foldOnBlur: true,
};

/** Where useComposerDraft keeps each project's unsent draft. */
export const DRAFT_KEY_PREFIX = "kone:draft:";

const prefs = useStorage<ComposerPrefs>("kone.composer.prefs", DEFAULT_COMPOSER_PREFS, undefined, {
  listenToStorageChanges: true,
  mergeDefaults: true,
});

function set<K extends keyof ComposerPrefs>(key: K, value: ComposerPrefs[K]): void {
  if (prefs.value[key] === value) return;
  prefs.value = { ...prefs.value, [key]: value };
  // Turning drafts off is a promise that nothing unsent sits on disk, so the
  // ones already saved go with it rather than resurfacing if it's turned back on.
  if (key === "keepDrafts" && value === false) forgetDrafts();
}

function reset(): void {
  prefs.value = { ...DEFAULT_COMPOSER_PREFS };
}

function forgetDrafts(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable
  }
}

export function useComposerPrefs() {
  return { prefs, set, reset };
}
