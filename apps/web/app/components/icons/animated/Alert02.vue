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

// the warning triangle cushions on its base while the exclamation mark hops and alerts
const triangleVariants = {
  normal: { transform: "scaleY(1)" },
  animate: {
    transform: ["scaleY(1)", "scaleY(0.92)", "scaleY(1.04)", "scaleY(0.98)", "scaleY(1)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const stemVariants = {
  normal: { transform: "scaleY(1)" },
  animate: {
    transform: ["scaleY(1)", "scaleY(1.2)", "scaleY(0.95)", "scaleY(1)"],
    transition: { duration: 0.48, ease: [0.23, 1, 0.32, 1], delay: 0.04 },
  },
};

const dotVariants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: ["translateY(0px)", "translateY(-1.8px)", "translateY(0.4px)", "translateY(0px)"],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1], delay: 0.08 },
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
        d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="triangleVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 21px' }"
      />
      <motion.path
        d="M12 9V13"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="stemVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 13px' }"
      />
      <motion.path
        d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z"
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
