<script setup lang="ts">
import { computed } from "vue";
import { agentIdentity } from "~/utils/agentIdentity";
import AgentFace from "~/components/agent/AgentFace.vue";

// The thread's agent, announced once at the head of the conversation: its face
// and name, "connected". The receipt for who picked the thread up, read under
// the day divider before the first request.
//
// It plays only as it happens. A conversation opened from history draws the
// line already in place — replaying the arrival of an agent that arrived last
// week would claim something is happening that isn't.
//
// The reveal is soft-blur-in, carried per word and scaled down for a 12px line
// (the spec's own body-text note: less blur, tighter stagger): the face settles
// in first with a micro scale-fade, then the name and "connected" resolve out
// of a light blur behind it.

const props = defineProps<{
  /** The thread's durable id — the same seed the speaker lines use, so the
   *  face and name here are the ones that answer below. */
  seed: string;
  /** Play the arrival. Off for a transcript loaded from history. */
  animate?: boolean;
}>();

const identity = computed(() => agentIdentity(props.seed));
const words = computed(() => [identity.value.name, "connected"]);
</script>

<template>
  <div
    class="thread-mark agent-connected"
    :class="{ 'agent-connected--enter': animate }"
    role="status"
    :aria-label="`${identity.name} connected`"
  >
    <AgentFace :seed="seed" :size="16" class="agent-connected__face" />
    <span class="agent-connected__text" aria-hidden="true">
      <template v-for="(w, i) in words" :key="i">
        <span
          class="agent-connected__word"
          :class="{ 'agent-connected__name': i === 0 }"
          :style="{ '--w': i }"
        >{{ w }}</span>{{ i < words.length - 1 ? " " : "" }}
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
.agent-connected__word {
  display: inline-block;
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
/* soft-blur-in per word: 700ms, 6px rise, 6px blur, 90ms apart, starting as
   the face lands. */
.agent-connected--enter .agent-connected__word {
  animation: agent-connected-word 700ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
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
    filter: blur(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-connected--enter .agent-connected__face,
  .agent-connected--enter .agent-connected__word {
    animation: none;
  }
}
</style>
