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

// keys press downward sequentially in a staggered left-to-right typing wave
const key1Variants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: ["translateY(0px)", "translateY(1.4px)", "translateY(-0.3px)", "translateY(0px)"],
    transition: { duration: 0.42, ease: [0.23, 1, 0.32, 1], delay: 0.02 },
  },
};

const key2Variants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: ["translateY(0px)", "translateY(1.4px)", "translateY(-0.3px)", "translateY(0px)"],
    transition: { duration: 0.42, ease: [0.23, 1, 0.32, 1], delay: 0.1 },
  },
};

const key3Variants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: ["translateY(0px)", "translateY(1.4px)", "translateY(-0.3px)", "translateY(0px)"],
    transition: { duration: 0.42, ease: [0.23, 1, 0.32, 1], delay: 0.18 },
  },
};

const spacebarVariants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: ["translateY(0px)", "translateY(1.2px)", "translateY(-0.2px)", "translateY(0px)"],
    transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1], delay: 0.26 },
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
      <path d="M14.5 7H9.5C6.21252 7 4.56878 7 3.46243 7.90796C3.25989 8.07418 3.07418 8.25989 2.90796 8.46243C2 9.56878 2 11.2125 2 14.5C2 17.7875 2 19.4312 2.90796 20.5376C3.07418 20.7401 3.25989 20.9258 3.46243 21.092C4.56878 22 6.21252 22 9.5 22H14.5C17.7875 22 19.4312 22 20.5376 21.092C20.7401 20.9258 20.9258 20.7401 21.092 20.5376C22 19.4312 22 17.7875 22 14.5C22 11.2125 22 9.56878 21.092 8.46243C20.9258 8.25989 20.7401 8.07418 20.5376 7.90796C19.4312 7 17.7875 7 14.5 7Z" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" />
      <path d="M12 7V5C12 4.44772 12.4477 4 13 4C13.5523 4 14 3.55228 14 3V2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
      <motion.path
        d="M7 12L8 12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="key1Variants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M11.5 12L12.5 12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="key2Variants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M16 12L17 12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="key3Variants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M7 17L17 17"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="spacebarVariants"
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
