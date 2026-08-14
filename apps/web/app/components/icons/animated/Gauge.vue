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

// the needle sweeps up into place like a dial taking a reading.
const needleVariants = {
  normal: { transform: "rotate(0deg)" },
  animate: {
    transform: ["rotate(-55deg)", "rotate(8deg)", "rotate(0deg)"],
    transition: { duration: 0.7, times: [0, 0.7, 1], ease: [0.34, 1.56, 0.64, 1] },
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
      <circle cx="12" cy="14" r="2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <path d="M20.0007 20C21.2561 18.3287 22 16.2512 22 14C22 12.5778 21.7031 11.2249 21.1679 10M3.99927 20C2.74389 18.3287 2 16.2512 2 14C2 8.47715 6.47715 4 12 4C13.4222 4 14.7751 4.2969 16 4.83209" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <motion.path d="M13.5 12.5L19 7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" :variants="needleVariants" :animate="controls" initial="normal" :style="{ transformOrigin: '12px 14px', transformBox: 'view-box' }" />
    </svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
