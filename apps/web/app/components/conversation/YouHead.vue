<script setup lang="ts">
import { useProfile } from "~/composables/useProfile";

// Your face, name and time over a request — the head the non-kone styles give
// a request so it sits among the replies like one (see STYLE_SPECS.youHead).
// Extracted from ConversationThread; every rule that positions this lives in
// conversationStyles.css, keyed off the thread root's `thread--style-*` class.
//
// Reads identity only — the thread warms the account lookup once (see
// ConversationThread), rather than every head firing its own resolve.
defineProps<{
  stamp: string;
}>();

const profile = useProfile();
</script>

<template>
  <div class="you-head">
    <span class="you-head__face" :style="profile.avatarStyle.value" aria-hidden="true">{{
      profile.youInitial.value
    }}</span>
    <span class="you-head__name">{{ profile.youName.value }}</span>
    <span class="you-head__time">{{ stamp }}</span>
    <span v-if="$slots.actions" class="you-head__acts"><slot name="actions" /></span>
  </div>
</template>
