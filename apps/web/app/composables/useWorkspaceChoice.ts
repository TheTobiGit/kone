import { computed, ref, type ComputedRef } from "vue";
import { LOCAL_WORKSPACE, workspaceRequest, type WorkspaceChoice } from "~/utils/threadWorkspace";

// Where a new conversation will work, held as draft state until its first send.
//
// Nothing is created while the choice sits here: choosing a workspace is a
// decision, and a user who opens the picker and then walks away must leave no
// directory behind. The send reads `request()` and hands it to whatever builds
// the worktree — after which the choice is spent.

type WorkspaceChoiceOptions = {
  /** The branch the project's checkout is on — what the composer names unless a
   *  new worktree was picked to start somewhere else. */
  fallbackBranch: () => string | null | undefined;
  /** Runs after the project's own checkout is picked. Its branch is what will be
   *  shown and is worth re-reading; a worktree does not exist yet and has
   *  nothing to read. */
  onLocal?: () => void;
};

export type WorkspaceChoiceState = {
  choice: ComputedRef<WorkspaceChoice>;
  pick: (next: WorkspaceChoice) => void;
  /** The branch the work starts from: a new worktree's base while one is
   *  picked, otherwise the checkout's. */
  branch: ComputedRef<string | undefined>;
  /** The start request the choice asks for; undefined for the checkout. */
  request: () => ReturnType<typeof workspaceRequest>;
};

function choiceState(
  read: () => WorkspaceChoice,
  write: (next: WorkspaceChoice) => void,
  options: WorkspaceChoiceOptions,
): WorkspaceChoiceState {
  const choice = computed(read);
  return {
    choice,
    pick(next) {
      write(next);
      if (next.mode === "local") options.onLocal?.();
    },
    branch: computed(() => {
      const c = choice.value;
      if (c.mode === "worktree" && c.base) return c.base;
      return options.fallbackBranch() ?? undefined;
    }),
    request: () => workspaceRequest(choice.value),
  };
}

/** One draft conversation's choice. `reset` puts it back to the checkout
 *  without the local-pick side effect — for when the project underneath it
 *  changes, and a worktree picked against the old one no longer applies. */
export function useWorkspaceChoice(options: WorkspaceChoiceOptions) {
  const held = ref<WorkspaceChoice>(LOCAL_WORKSPACE);
  const state = choiceState(
    () => held.value,
    (next) => {
      held.value = next;
    },
    options,
  );
  return {
    ...state,
    reset(): void {
      held.value = LOCAL_WORKSPACE;
    },
  };
}

/** A choice per draft, for a surface holding several at once and showing one.
 *
 *  `key` names the draft on screen. Outside `drafting` — no draft focused, or
 *  one that has already started and works somewhere — the choice reads as the
 *  checkout: nothing to request, and the fallback branch shown. */
export function useKeyedWorkspaceChoice(
  options: WorkspaceChoiceOptions & {
    key: () => string | null | undefined;
    drafting: () => boolean;
  },
): WorkspaceChoiceState {
  const held = ref<Record<string, WorkspaceChoice>>({});
  return choiceState(
    () => {
      const key = options.key();
      if (!key || !options.drafting()) return LOCAL_WORKSPACE;
      return held.value[key] ?? LOCAL_WORKSPACE;
    },
    (next) => {
      const key = options.key();
      if (key) held.value = { ...held.value, [key]: next };
    },
    options,
  );
}
