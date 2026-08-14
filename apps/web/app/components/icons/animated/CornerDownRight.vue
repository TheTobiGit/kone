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

// a short travel in its facing direction, then an eased return.
const iconVariants = {
  normal: { transform: "translate(0px, 0px)" },
  animate: {
    transform: ["translate(0px, 0px)", "translate(2px, 2px)", "translate(0px, 0px)"],
    transition: { duration: 0.5, times: [0, 0.4, 1], ease: [0.34, 1.56, 0.64, 1] },
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
      <motion.g :variants="iconVariants" :animate="controls" initial="normal">
        <path d="M19 15.002H12C8.22876 15.002 6.34315 15.002 5.17157 13.8304C4 12.6588 4 10.7732 4 7.00195V4.00195" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
        <path d="M15 20.002C15 20.002 20 16.3195 20 15.0019C20 13.6843 15 10.002 15 10.002" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      </motion.g>
    </svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
