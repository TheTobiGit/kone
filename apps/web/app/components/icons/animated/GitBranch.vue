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

// the main branch trunk stays anchored while the new branch draws out and its target commit node pops
const branchTrackVariants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.2, 1],
    pathOffset: [0, 0.8, 0],
    transition: { duration: 0.58, ease: [0.23, 1, 0.32, 1] },
  },
};

const branchHeadVariants = {
  normal: { transform: "scale(1)" },
  animate: {
    transform: ["scale(1)", "scale(1)", "scale(1.35)", "scale(0.92)", "scale(1)"],
    transition: { duration: 0.58, ease: [0.23, 1, 0.32, 1], times: [0, 0.45, 0.7, 0.85, 1] },
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
        d="M7 19H13C15.8284 19 17.2426 19 18.1213 18.1213C19 17.2426 19 15.8284 19 13V10M19 10C19.7002 10 21.0085 11.9943 21.5 12.5M19 10C18.2998 10 16.9915 11.9943 16.5 12.5"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="branchTrackVariants"
        :animate="controls"
        initial="normal"
      />
      <path d="M5 7L5 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <circle cx="5" cy="5" r="2" stroke="currentColor" :stroke-width="strokeWidth" />
      <motion.circle
        cx="19"
        cy="5"
        r="2"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        :variants="branchHeadVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '19px 5px' }"
      />
      <circle cx="5" cy="19" r="2" stroke="currentColor" :stroke-width="strokeWidth" />
    </svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
