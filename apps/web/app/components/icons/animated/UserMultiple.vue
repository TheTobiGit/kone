<script setup lang="ts">
import { motion, useAnimationControls } from "motion-v";
import { useIconAnimation } from "./useIconAnimation";

withDefaults(defineProps<{ size?: number; strokeWidth?: number; trigger?: "hover" | "manual" }>(), { size: 24, strokeWidth: 1.5, trigger: "hover" });

const controls = useAnimationControls();
const { startAnimation, stopAnimation } = useIconAnimation(controls);
defineExpose({ startAnimation, stopAnimation });

// two readable profiles gather toward one another without completing or overlapping
const primaryVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(-0.7px)", "translateX(0.18px)", "translateX(0px)"],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1] },
  },
};

const secondaryVariants = {
  normal: { transform: "translateX(0px)" },
  animate: {
    transform: ["translateX(0.7px)", "translateX(-0.18px)", "translateX(0px)"],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1] },
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
      <!-- The near figure: head and shoulders move together, so both carry the
           primary variant and each turns about its own centre. -->
      <motion.path
        d="M13 11C13 8.79086 11.2091 7 9 7C6.79086 7 5 8.79086 5 11C5 13.2091 6.79086 15 9 15C11.2091 15 13 13.2091 13 11Z"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="primaryVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '9px 11px' }"
      />
      <motion.path
        d="M15 21C15 17.6863 12.3137 15 9 15C5.68629 15 3 17.6863 3 21"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="primaryVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '9px 21px' }"
      />
      <!-- The far figure, leaning the other way: the two closing on each other is
           the whole gesture, and it only reads if neither one is the still half. -->
      <motion.path
        d="M11.0386 7.55773C11.0131 7.37547 11 7.18927 11 7C11 4.79086 12.7909 3 15 3C17.2091 3 19 4.79086 19 7C19 9.20914 17.2091 11 15 11C14.2554 11 13.5584 10.7966 12.9614 10.4423"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="secondaryVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '15px 7px' }"
      />
      <motion.path
        d="M21 17C21 13.6863 18.3137 11 15 11"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="strokeWidth"
        :variants="secondaryVariants"
        :animate="controls"
        initial="normal"
        :style="{ transformOrigin: '18px 17px' }"
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
