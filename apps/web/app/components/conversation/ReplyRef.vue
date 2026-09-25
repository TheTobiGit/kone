<script setup lang="ts">
import { useProfile } from "~/composables/useProfile";

// The channel's reply lead-in: which request this answers, as a line with a
// spine running into it from the reply's face (see STYLE_SPECS.replyRef).
// Extracted from ConversationThread; every rule that draws this lives in
// conversationStyles.css, keyed off the thread root's `thread--style-*` class.
//
// Reads identity only — the thread warms the account lookup once (see
// ConversationThread), rather than every lead-in firing its own resolve.
defineProps<{
  text: string;
}>();

const profile = useProfile();
</script>

<template>
  <div class="reply-ref" aria-hidden="true">
    <span class="reply-ref__face" :style="profile.avatarStyle.value">{{
      profile.youInitial.value
    }}</span>
    <span class="reply-ref__name">{{ profile.youName.value }}</span>
    <span class="reply-ref__text">{{ text }}</span>
  </div>
</template>
