import { computed } from "vue";

import type { PaneKind } from "~/types/studio";
import { PANE_KINDS } from "~/utils/paneKinds";
import { useTheme } from "./useTheme";
import { useSound } from "./useSound";

// The bare-board chooser: the same pane-kind registry the seam menu offers,
// laid out as a centered pick for a desktop with no windows at all. No
// singleton greying here — the chooser only shows on a zero-pane board, so
// nothing is ever already open.
//
// On white, the plasma's ridge veins read as a soft cloud; on near-black the
// same veins glow as high-contrast filaments — the same tuning as the
// projects-list empty state, so the bare board shares its ambient floor.
//
// The per-kind shortcut chips resolve through any user rebind, so they arrive
// as readers rather than values. The pick itself leaves as a callback, so
// this has no opinion about the component's event names.
export function useStripChooser(deps: {
  bindingFor: (id: string) => string;
  displayTokens: (binding: string) => string[];
  emits: {
    choose: (kind: PaneKind) => void;
  };
}) {
  const { bindingFor, displayTokens, emits } = deps;
  const { cue } = useSound();
  const { scheme } = useTheme();
  const plasmaOpacity = computed(() => (scheme.value === "dark" ? 0.5 : 1));

  const chooserActions = computed(() =>
    PANE_KINDS.map((meta) => ({
      kind: meta.kind,
      label: meta.insertLabel,
      icon: meta.icon,
      // The kind's own shortcut, resolved through any user rebind and split into
      // display chips (⌘-glyphs on mac, words elsewhere) — so the empty state
      // teaches the gesture that opens each column.
      keys: displayTokens(bindingFor(meta.shortcutId)),
    })),
  );

  function onChoose(kind: PaneKind): void {
    cue("press");
    emits.choose(kind);
  }

  return { plasmaOpacity, chooserActions, onChoose };
}
