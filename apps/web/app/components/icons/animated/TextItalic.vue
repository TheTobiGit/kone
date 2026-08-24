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

// the top and bottom serif bars slide while the center stem leans deeper into italic slant
const stemVariants = {
  normal: { transform: "rotate(0deg)" },
  animate: {
    transform: ["rotate(0deg)", "rotate(-8deg)", "rotate(2deg)", "rotate(0deg)"],
    transition: { duration: 0.54, ease: [0.23, 1, 0.32, 1] },
  },
};

const topBarVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(0px)", "translateX(1.4px)", "translateX(-0.3px)", "translateX(0px)"],
    transition: { duration: 0.54, ease: [0.23, 1, 0.32, 1] },
  },
};

const bottomBarVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(0px)", "translateX(-1.4px)", "translateX(0.3px)", "translateX(0px)"],
    transition: { duration: 0.54, ease: [0.23, 1, 0.32, 1] },
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
        d="M12 4H19"
        stroke="currentColor"
        stroke-linecap="round"
        :stroke-width="strokeWidth"
        :variants="topBarVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        d="M8 20L16 4"
        stroke="currentColor"
        stroke-linecap="round"
        :stroke-width="strokeWidth"
        :variants="stemVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '12px 12px' }"
      />
      <motion.path
        d="M5 20H12"
        stroke="currentColor"
        stroke-linecap="round"
        :stroke-width="strokeWidth"
        :variants="bottomBarVariants"
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
