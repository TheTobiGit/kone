<script setup lang="ts">
import { computed } from "vue";
import type { AgentSender } from "~/types/desktop";
import { agentIdentity } from "~/utils/agentIdentity";
import AgentFace from "~/components/agent/AgentFace.vue";

// The thread's agent, announced once at the head of the conversation: its face
// and name, "connected". The receipt for who picked the thread up, read under
// the day divider before the first request. A delegate's or contractor's thread
// finishes the same line with who handed it the work: "Mira connected ·
// contracted by Maya".
//
// It plays only as it happens. A conversation opened from history draws the
// line already in place — replaying the arrival of an agent that arrived last
// week would claim something is happening that isn't.
//
// The reveal is carried per word and scaled down for a 12px line — at this size
// a heavy blur smears the letters into a smudge and a long stagger reads as
// lag, so both are lighter than a heading's would be: the face settles in first
// with a micro scale-fade, then the name and "connected" fade up behind it,
// crisp the whole way.

const props = defineProps<{
  /** The thread's durable id — the same seed the speaker lines use, so the
   *  face and name here are the ones that answer below. */
  seed: string;
  /** Play the arrival. Off for a transcript loaded from history. */
  animate?: boolean;
  /** The name it answers under, when it has one of its own — a contractor's
   *  contracted name rather than the call sign its seed derives. */
  name?: string | null;
  /** The brief's sender, when another agent handed this thread its work. */
  from?: AgentSender | null;
}>();

const emit = defineEmits<{
  "open-thread": [threadId: string];
}>();

const identity = computed(() => agentIdentity(props.seed));

/** `face` seeds the avatar a name carries in front of it. */
type Word = { text: string; name?: boolean; face?: string };
const line = computed<Word[]>(() => [{ text: props.name ?? identity.value.name, name: true }, { text: "connected" }]);

/** Who handed the thread its work: "contracted by Maya", a link to Maya's
 *  thread. Its words carry on the line's stagger after "connected" and the
 *  dot between them. */
const handOff = computed<Word[] | null>(() => {
  const from = props.from;
  if (!from) return null;
  const verb = from.relationship === "contracting" ? "contracted by" : "delegated by";
  return [{ text: verb }, { text: fromName.value!, name: true, face: from.threadId }];
});
const fromName = computed(() => (props.from ? (props.from.name ?? agentIdentity(props.from.threadId).name) : null));
const label = computed(() =>
  [...line.value, ...(handOff.value ? [{ text: "·" }, ...handOff.value] : [])].map((w) => w.text).join(" "),
);
</script>

<template>
  <div
    class="thread-mark agent-connected"
    :class="{ 'agent-connected--enter': animate }"
    role="status"
    :aria-label="label"
  >
    <AgentFace :seed="seed" :size="16" class="agent-connected__face" />
    <span class="agent-connected__text">
      <span aria-hidden="true">
        <template v-for="(w, i) in line" :key="i">
          <span
            class="agent-connected__word"
            :class="{ 'agent-connected__name': w.name }"
            :style="{ '--w': i }"
          >{{ w.text }}</span>{{ i < line.length - 1 ? " " : "" }}
        </template>
      </span>
      <template v-if="handOff && from">
        {{ " " }}<span class="agent-connected__word" :style="{ '--w': line.length }" aria-hidden="true">·</span>{{ " " }}
        <button
          type="button"
          class="agent-connected__from"
          :title="`Open ${fromName}'s thread`"
          @click="emit('open-thread', from.threadId)"
        >
          <template v-for="(w, i) in handOff" :key="i">
            <span
              class="agent-connected__word"
              :class="{ 'agent-connected__name': w.name, 'agent-connected__word--face': w.face }"
              :style="{ '--w': line.length + 1 + i }"
            ><AgentFace v-if="w.face" :seed="w.face" :size="16" class="agent-connected__word-face" />{{ w.text }}</span>{{ i < handOff.length - 1 ? " " : "" }}
          </template>
        </button>
      </template>
    </span>
  </div>
</template>

<style scoped>
.agent-connected {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  /* No padding of its own — the transcript column's gap spaces this mark
     against the day divider above it and the first request below. */
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  color: var(--muted);
  user-select: none;
}
.agent-connected__face {
  flex: none;
}
.agent-connected__text {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The hand-off reads as part of the line until the pointer finds it. */
.agent-connected__from {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
/* A dotted underline that is always drawn and only coloured in, so it
   fades up under the pointer rather than snapping on. */
.agent-connected__from .agent-connected__word:not(.agent-connected__word--face),
.agent-connected__from .agent-connected__name {
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: transparent;
  transition: text-decoration-color 0.2s ease;
}
.agent-connected__from:hover .agent-connected__word:not(.agent-connected__word--face),
.agent-connected__from:hover .agent-connected__name,
.agent-connected__from:focus-visible .agent-connected__word:not(.agent-connected__word--face),
.agent-connected__from:focus-visible .agent-connected__name {
  text-decoration-color: color-mix(in oklab, var(--ink) 40%, transparent);
}
.agent-connected__word {
  display: inline-block;
}
.agent-connected__word--face {
  display: inline-flex;
  align-items: center;
  gap: 6px; /* the line's own face-to-name gap */
  vertical-align: top;
}
.agent-connected__word-face {
  flex: none;
}
.agent-connected__name {
  font-weight: 600;
  color: var(--ink-soft);
  letter-spacing: -0.01em;
}

/* micro-scale-fade: 600ms, opacity 0 → 1, scale 0.96 → 1. */
.agent-connected--enter .agent-connected__face {
  animation: agent-connected-face 600ms cubic-bezier(0.32, 0.72, 0, 1) backwards;
}
/* per-word-crossfade: 700ms, 6px rise, 90ms apart, starting as the face
   lands. */
.agent-connected--enter .agent-connected__word {
  animation: agent-connected-word 700ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: calc(120ms + var(--w) * 90ms);
}
@keyframes agent-connected-face {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
@keyframes agent-connected-word {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-connected--enter .agent-connected__face,
  .agent-connected--enter .agent-connected__word {
    animation: none;
  }
}
</style>
