<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// a mark stamping into place: the combined glyph hands off to two
// hand-drawn strokes that each overshoot long, pinch short, and settle
const plusBaseVariants = {
  normal: { visibility: "visible", transition: { duration: 0.2, delay: 0.05 } },
  animate: { visibility: "hidden", transition: { duration: 0.08 } },
};

const stemVariants = {
  normal: { d: "M12 4V20", visibility: "hidden", transition: { duration: 0.15 } },
  animate: {
    d: ["M12 4V20", "M12 2.6V21.4", "M12 4.6V19.4", "M12 4V20"],
    visibility: "visible",
    transition: {
      d: { duration: 0.5, ease: "easeInOut", times: [0, 0.32, 0.68, 1] },
    },
  },
};

const armVariants = {
  normal: { d: "M20 12H4", visibility: "hidden", transition: { duration: 0.15 } },
  animate: {
    d: ["M20 12H4", "M21.4 12H2.6", "M19.4 12H4.6", "M20 12H4"],
    visibility: "visible",
    transition: {
      d: { duration: 0.5, ease: "easeInOut", times: [0, 0.32, 0.68, 1], delay: 0.05 },
    },
  },
};

const generatedGeometryVariants = {
  normal: { visibility: "hidden", transition: { duration: 0.08 } },
  animate: { visibility: "visible", transition: { duration: 0.08 } },
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
        d="M12 4V20M20 12H4"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="plusBaseVariants"
        :animate="controls"
        initial="normal"
      />
      <motion.g
        :variants="generatedGeometryVariants"
        :animate="controls"
        initial="normal"
      >
        <motion.path
          d="M12 4V20"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
          :variants="stemVariants"
          :animate="controls"
          initial="normal"
        />
        <motion.path
          d="M20 12H4"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-width="strokeWidth"
          :variants="armVariants"
          :animate="controls"
          initial="normal"
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
