<script setup lang="ts">
import AgentSubagentDock from "~/components/agent/AgentSubagentDock.vue";
import type { DelegateRow } from "~/utils/subagentRuns";

// The bottom-left subagent corner — the Subagents dock —
// shared by the inbox's live and stored reading panes.

const props = withDefaults(
  defineProps<{
    rows: DelegateRow[];
    streaming?: boolean;
  }>(),
  {
    streaming: false,
  },
);

const emit = defineEmits<{
  "stop-subagent": [toolUseId: string];
}>();
</script>

<template>
  <!-- data-agent-dock: dock clicks must not collapse the composer bar, whose
       click-outside ignores marked surfaces. -->
  <div v-if="props.rows.length" data-agent-dock class="thread-sub-dock">
    <AgentSubagentDock
      :rows="props.rows"
      :streaming="props.streaming"
      @stop-subagent="emit('stop-subagent', $event)"
    />
  </div>
</template>

<style scoped>
.thread-sub-dock {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: min(340px, 48%);
  pointer-events: none;
}
</style>
