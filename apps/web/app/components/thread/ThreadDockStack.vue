<script setup lang="ts">
import { computed } from "vue";
import { AnimatePresence } from "motion-v";
import GitSpaceChangedFilesList from "~/components/git-space/GitSpaceChangedFilesList.vue";
import PlanTaskList from "~/components/plan/PlanTaskList.vue";
import type { ActivePlanState } from "~/utils/planTasks";
import type { ChangedFilesState } from "~/utils/changedFiles";

const props = withDefaults(
  defineProps<{
    composerOpen?: boolean;
    changes?: ChangedFilesState | null;
    plan?: ActivePlanState | null;
    projectPath?: string;
    threadKey?: string | null;
    positionMode?: "absolute-dock" | "absolute-pane" | "fixed";
  }>(),
  {
    composerOpen: false,
    changes: null,
    plan: null,
    projectPath: undefined,
    threadKey: "dock",
    positionMode: "absolute-dock",
  },
);

const emit = defineEmits<{
  openFile: [path: string, rect: DOMRect | null];
}>();

const hasContent = computed(
  () => Boolean((props.changes?.files?.length ?? 0) > 0 || props.plan),
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

/* Above composer when open */
.docks-above {
  position: relative;
  z-index: 5;
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  width: min(100% - 32px, 680px);
  margin-bottom: 8px;
  pointer-events: none;
}

.docks-above > *,
.docks-corner > * {
  pointer-events: auto;
}

.docks-above :deep(.plan-scroll),
.docks-above :deep(.chg-scroll),
.docks-above :deep(.peek-scroll) {
  max-height: min(22rem, calc(100vh - 340px));
}
</style>
