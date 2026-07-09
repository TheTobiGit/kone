<script setup lang="ts">
import type { ToolActivity } from "~/types/conversation";

defineProps<{
  tools: ToolActivity[];
}>();
</script>

<template>
  <div
    v-if="tools.length"
    class="mt-3 w-full divide-y divide-zinc-200/60 border-y border-zinc-200/60 py-0.5 dark:divide-zinc-800/70 dark:border-zinc-800/70"
    aria-label="Agent activity"
  >
    <ToolActivityRow
      v-for="activity in tools"
      :key="activity.id"
      :activity="activity"
    />
  </div>
</template>
