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

// diagonal corner arrows expand outward in opposition, then settle with a tactile snap
const topArrowVariants = {
  normal: { transform: "translate(0px, 0px)" },
  animate: {
    transform: [
      "translate(0px, 0px)",
      "translate(2.5px, -2.5px)",
      "translate(-0.4px, 0.4px)",
      "translate(0.2px, -0.2px)",
      "translate(0px, 0px)",
    ],
    transition: { duration: 0.54, ease: [0.23, 1, 0.32, 1] },
  },
};

const bottomArrowVariants = {
  normal: { transform: "translate(0px, 0px)" },
  animate: {
    transform: [
      "translate(0px, 0px)",
      "translate(-2.5px, 2.5px)",
      "translate(0.4px, -0.4px)",
      "translate(-0.2px, 0.2px)",
      "translate(0px, 0px)",
    ],
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
        d="M16.4999 3.26621C17.3443 3.25421 20.1408 2.67328 20.7337 3.26621C21.3266 3.85913 20.7457 6.65559 20.7337 7.5M20.5059 3.49097L13.5021 10.4961"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="topArrowVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M3.26636 16.5001C3.25436 17.3445 2.67343 20.141 3.26636 20.7339C3.85928 21.3268 6.65574 20.7459 7.50015 20.7339M10.502 13.4976L3.49824 20.5027"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="bottomArrowVariants"
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
