<script setup lang="ts">
import AgentSubagentDock from "~/components/agent/AgentSubagentDock.vue";
import SubagentShell from "~/components/conversation/SubagentShell.vue";
import type { ShellTarget } from "~/composables/useSubagentShell";
import type { PendingApproval } from "~/composables/useAgent";
import type { ApprovalDecision, SpawnedThread } from "~/types/desktop";
import type { DelegateRow, SubagentRunView } from "~/utils/subagentRuns";

// The bottom-left subagent corner — the Subagents dock plus its expanded shell —
// shared by the inbox's live and stored reading panes.
//
// Both panes show the same corner: delegated runs bottom-left, clear of the
// Changes/Tasks column, stepping aside while the shell — the zoom-in of a dock
// row — is open. The live pane drives the shell with a session behind it
// (answers, stops, thread reveals); the stored pane has no session, so it only
// subscribes to `open`/`close` and the shell degrades to its read path.
// Unlistened emits are no-ops, so one component serves both without a mode flag.

const props = withDefaults(
  defineProps<{
    rows: DelegateRow[];
    streaming?: boolean;
    shell?: ShellTarget | null;
    shellRun?: SubagentRunView | null;
    shellThread?: SpawnedThread | null;
    shellApprovals?: PendingApproval[];
  }>(),
  {
    streaming: false,
    shell: null,
    shellRun: null,
    shellThread: null,
    shellApprovals: () => [],
  },
);

const emit = defineEmits<{
  open: [row: DelegateRow];
  "stop-subagent": [toolUseId: string];
  close: [];
  "open-thread": [];
  "decide-approval": [requestId: string, decision: ApprovalDecision];
}>();
</script>

<template>
  <!-- data-agent-dock: dock clicks must not collapse the composer bar, whose
       click-outside ignores marked surfaces. The shell stays unmarked — it is
       its own overlay above the composer, not part of the bar. -->
  <div v-if="props.rows.length && !props.shell" data-agent-dock class="thread-sub-dock">
    <AgentSubagentDock
      :rows="props.rows"
      :streaming="props.streaming"
      @open="emit('open', $event)"
      @stop-subagent="emit('stop-subagent', $event)"
    />
  </div>

  <!-- A delegate's expanded shell: the zoom-in of the dock. Rises over the pane —
       fixed, like the modals — so no container positioning is needed here. -->
  <Transition name="sut">
    <SubagentShell
      v-if="props.shell"
      :kind="props.shell.kind"
      :run="props.shellRun"
      :thread="props.shellThread"
      :approvals="props.shellApprovals"
      @close="emit('close')"
      @open-thread="emit('open-thread')"
      @decide-approval="(requestId, decision) => emit('decide-approval', requestId, decision)"
      @stop-subagent="emit('stop-subagent', $event)"
    />
  </Transition>
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

/* The shell rises over the pane rather than sliding — a step INTO a
   delegate, not a neighbouring surface. */
.sut-enter-active,
.sut-leave-active {
  transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sut-enter-from,
.sut-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}
</style>
