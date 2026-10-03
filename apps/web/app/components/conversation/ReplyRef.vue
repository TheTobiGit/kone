<script setup lang="ts">
import { computed } from "vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import { useProfile } from "~/composables/useProfile";
import { messageSpeaker, type SpeakingSender } from "~/utils/messageSpeaker";

// The channel's reply lead-in: which request this answers, as a line with a
// spine running into it from the reply's face (see STYLE_SPECS.replyRef).
// Extracted from ConversationThread; every rule that draws this lives in
// conversationStyles.css, keyed off the thread root's `thread--style-*` class.
//
// Reads identity only — the thread warms the account lookup once (see
// ConversationThread), rather than every lead-in firing its own resolve.
//
// The request is the user's unless another agent wrote it — a brief, a
// follow-up — and then the line wears that agent's face and name; or kone's
// courier carried it, and then it wears kone's.
const props = defineProps<{
  text: string;
  from?: SpeakingSender | null;
}>();

const profile = useProfile();

const speaker = computed(() => (props.from ? messageSpeaker(props.from) : null));
</script>

<template>
  <div class="reply-ref" aria-hidden="true">
    <template v-if="speaker">
      <RosterFace v-if="speaker.agent" :agent="speaker.agent" :size="16" class="reply-ref__face" />
      <AgentFace v-else :seed="speaker.seed" :size="16" class="reply-ref__face" />
      <span class="reply-ref__name">{{ speaker.name }}</span>
    </template>
    <template v-else>
      <span class="reply-ref__face" :style="profile.avatarStyle.value">{{
        profile.youInitial.value
      }}</span>
      <span class="reply-ref__name">{{ profile.youName.value }}</span>
    </template>
    <span class="reply-ref__text">{{ text }}</span>
  </div>
</template>
