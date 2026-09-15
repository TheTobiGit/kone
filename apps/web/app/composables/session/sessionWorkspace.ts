import { computed, ref, type Ref } from "vue";
import type { KoneAgentApi, SessionStartInput, ThreadEnvMode } from "~/types/desktop";
import { isWorkspacePending } from "~/utils/threadWorkspace";
import { initialWorkspaceSteps, type WorkspaceStepRow } from "~/utils/workspaceSteps";

/** Where this conversation works. The staged start choice stays in the
 *  session that creates this unit — start() consumes and clears it — so it
 *  arrives as the `storeStagedWorkspace` callback below. */
export type SessionWorkspaceDeps = {
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | null;
  storeStagedWorkspace: (choice: SessionStartInput["workspace"]) => void;
};

/** The directory this conversation works in, the build that puts it there,
 *  and the choice that stages the next one. */
export function useSessionWorkspace(deps: SessionWorkspaceDeps) {
  const { threadId, bridge, storeStagedWorkspace } = deps;

  /** The directory this conversation works in, when it is not the project's own
   *  checkout. Null for the ordinary case and for a worktree still being built —
   *  the two are told apart by the pending derivation below, because one has a
   *  place and the other only has an intention. */
  const worktreePath = ref<string | null>(null);
  /** What this conversation asked for, seeded when a stored thread is adopted.
   *  Null until then, and once a build has settled — the store is the record
   *  from that point on, and the list row carries the directory once it
   *  refreshes. */
  const envMode = ref<ThreadEnvMode | null>(null);
  /** Whether the worktree this conversation asked for is still being built:
   *  intent without a place. Derived, not carried, so it can never disagree
   *  with the two facts behind it — the start below clears the intent when the
   *  build settles, which is what flips this, because the renderer never learns
   *  the built directory itself. */
  const workspacePending = computed(() =>
    isWorkspacePending({ envMode: envMode.value, worktreePath: worktreePath.value }),
  );
  /** The branch a pending worktree was asked for, when the user named one.
   *  Mirrors the stored request so surfaces can show and re-stage it. */
  const requestedBranch = ref<string | null>(null);
  /** The build of this conversation's worktree, step by step, while it happens.
   *
   *  Empty at rest and for every thread that never asked for one. It is filled
   *  when the send stages a worktree and left standing afterwards only if a step
   *  failed — the stepper is what accounts for the failure, so withdrawing it
   *  would leave the user with nothing to read. */
  const workspaceSteps = ref<WorkspaceStepRow[]>([]);

  /** Open the stepper. Called by the send that staged a worktree, so the list is
   *  on screen before the first report rather than appearing a beat into it. */
  function beginWorkspaceSteps(): void {
    workspaceSteps.value = initialWorkspaceSteps();
  }

  /** Put the stepper away. Only ever the user's choice or a settled build —
   *  never something that happens to a failure on its own. */
  function dismissWorkspaceSteps(): void {
    workspaceSteps.value = [];
  }

  /** Back out of a worktree still being built.
   *
   *  Does not interrupt git. The creation is already running, and what it
   *  produces is removed once it finishes — so this is "undo whatever
   *  finishes", not "stop trying". */
  async function cancelWorkspace(): Promise<void> {
    const api = bridge();
    if (!api) return;
    await api.cancelWorkspace(threadId.value).catch(() => undefined);
  }

  /** Record where this conversation will work. Only meaningful before the first
   *  start; after that the session is running somewhere and cannot be moved. */
  function stageWorkspace(choice: SessionStartInput["workspace"]): void {
    storeStagedWorkspace(choice);
  }

  return {
    worktreePath,
    envMode,
    workspacePending,
    requestedBranch,
    workspaceSteps,
    stageWorkspace,
    beginWorkspaceSteps,
    dismissWorkspaceSteps,
    cancelWorkspace,
  };
}
