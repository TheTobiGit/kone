import { readonly, watch } from "vue";
import { useStorage } from "@vueuse/core";
import {
  applyTypographyVariables,
  clearTypographyVariables,
  DEFAULT_TYPOGRAPHY_PREFS,
  MAX_TYPOGRAPHY_FAMILY_LENGTH,
  resolveTypographyPrefs,
  TYPOGRAPHY_STORAGE_KEY,
  type TypographyPrefs,
  type TypographySizeKind,
  type TypographyFamilyKind,
} from "~/theme/typography";

// Typography preferences: the faces and sizes text wears across the app.
// Per-install feel knobs, the same shelf as the strip's centering and the sound
// mute — they belong to no project and to no pane entry.
//
// The ref lives at module scope on purpose: the settings pane writes it and the
// plugin (plus any future reader) applies it, with no props threaded between
// them and no reload. Sharing one reactive `useStorage` is what makes a change
// take effect live — flip a size in the drawer and the interface behind it
// already obeys — and a change in one window is picked up by another.
const stored = useStorage<TypographyPrefs>(
  TYPOGRAPHY_STORAGE_KEY,
  { ...DEFAULT_TYPOGRAPHY_PREFS },
  undefined,
  { listenToStorageChanges: true, mergeDefaults: true },
);

function paint(): void {
  if (!import.meta.client) return;
  applyTypographyVariables(document.documentElement, resolveTypographyPrefs(stored.value));
}

if (import.meta.client) {
  watch(
    stored,
    () => paint(),
    { deep: true },
  );
}

/** The resolved prefs: stored values validated and clamped, never raw. */
function resolved(): TypographyPrefs {
  return resolveTypographyPrefs(stored.value);
}

function setFamily(kind: TypographyFamilyKind, value: string): void {
  const next = resolved();
  // Truncate rather than refuse: shared bound with the resolver, so a pasted
  // stack stays usable instead of failing the write.
  next[kind] = value.length > MAX_TYPOGRAPHY_FAMILY_LENGTH
    ? value.slice(0, MAX_TYPOGRAPHY_FAMILY_LENGTH)
    : value;
  stored.value = next;
}

function setSize(kind: TypographySizeKind, value: number): void {
  const next = resolved();
  if (kind === "interface") next.sizeInterface = value;
  else if (kind === "composer") next.sizeComposer = value;
  else next.sizeCode = value;
  stored.value = resolveTypographyPrefs(next);
}

function setLineHeightBody(value: number): void {
  stored.value = resolveTypographyPrefs({ ...resolved(), lineHeightBody: value });
}

function setMeasure(value: number): void {
  stored.value = resolveTypographyPrefs({ ...resolved(), measure: value });
}

function setSmoothing(value: boolean): void {
  stored.value = { ...resolved(), smoothing: value };
}

/** Apply a partial update. A key the update doesn't name is left alone, the
 *  same contract the strip mutation follows. */
function patchTypography(patch: Partial<TypographyPrefs>): void {
  stored.value = resolveTypographyPrefs({ ...resolved(), ...patch });
}

function resetTypography(): void {
  stored.value = { ...DEFAULT_TYPOGRAPHY_PREFS };
  if (import.meta.client) {
    clearTypographyVariables(document.documentElement);
    paint();
  }
}

/** Read persisted prefs and paint them. Idempotent. */
export function initTypography(): void {
  stored.value = resolveTypographyPrefs(stored.value);
  paint();
}

export function useTypography() {
  return {
    prefs: readonly(stored),
    setFamily,
    setSize,
    setLineHeightBody,
    setMeasure,
    setSmoothing,
    patchTypography,
    resetTypography,
  };
}
