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
      <path d="M3.5 5V19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <path d="M13.5 5V19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <motion.path
        d="M3.5 12L13.5 12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="crossbarVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '8.5px 12px' }"
      />
      <motion.path
        d="M16.5 17C16.5 18.1046 17.3954 19 18.5 19C19.6046 19 20.5 18.1046 20.5 17C20.5 15.8954 19.6046 15 18.5 15C19.6046 15 20.5 14.1046 20.5 13C20.5 11.8954 19.6046 11 18.5 11C17.3954 11 16.5 11.8954 16.5 13"
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
