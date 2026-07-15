<script setup lang="ts">
import type { Project } from "~/composables/useProject";

defineProps<{ project: Project }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <main class="flex h-full min-h-screen flex-col bg-ground px-16 pt-[52px]">
    <!-- Opened project: intentionally empty — the active project surface
         gets built here next. -->
  </main>
</template>
