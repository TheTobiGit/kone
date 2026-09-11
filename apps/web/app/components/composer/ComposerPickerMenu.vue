<script setup lang="ts" generic="T">
 // One shell for both composer pickers: the house popover chrome (banded
 // header + hairline ring, no hard border, no heavy shadow), the row list with
 // the keyboard-active accent tint, and the shared row protocol (hover
 // highlights, click selects, mousedown never steals the field's caret). The
 // row CONTENT stays with each menu through the `row` slot — this owns
 // everything around it. Keyboard navigation itself lives in the shared
 // trigger machine, which drives `activeIndex` from above.

const props = defineProps<{
  /** The marker glyph in the header band (`@` or `/`). */
  glyph: string;
  /** What the header names — only what is actually listed. */
  title: string;
  /** The live query, echoed mono in the header. Empty hides the echo. */
  query?: string;
  /** Accessible name for the listbox. */
  listLabel: string;
  items: readonly T[];
  activeIndex: number;
  itemKey: (item: T, index: number) => string;
  /** Extra classes for a row's button (e.g. the mention list's section
   *  boundary). Active handling stays here. */
  rowClass?: (item: T, index: number) => string;
}>();

const emit = defineEmits<{
  select: [index: number];
  highlight: [index: number];
}>();
</script>

<template>
  <div class="composer-picker" role="listbox" :aria-label="props.listLabel">
    <div class="composer-picker__shell">
      <div class="composer-picker__head">
        <span class="composer-picker__glyph">{{ props.glyph }}</span>
        <span class="composer-picker__title">{{ props.title }}</span>
        <span v-if="props.query" class="composer-picker__query">{{ props.query }}</span>
      </div>

      <div v-if="props.items.length" class="composer-picker__list">
        <button
          v-for="(item, index) in props.items"
          :key="props.itemKey(item, index)"
          type="button"
          role="option"
          :aria-selected="index === props.activeIndex"
          class="composer-picker__row"
          :class="[
            props.rowClass?.(item, index),
            { 'composer-picker__row--active': index === props.activeIndex },
          ]"
          @mousedown.prevent
          @mouseenter="emit('highlight', index)"
          @click="emit('select', index)"
        >
          <slot name="row" :item="item" :index="index" :active="index === props.activeIndex" />
        </button>
      </div>

      <slot v-else name="empty">
        <p class="composer-picker__empty">No matches</p>
      </slot>
    </div>
  </div>
</template>

<style scoped>
/* Container — the app's shared modal treatment (BranchPicker / UserInput /
   ThreadInsertMenu): a plain --surface panel lifted by a single hairline ring,
   no drop shadow. It rises a few px on open, anchored to its bottom-left corner
   since it floats above the field. */
.composer-picker {
  width: 100%;
  overflow: hidden;
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transform-origin: bottom left;
  animation: composer-picker-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes composer-picker-in {
  from {
    opacity: 0;
    transform: translateY(5px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.composer-picker__shell {
  --band-bg: var(--band);
  --band-arc: 14px;
  padding: 0 0 5px;
}

/* Header band — a soft strip with arced bottom corners, like the insert menu. */
.composer-picker__head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  background-color: var(--band-bg);
  color: var(--muted);
  font-size: 11.5px;
}
.composer-picker__head::before,
.composer-picker__head::after {
  content: "";
  position: absolute;
  top: 100%;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.composer-picker__head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.composer-picker__head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.composer-picker__glyph {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
}

.composer-picker__title {
  color: var(--ink-soft);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.composer-picker__query {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-picker__list {
  max-height: 288px;
  padding: 6px;
  overflow-y: auto;
}

.composer-picker__row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 9px;
  min-height: 34px;
  padding: 5px 9px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}
.composer-picker__row:hover {
  background: var(--hover);
  color: var(--ink);
}
/* Keyboard-active row takes the accent tint the app uses for a selected list
   row — distinct from a plain hover so arrow-key navigation stays legible. */
.composer-picker__row--active,
.composer-picker__row--active:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--ink);
}
/* The first file row after the leading projects keeps the hairline boundary
   the two-section list drew — located by kind, not by section lengths. */
.composer-picker__row--boundary {
  border-top: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  margin-top: 2px;
  padding-top: 7px;
}

.composer-picker__empty {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  font-size: 12.5px;
}

@media (prefers-reduced-motion: reduce) {
  .composer-picker {
    animation: none;
  }
}
</style>
