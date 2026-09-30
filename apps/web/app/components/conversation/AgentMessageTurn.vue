<script setup lang="ts">
import { computed } from "vue";
import { senderRelationshipLabel } from "@kone/protocol/message-sender";
import type { AgentSender } from "~/types/desktop";
import AgentFace from "~/components/agent/AgentFace.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentOrDeparted } from "~/utils/agents";

// Words another agent wrote into this thread — a delegator's brief, a
// follow-up, a question from a delegate, a worker's report.
//
// It sits on the agent's side of the conversation, with that agent's own face
// and name, because it is not the user speaking: only the user's words take
// the user's side. The relationship tag says who it is to this thread ("your
// delegator", "your contractor") and, for a message with a purpose, what it is
// for, so a question reads as waiting on an answer and a note as needing none.
//
// It reuses the reply's speaker classes so every conversation style lays it out
// the way it lays out an agent speaking; `.turn--peer` on the turn adds the
// tint that tells it apart from this thread's own agent.

const props = defineProps<{
  sender: AgentSender;
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

/** A saved agent, while the roster still has it — renamed or not. */
const rosterAgent = computed(() => agentOrDeparted(props.sender.agentId));

const name = computed(
  () => rosterAgent.value?.name ?? props.sender.name ?? agentIdentity(props.sender.threadId).name,
);

const relation = computed(() => senderRelationshipLabel(props.sender.relationship));

/** What the message is for, when that changes how to read it. A brief and a
 *  follow-up are what a hand-off is made of; a note is the default. */
const purpose = computed(() => {
  switch (props.sender.messageKind) {
    case "question":
      return "question";
    case "pushback":
      return "pushback";
    case "report":
      return "report";
    case "answer":
      return "answer";
    case "brief":
      return "brief";
    default:
      return null;
  }
});
</script>

<template>
  <div class="speaker peer-head">
    <template v-if="showFace">
      <RosterFace v-if="rosterAgent" :agent="rosterAgent" :size="faceSize" class="speaker__face" />
      <AgentFace v-else :seed="sender.threadId" :size="faceSize" class="speaker__face" />
    </template>
    <div class="speaker__head">
      <button
        type="button"
        class="speaker__name peer-head__name"
        :title="`Open ${name}'s thread`"
        @click="emit('open-thread', sender.threadId)"
      >
        {{ name }}
      </button>
      <span class="peer-head__tag">{{ relation }}<template v-if="purpose"> · {{ purpose }}</template></span>
      <span v-if="stamp" class="speaker__stamp">{{ stamp }}</span>
    </div>
  </div>
  <div class="stack selectable peer-body" :data-kind="purpose ?? 'note'">
    <!-- The prompt style's line prefix: who is talking to whom. -->
    <span class="peer-body__prefix" aria-hidden="true">[{{ name }} → you]</span>
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
}
.peer-head__name:hover,
.peer-head__name:focus-visible {
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in oklab, var(--ink) 30%, transparent);
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
/* The words themselves, on a tinted card with an edge in the sender's
   colour: another agent speaking, never this thread's own reply. */
.peer-body {
  width: 100%;
  min-width: 0;
  padding: 9px 12px;
  border-left: 2px solid color-mix(in oklab, var(--accent, var(--ink)) 55%, transparent);
  border-radius: 4px 10px 10px 4px;
  background: color-mix(in oklab, var(--accent, var(--ink)) 6%, var(--ground));
}
/* A question or pushback is waiting on this thread — a warmer edge says so. */
.peer-body[data-kind="question"],
.peer-body[data-kind="pushback"] {
  border-left-color: color-mix(in oklab, var(--warn, #c08a3e) 75%, transparent);
  background: color-mix(in oklab, var(--warn, #c08a3e) 7%, var(--ground));
}
.peer-body__prefix {
  display: none;
}
</style>
