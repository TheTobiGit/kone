<script setup lang="ts">
import { MotionConfig } from "motion-v";

const isDesktop = computed(() => Boolean(import.meta.client && window.koneDesktop?.isDesktop));
</script>

<template>
  <MotionConfig reduced-motion="user">
    <div
      class="kone-surface kone-viewport transition-colors duration-700"
      style="transition-timing-function: var(--kone-ease-out)"
    >
      <div
        v-if="isDesktop"
        class="desktop-drag-region fixed inset-x-0 top-0 z-50 h-7"
        aria-hidden="true"
      />
      <div class="relative z-[1]">
        <slot />
      </div>
    </div>
  </MotionConfig>
</template>

<style scoped>
.desktop-drag-region {
  -webkit-app-region: drag;
}
</style>
