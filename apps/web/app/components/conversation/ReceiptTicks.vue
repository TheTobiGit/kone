<script setup lang="ts">
// The chat's corner ticks: sent, delivered while the reply is being written,
// read once it has been. Extracted from ConversationThread; the only
// bubble-stamped style with ticks is the chat (see STYLE_SPECS.ticks).
defineProps<{
  receipt: "sent" | "delivered" | "read";
}>();
</script>

<template>
  <svg class="you-ticks" :class="`you-ticks--${receipt}`" viewBox="0 0 16 11">
    <path d="M11.2 1.1 4.6 8.3 1.9 5.6l-.9.9 3.6 3.6 7.5-8.1z" />
    <path v-if="receipt !== 'sent'" d="M15.1 1.1 8.5 8.3l-.7-.7-.9.9 1.6 1.6 7.5-8.1z" />
  </svg>
</template>
