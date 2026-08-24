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

// the H letterform anchors while the heading level number badge lifts and settles
const numberVariants = {
  normal: { transform: "translateY(0px) scale(1)" },
  animate: {
    transform: [
      "translateY(0px) scale(1)",
      "translateY(-2.8px) scale(1.08)",
      "translateY(0.4px) scale(0.97)",
      "translateY(-0.2px) scale(1.01)",
      "translateY(0px) scale(1)",
    ],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const crossbarVariants = {
  normal: { scaleX: 1 },
  animate: {
    scaleX: [1, 1.12, 0.98, 1],
    transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1], delay: 0.04 },
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
      <path d="M4 5V19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <path d="M14 5V19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <motion.path
        d="M4 12L14 12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="crossbarVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '9px 12px' }"
      />
      <motion.path
        d="M17 19H18.5M20 19H18.5M18.5 19V11L17 12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="numberVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '18.5px 15px' }"
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
