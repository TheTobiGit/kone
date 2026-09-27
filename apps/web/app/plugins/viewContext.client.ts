import { computed, shallowRef } from "vue";
import { watchDebounced } from "@vueuse/core";
import {
  VIEW_SELECTION_MAX,
  VIEW_SNAPSHOT_VERSION,
  viewSignature,
  type ViewSelection,
  type ViewSnapshot,
} from "@kone/protocol/view-context";
import { stackViewLayers, useViewFacet } from "~/composables/useViewContext";
import { useGlobalAssistant } from "~/composables/useGlobalAssistant";
import { useSettingsSurface } from "~/composables/useSettingsSurface";

// What is on screen, mirrored to the shell for the assistant.
//
// Every surface publishes its own facet (useViewContext); this stacks them into
// one ViewSnapshot, adds what the user last selected, and pushes it on the
// app:state channel the rest of the mirror rides. The shell hands it to the
// gateway, which puts it in front of every assistant turn and behind
// app_get_view.
//
// Pushed on change, not on a clock: the snapshot is a computed over the facets,
// and a push goes out only when its signature moves. Debounced, because a
// surface transition moves several facets in one gesture and the shell only
// needs the screen it settles on. The wait is short next to how long it takes
// to type a message, so a send always carries the screen it was written over.

/** Where the user's selection is kept alive through: the assistant's own card.
 *  Selecting text and then clicking into the assistant to ask about it is the
 *  whole gesture, and that click collapses the selection. */
const ASSISTANT_SELECTOR = "[data-kone-assistant]";

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export default defineNuxtPlugin(() => {
  const bridge = window.koneDesktop;
  if (!bridge?.setAppState) return;

  const { isOpen: assistantOpen } = useGlobalAssistant();
  const { isOpen: settingsOpen, pane: settingsPane } = useSettingsSurface();

  // The drawer's state is module-scope already, so it is published here rather
  // than from inside the drawer: this is the one surface with no local state
  // the plugin can't reach.
  useViewFacet("settings", () =>
    settingsOpen.value ? { surface: "settings", pane: settingsPane.value } : null,
  );

  const selection = shallowRef<ViewSelection | null>(null);

  document.addEventListener("selectionchange", () => {
    const current = document.getSelection();
    const text = current?.toString().trim() ?? "";
    const anchor = elementOf(current?.anchorNode ?? null);
    if (text) {
      // A selection inside the assistant's own transcript is the user reading
      // the answer, not pointing at the app. Leave the last one standing.
      if (anchor?.closest(ASSISTANT_SELECTOR)) return;
      const front = stackViewLayers().find((layer) => !layer.covered);
      selection.value = {
        text: text.slice(0, VIEW_SELECTION_MAX),
        surface: front?.surface ?? "unknown",
        at: Date.now(),
      };
      return;
    }
    // Collapsed. Into the assistant (the click that follows a selection) it is
    // kept; anywhere else the user has let go of it.
    if (document.activeElement?.closest(ASSISTANT_SELECTOR)) return;
    if (anchor?.closest(ASSISTANT_SELECTOR)) return;
    selection.value = null;
  });

  const snapshot = computed<ViewSnapshot>(() => ({
    version: VIEW_SNAPSHOT_VERSION,
    at: 0,
    layers: stackViewLayers(),
    assistantOpen: assistantOpen.value,
    selection: selection.value,
  }));

  let lastSent = "";
  const push = () => {
    const next = snapshot.value;
    const signature = `${viewSignature(next)}|${next.assistantOpen}`;
    if (signature === lastSent) return;
    lastSent = signature;
    void bridge.setAppState({ view: { ...next, at: Date.now() } });
  };

  push();
  watchDebounced(snapshot, push, { debounce: 120, maxWait: 600 });
});
