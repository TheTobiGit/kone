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

// directional flow around the corner: the stem pulses and the arrowhead surges forward
const arrowheadVariants = {
  normal: { transform: "translate(0px, 0px)" },
  animate: {
    transform: [
      "translate(0px, 0px)",
      "translate(2.8px, 0px)",
      "translate(-0.4px, 0px)",
      "translate(0.3px, 0px)",
      "translate(0px, 0px)",
    ],
    transition: { duration: 0.54, ease: [0.23, 1, 0.32, 1] },
  },
};

const stemVariants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.88, 1],
    pathOffset: [0, 0.12, 0],
    transition: { duration: 0.54, ease: [0.23, 1, 0.32, 1] },
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
        d="M19 15.002H12C8.22876 15.002 6.34315 15.002 5.17157 13.8304C4 12.6588 4 10.7732 4 7.00195V4.00195"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="stemVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M15 20.002C15 20.002 20 16.3195 20 15.0019C20 13.6843 15 10.002 15 10.002"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="arrowheadVariants"
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
