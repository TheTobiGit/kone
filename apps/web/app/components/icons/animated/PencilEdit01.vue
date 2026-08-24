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

// the pencil scribbles from its tip and the baseline redraws underneath
const pencilVariants = {
  normal: { rotate: 0, translateX: 0, translateY: 0 },
  animate: {
    rotate: [0, -7, 4, -2, 0],
    translateX: [0, -1.2, 1, -0.4, 0],
    translateY: [0, 0.4, -0.2, 0.1, 0],
    transition: { duration: 0.65, ease: [0.23, 1, 0.32, 1] },
  },
};

const lineVariants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.2, 1],
    pathOffset: [0, 0.8, 0],
    transition: { duration: 0.55, ease: [0.23, 1, 0.32, 1], delay: 0.08 },
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
      <motion.path
        d="M15.2141 5.98239L16.6158 4.58063C17.39 3.80646 18.6452 3.80646 19.4194 4.58063C20.1935 5.3548 20.1935 6.60998 19.4194 7.38415L18.0176 8.78591M15.2141 5.98239L6.98023 14.2163C5.93493 15.2616 5.41226 15.7842 5.05637 16.4211C4.70047 17.058 4.3424 18.5619 4 20C5.43809 19.6576 6.94199 19.2995 7.57889 18.9436C8.21579 18.5877 8.73844 18.0651 9.78375 17.0198L18.0176 8.78591M15.2141 5.98239L18.0176 8.78591"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="pencilVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '4.5px 19.5px' }"
      />
      <motion.path
        d="M11 20H17"
        stroke="currentColor"
        stroke-linecap="round"
        :stroke-width="strokeWidth"
        :variants="lineVariants"
        :animate="controls"
        initial="normal"
      />
    </svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
