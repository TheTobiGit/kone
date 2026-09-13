<script setup lang="ts">
import { computed } from "vue";
import { AnimatePresence } from "motion-v";
import GitSpaceChangedFilesList from "~/components/git-space/GitSpaceChangedFilesList.vue";
import PlanTaskList from "~/components/plan/PlanTaskList.vue";
import AgentSubagentDock from "~/components/agent/AgentSubagentDock.vue";
import type { ActivePlanState } from "~/utils/planTasks";
import type { ChangedFilesState } from "~/utils/changedFiles";
import type { DelegatesState } from "~/utils/subagentRuns";

const props = withDefaults(
  defineProps<{
    composerOpen?: boolean;
    changes?: ChangedFilesState | null;
    plan?: ActivePlanState | null;
    /** Delegated runs to show in this stack, or null to show none. Which host
     *  the subagents belong to is the surface's call, not this component's —
     *  see `subagentsAbove` in the panes that mount it. */
    delegates?: DelegatesState | null;
    projectPath?: string;
    threadKey?: string | null;
    positionMode?: "absolute-dock" | "absolute-pane" | "fixed";
  }>(),
  {
    composerOpen: false,
    changes: null,
    plan: null,
    delegates: null,
    projectPath: undefined,
    threadKey: "dock",
    positionMode: "absolute-dock",
  },
);

const emit = defineEmits<{
  openFile: [path: string, rect: DOMRect | null];
  "stop-subagent": [toolUseId: string];
}>();

const subagents = computed(() => (props.delegates?.rows.length ? props.delegates : null));

/** Subagents ride this stack only while it is the above-composer row. Closing
 *  the composer hands the dock back to its corner host, and that handover has
 *  to be instant: the card's own leave spring would otherwise play out inside
 *  a stack that has already re-laid itself into the opposite corner, so the
 *  dock would flash there before reappearing where it actually went. Dropping
 *  the whole AnimatePresence — rather than just its child — is what skips the
 *  exit; the child's own `v-if` still animates the case this stack owns, a
 *  delegate list emptying while the composer stays open. */
const hostsSubagents = computed(() => props.composerOpen);

const hasContent = computed(
  () =>
    Boolean(
      (props.changes?.files?.length ?? 0) > 0 ||
        props.plan ||
        (hostsSubagents.value && subagents.value),
    ),
);
</script>

<template>
  <div
    v-if="hasContent"
    data-agent-dock
    class="thread-dock-stack"
    :class="composerOpen ? 'docks-above' : ['docks-corner', `docks-corner--${positionMode}`]"
  >
    <AnimatePresence :initial="false" mode="wait">
      <GitSpaceChangedFilesList
        v-if="changes?.files?.length"
        :key="`agent-changes-dock-${threadKey}`"
        :files="changes.files"
        :total-added="changes.totalAdded"
        :total-removed="changes.totalRemoved"
        :streaming="changes.streaming"
        :repo-path="projectPath"
        @open-file="(path, rect) => emit('openFile', path, rect)"
      />
    </AnimatePresence>
    <AnimatePresence :initial="false" mode="wait">
      <PlanTaskList
        v-if="plan"
        :key="`agent-plan-dock-${threadKey}`"
        :tasks="plan.tasks"
        :streaming="plan.streaming"
      />
    </AnimatePresence>
    <AnimatePresence v-if="hostsSubagents" :initial="false" mode="wait">
      <AgentSubagentDock
        v-if="subagents"
        :key="`agent-subagents-dock-${threadKey}`"
        :rows="subagents.rows"
        :streaming="subagents.streaming"
        @stop-subagent="emit('stop-subagent', $event)"
      />
    </AnimatePresence>
  </div>
</template>

<style scoped>
.thread-dock-stack {
  pointer-events: none;
}

/* Resting corner stack */
.docks-corner {
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  transform-origin: 100% 100%;
}

.docks-corner--absolute-dock {
  position: absolute;
  right: 12px;
  /* The live pane hosts this inside its composer rail, which itself sits 18px
     above the pane bottom — so −6px lands the stack 12px above the pane, the
     same resting height as the stored pane's corner stack. */
  bottom: -6px;
  max-width: min(320px, 48%);
}

.docks-corner--absolute-pane {
  position: absolute;
  right: 12px;
  bottom: 12px;
  max-width: min(320px, 48%);
}

.docks-corner--fixed {
  position: fixed;
  right: 2rem;
  bottom: 2rem;
  gap: 12px;
}

/* Above composer when open — wide enough for all three collapsed pills
   (Changes 17rem + Tasks 17rem + Subagents 18rem + gaps ≈ 848px) to share one
   row. Expanded docks still wrap onto their own line via flex-wrap. */
.docks-above {
  position: relative;
  z-index: 5;
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  width: min(100% - 32px, 880px);
  margin-bottom: 8px;
  pointer-events: none;
}

.docks-above > *,
.docks-corner > * {
  pointer-events: auto;
}

.docks-above :deep(.plan-scroll),
.docks-above :deep(.chg-scroll),
.docks-above :deep(.peek-scroll),
.docks-above :deep(.sub-scroll) {
  max-height: min(22rem, calc(100vh - 340px));
}

.docks-above :deep(.sub-dock) {
  /* Match the Changes/Tasks 17rem so the three pills share one even row —
     the corner keeps its wider 18rem stance. */
  width: min(17rem, 100%);
}
</style>
