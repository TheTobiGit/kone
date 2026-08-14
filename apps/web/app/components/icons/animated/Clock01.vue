<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 28, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// a playful fast-forward: the long hand completes two circuits while the short
// hand completes one, both winding up and settling back into the rest shape
const CLOCK_REST = "M12 8L12 12L14 14";

const handsVariants = {
  normal: { d: CLOCK_REST },
  animate: {
    d: [
      CLOCK_REST,
      "M15.464 10L12 12L12.732 14.732",
      "M15.464 14L12 12L11.268 14.732",
      "M12 16L12 12L10 14",
      "M8.536 14L12 12L9.268 12.732",
      "M8.536 10L12 12L9.268 11.268",
      "M12 8L12 12L10 10",
      "M15.464 10L12 12L11.268 9.268",
      "M15.464 14L12 12L12.732 9.268",
      "M12 16L12 12L14 10",
      "M8.536 14L12 12L14.732 11.268",
      "M8.536 10L12 12L14.732 12.732",
      CLOCK_REST,
    ],
    transition: {
      duration: 1.04,
      ease: "linear",
      times: [0, 0.12, 0.22, 0.3, 0.37, 0.43, 0.49, 0.55, 0.61, 0.68, 0.76, 0.86, 1],
    },
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
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        :stroke-width="strokeWidth"
      />
      <motion.path
        d="M12 8V12L14 14"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="handsVariants"
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
