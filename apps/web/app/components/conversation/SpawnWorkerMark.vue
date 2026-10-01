<script setup lang="ts">
import { computed } from "vue";
import type { SpawnRecord } from "@kone/protocol/spawn-record";
import AgentFace from "~/components/agent/AgentFace.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentOrDeparted } from "~/utils/agents";
import { HugeiconsIcon } from "@hugeicons/vue";
import { WorkflowSquare01Icon } from "@hugeicons/core-free-icons";

// Work the agent handed off, said in the reply at the point it happened, one
// line per hand-off, and the kind of hand-off in the words:
//
//   "I gave a worker a task: Audit the migration tests"      a worker it briefed
//   "I gave a Reviewer worker a task: …"                      a worker from a preset
//   "I delegated to Ada: Build the /users endpoint"           a teammate
//   "I contracted Frontend Auth: Build the login screens"     an agent made up for the job
//
// with the agent's reason under it when it gave one. A worker has no identity
// — it is a task, not a colleague — so it wears the worker glyph and no name,
// and lives in the Subagents dock rather than as a thread to open. A teammate
// or contractor is somebody: their face and name, and their thread one click
// away.
//
// First person, because it sits inside the agent's own reply under its own
// name. It says what was handed off, nothing more: no live status. The line
// stays in the reply long after the work settles, and a state read off it there
// would be one the transcript can't keep true.

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

/** What kind of hand-off this was: a worker, a teammate, or a contractor. */
const kind = computed<"worker" | "delegation" | "contract">(() =>
  props.record.contractor ? "contract" : props.record.agent ? "delegation" : "worker",
);

/** The teammate a delegation went to, while the roster still remembers them. */
const teammate = computed(() => (props.record.agent ? agentOrDeparted(props.record.agentId) : undefined));

const name = computed(
  () =>
    teammate.value?.name ??
    props.record.agent ??
    props.record.contractor ??
    agentIdentity(props.record.threadId).name,
);

/** Only an agent has a thread of its own to open; a worker lives in the dock. */
const opens = computed(() => props.linkable && kind.value !== "worker");

/** "because the suite is slow" — the record keeps only the clause. */
const because = computed(() => (props.record.why ? `because ${props.record.why}` : null));

const where = computed(() =>
  props.record.model ? `${props.record.provider} · ${props.record.model}` : props.record.provider,
);
</script>

<template>
  <div class="spawn-mark" :class="{ 'spawn-mark--enter': animate }" :data-kind="kind">
    <p v-if="kind === 'worker'" class="spawn-mark__line">
      I gave
      <span class="spawn-mark__worker" :title="`${record.preset ? `${record.preset} worker` : 'Worker'} · ${where}`">
        <span class="spawn-mark__glyph" aria-hidden="true">
          <HugeiconsIcon :icon="WorkflowSquare01Icon" :size="12" :stroke-width="2" />
        </span>
        <span class="spawn-mark__name">{{ record.preset ? `${/^[aeiou]/i.test(record.preset) ? "an" : "a"} ${record.preset} worker` : "a worker" }}</span>
      </span>
      a task:
      <span class="spawn-mark__title">{{ record.title }}</span>
    </p>
    <p v-else class="spawn-mark__line">
      {{ kind === "contract" ? "I contracted" : "I delegated to" }}
      <component
        :is="opens ? 'button' : 'span'"
        :type="opens ? 'button' : undefined"
        class="spawn-mark__worker"
        :class="{ 'spawn-mark__worker--link': opens }"
        :title="opens ? `Open ${name}'s thread · ${where}` : where"
        @click="opens && emit('open-thread', record.threadId)"
      >
        <RosterFace v-if="teammate" :agent="teammate" :size="16" />
        <AgentFace v-else :seed="record.threadId" :size="16" />
        <span class="spawn-mark__name">{{ name }}</span>
      </component>:
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
/* A worker has no face: the glyph stands in, on the same small disc a face
   would sit on. */
.spawn-mark__glyph {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background: color-mix(in oklab, var(--ink) 9%, transparent);
  color: color-mix(in oklab, var(--ink) 60%, transparent);
}
.spawn-mark__worker--link {
  cursor: pointer;
}
/* Always drawn and only coloured in, so the underline fades up under the
   pointer rather than snapping on. */
.spawn-mark__worker--link .spawn-mark__name {
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: transparent;
  transition: text-decoration-color 0.2s ease;
}
.spawn-mark__worker--link:hover .spawn-mark__name,
.spawn-mark__worker--link:focus-visible .spawn-mark__name {
  text-decoration-color: color-mix(in oklab, var(--ink) 40%, transparent);
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
