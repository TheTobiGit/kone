<script setup lang="ts">
import { computed } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Eraser01Icon,
  HighlighterIcon,
  SourceCodeIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
} from "@hugeicons/core-free-icons";
import { PAD_HIGHLIGHTS, PAD_TEXT_COLORS, highlightById } from "~/utils/padColors";
import type { PadMarker } from "~/composables/useScratchpad";

export type PadMarkKind = "bold" | "italic" | "strike" | "code" | "highlight";

const props = defineProps<{
  visible: boolean;
  top: number;
  left: number;
  placement: "above" | "below";
  /** Which marks the current selection already carries — the lit buttons. */
  marks: Record<PadMarkKind, boolean>;
  /** The armed pens; their swatches wear the ring. */
  marker: PadMarker;
}>();

const emit = defineEmits<{
  mark: [kind: PadMarkKind];
  highlight: [id: string];
  "text-color": [id: string];
  clear: [];
}>();

const armedHighlight = computed(() => highlightById(props.marker.highlight));

const style = computed(() => ({
  top: `${props.top}px`,
  left: `${props.left}px`,
  transform: props.placement === "above" ? "translateY(-100%)" : "none",
}));

const marks = [
  { kind: "bold" as const, icon: TextBoldIcon, label: "Bold", hint: "⌘B" },
  { kind: "italic" as const, icon: TextItalicIcon, label: "Italic", hint: "⌘I" },
  { kind: "strike" as const, icon: TextStrikethroughIcon, label: "Strikethrough", hint: "⌘⇧S" },
  { kind: "code" as const, icon: SourceCodeIcon, label: "Code", hint: "⌘E" },
];
</script>

<template>
  <Teleport to="body">
    <AnimatePresence>
      <motion.div
        v-if="visible"
        key="pad-format-bar"
        class="fmt"
        :style="style"
        role="toolbar"
        aria-label="Formatting"
        :initial="{ opacity: 0, y: placement === 'above' ? 4 : -4, scale: 0.97 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: placement === 'above' ? 4 : -4, scale: 0.97 }"
        :transition="{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }"
        @mousedown.prevent
      >
        <div class="fmt__row">
          <button
            v-for="m in marks"
            :key="m.kind"
            type="button"
            class="fmt__btn"
            :class="{ 'is-on': props.marks[m.kind] }"
            :title="`${m.label} · ${m.hint}`"
            :aria-label="m.label"
            :aria-pressed="props.marks[m.kind]"
            @click="emit('mark', m.kind)"
          >
            <HugeiconsIcon :icon="m.icon" :size="13" :stroke-width="2" />
          </button>
          <span class="fmt__sep" aria-hidden="true" />
          <button
            type="button"
            class="fmt__btn fmt__btn--pen"
            :class="{ 'is-on': props.marks.highlight }"
            :title="`Highlight · ${armedHighlight.label} · ⌘⇧H`"
            :aria-label="`Highlight with ${armedHighlight.label}`"
            :style="{ '--pen': armedHighlight.swatch }"
            @click="emit('highlight', marker.highlight)"
          >
            <HugeiconsIcon :icon="HighlighterIcon" :size="13" :stroke-width="2" />
          </button>
          <button
            type="button"
            class="fmt__btn"
            title="Clear formatting"
            aria-label="Clear formatting"
            @click="emit('clear')"
          >
            <HugeiconsIcon :icon="Eraser01Icon" :size="13" :stroke-width="2" />
          </button>
        </div>

        <div class="fmt__row fmt__row--swatches">
          <button
            v-for="c in PAD_HIGHLIGHTS"
            :key="`h-${c.id}`"
            type="button"
            class="fmt__dot"
            :class="{ 'is-armed': marker.highlight === c.id }"
            :style="{ '--dot': c.swatch }"
            :title="`Highlight · ${c.label}`"
            :aria-label="`Highlight ${c.label}`"
            @click="emit('highlight', c.id)"
          />
          <span class="fmt__sep" aria-hidden="true" />
          <button
            v-for="c in PAD_TEXT_COLORS"
            :key="`t-${c.id}`"
            type="button"
            class="fmt__dot fmt__dot--text"
            :class="{ 'is-armed': marker.text === c.id, 'is-default': c.id === 'default' }"
            :style="{ '--dot': c.swatch }"
            :title="`Text · ${c.label}`"
            :aria-label="`Text colour ${c.label}`"
            @click="emit('text-color', c.id)"
          />
        </div>
      </motion.div>
    </AnimatePresence>
  </Teleport>
</template>

<style scoped>
.fmt {
  position: fixed;
  z-index: 52;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--ground) 92%, transparent);
  backdrop-filter: blur(10px);
  /* A hairline holds the bar apart from the page — no slab of shadow. */
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  pointer-events: auto;
}

.fmt__row {
  display: flex;
  align-items: center;
  gap: 1px;
}
.fmt__row--swatches {
  gap: 3px;
  padding: 2px 4px 1px;
}

.fmt__sep {
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: color-mix(in srgb, var(--ink) 12%, transparent);
}

.fmt__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-soft, var(--ink));
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.fmt__btn:hover {
  background: var(--hover);
  color: var(--ink);
}
.fmt__btn.is-on {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
}

/* The highlighter carries the armed colour as an underline of ink. */
.fmt__btn--pen {
  position: relative;
}
.fmt__btn--pen::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 3px;
  height: 2px;
  border-radius: 999px;
  background: var(--pen);
}

.fmt__dot {
  position: relative;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dot);
  cursor: pointer;
  transition: transform 0.14s ease;
}
.fmt__dot:hover {
  transform: scale(1.14);
}
.fmt__dot--text {
  background: transparent;
  color: var(--dot);
}
/* A text swatch reads as a letter-coloured disc with a ring, so the two rows
 * can't be mistaken for each other. */
.fmt__dot--text::before {
  content: "";
  position: absolute;
  inset: 2px;
  border-radius: 999px;
  background: var(--dot);
}
.fmt__dot--text.is-default::before {
  background: var(--ink);
}

.fmt__dot.is-armed {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ink) 45%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .fmt {
    backdrop-filter: none;
  }
  .fmt__dot {
    transition: none;
  }
}
</style>
