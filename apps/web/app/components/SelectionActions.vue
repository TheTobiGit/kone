<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, Copy01Icon, MessageAdd01Icon } from "@hugeicons/core-free-icons";
import type { BoardIntent } from "~/types/board";

const props = defineProps<{
  /** The focused pane's id — a change dismisses the in-flight selection bubble. */
  focusedPaneId: string;
}>();

// One event: every button hands the board a fully-formed intent.
const emit = defineEmits<{
  dispatch: [intent: BoardIntent];
}>();

const { cue } = useSound();

const visible = ref(false);
const coords = ref({ top: 0, left: 0 });
const placement = ref<"above" | "below">("above");
const capturedText = ref("");
const sourceKey = ref("");

function hide(): void {
  visible.value = false;
  capturedText.value = "";
  sourceKey.value = "";
}

function extractMarkdown(sel: Selection, body: HTMLElement): string {
  // SAFETY: [data-markdown-source] is only ever set by this app on HTML
  // elements (thread-column content blocks), never on SVG or other Element
  // subclasses, so closest() yields an HTMLElement or null.
  const sourceEl = sel.anchorNode
    ? (sel.anchorNode instanceof Element
        ? sel.anchorNode
        : sel.anchorNode.parentElement
      )?.closest("[data-markdown-source]") as HTMLElement | null
    : null;
  if (!sourceEl?.dataset.markdownSource) return sel.toString();
  const source = sourceEl.dataset.markdownSource;
  const range = sel.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return sel.toString();
  const plain = sel.toString();
  if (!plain.trim()) return plain;
  // Cheap slice: if the whole block is selected, return source markdown.
  if (plain.replace(/\s+/g, " ").trim() === source.replace(/\s+/g, " ").trim()) {
    return source;
  }
  return plain;
}

function positionBubble(range: Range): void {
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
  const margin = 8;
  const width = 200;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.min(window.innerWidth - width - margin, Math.max(margin, left));
  const aboveTop = rect.top - margin;
  if (aboveTop > 52) {
    placement.value = "above";
    coords.value = { top: aboveTop, left };
  } else {
    placement.value = "below";
    coords.value = { top: rect.bottom + margin, left };
  }
}

const evaluate = useDebounceFn(() => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hide();
    return;
  }
  const text = sel.toString().trim();
  if (text.length <= 2) {
    hide();
    return;
  }
  const anchor = sel.anchorNode;
  const body = anchor instanceof Element
    ? anchor.closest('.col__body[data-column-type="thread"]')
    : anchor?.parentElement?.closest('.col__body[data-column-type="thread"]');
  if (!(body instanceof HTMLElement)) {
    hide();
    return;
  }
  const column = body.closest("section.col");
  const key = column?.getAttribute("data-column-key");
  if (!key) {
    hide();
    return;
  }
  const range = sel.getRangeAt(0);
  positionBubble(range);
  capturedText.value = extractMarkdown(sel, body);
  sourceKey.value = key;
  if (!visible.value) cue("toggle");
  visible.value = true;
}, 120);

useEventListener(document, "selectionchange", evaluate);
useEventListener(document, "mouseup", evaluate);

useEventListener(document, "mousedown", (e) => {
  if (!visible.value) return;
  // SAFETY: a mousedown's target is the deepest node under the pointer — an
  // Element in practice — and only .closest() is read from it.
  const t = e.target as HTMLElement;
  if (t.closest(".selection-actions")) return;
  hide();
});

useEventListener(window, "keydown", (e) => {
  if (e.key === "Escape" && visible.value) hide();
});

useEventListener(document, "scroll", () => {
  if (visible.value) hide();
}, { capture: true });

watch(
  () => props.focusedPaneId,
  () => {
    if (visible.value) hide();
  },
);

function onCopy(): void {
  emit("dispatch", { type: "copy", text: capturedText.value });
  cue("press");
  hide();
}

function onScratchpad(): void {
  emit("dispatch", { type: "capture-text", text: capturedText.value, from: sourceKey.value });
  cue("press");
  hide();
}

function onNewThread(): void {
  // The board's draft-thread intent opens a fresh column beside this pane with
  // the composer pre-filled — the caller does the quoting.
  const draft = capturedText.value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  emit("dispatch", { type: "draft-thread", draft, from: sourceKey.value });
  cue("press");
  hide();
}

const style = computed(() => ({
  top: `${coords.value.top}px`,
  left: `${coords.value.left}px`,
  transform: placement.value === "above" ? "translateY(-100%)" : "none",
}));
</script>

<template>
  <Teleport to="body">
    <AnimatePresence>
      <motion.div
        v-if="visible"
        key="selection-actions"
        class="selection-actions"
        :style="style"
        role="toolbar"
        aria-label="Selection actions"
        :initial="{ opacity: 0, y: placement === 'above' ? 4 : -4, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: placement === 'above' ? 4 : -4, scale: 0.96 }"
        :transition="{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }"
      >
        <button type="button" class="selection-actions__btn" @click="onCopy">
          <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="2" />
          <span>Copy</span>
        </button>
        <button type="button" class="selection-actions__btn" @click="onScratchpad">
          <HugeiconsIcon :icon="Add01Icon" :size="12" :stroke-width="2" />
          <span>Scratchpad</span>
        </button>
        <button type="button" class="selection-actions__btn" @click="onNewThread">
          <HugeiconsIcon :icon="MessageAdd01Icon" :size="12" :stroke-width="2" />
          <span>New thread</span>
        </button>
      </motion.div>
    </AnimatePresence>
  </Teleport>
</template>

<style scoped>
.selection-actions {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ground) 92%, transparent);
  backdrop-filter: blur(10px);
  /* A hairline, not a shadow, is what sets the bubble apart from the thread. */
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  pointer-events: auto;
}

.selection-actions__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  padding: 0.32rem 0.55rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft, var(--ink));
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.selection-actions__btn:hover {
  background: var(--hover);
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .selection-actions {
    backdrop-filter: none;
  }
}
</style>
