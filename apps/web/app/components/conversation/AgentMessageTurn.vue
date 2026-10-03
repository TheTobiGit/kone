<script setup lang="ts">
import { computed } from "vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import { messageSpeaker, type SpeakingSender } from "~/utils/messageSpeaker";

// Words another agent wrote into this thread — a delegator's brief, a
// follow-up, a question from a delegate, a worker's report — or that kone's
// courier carried here for one.
//
// It sits on the agent's side of the conversation, with the speaker's own face
// and name, because it is not the user speaking: only the user's words take
// the user's side. The relationship tag says who it is to this thread ("your
// delegator", "your contractor") and, for a message with a purpose, what it is
// for, so a question reads as waiting on an answer and a note as needing none.
// The courier speaks as kone, never as the agent whose work it carries: that
// agent is named in the tag, and the name opens its thread.
//
// It reuses the reply's speaker classes so every conversation style lays it out
// the way it lays out an agent speaking, and each style then draws the words
// as its own message from someone else: kone's left-hand bubble here, and the
// rest in conversationStyles.css under "Another agent speaking".

const props = defineProps<{
  sender: SpeakingSender;
  text: string;
  /** Show a face beside the name — the style decides, as for replies. */
  showFace: boolean;
  faceSize: number;
  stamp?: string;
  historical?: boolean;
}>();

const emit = defineEmits<{
  "open-thread": [threadId: string];
}>();

const speaker = computed(() => messageSpeaker(props.sender));

/** Whose thread the name opens: the speaker's own, or for the courier, the
 *  agent whose work it carried. */
const opensTitle = computed(() => {
  const s = speaker.value;
  return s.about ? `Open ${s.about.name}'s thread` : `Open ${s.name}'s thread`;
});
</script>

<template>
  <div class="speaker peer-head">
    <template v-if="showFace">
      <RosterFace v-if="speaker.agent" :agent="speaker.agent" :size="faceSize" class="speaker__face" />
      <AgentFace v-else :seed="speaker.seed" :size="faceSize" class="speaker__face" />
    </template>
    <div class="speaker__head">
      <button
        v-if="speaker.opens"
        type="button"
        class="speaker__name peer-head__name"
        :title="opensTitle"
        @click="emit('open-thread', speaker.opens)"
      >
        {{ speaker.name }}
      </button>
      <span v-else class="speaker__name peer-head__name">{{ speaker.name }}</span>
      <!-- A brief's sender is already named on the thread's connected line. -->
      <span v-if="speaker.purpose !== 'brief'" class="peer-head__tag" :data-kind="speaker.purpose ?? 'note'">{{ speaker.relation }}<template v-if="speaker.purpose"> · {{ speaker.purpose }}</template></span>
      <span v-if="stamp" class="speaker__stamp">{{ stamp }}</span>
    </div>
  </div>
  <div class="stack selectable peer-body" :data-kind="speaker.purpose ?? 'note'">
    <!-- The prompt style's line prefix: who is talking to whom. -->
    <span class="peer-body__prefix" aria-hidden="true">[{{ speaker.name }} → you]</span>
    <MarkdownMessage class="answer" :source="text" :historical="historical ?? true" />
  </div>
</template>

<style scoped>
/* The same speaker line a reply has — face, name, stamp — kept in step with
   AssistantTurnBody's so the two sit in one column. */
.speaker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  line-height: 1;
  -webkit-user-select: none;
  user-select: none;
  margin-bottom: -6px;
}
.speaker__face {
  position: relative;
  z-index: 1;
  border-radius: 50%;
  background: var(--ground);
}
.speaker__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1;
}
.speaker__name {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  color: var(--ink-soft);
}
.speaker__stamp {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
}
.peer-head__name {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-soft);
  cursor: pointer;
  /* Always drawn and only coloured in, so the underline fades up under the
     pointer rather than snapping on. */
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: transparent;
  transition: text-decoration-color 0.2s ease;
}
.peer-head__name:hover,
.peer-head__name:focus-visible {
  text-decoration-color: color-mix(in oklab, var(--ink) 40%, transparent);
}
/* Who the sender is to this thread: small, and quiet enough not to compete
   with the words. */
.peer-head__tag {
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--accent, var(--ink)) 12%, transparent);
  color: color-mix(in oklab, var(--accent, var(--ink)) 78%, var(--ink));
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
}
/* A question or pushback is waiting on this thread — the tag warms to say so,
   in every style, since not every style has a surface to tint. */
.peer-head__tag[data-kind="question"],
.peer-head__tag[data-kind="pushback"] {
  background: color-mix(in oklab, var(--warn, #c08a3e) 14%, transparent);
  color: color-mix(in oklab, var(--warn, #c08a3e) 80%, var(--ink));
}
/* kone's words from someone else: a bubble on the agent's side, the user's
   own bubble mirrored — its tucked corner under the sender's face, and a
   neutral wash where the user's carries the accent. Written `.stack.peer-body`
   so it outweighs the thread's own full-width `.stack`. */
.stack.peer-body {
  align-self: flex-start;
  width: auto;
  max-width: 88%;
  min-width: 0;
  padding: 10px 15px;
  border-radius: 5px 16px 16px 16px;
  background: color-mix(in oklab, var(--ink) 4.5%, var(--ground));
  text-wrap: pretty;
}
.peer-body__prefix {
  display: none;
}
</style>
