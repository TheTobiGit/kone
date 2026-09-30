import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { KoneGitApi } from "~/types/desktop";
import { useGit } from "./useGit";

/** A built worktree owns its branch; the project's branch only describes local work. */
export function useWorktreeBranch(options: {
  worktreePath: MaybeRefOrGetter<string | null | undefined>;
  fallbackBranch: MaybeRefOrGetter<string | null | undefined>;
  git?: Pick<KoneGitApi, "status" | "watchStatus">;
}) {
  const git = options.git ?? useGit();
  const worktreeBranch = ref<string | undefined>();
  const path = computed(() => toValue(options.worktreePath)?.trim() || null);

  watch(path, (dir, _previous, onCleanup) => {
    worktreeBranch.value = undefined;
    if (!dir) return;
    let active = true;
    let pushed = false;
    const stop = git.watchStatus(dir, (status) => {
      if (!active) return;
      pushed = true;
      worktreeBranch.value = status.branch ?? undefined;
    });
    onCleanup(() => {
      active = false;
      stop();
    });
    void git.status(dir).then((status) => {
      // A newer watcher push or a switch to another thread owns the label now.
      if (active && !pushed) worktreeBranch.value = status?.branch ?? undefined;
    }).catch(() => {
      // An unreadable worktree must never wear the project's unrelated branch.
    });
  }, { immediate: true, flush: "sync" });

  return computed(() => path.value ? worktreeBranch.value : toValue(options.fallbackBranch) ?? undefined);
}
