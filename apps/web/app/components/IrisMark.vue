<script setup lang="ts">
/**
 * Iris — kone's agent mark. A calm ring with an accent iris at its core.
 * Ring follows --orb-ring (ink in light, light in dark); iris is --accent.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    class="shrink-0"
    aria-hidden="true"
  >
    <circle
      cx="12"
      cy="12"
      r="9.25"
      fill="none"
      stroke="var(--color-orb-ring)"
      stroke-width="1.75"
    />
    <circle cx="12" cy="12" r="3.4" fill="var(--color-accent)" />
  </svg>
</template>
