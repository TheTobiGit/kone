import type { Ref } from "vue";
import { useEventListener } from "@vueuse/core";

import { useShortcuts } from "./useShortcuts";
import { useSound } from "./useSound";

// The strip's keyboard map: niri-style column focus/carry/width shortcuts plus
// bare arrows when nothing is being typed. The window listener is registered
// here (useEventListener tears it down with the component scope), so the
// component never half-owns the lifecycle: it passes behaviour in and reads
// key hints out. `overview` and the preset/zen controls arrive as live refs
// and callbacks — this names no component events and no pane state.
export function useStripKeyboard(deps: {
  focusedId: () => string;
  overview: Ref<boolean>;
  exitOverview: () => Promise<void>;
  isZen: (id: string) => boolean;
  cycleWidth: (id: string) => void;
  growWidth: (id: string) => void;
  shrinkWidth: (id: string) => void;
  toggleZen: () => void;
  emits: {
    shift: (delta: number) => void;
    move: (delta: number) => void;
  };
}) {
  const {
    focusedId,
    overview,
    exitOverview,
    isZen,
    cycleWidth,
    growWidth,
    shrinkWidth,
    toggleZen,
    emits,
  } = deps;
  const { cue } = useSound();
  const { matchesShortcut, bindingFor, displayTokens } = useShortcuts();

  function isTyping(): boolean {
    // SAFETY: only tagName and isContentEditable are read; a non-HTMLElement
    // focus target simply fails both checks and yields false.
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  useEventListener(window, "keydown", (e: KeyboardEvent) => {
    if (overview.value) {
      if (e.key === "Escape") {
        e.preventDefault();
        void exitOverview();
      }
      return;
    }
    if (matchesShortcut("focus-thread-left", e)) {
      e.preventDefault();
      cue("press");
      return emits.shift(-1);
    }
    if (matchesShortcut("focus-thread-right", e)) {
      e.preventDefault();
      cue("press");
      return emits.shift(1);
    }
    if (matchesShortcut("move-thread-left", e)) {
      e.preventDefault();
      cue("press");
      return emits.move(-1);
    }
    if (matchesShortcut("move-thread-right", e)) {
      e.preventDefault();
      cue("press");
      return emits.move(1);
    }
    if (matchesShortcut("cycle-thread-width", e)) {
      e.preventDefault();
      if (focusedId()) cycleWidth(focusedId());
      return;
    }
    if (matchesShortcut("grow-thread-width", e)) {
      e.preventDefault();
      if (focusedId()) growWidth(focusedId());
      return;
    }
    if (matchesShortcut("shrink-thread-width", e)) {
      e.preventDefault();
      if (focusedId()) shrinkWidth(focusedId());
      return;
    }
    if (matchesShortcut("maximize-thread", e)) {
      e.preventDefault();
      toggleZen();
      return;
    }
    // Escape precedence: overview wins. It sits above the zen branch so a single Esc
    // exits overview and never also drops zen in the same press (they can't both be on
    // — entering overview clears zen — but the ordering keeps that guarantee explicit).
    if (e.key === "Escape" && overview.value) {
      e.preventDefault();
      void exitOverview();
      return;
    }
    // Esc leaves zen — but only swallow the event while zen is actually on, so the
    // rest of the time Escape still bubbles up to close a modal or the settings drawer.
    if (e.key === "Escape" && focusedId() && isZen(focusedId())) {
      e.preventDefault();
      toggleZen();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping()) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      cue("press");
      emits.shift(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      cue("press");
      emits.shift(1);
    }
  });

  // The template reads these for the chooser's per-kind key hints.
  return { matchesShortcut, bindingFor, displayTokens };
}
