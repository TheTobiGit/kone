<script setup lang="ts">
import { motion } from "motion-v";
import type { Project } from "~/composables/useProject";

defineProps<{ project: Project }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <main class="flex h-full min-h-screen flex-col bg-ground px-16 pt-[52px]">
    <HomeHeader>
      <template #trailing>
        <button
          type="button"
          class="cursor-pointer font-mono text-xs text-muted transition-colors duration-150 hover:text-ink"
          style="letter-spacing: 0.16em"
          @click="$emit('close')"
        >
          ← HOME
        </button>
      </template>
    </HomeHeader>

    <!-- Opened project: for now, just the directory name at rest. -->
    <section class="flex flex-1 flex-col items-center justify-center">
      <motion.div
        class="flex flex-col items-center gap-3"
        :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }"
      >
        <span
          class="font-mono text-muted"
          style="font-size: 11px; letter-spacing: 0.18em"
        >
          OPENED PROJECT
        </span>
        <h1
          class="text-ink"
          style="
            font-size: 34px;
            font-weight: 600;
            letter-spacing: -0.02em;
            line-height: 1.05;
          "
        >
          {{ project.name }}
        </h1>
      </motion.div>
    </section>
  </main>
</template>
