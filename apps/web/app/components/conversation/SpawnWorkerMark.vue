<script setup lang="ts">
import { computed } from "vue";
import type { SpawnRecord } from "@kone/protocol/spawn-record";
import AgentFace from "~/components/agent/AgentFace.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentOrDeparted } from "~/utils/agents";

// Work the agent handed to another agent, said in the reply at the point it
// happened, one line per thread it opened:
//
//   "I spawned Theo: Audit the migration tests"    a worker it briefed itself
//   "I spawned Theo (Reviewer): …"                 a worker cut from a preset
//   "I asked Ada: Build the /users endpoint"        a teammate, by delegation
//
// with the agent's reason under it when it gave one. A teammate is asked
// rather than spawned: they are somebody already on the team, not a worker
// brought into being for the job.
//
// First person, because it sits inside the agent's own reply under its own
// name — naming the speaker again would turn a thing it said into a log line
// about it. A worker is a thread like any other, so its face and name come
// from its own id — the same ones it answers under when you open it. A
// teammate's come from the roster, so a renamed teammate still reads as
// themselves.
//
// It says what was handed off, nothing more: no live status. The line stays in
// the reply long after the work settles, and a state read off it there would
// be one the transcript can't keep true — the child's own thread, one click
// away, is where its progress lives.

const props = defineProps<{
  record: SpawnRecord;
  /** The child's name opens its thread. Off where nothing routes the jump. */
  linkable?: boolean;
  /** Play the arrival. Off for a transcript loaded from history. */
  animate?: boolean;
}>();

const emit = defineEmits<{
  "open-thread": [threadId: string];
}>();

/** The teammate a delegation went to, while the roster still remembers them. */
const teammate = computed(() => (props.record.agent ? agentOrDeparted(props.record.agentId) : undefined));

const name = computed(
  () => teammate.value?.name ?? props.record.agent ?? agentIdentity(props.record.threadId).name,
);

/** "because the suite is slow" — the record keeps only the clause. */
const because = computed(() => (props.record.why ? `because ${props.record.why}` : null));

const where = computed(() =>
  props.record.model ? `${props.record.provider} · ${props.record.model}` : props.record.provider,
);
</script>

<template>
  <div class="spawn-mark" :class="{ 'spawn-mark--enter': animate }">
    <p class="spawn-mark__line">
      {{ record.agent ? "I asked" : "I spawned" }}
      <component
        :is="linkable ? 'button' : 'span'"
        :type="linkable ? 'button' : undefined"
        class="spawn-mark__worker"
        :class="{ 'spawn-mark__worker--link': linkable }"
        :title="linkable ? `Open ${name}'s thread · ${where}` : where"
        @click="linkable && emit('open-thread', record.threadId)"
      >
        <RosterFace v-if="teammate" :agent="teammate" :size="16" />
        <AgentFace v-else :seed="record.threadId" :size="16" />
        <span class="spawn-mark__name">{{ name }}</span>
      </component><template v-if="record.preset">
        <span class="spawn-mark__preset">({{ record.preset }})</span></template>:
      <span class="spawn-mark__title">{{ record.title }}</span>
    </p>
    <p v-if="because" class="spawn-mark__why">{{ because }}</p>
  </div>
</template>

<style scoped>
/* The thread's own quiet line: no ground, no border — it is something the
   agent said, set a step down from the reply around it. */
.spawn-mark {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  font-size: 0.86rem;
  line-height: 1.5;
  color: color-mix(in oklab, var(--ink) 50%, transparent);
}
.spawn-mark__line,
.spawn-mark__why {
  margin: 0;
}
/* What was handed off is the part worth reading, so it carries the ink. */
.spawn-mark__title {
  color: color-mix(in oklab, var(--ink) 82%, transparent);
}
.spawn-mark__worker {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  vertical-align: bottom;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
}
.spawn-mark__name {
  font-weight: 600;
  color: var(--ink-soft);
  letter-spacing: -0.01em;
}
.spawn-mark__preset {
  margin-left: 4px;
}
.spawn-mark__worker--link {
  cursor: pointer;
}
.spawn-mark__worker--link:hover .spawn-mark__name,
.spawn-mark__worker--link:focus-visible .spawn-mark__name {
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in oklab, var(--ink) 30%, transparent);
}
.spawn-mark__why {
  font-style: italic;
  color: color-mix(in oklab, var(--ink) 45%, transparent);
}

/* The handoff and its reason rise in line by line on `mask-reveal-up`'s
   timing — 760ms each, the reason 90ms behind the line it explains — without
   its blur, so both lines read crisp as they move. The 30px rise drops to 8px
   for copy this size, where the full travel would carry a line past the one
   above it. */
.spawn-mark--enter > p {
  animation: spawn-line-in 760ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.spawn-mark--enter > p + p {
  animation-delay: 90ms;
}
@keyframes spawn-line-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spawn-mark--enter > p {
    animation: none;
  }
}
</style>
