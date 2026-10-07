<script setup lang="ts">
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";

// One section of the thread dock — a card in the shell's tray, the intent
// menu's picker-card: a head that folds the body open and shut, with whatever
// the section wants to say about itself on the right of it (a diffstat, a
// count, the live item). The section owns its fold; this only draws it.
//
// A section that needs a different head for a while (Changes, while it reads
// one file's diff) fills the `head` slot instead and brings its own fold
// control — `toggle` is handed to it for that.

const props = defineProps<{
  label: string;
  expanded: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
}>();

const chevSpring = { type: "spring", stiffness: 520, damping: 30, mass: 0.45 } as const;
</script>

<template>
  <motion.section
    class="dock-section"
    :class="{ 'dock-section--open': props.expanded }"
    :initial="{ opacity: 0, y: 6 }"
    :animate="{ opacity: 1, y: 0 }"
    :exit="{ opacity: 0, y: -4 }"
    :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
    :aria-label="props.label"
  >
    <slot name="head" :toggle="() => emit('toggle')">
      <button
        type="button"
        class="dock-section__head"
        :aria-expanded="props.expanded"
        @click="emit('toggle')"
      >
        <span class="dock-section__label">{{ props.label }}</span>
        <span class="dock-section__trail">
          <slot name="trail" />
          <motion.span
            class="dock-section__chev"
            :animate="{ rotate: props.expanded ? 180 : 0 }"
            :transition="chevSpring"
            aria-hidden="true"
          >
            <HugeiconsIcon :icon="ArrowDown01Icon" :size="14" :stroke-width="2" />
          </motion.span>
        </span>
      </button>
    </slot>

    <div class="dock-section__body" :class="{ 'dock-section__body--open': props.expanded }">
      <div class="dock-section__inner">
        <slot />
      </div>
    </div>
  </motion.section>
</template>

<!-- Unscoped: the head-slot markup a section brings carries its own scope, and
     the chevron and trail classes below are shared with it. The dock-section
     prefix keeps every rule to this card. -->
<style>
/* The card — PickerShell's picker-card: panel fill, 18px radius, its own ring. */
.dock-section {
  flex: none;
  padding: 4px;
  border-radius: 18px;
  background: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent),
    0 1px 2px rgb(0 0 0 / 0.05);
}

/* ── head ── an action row: the label left, the section's summary and the
   chevron right. */
.dock-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  min-width: 0;
  padding: 0.42rem 0.55rem;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.16s ease;
}
.dock-section__head:hover,
.dock-section__head:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.dock-section__label {
  flex: none;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 20px;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.dock-section__trail {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  min-width: 0;
  height: 20px;
}
.dock-section__chev {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  transition: color 0.18s ease;
}
.dock-section--open .dock-section__chev {
  color: var(--ink-soft);
}

/* ── body ── folds on the grid-row trick, so it opens to its content's height. */
.dock-section__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.dock-section__body--open {
  grid-template-rows: 1fr;
}
.dock-section__inner {
  min-height: 0;
  overflow: hidden;
}

/* The scrolling list inside a section — rows at the head's inset, a thin bar
   only once it overflows. */
.dock-section .dock-scroll {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  max-height: var(--dock-section-max, min(22rem, calc(100vh - 10rem)));
  padding: 0.1rem 0 0.15rem;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted) 40%, transparent) transparent;
}
.dock-section .dock-scroll::-webkit-scrollbar {
  width: 6px;
}
.dock-section .dock-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.dock-section .dock-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 35%, transparent);
}

/* The quiet line for an empty or still-drafting section. */
.dock-section .dock-empty {
  margin: 0;
  padding: 0.35rem 0.55rem;
  font-size: 12.5px;
  color: var(--muted);
}

/* The live item a closed section names in its head. */
.dock-section .dock-peek {
  display: block;
  min-width: 0;
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 20px;
  letter-spacing: -0.01em;
  color: var(--muted);
}

/* A section's count — mono, tabular, brighter while it is live. */
.dock-section .dock-count {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.dock-section .dock-count--live {
  color: var(--ink-soft);
}

@media (prefers-reduced-motion: reduce) {
  .dock-section__body,
  .dock-section__head {
    transition: none;
  }
}
</style>
