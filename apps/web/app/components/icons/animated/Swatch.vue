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

// the color swatch fan blades pivot outward from the bottom rivet and fold back
const fanBladeVariants = {
  normal: { transform: "rotate(0deg)" },
  animate: {
    transform: ["rotate(0deg)", "rotate(16deg)", "rotate(-3deg)", "rotate(0deg)"],
    transition: { duration: 0.62, ease: [0.23, 1, 0.32, 1] },
  },
};

const frontCardVariants = {
  normal: { transform: "rotate(0deg)" },
  animate: {
    transform: ["rotate(0deg)", "rotate(-4deg)", "rotate(1deg)", "rotate(0deg)"],
    transition: { duration: 0.55, ease: [0.23, 1, 0.32, 1], delay: 0.04 },
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
      <motion.g
        :variants="fanBladeVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '7.5px 17.5px' }"
      >
        <path d="M16.5551 4C17.0179 4.42885 17.5421 4.96506 18.1713 5.60862C20.0571 7.53758 21 8.50206 21 9.70056C21 10.8991 20.0571 11.8635 18.1713 13.7925L11.7706 20.3396C11.5289 20.5868 11.2709 20.8069 11 21" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" />
        <path d="M2 16.6153C2 19.5892 4.48731 22 7.55556 22H16.4444C19.0634 22 20.3728 22 21.1864 21.2114C22 20.4229 22 19.1537 22 16.6153C22 16.0078 22 15.4729 21.9888 15" stroke="currentColor" stroke-linecap="round" :stroke-width="strokeWidth" />
      </motion.g>
      <motion.g
        :variants="frontCardVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '7.5px 17.5px' }"
      >
        <path d="M2 7.55556C2 4.93664 2 3.62718 2.80546 2.81359C3.61091 2 4.90728 2 7.5 2C10.0927 2 11.3891 2 12.1945 2.81359C13 3.62718 13 4.93664 13 7.55556V16.4444C13 19.5127 10.5376 22 7.5 22C4.46243 22 2 19.5127 2 16.4444V7.55556Z" stroke="currentColor" :stroke-width="strokeWidth" />
        <path d="M7.5 17.5H7.50898" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
        <path d="M2 8H13M2 13H13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" :stroke-width="strokeWidth" />
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
