<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// The completed stroke compresses once as it lands, then releases without a
// trailing bounce.
const impactVariants = {
  normal: { transform: "translateY(0px) rotate(0deg) scale(1)" },
  animate: {
    transform: [
      "translateY(0px) rotate(0deg) scale(1)",
      "translateY(0px) rotate(0deg) scale(1)",
      "translateY(-0.35px) rotate(0.8deg) scale(1.08)",
      "translateY(0px) rotate(0deg) scale(1)",
    ],
    transition: {
      duration: 0.82,
      ease: ["linear", [0.23, 1, 0.32, 1], [0.23, 1, 0.32, 1]],
      times: [0, 0.78, 0.9, 1],
    },
  },
};

// Erase and redraw both start at the tail. The offset resets while the path is
// hidden, so the direction change cannot show a cap or jump.
const checkVariants = {
  normal: { pathLength: 1, pathOffset: 0, visibility: "visible" },
  animate: {
    pathLength: [1, 1, 0.12, 0, 0, 0.12, 0.25, 0.25, 1, 1],
    pathOffset: [0, 0, 0.88, 1, 0, 0, 0, 0, 0, 0],
    visibility: [
      "visible",
      "visible",
      "hidden",
      "hidden",
      "hidden",
      "hidden",
      "visible",
      "visible",
      "visible",
      "visible",
    ],
    transition: {
      duration: 0.82,
      ease: [
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
        "linear",
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
      ],
      times: [0, 0.06, 0.25, 0.28, 0.35, 0.39, 0.5, 0.57, 0.84, 1],
    },
  },
};

// The pen-lift stroke only exists while the redraw is in flight; the group
// hides it the rest of the gesture so nothing ghosts over the check.
const penLiftGroupVariants = {
  normal: { visibility: "hidden", transition: { duration: 0.08 } },
  animate: { visibility: "visible", transition: { duration: 0 } },
};

const penLiftVariants = {
  normal: { pathLength: 0, opacity: 0, visibility: "hidden" },
  animate: {
    pathLength: [0, 0, 1, 1],
    opacity: [0, 0, 0.72, 0],
    visibility: ["hidden", "hidden", "visible", "hidden"],
    transition: {
      duration: 0.9,
      ease: [
        "linear",
        [0.23, 1, 0.32, 1],
        [0.23, 1, 0.32, 1],
      ],
      times: [0, 0.765, 0.89, 1],
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
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      :width="size"
      :height="size"
      viewBox="0 0 24 24"
      fill="none"
      overflow="visible"
      :variants="impactVariants"
      :animate="controls"
      initial="normal"
      :style="{ transformOrigin: '12px 12px' }"
    >
      <motion.path
        d="M5 14L8.5 17.5L19 6.5"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="checkVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.g
        :variants="penLiftGroupVariants"
        :animate="controls"
        initial="normal"
      >
        <motion.path
          d="M19 6.5L19.48 6"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
          :variants="penLiftVariants"
          :animate="controls"
          initial="normal"
        />
      </motion.g>
    </motion.svg>
  </span>
</template>

<style scoped>
.animated-icon {
  display: inline-flex;
  line-height: 0;
}
</style>
