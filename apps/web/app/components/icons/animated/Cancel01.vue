<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

const FIRST_PATH = "M18 6L6.00081 17.9992";
const SECOND_PATH = "M6 6.00085L17.9992 18";

// Both strikes finish with one shared settle — a small overshoot on the
// whole glyph after the second strike lands, then it eases back to rest.
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
      duration: 1.04,
      ease: ["linear", [0.23, 1, 0.32, 1], [0.23, 1, 0.32, 1]],
      times: [0, 0.78, 0.9, 1],
    },
  },
};

// Each stroke continues briefly as the pen lifts from the page.
const firstEndFlourishVariants = {
  normal: {
    pathLength: 0,
    opacity: 0,
    visibility: "hidden",
  },
  animate: {
    pathLength: [0, 0, 1, 1],
    opacity: [0, 0, 1, 0],
    visibility: ["hidden", "hidden", "visible", "hidden"],
    transition: {
      duration: 0.76,
      ease: [
        "linear",
        [0.23, 1, 0.32, 1],
        [0.23, 1, 0.32, 1],
      ],
      times: [0, 0.69, 0.84, 1],
    },
  },
};

const secondEndFlourishVariants = {
  normal: {
    pathLength: 0,
    opacity: 0,
    visibility: "hidden",
  },
  animate: {
    pathLength: [0, 0, 1, 1],
    opacity: [0, 0, 1, 0],
    visibility: ["hidden", "hidden", "visible", "hidden"],
    transition: {
      duration: 1.06,
      ease: [
        "linear",
        [0.23, 1, 0.32, 1],
        [0.23, 1, 0.32, 1],
      ],
      times: [0, 0.77, 0.88, 1],
    },
  },
};

const generatedGeometryVariants = {
  normal: { visibility: "hidden", transition: { duration: 0.08 } },
  animate: { visibility: "visible", transition: { duration: 0 } },
};

// rest-parity: split-source-path
// The first strike starts at the top-right. The second starts at the top-left.
// Erase and redraw use those same starts, with the offset reset while hidden.
const firstStrikeVariants = {
  normal: { pathLength: 1, pathOffset: 0, visibility: "visible" },
  animate: {
    pathLength: [1, 1, 0.12, 0, 0, 0.12, 1, 1],
    pathOffset: [0, 0, 0.88, 1, 0, 0, 0, 0],
    visibility: [
      "visible",
      "visible",
      "hidden",
      "hidden",
      "hidden",
      "hidden",
      "visible",
      "visible",
    ],
    transition: {
      duration: 0.9,
      ease: [
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
        "linear",
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
      ],
      times: [0, 0.05, 0.22, 0.25, 0.34, 0.38, 0.58, 1],
    },
  },
};

const secondStrikeVariants = {
  normal: { pathLength: 1, pathOffset: 0, visibility: "visible" },
  animate: {
    pathLength: [1, 1, 0.12, 0, 0, 0.12, 1, 1],
    pathOffset: [0, 0, 0.88, 1, 0, 0, 0, 0],
    visibility: [
      "visible",
      "visible",
      "hidden",
      "hidden",
      "hidden",
      "hidden",
      "visible",
      "visible",
    ],
    transition: {
      duration: 0.9,
      ease: [
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
        "linear",
        "linear",
        [0.77, 0, 0.175, 1],
        "linear",
      ],
      times: [0, 0.1, 0.27, 0.3, 0.64, 0.7, 0.9, 1],
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
        :d="FIRST_PATH"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="firstStrikeVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.path
        :d="SECOND_PATH"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="secondStrikeVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.g
        :variants="generatedGeometryVariants"
        :animate="controls"
        initial="normal"
      >
        <motion.path
          d="M6.00081 17.9992L5.1 18.9"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
          :variants="firstEndFlourishVariants"
          :animate="controls"
          initial="normal"
        />
        <motion.path
          d="M17.9992 18L18.9 18.9008"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
          :variants="secondEndFlourishVariants"
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
