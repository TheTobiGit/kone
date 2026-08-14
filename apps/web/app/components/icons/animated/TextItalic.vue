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

// a quick tilt-shake that reads as activity, damping to still.
const iconVariants = {
  normal: { transform: "rotate(0deg)" },
  animate: {
    transform: ["rotate(0deg)", "rotate(-6deg)", "rotate(6deg)", "rotate(-3.0deg)", "rotate(0deg)"],
    transition: { duration: 0.55, times: [0, 0.25, 0.55, 0.8, 1], ease: [0.4, 0, 0.2, 1] },
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
      <motion.g :variants="iconVariants" :animate="controls" initial="normal" :style="{ transformOrigin: '12px 12px', transformBox: 'view-box' }">
        <path d="M12 4H19" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" />
        <path d="M8 20L16 4" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" />
        <path d="M5 20H12" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" />
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
