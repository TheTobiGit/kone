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

// the shield body braces for impact while the core security keyhole mechanism locks in
const shieldVariants = {
  normal: { transform: "scale(1)" },
  animate: {
    transform: ["scale(1)", "scale(0.95)", "scale(1.04)", "scale(0.99)", "scale(1)"],
    transition: { duration: 0.52, ease: [0.23, 1, 0.32, 1] },
  },
};

const lockVariants = {
  normal: { transform: "scale(1)" },
  animate: {
    transform: ["scale(1)", "scale(1.22)", "scale(0.94)", "scale(1)"],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1], delay: 0.05 },
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
        d="M18.7088 3.49546C16.8165 2.55394 14.5009 2.00012 12 2.00012C9.4991 2.00012 7.1835 2.55394 5.29116 3.49547C4.36318 3.95718 3.89919 4.18804 3.4496 4.91391C3 5.63978 3 6.3426 3 7.74826V11.2372C3 16.9206 7.54236 20.0805 10.173 21.4339C10.9067 21.8114 11.2735 22.0001 12 22.0001C12.7265 22.0001 13.0933 21.8114 13.8269 21.4339C16.4576 20.0805 21 16.9206 21 11.2372L21 7.74827C21 6.34261 21 5.63978 20.5504 4.91391C20.1008 4.18804 19.6368 3.95718 18.7088 3.49546Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="shieldVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 12px' }"
      />
      <motion.g
        :variants="lockVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 11px' }"
      >
        <path d="M12 9.00012V10.0001M11 9.50012C11 9.76534 11.1054 10.0197 11.2929 10.2072C11.4804 10.3948 11.7348 10.5001 12 10.5001C12.2652 10.5001 12.5196 10.3948 12.7071 10.2072C12.8946 10.0197 13 9.76534 13 9.50012C13 9.23491 12.8946 8.98055 12.7071 8.79302C12.5196 8.60548 12.2652 8.50012 12 8.50012C11.7348 8.50012 11.4804 8.60548 11.2929 8.79302C11.1054 8.98055 11 9.23491 11 9.50012Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
        <path d="M12.75 14.0001H11.25L12 10.5001L12.75 14.0001Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
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
