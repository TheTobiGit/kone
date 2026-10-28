// The floating preview behind a reference chip.
//
// A chip shows the selection in one line; the panel shows the exact text, which
// can be long enough to scroll. It is a small non-modal popover: hover or focus
// opens it, the pointer may cross the gap between chip and panel, focus may
// enter the panel to scroll with the keyboard, and it closes on Escape, an
// outside click, or when the chip goes away.
//
// Keeping the event bookkeeping here (rather than in the component) makes the
// hover-gap and focus-return rules testable without a DOM.

import { getCurrentScope, onScopeDispose, ref } from "vue";

export type ReferencePreviewRegion = "chip" | "panel";

export interface ReferencePreviewAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** The chip body: focusable, and enough of an element to follow the chip. */
export interface ReferencePreviewTrigger {
  focus(options?: FocusOptions): void;
  closest(selector: string): Element | null;
  isConnected: boolean;
}

export interface ReferencePreview {
  id: string;
  /** The exact selected text, never a glance or a truncation. */
  text: string;
  anchor: ReferencePreviewAnchor;
  /** Focused again when the panel closes from the keyboard. */
  trigger: ReferencePreviewTrigger | null;
}

export interface ReferencePreviewTimers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface ReferencePreviewOptions {
  /** Time the pointer or focus may spend outside both regions before closing.
   *  Long enough to cross the gap, short enough to feel like a dismissal. */
  closeDelay?: number;
  timers?: ReferencePreviewTimers;
}

export const REFERENCE_PREVIEW_GAP = 6;
export const REFERENCE_PREVIEW_MARGIN = 8;
export const REFERENCE_PREVIEW_MAX_WIDTH = 400;
export const REFERENCE_PREVIEW_MAX_HEIGHT = 320;

export interface ReferencePreviewPlacement {
  left: number;
  /** An upper bound; a short selection still takes only the room it needs. */
  maxWidth: number;
  top: number | null;
  bottom: number | null;
  maxHeight: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Place the panel above the chip when that side is roomier, clamp it to the
 *  horizontal margins, and cap its height to the side it actually opens on. */
export function placeReferencePreview(
  anchor: ReferencePreviewAnchor,
  viewport: ViewportSize,
): ReferencePreviewPlacement {
  const maxWidth = Math.min(
    REFERENCE_PREVIEW_MAX_WIDTH,
    Math.max(0, viewport.width - REFERENCE_PREVIEW_MARGIN * 2),
  );
  const left = clamp(
    anchor.left,
    REFERENCE_PREVIEW_MARGIN,
    viewport.width - REFERENCE_PREVIEW_MARGIN - maxWidth,
  );
  const spaceAbove = anchor.top - REFERENCE_PREVIEW_GAP - REFERENCE_PREVIEW_MARGIN;
  const spaceBelow =
    viewport.height - anchor.bottom - REFERENCE_PREVIEW_GAP - REFERENCE_PREVIEW_MARGIN;
  const openAbove = spaceAbove >= spaceBelow;
  const available = openAbove ? spaceAbove : spaceBelow;

  // The chip covers the viewport (a tiny window): pin the panel to the margins
  // rather than render it with no height at all.
  if (available < 1) {
    return {
      left,
      maxWidth,
      top: REFERENCE_PREVIEW_MARGIN,
      bottom: null,
      maxHeight: Math.max(0, viewport.height - REFERENCE_PREVIEW_MARGIN * 2),
    };
  }

  return {
    left,
    maxWidth,
    top: openAbove ? null : anchor.bottom + REFERENCE_PREVIEW_GAP,
    bottom: openAbove ? viewport.height - anchor.top + REFERENCE_PREVIEW_GAP : null,
    maxHeight: Math.min(REFERENCE_PREVIEW_MAX_HEIGHT, available),
  };
}

const defaultTimers: ReferencePreviewTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle),
};

export function useReferencePreview(options: ReferencePreviewOptions = {}) {
  const closeDelay = options.closeDelay ?? 140;
  const timers = options.timers ?? defaultTimers;
  const preview = ref<ReferencePreview | null>(null);

  const pointer = { chip: false, panel: false };
  const focus = { chip: false, panel: false };
  let pending: { id: string; handle: number } | null = null;
  let suppressFocusOpen = false;

  function cancelClose(): void {
    if (!pending) return;
    timers.clear(pending.handle);
    pending = null;
  }

  /** Stay open while the pointer or focus is in either region. */
  function held(): boolean {
    return pointer.chip || pointer.panel || focus.chip || focus.panel;
  }

  /** Forget region state when the panel unmounts: an unmounted panel never
   *  sends a mouseleave or focusout, and a stale flag would hold a later
   *  preview open forever. */
  function resetRegions(): void {
    pointer.chip = false;
    pointer.panel = false;
    focus.chip = false;
    focus.panel = false;
  }

  function open(next: ReferencePreview): void {
    cancelClose();
    preview.value = next;
  }

  function close(): void {
    cancelClose();
    preview.value = null;
    resetRegions();
  }

  function scheduleClose(id = preview.value?.id): void {
    if (!id) return;
    cancelClose();
    pending = {
      id,
      handle: timers.set(() => {
        pending = null;
        if (preview.value?.id === id && !held()) preview.value = null;
      }, closeDelay),
    };
  }

  function enter(region: ReferencePreviewRegion): void {
    pointer[region] = true;
    cancelClose();
  }

  function leave(region: ReferencePreviewRegion): void {
    pointer[region] = false;
    if (!held()) scheduleClose();
  }

  function focusEnter(region: ReferencePreviewRegion): void {
    focus[region] = true;
    cancelClose();
  }

  function focusLeave(region: ReferencePreviewRegion): void {
    focus[region] = false;
    if (!held()) scheduleClose();
  }

  /** Whether a focus event may open the panel. False only during the one
   *  programmatic focus that returns to the trigger after Escape/Tab, so the
   *  panel does not immediately reopen. */
  function allowsFocusOpen(): boolean {
    return !suppressFocusOpen;
  }

  /** Close from the keyboard and put focus back on the chip. The focus event
   *  fired by `focus()` runs synchronously in the browser and is suppressed;
   *  the flag is cleared afterwards so a later, real focus still opens. */
  function focusTrigger(): void {
    const trigger = preview.value?.trigger;
    close();
    if (!trigger) return;
    suppressFocusOpen = true;
    trigger.focus({ preventScroll: true });
    suppressFocusOpen = false;
  }

  function hideIf(id: string): void {
    if (preview.value?.id === id) close();
  }

  function hideMissing(ids: readonly string[]): void {
    if (preview.value && !ids.includes(preview.value.id)) close();
  }

  if (getCurrentScope()) onScopeDispose(cancelClose);

  return {
    preview,
    open,
    close,
    enter,
    leave,
    focusEnter,
    focusLeave,
    allowsFocusOpen,
    focusTrigger,
    hideIf,
    hideMissing,
  };
}
