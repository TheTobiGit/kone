<script setup lang="ts">
import { ref, watch } from "vue";

/** Shared modal scrim: opacity fade only, no backdrop blur. One place so
 *  blur/opacity changes apply consistently across every modal.
 *
 *  Plain CSS keyframes rather than a JS tween, so the fade runs on the
 *  compositor and keeps going while the modal it sits under is still mounting.
 *  The fade-in plays on mount; the fade-out plays once `shown` drops after
 *  having been up, and finishes inside the modal's exit window (EXIT_MS). */
const props = defineProps<{
  shown: boolean;
}>();

// Modals mount with `shown` false and raise it a tick later, so a false
// before the first true is the entrance, not an exit.
const seen = ref(props.shown);
watch(
  () => props.shown,
  (v) => {
    if (v) seen.value = true;
  },
);
</script>

<template>
  <div class="scrim absolute inset-0" :class="{ 'scrim--out': seen && !shown }" />
</template>

<style scoped>
.scrim {
  animation: scrim-in 240ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.scrim--out {
  animation: scrim-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards;
}
@keyframes scrim-in {
  from {
    opacity: 0;
  }
}
@keyframes scrim-out {
  to {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .scrim {
    animation-duration: 1ms;
  }
}
</style>
