<script setup lang="ts">
import { computed } from "vue";
import type { AgentSender } from "~/types/desktop";
import AgentFace from "~/components/agent/AgentFace.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentForThread } from "~/utils/agents";

// Where this thread's work came from, at the top of a delegate's or
// contractor's thread: "Delegated by Maya" or "Contracted by Maya". The brief
// below it is that agent's message, so this line is what makes the thread
// readable on its own — somebody handed this agent the work, and here is who.

const props = defineProps<{
  threadId: string | null | undefined;
  /** The brief's sender: the agent that handed the work over. */
  from: AgentSender;
}>();

const isContract = computed(() => props.from.relationship === "contracting");

const fromName = computed(() => props.from.name ?? agentIdentity(props.from.threadId).name);

const hired = computed(() => Boolean(props.threadId && agentForThread(props.threadId)));
</script>

<template>
  <div class="thread-mark origin-mark" role="note">
    <AgentFace :seed="from.threadId" :size="16" class="origin-mark__face" />
    <p class="origin-mark__line">
      {{ isContract ? "Contracted by" : "Delegated by" }}
      <span class="origin-mark__from">{{ fromName }}</span>
    </p>
    <span v-if="isContract && hired" class="origin-mark__hired">On the team</span>
  </div>
</template>

<style scoped>
.origin-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  font-size: 12px;
  line-height: 16px;
  color: var(--muted);
}
.origin-mark__face {
  flex: none;
  border-radius: 50%;
}
.origin-mark__line {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
}
.origin-mark__from {
  font-weight: 600;
  color: var(--ink-soft);
}
.origin-mark__hired {
  flex: none;
  font-size: 11.5px;
  color: color-mix(in oklab, var(--ink) 50%, transparent);
}
</style>
