<script setup lang="ts">
import type { InteractionMode } from "~/types/desktop";

// One glyph per rung of the autonomy ladder (~/utils/interactionModes): the
// composer's mode control and the Composer settings page draw the same marks.
defineProps<{ mode: InteractionMode }>();
</script>

<template>
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <!-- Ask · a chat bubble with a question (the agent asks first) -->
    <template v-if="mode === 'ask'">
      <path d="M3 5.2c0-.9.7-1.6 1.6-1.6h8.8c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H8l-3 2.4V11.4H4.6c-.9 0-1.6-.7-1.6-1.6Z" />
      <path d="M7.6 6.7a1.4 1.4 0 1 1 1.9 1.3c-.5.3-.7.6-.7 1.1" />
      <path d="M8.8 10.7v.02" />
    </template>
    <!-- Edits · a pencil (auto-applies edits) -->
    <template v-else-if="mode === 'accept-edits'">
      <path d="M11.4 3.7 14.3 6.6 6.9 14H4v-2.9Z" />
      <path d="M10.4 4.7 13.3 7.6" />
    </template>
    <!-- Full access · a shield (no limits, nothing held back) -->
    <template v-else>
      <path d="M9 2.6 14 4.6V9C14 12 11.9 14 9 15.4 6.1 14 4 12 4 9V4.6Z" />
    </template>
  </svg>
</template>
