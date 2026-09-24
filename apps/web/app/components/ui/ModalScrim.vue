<script setup lang="ts">
import { motion } from "motion-v";

/** Shared modal scrim: opacity fade only, no backdrop blur. One place so
 *  blur/opacity changes apply consistently across every modal. */
defineProps<{
  shown: boolean;
}>();
</script>

<template>
  <motion.div
    class="absolute inset-0"
    :initial="{ opacity: 0 }"
    :animate="{ opacity: shown ? 1 : 0 }"
    :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
  />
</template>
