<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// the alert strikes in one beat: the ring flinches inward, the stem leans
// and rebounds through overshoot, and the dot drops under its own weight —
// each keyed to its own easing so they read as one impact
const circleVariants = {
  normal: { transform: "scale(1)" },
  animate: {
    transform: ["scale(1)", "scale(0.96)", "scale(1.025)", "scale(0.996)", "scale(1)"],
    transition: {
      duration: 0.56,
      ease: [0.23, 1, 0.32, 1],
      times: [0, 0.18, 0.48, 0.74, 1],
    },
  },
};

const stemVariants = {
  normal: { transform: "translateY(0px) scaleY(1)" },
  animate: {
    transform: ["translateY(0px) scaleY(1)", "translateY(-0.8px) scaleY(1.08)", "translateY(0.35px) scaleY(0.94)", "translateY(-0.12px) scaleY(1.02)", "translateY(0px) scaleY(1)"],
    transition: {
      duration: 0.56,
      ease: [0.23, 1, 0.32, 1],
      times: [0, 0.24, 0.52, 0.76, 1],
    },
  },
};

const dotVariants = {
  normal: { transform: "scale(1)" },
  animate: {
    transform: ["translateY(0px) scale(1)", "translateY(0.9px) scale(0.88)", "translateY(-1px) scale(1.18)", "translateY(0.24px) scale(0.93)", "translateY(0px) scale(1)"],
    transition: {
      duration: 0.56,
      ease: [0.23, 1, 0.32, 1],
      times: [0, 0.18, 0.48, 0.74, 1],
    },
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
      <motion.circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :style="{ transformOrigin: '12px 12px' }"
        :variants="circleVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M12 8V12"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :style="{ transformOrigin: '12px 12px' }"
        :variants="stemVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M12.125 15.75H12M12.25 15.75C12.25 15.8881 12.1381 16 12 16C11.8619 16 11.75 15.8881 11.75 15.75C11.75 15.6119 11.8619 15.5 12 15.5C12.1381 15.5 12.25 15.6119 12.25 15.75Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :style="{ transformOrigin: '12px 15.75px' }"
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
