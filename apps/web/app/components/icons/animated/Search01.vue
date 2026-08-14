<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// the lens dips in to inspect — a quick tilt-and-shrink toward the glass, then
// a springy release back to rest. Origin sits on the lens centre (11,11 in user
// units) so it reads the same at any rendered size.
const lensVariants = {
  normal: { transform: "translate(0px, 0px) rotate(0deg) scale(1)" },
  animate: {
    transform: [
      "translate(0px, 0px) rotate(0deg) scale(1)",
      "translate(1.25px, -0.55px) rotate(14deg) scale(0.78)",
      "translate(0.4px, -0.8px) rotate(6deg) scale(0.76)",
      "translate(-0.65px, 0.25px) rotate(-8deg) scale(0.8)",
      "translate(-0.15px, 0.1px) rotate(-2.5deg) scale(1.08)",
      "translate(0px, 0px) rotate(0deg) scale(1)",
    ],
    transition: {
      duration: 1.24,
      times: [0, 0.32, 0.48, 0.64, 0.84, 1],
      ease: [
        [0.77, 0, 0.175, 1],
        "linear",
        "linear",
        [0.77, 0, 0.175, 1],
        [0.23, 1, 0.32, 1],
      ],
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
      <motion.g
        :variants="lensVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '11px 11px', transformBox: 'fill-box' }"
      >
        <path
          d="M17 17L21 21"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
        />
        <path
          d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
        />
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
