<script setup lang="ts">
// The small sheet of paper a settings glyph is drawn on: ink at low strength
// for the wash and the hairline edge, so the one tile wearing the accent is the
// only colour in its column. The drawing itself is the slot; this owns only the
// sheet, the accent state and the reduced-motion stop.
//
// `accent` colours the sheet; `live` is the flag a drawing keys its loop off
// (`.gt--live …`). They're separate because a choice that's set wears the accent
// without moving, and a row under the pointer moves.

defineProps<{ accent?: boolean; live?: boolean }>();
</script>

<template>
  <span class="gt" :class="{ 'gt--accent': accent, 'gt--live': live }" aria-hidden="true">
    <slot />
  </span>
</template>

<style scoped>
.gt {
  --gt-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --gt-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  flex-shrink: 0;
  background-color: color-mix(in srgb, var(--ink) var(--gt-wash, 5%), transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) var(--gt-edge, 6%), transparent);
  transition:
    color 220ms ease,
    background-color 220ms ease,
    box-shadow 220ms ease;
}
.gt--accent {
  color: var(--accent);
  background-color: color-mix(in srgb, var(--accent) var(--gt-accent-wash, 12%), transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .gt,
  .gt :deep(*) {
    animation: none !important;
    transition: none !important;
  }
}
</style>
