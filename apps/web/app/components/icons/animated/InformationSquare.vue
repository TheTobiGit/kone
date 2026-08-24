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

// the square outline stays grounded while the information dot hops and the stem cushions
const dotVariants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: ["translateY(0px)", "translateY(-2.2px)", "translateY(0.4px)", "translateY(0px)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const stemVariants = {
  normal: { transform: "scaleY(1)" },
  animate: {
    transform: ["scaleY(1)", "scaleY(1.15)", "scaleY(0.96)", "scaleY(1)"],
    transition: { duration: 0.48, ease: [0.23, 1, 0.32, 1], delay: 0.05 },
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
      <path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <motion.path
        d="M12 16V12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="stemVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 16px' }"
      />
      <motion.path
        d="M12.125 8.25H12M12.25 8.25C12.25 8.11193 12.1381 8 12 8C11.8619 8 11.75 8.11193 11.75 8.25C11.75 8.38807 11.8619 8.5 12 8.5C12.1381 8.5 12.25 8.38807 12.25 8.25Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="dotVariants"
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
