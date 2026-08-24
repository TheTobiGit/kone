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

// a sharp downward surge with directional compression and an elastic rebound
const arrowVariants = {
  normal: { transform: "translateY(0px) scaleX(1)" },
  animate: {
    transform: [
      "translateY(0px) scaleX(1)",
      "translateY(3.2px) scaleX(0.92)",
      "translateY(-0.4px) scaleX(1.03)",
      "translateY(0.5px) scaleX(0.99)",
      "translateY(0px) scaleX(1)",
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
        <path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
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
