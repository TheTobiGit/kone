<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), {
  size: 24,
  strokeWidth: 1.5,
  trigger: "hover",
});

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// each stroke redraws itself in, as if written on the spot.
const draw0 = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1, 1],
    transition: { duration: 0.5, delay: 0.0, times: [0, 0.15, 1], ease: [0.4, 0, 0.2, 1] },
  },
};
const draw1 = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1, 1],
    transition: { duration: 0.5, delay: 0.07, times: [0, 0.15, 1], ease: [0.4, 0, 0.2, 1] },
  },
};
const draw2 = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1, 1],
    transition: { duration: 0.5, delay: 0.14, times: [0, 0.15, 1], ease: [0.4, 0, 0.2, 1] },
  },
};
</script>

<template>
  <span
    class="animated-icon"
    @mouseenter="trigger === 'hover' && startAnimation()"
    @mouseleave="trigger === 'hover' && stopAnimation()"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      :width="size"
      :height="size"
      viewBox="0 0 24 24"
      fill="none"
      overflow="visible"
    >
      <motion.path d="M3 21H21" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" :variants="draw0" :animate="controls" initial="normal" />
      <motion.path d="M19 18L15.6247 9.15847C14.0574 5.05282 13.2737 3 12 3C10.7263 3 9.94261 5.05282 8.37527 9.15847L5 18" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" :variants="draw1" :animate="controls" initial="normal" />
      <motion.path d="M8 11H16" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" :variants="draw2" :animate="controls" initial="normal" />
    </svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
