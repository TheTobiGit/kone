<script setup lang="ts">
import { computed } from "vue";

// A short value that ticks — a running clock, a count — where only the
// characters that changed move: "14s" to "15s" rolls the 5 in and leaves the 1
// and the s alone. Each changed character is a `per-character-rise` swap: the
// old one slides up and out of its slot as the new one rises in from below,
// crisp, no blur, clipped to the line so it reads as a counter turning over.
//
// Slots are keyed from the right, so the units stay put as the value grows a
// digit ("9s" → "10s" rolls in a new tens slot rather than shifting every
// character one place over).
//
// Timed at ~0.72× the effect (700ms in, 420ms out): a clock that ticks every
// second has to have finished turning well before the next tick.

const props = defineProps<{
  text: string;
}>();

const slots = computed(() => {
  const chars = Array.from(props.text);
  return chars.map((c, i) => ({ slot: chars.length - i, char: c }));
});
</script>

<template>
  <span class="roll" :aria-label="text">
    <span v-for="s in slots" :key="s.slot" class="roll__slot" aria-hidden="true">
      <Transition name="roll">
        <span :key="s.char" class="roll__char">{{ s.char }}</span>
      </Transition>
    </span>
  </span>
</template>

<style scoped>
.roll {
  display: inline-flex;
  font-variant-numeric: tabular-nums;
  white-space: pre;
}
.roll__slot {
  display: inline-grid;
  overflow: hidden;
}
.roll__char {
  grid-area: 1 / 1;
}
.roll-enter-active {
  transition:
    opacity 500ms cubic-bezier(0.2, 0.8, 0.2, 1),
    transform 500ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.roll-leave-active {
  transition:
    opacity 300ms cubic-bezier(0.7, 0, 0.84, 0),
    transform 300ms cubic-bezier(0.7, 0, 0.84, 0);
}
.roll-enter-from {
  opacity: 0;
  transform: translateY(70%);
}
.roll-leave-to {
  opacity: 0;
  transform: translateY(-70%);
}
@media (prefers-reduced-motion: reduce) {
  .roll-enter-active,
  .roll-leave-active {
    transition: none;
  }
}
</style>
