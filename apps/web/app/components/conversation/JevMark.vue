<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Directions01Icon } from "@hugeicons/core-free-icons";
import { agentById } from "~/utils/agents";
import RosterFace from "~/components/agent/RosterFace.vue";
import type { JevThreadRoute } from "~/utils/jevRoutes";

// One Jev routing marker in the timeline flow: the decision that staffed the
// thread, read once at the head of the conversation it staffed.
//
// A quiet centered line straight on the page — Jev's mark and score on the
// left, the chosen agent's face and name on the right — so a routed thread
// names both ends of the handoff. Only a thread Jev actually staffed has one:
// a send the router could not answer left the thread on the default partner
// and settled nothing, which the composer reports in its receipt for that send
// and the timeline has no reason to carry for good.
//
// Purely presentational: the record lives in `~/utils/jevRoutes`, this only
// names it. The face and name resolve live, so renaming an agent renames the
// history it worked.

const props = defineProps<{
  /** The stored decision itself — no wider result is reconstructed around it,
   *  so there is nothing here the record did not actually say. */
  route: JevThreadRoute;
}>();

// The chosen agent's row, which outlives their removal from the roster — the
// whole line is the two ends of a handoff, so with nobody to name at the far
// end there is no handoff to draw and the mark stays off the page.
const agent = computed(() => agentById(props.route.agentId));
const pct = computed(() => Math.round(props.route.confidence * 100));
</script>

<template>
  <div v-if="agent" class="thread-mark jev-mark" aria-label="Routed by Jev">
    <HugeiconsIcon
      :icon="Directions01Icon"
      :size="13"
      :stroke-width="2"
      aria-hidden="true"
      class="jev-mark__jev-icon"
    />
    <span class="jev-mark__jev-name">Jev</span>
    <span class="jev-mark__score">({{ pct }}%)</span>
    <span class="jev-mark__arrow" aria-hidden="true">→</span>
    <RosterFace :agent="agent" :size="16" />
    <span class="jev-mark__agent-name">{{ agent.name }}</span>
  </div>
</template>

<style scoped>
.jev-mark {
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
  user-select: none;
}
.jev-mark__jev-icon {
  color: var(--accent-2);
  flex: none;
}
.jev-mark__jev-name {
  font-weight: 650;
  color: var(--ink-soft);
  letter-spacing: -0.01em;
}
.jev-mark__score {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  letter-spacing: 0.02em;
}
.jev-mark__arrow {
  color: var(--muted);
  flex: none;
}
.jev-mark__agent-name {
  font-weight: 600;
  color: var(--ink-soft);
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
