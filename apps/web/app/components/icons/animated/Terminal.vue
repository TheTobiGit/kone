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

// the command chevron steps forward while the cursor underline blinks
const chevronVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(0px)", "translateX(2.2px)", "translateX(-0.3px)", "translateX(0px)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const cursorVariants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0, 1, 0, 1],
    transition: { duration: 0.6, ease: "linear" },
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
        d="M4.00004 17C4.00004 17 9.99999 12.5811 10 11C10 9.41884 4 5 4 5"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="chevronVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M12 19H20"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="cursorVariants"
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
