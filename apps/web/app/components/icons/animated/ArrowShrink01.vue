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

// diagonal corner arrows compress inward toward the center, then release with a crisp rebound
const topArrowVariants = {
  normal: { transform: "translate(0px, 0px)" },
  animate: {
    transform: [
      "translate(0px, 0px)",
      "translate(2.5px, 2.5px)",
      "translate(-0.4px, -0.4px)",
      "translate(0.2px, 0.2px)",
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
      "translate(-2.5px, -2.5px)",
      "translate(0.4px, 0.4px)",
      "translate(-0.2px, -0.2px)",
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
        d="M6.5023 10.7365C7.34671 10.7485 10.1432 11.3294 10.7361 10.7365C11.329 10.1436 10.7481 7.34708 10.7361 6.50267M10.3691 10.3763L2.99998 2.99902"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="topArrowVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M13.2685 17.5027C13.2565 16.6583 12.6756 13.8618 13.2685 13.2689C13.8614 12.676 16.6579 13.2569 17.5023 13.2689M20.9991 21.001L13.6102 13.6188"
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
