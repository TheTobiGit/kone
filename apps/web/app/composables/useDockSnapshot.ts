// Debounced dock snapshot: derives active plan, changed files, subagents, and delegates
// from thread timeline blocks, refreshed at ~10×/s rather than on every streamed token.
// The plan is the thread's kone task list when it keeps one, else the
// checklist its provider sent.

import { computed, shallowRef, type ComputedRef, type ShallowRef } from "vue";
import { watchDebounced } from "@vueuse/core";
import { deriveActivePlan, resolveDockPlan, type ActivePlanState } from "~/utils/planTasks";
import { koneTaskListFor } from "~/composables/useKoneTasks";
import { deriveChangedFiles, type ChangedFilesState } from "~/utils/changedFiles";
import {
  deriveActiveSubagents,
  deriveDelegates,
  type ActiveSubagentsState,
  type DelegatesState,
} from "~/utils/subagentRuns";
import type { SpawnedThread } from "~/types/desktop";
import type { ThreadBlock } from "~/composables/useAgent";

export interface UseDockSnapshotReturn {
  planRaw: ComputedRef<ActivePlanState | null>;
  changesRaw: ComputedRef<ChangedFilesState>;
  subagentsRaw: ComputedRef<ActiveSubagentsState>;
  delegatesRaw: ComputedRef<DelegatesState>;
  activePlan: ShallowRef<ActivePlanState | null>;
  activeChanges: ShallowRef<ChangedFilesState>;
  activeDelegates: ShallowRef<DelegatesState>;
  sync: () => void;
}

/** The thread the dock shows, for its kone task list: its id, and whether a
 *  turn is running on it. */
export interface DockThread {
  threadId: string | null | undefined;
  live: boolean;
}

export function useDockSnapshot(
  blocks: ComputedRef<ThreadBlock[]>,
  spawnedChildren?: ComputedRef<SpawnedThread[]>,
  thread?: ComputedRef<DockThread>,
): UseDockSnapshotReturn {
  const planRaw = computed(() =>
    resolveDockPlan(
      koneTaskListFor(thread?.value.threadId),
      deriveActivePlan(blocks.value),
      thread?.value.live ?? false,
    ),
  );
  const changesRaw = computed(() => deriveChangedFiles(blocks.value));
  const subagentsRaw = computed(() => deriveActiveSubagents(blocks.value));
  const delegatesRaw = computed(() =>
    deriveDelegates(blocks.value, spawnedChildren?.value ?? []),
  );

  const activePlan = shallowRef<ActivePlanState | null>(planRaw.value);
  const activeChanges = shallowRef<ChangedFilesState>(changesRaw.value);
  const activeDelegates = shallowRef<DelegatesState>(delegatesRaw.value);

  function sync(): void {
    activePlan.value = planRaw.value;
    activeChanges.value = changesRaw.value;
    activeDelegates.value = delegatesRaw.value;
  }

  watchDebounced(
    [planRaw, changesRaw, subagentsRaw, delegatesRaw],
    () => sync(),
    { debounce: 100, maxWait: 200 },
  );

  return {
    planRaw,
    changesRaw,
    subagentsRaw,
    delegatesRaw,
    activePlan,
    activeChanges,
    activeDelegates,
    sync,
  };
}
