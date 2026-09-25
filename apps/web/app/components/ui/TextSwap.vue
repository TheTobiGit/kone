<script setup lang="ts">
// A label that changes in place — "Copy" becoming "Copied", "Load older turns"
// becoming "Loading…" — swapped as a `scale-down-fade` crossfade rather than a
// hard cut: the old label settles down and away while the new one lands from
// a hair above its final size, with a short overlap so the slot is never empty.
//
// Both labels share one grid cell while they overlap, so the swap needs no
// absolute positioning and the control never collapses to zero width between
// them; it takes the new label's width the moment the old one has left.
//
// Timings run at ~0.72× the effect's own (520ms in, 380ms out) and the travel
// is cut to 3px: at control-label size the full move reads as the button
// jumping, and a click's feedback should finish before the hand has moved on.

defineProps<{
  /** What the slot currently says. A new value is what plays the swap; the
   *  slot renders it unless content is passed in. */
  swapKey: string;
}>();
</script>

<template>
  <span class="swap">
    <Transition name="swap">
      <span :key="swapKey" class="swap__item"><slot>{{ swapKey }}</slot></span>
    </Transition>
  </span>
</template>

<style scoped>
/* The gap passes through from the host control, so an icon + label pair
   inside the swap keeps the control's own spacing. */
.swap {
  display: inline-grid;
  vertical-align: bottom;
  gap: inherit;
}
.swap__item {
  grid-area: 1 / 1;
  display: inline-flex;
  align-items: center;
  gap: inherit;
  white-space: nowrap;
}
/* Enter starts as the exit is ~2/3 through — the effect's overlap — so the
   labels cross rather than queue. */
.swap-enter-active {
  transition:
    opacity 375ms cubic-bezier(0.22, 1, 0.36, 1) 180ms,
    transform 375ms cubic-bezier(0.22, 1, 0.36, 1) 180ms;
}
.swap-leave-active {
  transition:
    opacity 275ms cubic-bezier(0.64, 0, 0.78, 0),
    transform 275ms cubic-bezier(0.64, 0, 0.78, 0);
}
.swap-enter-from {
  opacity: 0;
  transform: translateY(3px) scale(1.04);
}
.swap-leave-to {
  opacity: 0;
  transform: translateY(-3px) scale(0.94);
}
@media (prefers-reduced-motion: reduce) {
  .swap-enter-active,
  .swap-leave-active {
    transition: opacity 120ms ease;
  }
  .swap-enter-from,
  .swap-leave-to {
    transform: none;
  }
}
</style>
