<script setup lang="ts">
import { motion } from "motion-v";
import { useMouse } from "@vueuse/core";

const { x, y } = useMouse();
</script>

<template>
  <main
    class="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 text-neutral-100"
  >
    <motion.h1
      class="text-4xl font-semibold tracking-tight"
      :initial="{ opacity: 0, y: 12 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.6, ease: 'easeOut' }"
    >
      kone
    </motion.h1>

    <motion.p
      class="text-sm text-neutral-400"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :transition="{ delay: 0.3, duration: 0.6 }"
    >
      Nuxt · Electron · Tailwind · Motion&nbsp;Vue · VueUse
    </motion.p>

    <p class="font-mono text-xs text-neutral-600">
      mouse: {{ Math.round(x) }}, {{ Math.round(y) }}
    </p>
  </main>
</template>
