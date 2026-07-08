<script setup lang="ts">
import { computed } from "vue";
import {
  BRAIN_ICON_OVERLAP,
  BRAIN_ICON_SIZE,
  getThinkingBrainCount,
  getThinkingColorClass,
  getThinkingIconWidth,
  getThinkingStrokeWidth,
  isThinkingSlashed,
} from "~/lib/thinking-level-icon";

const props = withDefaults(
  defineProps<{
    levelIndex: number;
    levelTotal: number;
    effortId: string;
    active?: boolean;
  }>(),
  {
    active: false,
  },
);

const brainCount = computed(() =>
  getThinkingBrainCount(props.levelIndex, props.levelTotal, props.effortId),
);

const strokeWidth = computed(() =>
  getThinkingStrokeWidth(props.levelIndex, props.levelTotal, props.effortId),
);

const colorClass = computed(() =>
  getThinkingColorClass(props.levelIndex, props.levelTotal, props.effortId),
);
const slashed = computed(() => isThinkingSlashed(props.effortId));

const width = computed(() => getThinkingIconWidth(brainCount.value));

const brainOffsets = computed(() =>
  Array.from({ length: brainCount.value }, (_, index) => ({
    left: index * (BRAIN_ICON_SIZE - BRAIN_ICON_OVERLAP),
  })),
);
</script>

<template>
  <span
    class="relative inline-flex shrink-0 items-center"
    :class="colorClass"
    :style="{ width: `${width}px`, height: `${BRAIN_ICON_SIZE}px` }"
    aria-hidden="true"
  >
    <svg
      v-for="(offset, index) in brainOffsets"
      :key="index"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="absolute top-0"
      :style="{
        left: `${offset.left}px`,
        width: `${BRAIN_ICON_SIZE}px`,
        height: `${BRAIN_ICON_SIZE}px`,
      }"
    >
      <path
        d="M12 18V5"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M17.997 5.125a4 4 0 0 1 2.526 5.77"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M18 18a4 4 0 0 0 2-7.464"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M6 18a4 4 0 0 1-2-7.464"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M6.003 5.125a4 4 0 0 0-2.526 5.77"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        v-if="slashed && index === 0"
        d="M5 5l14 14"
        stroke="currentColor"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
      />
    </svg>
  </span>
</template>
