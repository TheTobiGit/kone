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

// the plus stems extend outward along their axes and snap shut into alignment
const stemVariants = {
  normal: { transform: "scaleY(1)" },
  animate: {
    transform: ["scaleY(1)", "scaleY(1.22)", "scaleY(0.96)", "scaleY(1)"],
    transition: { duration: 0.48, ease: [0.23, 1, 0.32, 1] },
  },
};

const armVariants = {
  normal: { transform: "scaleX(1)" },
  animate: {
    transform: ["scaleX(1)", "scaleX(1.22)", "scaleX(0.96)", "scaleX(1)"],
    transition: { duration: 0.48, ease: [0.23, 1, 0.32, 1], delay: 0.04 },
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
        d="M12.001 5.00003V19.002"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="stemVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 12px' }"
      />
      <motion.path
        d="M19.002 12.002L4.99998 12.002"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="armVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 12px' }"
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
