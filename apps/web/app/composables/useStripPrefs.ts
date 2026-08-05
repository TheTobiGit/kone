import { useStorage } from "@vueuse/core";
import type { CenterMode } from "~/utils/stripScroll";

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
//
// The *meaning* of the setting — the mode union, the labels, and the scroll rule
// each one names — lives in `~/utils/stripScroll`, next to the geometry it drives,
// so the board and the settings preview share one definition. Import it from there;
// re-exporting it here would give Nuxt's auto-import two sources for one name.
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
