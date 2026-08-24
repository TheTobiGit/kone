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

// the download arrow glides downward into the tray while the baseline flexes to receive it
const arrowVariants = {
  normal: { transform: "translateY(0px) scaleX(1)" },
  animate: {
    transform: [
      "translateY(0px) scaleX(1)",
      "translateY(3.2px) scaleX(0.92)",
      "translateY(-0.6px) scaleX(1.02)",
      "translateY(0px) scaleX(1)",
    ],
    transition: { duration: 0.55, ease: [0.23, 1, 0.32, 1] },
  },
};

const trayVariants = {
  normal: { transform: "translateY(0px) scaleX(1)" },
  animate: {
    transform: [
      "translateY(0px) scaleX(1)",
      "translateY(0px) scaleX(1)",
      "translateY(1.2px) scaleX(1.06)",
      "translateY(0px) scaleX(1)",
    ],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1], times: [0, 0.45, 0.75, 1] },
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
        d="M16.9504 12.1817C17.1981 12.814 16.5076 13.5726 15.1267 15.0899C13.6702 16.6902 12.9201 17.4904 12 17.5C11.0799 17.4904 10.3298 16.6902 8.87331 15.0899C7.49239 13.5726 6.80193 12.814 7.04964 12.1817C7.05868 12.1586 7.06851 12.1359 7.0791 12.1135C7.34928 11.542 8.24477 11.5029 10 11.5002V4.99998C10 4.53501 10 4.30253 10.0511 4.11179C10.1898 3.59414 10.5941 3.1898 11.1118 3.05111C11.3025 3 11.535 3 12 3C12.4649 3 12.6974 3 12.8882 3.05111C13.4058 3.1898 13.8102 3.59414 13.9489 4.11179C14 4.30253 14 4.53501 14 4.99998V11.5002C15.7552 11.5029 16.6507 11.542 16.9209 12.1135C16.9315 12.1359 16.9413 12.1586 16.9504 12.1817Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="arrowVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M5.00006 21H19.0001"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="trayVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 21px' }"
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
