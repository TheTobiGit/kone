<script setup lang="ts">
import { computed, ref, toRef } from "vue";
import type { AgentSender } from "~/types/desktop";
import AgentFace from "~/components/agent/AgentFace.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { addAgentToProject, agentForThread, createAgent, settleThreadAgent } from "~/utils/agents";
import { DEFAULT_BOT } from "~/utils/bot";
import { useThreadContract } from "~/composables/useThreadContract";

// Where this thread's work came from, at the top of a delegate's or
// contractor's thread: "Delegated by Maya" or "Contracted by Maya · Frontend
// auth specialist". The brief below it is that agent's message, so this line
// is what makes the thread readable on its own — somebody handed this agent
// the work, and here is who.
//
// A contractor was made up for the job and is not on the team. If it did good
// work, the user — never an agent — can hire it: its name, role and
// instructions become a teammate's, and this thread becomes that teammate's.

const props = defineProps<{
  threadId: string | null | undefined;
  /** The brief's sender: the agent that handed the work over. */
  from: AgentSender;
}>();

const isContract = computed(() => props.from.relationship === "contracting");
const { contract, projectPath } = useThreadContract(toRef(props, "threadId"), isContract);

const fromName = computed(() => props.from.name ?? agentIdentity(props.from.threadId).name);

const hiring = ref(false);
const hiredName = ref<string | null>(null);
/** Hired already — by this button, or earlier (the thread is bound to a
 *  roster agent now). */
const hired = computed(() => hiredName.value !== null || Boolean(props.threadId && agentForThread(props.threadId)));

async function hire(): Promise<void> {
  const terms = contract.value;
  if (!terms || !props.threadId || hiring.value) return;
  hiring.value = true;
  try {
    const agent = await createAgent({
      name: terms.name,
      role: terms.role,
      instructions: terms.instructions,
      bot: DEFAULT_BOT,
    });
    if (!agent) return;
    if (projectPath.value) await addAgentToProject(projectPath.value, agent.id);
    settleThreadAgent(props.threadId, agent.id);
    hiredName.value = agent.name;
  } finally {
    hiring.value = false;
  }
}
</script>

<template>
  <div class="origin-mark" role="note">
    <AgentFace :seed="from.threadId" :size="16" class="origin-mark__face" />
    <p class="origin-mark__line">
      {{ isContract ? "Contracted by" : "Delegated by" }}
      <span class="origin-mark__from">{{ fromName }}</span>
      <template v-if="contract"> · <span class="origin-mark__role">{{ contract.role }}</span></template>
    </p>
    <button
      v-if="isContract && contract && !hired"
      type="button"
      class="origin-mark__hire"
      :disabled="hiring"
      :title="`Save ${contract.name} to the team, with the role and instructions it was contracted under`"
      @click="hire"
    >
      Hire {{ contract.name }}
    </button>
    <span v-else-if="isContract && hired" class="origin-mark__hired">On the team</span>
  </div>
</template>

<style scoped>
.origin-mark {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  margin-bottom: 4px;
  border: 1px solid color-mix(in oklab, var(--ink) 9%, transparent);
  border-radius: 10px;
  background: color-mix(in oklab, var(--ink) 2.5%, var(--ground));
  font-size: 12.5px;
  line-height: 1.4;
  color: color-mix(in oklab, var(--ink) 58%, transparent);
}
.origin-mark__face {
  flex: none;
  border-radius: 50%;
}
.origin-mark__line {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
}
.origin-mark__from {
  font-weight: 600;
  color: color-mix(in oklab, var(--ink) 82%, transparent);
}
.origin-mark__role {
  font-style: italic;
}
.origin-mark__hire {
  flex: none;
  padding: 4px 10px;
  border: 1px solid color-mix(in oklab, var(--ink) 16%, transparent);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.origin-mark__hire:hover {
  background: var(--hover);
}
.origin-mark__hire:disabled {
  opacity: 0.6;
  cursor: progress;
}
.origin-mark__hired {
  flex: none;
  font-size: 11.5px;
  color: color-mix(in oklab, var(--ink) 50%, transparent);
}
</style>
