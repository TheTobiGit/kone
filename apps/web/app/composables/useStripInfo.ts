import { ref, shallowRef } from "vue";

import type { ThreadSession } from "~/composables/useAgent";
import type { Pane } from "~/types/studio";

// The thread-info drop-down: clicking a column title toggles a panel anchored
// beneath it. The opening title's viewport rect is the anchor and the session
// itself (its refs stay live while the panel is open). The session stays a
// shallowRef — the panel reads the session's own refs, so wrapping it deeply
// would only re-trigger on every turn.
export function useStripInfo() {
  const infoPaneId = ref<string | null>(null);
  const infoAnchor = ref<DOMRect | null>(null);
  const infoSession = shallowRef<ThreadSession | null>(null);

  function toggleInfo(c: Pane, ev: Event): void {
    if (c.kind !== "thread") return;
    if (infoPaneId.value === c.id) {
      closeInfo();
      return;
    }
    // SAFETY: toggleInfo is bound to the pane title's <h2> element, so
    // currentTarget is that HTMLElement during dispatch (nulled after — hence
    // | null before the guard below).
    const el = ev.currentTarget as HTMLElement | null;
    if (!el || !c.session) return;
    infoAnchor.value = el.getBoundingClientRect();
    infoSession.value = c.session;
    infoPaneId.value = c.id;
  }

  function closeInfo(): void {
    infoPaneId.value = null;
    infoAnchor.value = null;
    infoSession.value = null;
  }

  return { infoPaneId, infoAnchor, infoSession, toggleInfo, closeInfo };
}
