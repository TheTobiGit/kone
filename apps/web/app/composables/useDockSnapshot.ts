// Debounced dock snapshot: derives active plan, changed files, subagents, and delegates
// from thread timeline blocks, refreshed at ~10×/s rather than on every streamed token.

import { computed, shallowRef, type ComputedRef, type ShallowRef } from "vue";
import { watchDebounced } from "@vueuse/core";
import { deriveActivePlan, type ActivePlanState } from "~/utils/planTasks";
import { deriveChangedFiles, type ChangedFilesState } from "~/utils/changedFiles";
import {
  deriveActiveSubagents,
  deriveDelegates,
  type ActiveSubagentsState,
  type DelegateRow,
} from "~/utils/subagentRuns";
import type { SpawnedThread } from "~/types/desktop";
import type { ThreadBlock } from "~/composables/useAgent";

export interface UseDockSnapshotReturn {
  planRaw: ComputedRef<ActivePlanState | null>;
  changesRaw: ComputedRef<ChangedFilesState>;
  subagentsRaw: ComputedRef<ActiveSubagentsState>;
  delegatesRaw: ComputedRef<{ rows: DelegateRow[]; streaming: boolean }>;
  activePlan: ShallowRef<ActivePlanState | null>;
  activeChanges: ShallowRef<ChangedFilesState>;
  activeDelegates: ShallowRef<{ rows: DelegateRow[]; streaming: boolean }>;
  sync: () => void;
}

export function useDockSnapshot(
  blocks: ComputedRef<ThreadBlock[]>,
  spawnedChildren?: ComputedRef<SpawnedThread[]>,
): UseDockSnapshotReturn {
  const planRaw = computed(() => deriveActivePlan(blocks.value));
  const changesRaw = computed(() => deriveChangedFiles(blocks.value));
  const subagentsRaw = computed(() => deriveActiveSubagents(blocks.value));
  const delegatesRaw = computed(() =>
    deriveDelegates(blocks.value, spawnedChildren?.value ?? []),
  );

  const activePlan = shallowRef<ActivePlanState | null>(planRaw.value);
  const activeChanges = shallowRef<ChangedFilesState>(changesRaw.value);
  const activeDelegates = shallowRef<{ rows: DelegateRow[]; streaming: boolean }>(delegatesRaw.value);

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
