import { useStorage } from "@vueuse/core";

// Motion preferences for the thread strip. These aren't board state — they don't
// belong to any one project and they aren't persisted onto a pane entry — they're
// per-install feel knobs, the same shelf as the sound mute and reduced-motion.
//
// The ref lives at module scope on purpose: ThreadStrip.vue reads it to decide how
// far to scroll, and SettingsDrawer.vue writes it from the Personalization list.
// Sharing one reactive `useStorage` (the pattern useShortcuts.ts uses for
// `kone.shortcuts.bindings`) is what makes the setting take effect live — flip it
// in the drawer and the board behind it already obeys, with no props threaded
// between the two components and no reload.

// niri's `center-focused-column`. `never` keeps the strip anchored and only nudges
// the focused column into view; `on-overflow` does the same but lands it centred
// when it does have to move; `always` is the old behaviour — recentre the world on
// every focus change. Persisted per-install, not per-project: it's a motion
// preference, like reduced-motion.
export type CenterMode = "never" | "on-overflow" | "always";

const centerMode = useStorage<CenterMode>(
  "kone.strip.centering",
  "on-overflow",
  // Sync across tabs/windows of the same origin so a change in the drawer of one
  // is picked up by a board open in another without a reload.
  undefined,
  { listenToStorageChanges: true },
);

export function useStripPrefs() {
  return { centerMode };
}
