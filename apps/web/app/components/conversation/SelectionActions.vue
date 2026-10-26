<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ComponentPublicInstance, CSSProperties } from "vue";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { SolarChatRoundLineLinearIcon } from "~/utils/solarChatIcons";
import type { StudioIntent } from "~/types/studio";
import type {
  SelectionCapture,
  ToolbarDismissReason,
  ToolbarViewport,
} from "~/utils/selectionActions";
import {
  captureSelection,
  captureSelectionReference,
  consumeToolbarEscape,
  copySelectionText,
  isSelectionToolbarTarget,
  isToolbarEntryKey,
  measureSelectionToolbar,
  nextToolbarIndex,
  restoreToolbarFocus,
  sameSelection,
  SELECTION_TOOLBAR_MEASURE_ORIGIN,
  selectionToolbarCap,
} from "~/utils/selectionActions";

const props = defineProps<{
  /** The focused pane's id — a change dismisses the in-flight selection toolbar. */
  focusedPaneId: string;
}>();

const emit = defineEmits<{
  dispatch: [intent: StudioIntent];
}>();

const { cue } = useSound();

const visible = ref(false);
const positioned = ref(false);
/** True only while the surface is parked at the neutral origin for a read. */
const measuring = ref(false);
const coords = ref({ top: 0, left: 0 });
/** The viewport width cap applied while measuring. Never a previous measurement:
 *  a cap read back from the element is what collapsed the surface to 8px. */
const viewportCap = ref<number | null>(null);
const capture = ref<SelectionCapture | null>(null);
const toolbar = ref<HTMLElement | null>(null);
const buttons = ref<HTMLButtonElement[]>([]);
const activeIndex = ref(0);
const entered = ref(false);
const copyState = ref<"idle" | "busy" | "copied" | "failed">("idle");
let copyTimer: number | undefined;
/** Where focus was before Tab entered the toolbar, returned on Escape. */
let returnFocus: HTMLElement | null = null;
/** Guards an async measure that finished after its selection was dismissed. */
let measureRun = 0;
let selectingWithPointer = false;
let selectingWithKeyboard = false;
let selectionCancelled = false;
let releasePoint: { x: number; y: number } | undefined;
let selectionRange: Range | null = null;

function sourceBody(paneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-column-key="${CSS.escape(paneId)}"] [data-column-type="thread"]`,
  );
}

function matchesRange(range: Range | null, selection: Selection | null): boolean {
  if (!range || !selection?.rangeCount) return false;
  const next = selection.getRangeAt(0);
  return (
    range.startContainer === next.startContainer &&
    range.startOffset === next.startOffset &&
    range.endContainer === next.endContainer &&
    range.endOffset === next.endOffset
  );
}
// A deliberate dismissal outlives the selection that caused it. Without this,
// the pointer-up or focus tick that follows Escape / an outside click would
// re-open the toolbar under the reader's cursor.
let suppressed: SelectionCapture | null = null;

function clearCopyTimer(): void {
  if (copyTimer === undefined) return;
  window.clearTimeout(copyTimer);
  copyTimer = undefined;
}

/** The source pane's message body. A mouse selection leaves focus on `body`, so
 *  this is the "where the reader was" target when the toolbar opened without
 *  one; making it programmatically focusable keeps the keyboard in that thread
 *  without adding a tab stop. */
function focusTargetForPane(paneId: string): HTMLElement | null {
  const column = document.querySelector<HTMLElement>(
    `[data-column-key="${CSS.escape(paneId)}"]`,
  );
  const target = column?.querySelector<HTMLElement>('[data-column-type="thread"]');
  if (!target) return null;
  target.tabIndex = -1;
  return target;
}

function hide(
  options: { suppress?: boolean; reason?: ToolbarDismissReason; restore?: boolean } = {},
): void {
  const selected = capture.value;
  if (options.suppress && selected) suppressed = selected;
  const target = returnFocus;
  returnFocus = null;
  measureRun += 1;
  visible.value = false;
  positioned.value = false;
  measuring.value = false;
  // Never carry the old geometry into the next read: it is what made a re-show
  // after a resize measure the remainder of the previous layout.
  coords.value = { top: 0, left: 0 };
  entered.value = false;
  capture.value = null;
  copyState.value = "idle";
  clearCopyTimer();
  if (options.restore !== false) {
    restoreToolbarFocus(
      options.reason ?? "action",
      target,
      selected ? focusTargetForPane(selected.paneId) : null,
    );
  }
}

function readViewport(): ToolbarViewport {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
    offsetLeft: viewport?.offsetLeft ?? 0,
    offsetTop: viewport?.offsetTop ?? 0,
  };
}

async function measureAndPlace(): Promise<void> {
  const el = toolbar.value;
  const selected = capture.value;
  if (!el || !selected?.rect) {
    hide();
    return;
  }
  const bounds = sourceBody(selected.paneId)?.getBoundingClientRect();
  if (!bounds || bounds.width <= 16 || bounds.height <= 16) {
    hide();
    return;
  }
  const run = ++measureRun;
  const placed = await measureSelectionToolbar({
    anchor: selected.rect,
    bounds,
    releasePoint,
    viewport: readViewport(),
    measurement: {
      // Park the surface at a neutral origin first. A fixed, auto-width box
      // shrinks to fit the space right of its `left`, so reading at the previous
      // placement is what made a desktop→320 re-show render 149.5px wide.
      prepare: () => {
        measuring.value = true;
      },
      // Reapply the visible pane's cap before every read so wrapped labels
      // measure at the width available for this selection.
      applyCap: async (maxWidth) => {
        viewportCap.value = maxWidth;
        await nextTick();
      },
      measure: () => {
        const box = el.getBoundingClientRect();
        return { width: box.width, height: box.height };
      },
    },
  });
  if (run !== measureRun || !visible.value) return;
  coords.value = { top: placed.top, left: placed.left };
  measuring.value = false;
  positioned.value = true;
}

const evaluate = useDebounceFn(() => {
  if (
    selectionCancelled || selectingWithPointer || selectingWithKeyboard || !document.hasFocus()
  ) return;
  const nativeSelection = window.getSelection();
  const selected = captureSelection(nativeSelection);
  if (!selected) {
    suppressed = null;
    hide();
    return;
  }
  const unchangedRange = matchesRange(selectionRange, nativeSelection);
  if (suppressed && sameSelection(suppressed, selected) && unchangedRange) return;
  suppressed = null;
  // The same selection survives a toolbar press: pointer-up and focus events
  // must not wipe a "Copied" result or restart the toolbar under the cursor.
  if (visible.value && sameSelection(capture.value, selected) && unchangedRange) {
    capture.value = selected;
    return;
  }
  selectionRange = nativeSelection?.getRangeAt(0).cloneRange() ?? null;
  capture.value = selected;
  activeIndex.value = 0;
  entered.value = false;
  copyState.value = "idle";
  clearCopyTimer();
  const active = document.activeElement;
  returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  // Paint the first frame already capped to the visible viewport, never to 0.
  viewportCap.value = selectionToolbarCap(readViewport().width);
  visible.value = true;
  positioned.value = false;
  void nextTick(measureAndPlace);
}, 120);

useEventListener(document, "selectionchange", () => {
  if (selectingWithPointer) suppressed = null;
  evaluate();
});

useEventListener(document, "pointerdown", (event) => {
  const target = event.target instanceof Node ? event.target : null;
  if (isSelectionToolbarTarget(target)) return;
  if (visible.value) hide({ suppress: true, reason: "outside" });
  if (event.button !== 0 || !event.isPrimary) return;
  selectingWithPointer = true;
  selectionCancelled = false;
  releasePoint = undefined;
});

useEventListener(document, "pointerup", (event) => {
  if (!selectingWithPointer || event.button !== 0) return;
  selectingWithPointer = false;
  releasePoint = { x: event.clientX, y: event.clientY };
  evaluate();
});

useEventListener(document, "pointercancel", () => {
  selectionCancelled = true;
  selectingWithPointer = false;
  hide({ suppress: true });
});

useEventListener(window, "blur", () => {
  selectingWithPointer = false;
  selectingWithKeyboard = false;
  hide({ suppress: true });
});

useEventListener(document, "keydown", (event) => {
  const extendsSelection = event.shiftKey && [
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
  ].includes(event.key);
  const selectsAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a";
  if (!extendsSelection && !selectsAll) return;
  if (toolbar.value?.contains(document.activeElement)) return;
  selectingWithKeyboard = true;
  selectionCancelled = false;
  releasePoint = undefined;
  suppressed = null;
  if (visible.value) hide();
});

useEventListener(document, "keyup", () => {
  if (!selectingWithKeyboard) return;
  selectingWithKeyboard = false;
  evaluate();
});

/** A dialog painted above the plane keeps Escape while it holds focus; the
 *  toolbar is a floating surface, not the top of a modal stack. */
function modalAboveOwnsFocus(): boolean {
  const active = document.activeElement;
  if (!(active instanceof Element)) return false;
  if (toolbar.value?.contains(active)) return false;
  return active.closest('[aria-modal="true"]') !== null;
}

// Escape is read in the capture phase on `document`. The studio's board binding
// is a window listener registered by the parent before this surface mounts, so
// it runs first in the bubble phase and closes the studio out from under the
// reader; `stopPropagation` from another listener on `window` would not stop
// that same-node listener. Capturing earlier — and stopping the event there —
// keeps one Escape to one surface and leaves the focus return reachable.
useEventListener(
  document,
  "keydown",
  (event) => {
    if (!visible.value || modalAboveOwnsFocus()) return;
    if (!consumeToolbarEscape(event)) return;
    hide({ suppress: true, reason: "escape" });
  },
  { capture: true },
);

useEventListener(window, "keydown", (event) => {
  if (!visible.value) return;
  const inside = toolbar.value?.contains(document.activeElement) ?? false;
  // Once Tab has entered the toolbar, the next Tab is the browser's: it leaves
  // and continues through the page. `entered` is the guard that stops the
  // global handler from pulling focus back to Copy after that exit.
  if (positioned.value && isToolbarEntryKey(event, inside, entered.value)) {
    event.preventDefault();
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    entered.value = true;
    buttons.value[0]?.focus();
  }
});

function onToolbarFocusin(): void {
  entered.value = true;
}

/** Focus leaving the surface dismisses it, so a stale toolbar never floats over
 *  the page the keyboard has moved on to. Tab landing on a real control keeps
 *  that focus; landing on nothing would drop the reader at the top of the page,
 *  so only that case returns to the pre-entry element or the source pane. */
function onToolbarFocusout(event: FocusEvent): void {
  if (!visible.value) return;
  const next = event.relatedTarget;
  if (next instanceof Node && toolbar.value?.contains(next)) return;
  const landed = next instanceof HTMLElement;
  hide({ suppress: true, reason: "focusout", restore: !landed });
}

useEventListener(
  document,
  "scroll",
  (event) => {
    if (!visible.value || !capture.value) return;
    const body = sourceBody(capture.value.paneId);
    const target = event.target;
    const sourceScrolled = target instanceof Element && body &&
      (target.contains(body) || body.contains(target));
    if (target === document || sourceScrolled) {
      hide({ suppress: true, reason: "scroll" });
    }
  },
  { capture: true },
);

function onViewportResize(): void {
  if (visible.value) hide({ suppress: true, reason: "viewport" });
}

onMounted(() => {
  window.visualViewport?.addEventListener("resize", onViewportResize);
  window.visualViewport?.addEventListener("scroll", onViewportResize);
});

watch(
  () => props.focusedPaneId,
  () => {
    if (visible.value) hide({ suppress: true, reason: "pane" });
  },
);

watch(copyState, () => {
  if (visible.value) void nextTick(measureAndPlace);
});

function setButton(el: Element | ComponentPublicInstance | null, index: number): void {
  if (!(el instanceof HTMLButtonElement)) return;
  buttons.value[index] = el;
}

function focusAt(index: number): void {
  activeIndex.value = index;
  buttons.value[index]?.focus();
}

function onButtonKeydown(event: KeyboardEvent, index: number): void {
  const next = nextToolbarIndex(event.key, index, buttons.value.length);
  if (next === null) return;
  event.preventDefault();
  focusAt(next);
}

/** Keep the native selection alive while a toolbar button is pressed. The
 *  mousedown is the event that would otherwise collapse it. */
function onToolbarMousedown(event: MouseEvent): void {
  event.preventDefault();
}

async function onCopy(): Promise<void> {
  const selected = capture.value;
  if (!selected || copyState.value === "busy") return;
  copyState.value = "busy";
  clearCopyTimer();
  const outcome = await copySelectionText(selected.text, navigator.clipboard ?? null);
  if (outcome === "copied") {
    copyState.value = "copied";
    cue("copy");
    copyTimer = window.setTimeout(() => {
      copyState.value = "idle";
      copyTimer = undefined;
    }, 1800);
    return;
  }
  // No success is reported until the write resolves; a blocked or absent
  // clipboard leaves a retryable failure in the same button.
  copyState.value = "failed";
  cue("refuse");
  copyTimer = window.setTimeout(() => {
    copyState.value = "idle";
    copyTimer = undefined;
  }, 4000);
}

const copyLabel = computed(() => {
  switch (copyState.value) {
    case "busy":
      return "Copying";
    case "copied":
      return "Copied";
    case "failed":
      return "Copy failed";
    default:
      return "Copy";
  }
});

const statusMessage = computed(() => {
  switch (copyState.value) {
    case "copied":
      return "Copied to clipboard";
    case "failed":
      return "Could not copy. Try again.";
    default:
      return "";
  }
});

function onAddToComposer(): void {
  const selected = capture.value;
  if (!selected) return;
  emit("dispatch", {
    type: "attach-selection",
    reference: captureSelectionReference(selected),
  });
  hide({ suppress: true, reason: "action" });
}

function onNewThread(): void {
  const selected = capture.value;
  if (!selected) return;
  // The exact selection becomes ordinary editable input in the new thread's
  // composer. No quote markers, no reference, no send.
  emit("dispatch", {
    type: "draft-thread",
    draft: selected.text,
  });
  cue("press");
  hide({ suppress: true, reason: "action" });
}

onBeforeUnmount(() => {
  clearCopyTimer();
  window.visualViewport?.removeEventListener("resize", onViewportResize);
  window.visualViewport?.removeEventListener("scroll", onViewportResize);
});

const toolbarStyle = computed<CSSProperties>(() => {
  const cap =
    viewportCap.value === null ? "calc(100vw - 16px)" : `${viewportCap.value}px`;
  // While measuring, the surface sits at the neutral origin so its width is the
  // width it will render, not what is left of the previous placement.
  const origin = measuring.value ? SELECTION_TOOLBAR_MEASURE_ORIGIN : coords.value;
  return {
    top: `${origin.top}px`,
    left: `${origin.left}px`,
    // The cap is the visible viewport from the very first render. It is never a
    // measurement of the toolbar, so it can never become the 8px sliver the old
    // implementation measured back into itself.
    maxWidth: cap,
    visibility: positioned.value && !measuring.value ? "visible" : "hidden",
  };
});

watch(visible, (shown) => {
  if (shown) return;
  buttons.value = [];
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="toolbar"
      class="selection-actions"
      data-selection-toolbar
      :style="toolbarStyle"
      role="toolbar"
      aria-label="Selection actions"
      @mousedown="onToolbarMousedown"
      @focusin="onToolbarFocusin"
      @focusout="onToolbarFocusout"
    >
      <button
        :ref="(el) => setButton(el, 0)"
        type="button"
        class="selection-actions__btn"
        :tabindex="activeIndex === 0 ? 0 : -1"
        :aria-busy="copyState === 'busy'"
        :aria-disabled="copyState === 'busy'"
        @focus="activeIndex = 0"
        @keydown="onButtonKeydown($event, 0)"
        @click="onCopy"
      >
        <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        <span>{{ copyLabel }}</span>
      </button>
      <button
        :ref="(el) => setButton(el, 1)"
        type="button"
        class="selection-actions__btn"
        :tabindex="activeIndex === 1 ? 0 : -1"
        @focus="activeIndex = 1"
        @keydown="onButtonKeydown($event, 1)"
        @click="onAddToComposer"
      >
        <HugeiconsIcon :icon="Add01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        <span>Add to Composer</span>
      </button>
      <button
        :ref="(el) => setButton(el, 2)"
        type="button"
        class="selection-actions__btn"
        :tabindex="activeIndex === 2 ? 0 : -1"
        @focus="activeIndex = 2"
        @keydown="onButtonKeydown($event, 2)"
        @click="onNewThread"
      >
        <HugeiconsIcon
          :icon="SolarChatRoundLineLinearIcon"
          :size="12"
          :stroke-width="1.5"
          aria-hidden="true"
        />
        <span>New Thread</span>
      </button>
      <span class="selection-actions__status" role="status" aria-live="polite">{{
        statusMessage
      }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
/* The studio's menu surface: a compact raised rectangle, not the legacy pill.
   Opaque `--raised` with the menu hairline/shadow pair keeps it legible over
   both message text and code. No entrance motion — this is a frequent move. */
.selection-actions {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  background: var(--raised);
  box-shadow:
    0 0 0 1px var(--line-soft),
    0 8px 20px -8px color-mix(in srgb, var(--ink) 12%, transparent);
  /* Fallback before the visual viewport is read; the inline cap is narrower
     when a pinch-zoomed viewport differs from the layout viewport. */
  max-width: calc(100vw - 16px);
  pointer-events: auto;
}

/* Deliberate narrow behaviour: rows wrap and every label stays whole, so a
   300px viewport gets a second row instead of clipping "New Thread". */
.selection-actions__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 5px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  color: var(--ink-soft, var(--ink));
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.selection-actions__btn[aria-disabled="true"] {
  cursor: progress;
  opacity: 0.72;
}

.selection-actions__btn:focus-visible {
  /* The semantic focus token is the one that clears 3:1 on both schemes
     (3.10:1 on the light pill, 5.68:1 on the dark one). */
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

@media (hover: hover) {
  .selection-actions__btn:hover:not([aria-disabled="true"]) {
    background: var(--hover);
    color: var(--ink);
  }
}

.selection-actions__btn:active:not([aria-disabled="true"]) {
  background: var(--press);
}

.selection-actions__status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .selection-actions__btn {
    transition: none;
  }
}
</style>
