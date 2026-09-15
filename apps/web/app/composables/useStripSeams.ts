import { ref } from "vue";

import type { PaneKind } from "~/types/studio";
import { useSound } from "./useSound";

// The seam insert flyout: which rail joint (leading -1, or the index after a
// column) has its insert card open, and where that card anchors. The rail
// closes the card on any scroll; picking a kind inserts through the caller's
// callback, so this has no opinion about the component's event names.
export function useStripSeams(deps: {
  onInsert: (seamIndex: number, kind: PaneKind) => void;
}) {
  const { onInsert } = deps;
  const { cue } = useSound();

  const openSeam = ref<number | null>(null);
  const menuAnchor = ref({ x: 0, y: 0 });

  function closeJoint(): void {
    openSeam.value = null;
  }

  function toggleJoint(i: number, target: EventTarget | null): void {
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return;
    if (openSeam.value === i) {
      closeJoint();
      cue("collapse");
      return;
    }
    const rect = el.getBoundingClientRect();
    menuAnchor.value = {
      // The leading seam (-1) unfolds rightward, so anchor its card to the seam's
      // right edge; every trailing seam unfolds leftward from its left edge.
      x: i === -1 ? rect.right : rect.left,
      y: rect.top + rect.height / 2,
    };
    openSeam.value = i;
    cue("expand");
  }

  function onInsertPick(kind: PaneKind): void {
    if (openSeam.value === null) return;
    onInsert(openSeam.value, kind);
    closeJoint();
  }

  return { openSeam, menuAnchor, closeJoint, toggleJoint, onInsertPick };
}
