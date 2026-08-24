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

// the chat bubble breathes while the center plus badge pops with a crisp rotational snap
const bubbleVariants = {
  normal: { transform: "scale(1)" },
  animate: {
    transform: ["scale(1)", "scale(1.03)", "scale(0.98)", "scale(1)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const plusVariants = {
  normal: { transform: "scale(1) rotate(0deg)" },
  animate: {
    transform: [
      "scale(1) rotate(0deg)",
      "scale(1.24) rotate(90deg)",
      "scale(0.95) rotate(90deg)",
      "scale(1) rotate(90deg)",
    ],
    transition: { duration: 0.58, ease: [0.23, 1, 0.32, 1], times: [0, 0.45, 0.75, 1] },
    transitionEnd: { transform: "scale(1) rotate(0deg)" },
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
        d="M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="bubbleVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 12px' }"
      />
      <motion.path
        d="M15.5 12H8.5M12 8.5V15.5"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="plusVariants"
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
