<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// the whole arrow lifts toward the top-right, springs past, then settles
// back — a one-beat nudge on the group, anchored at its own centre.
const arrowVariants = {
  normal: { transform: "translate(0px, 0px) scale(1)" },
  animate: {
    transform: [
      "translate(0px, 0px) scale(1)",
      "translate(2.1px, -2.1px) scale(0.97)",
      "translate(-0.25px, 0.25px) scale(1.01)",
      "translate(0.4px, -0.4px) scale(0.995)",
      "translate(0px, 0px) scale(1)",
    ],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1] },
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
      <motion.g
        :variants="arrowVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 12px' }"
      >
        <path
          d="M16.5 7.5L6.5 17.5"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
        />
        <path
          d="M9 6.65032C9 6.65032 15.9383 6.10759 16.9154 7.08463C17.8924 8.06167 17.3496 15 17.3496 15"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
        />
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
