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
const draw3 = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1, 1],
    transition: { duration: 0.5, delay: 0.21, times: [0, 0.15, 1], ease: [0.4, 0, 0.2, 1] },
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
      <motion.path d="M7 17L7 13" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" :variants="draw0" :animate="controls" initial="normal" />
      <motion.path d="M12 17L12 7" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" :variants="draw1" :animate="controls" initial="normal" />
      <motion.path d="M17 17L17 11" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" :variants="draw2" :animate="controls" initial="normal" />
      <motion.path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z" stroke="currentColor" stroke-linejoin="round" :stroke-width="strokeWidth" :variants="draw3" :animate="controls" initial="normal" />
    </svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
