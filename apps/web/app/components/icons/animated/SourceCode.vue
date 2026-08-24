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

// the code brackets spread outward while the center slash redraws cleanly
const leftBracketVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(0px)", "translateX(-2px)", "translateX(0.3px)", "translateX(0px)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const rightBracketVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(0px)", "translateX(2px)", "translateX(-0.3px)", "translateX(0px)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const slashVariants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.3, 1],
    pathOffset: [0, 0.7, 0],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1], delay: 0.04 },
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
        d="M7 8L5.16019 9.85008C4.38673 10.6279 4 11.0168 4 11.5C4 11.9832 4.38673 12.3721 5.16019 13.1499L7 15"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="leftBracketVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M14.5 4L9.5 20"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="slashVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M17 8L18.8398 9.85008C19.6133 10.6279 20 11.0168 20 11.5C20 11.9832 19.6133 12.3721 18.8398 13.1499L17 15"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="rightBracketVariants"
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
