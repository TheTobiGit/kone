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

// a sharp rightward surge with directional compression and an elastic rebound
const arrowVariants = {
  normal: { transform: "translateX(0px) scaleY(1)" },
  animate: {
    transform: [
      "translateX(0px) scaleY(1)",
      "translateX(3.2px) scaleY(0.92)",
      "translateX(-0.4px) scaleY(1.03)",
      "translateX(0.5px) scaleY(0.99)",
      "translateX(0px) scaleY(1)",
    ],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
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
      <motion.g :variants="arrowVariants" :animate="controls" initial="normal" :style="{ transformOrigin: '12px 12px' }">
        <path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
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
