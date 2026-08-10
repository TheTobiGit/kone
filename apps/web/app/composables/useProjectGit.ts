import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import type { GitChange, GitStatus } from "~/types/desktop";
import type { Project } from "~/composables/useProject";
import { createLatestWinsRun } from "~/utils/latestWins";

// The live git model behind an open project. One reactive `changes` array is the
// single source of truth; every count the page shows (line diffstat, file total,
// staged split, clean-ness) is derived from it, so any edit — staging a file,
// discarding one, committing — ripples to the greeting, the changes header, the
// cards and the corner folder in the same tick.
//
// Staging mutations are optimistic: they edit the model for an instant response,
// then run the real git command through the Electron bridge; the watcher's push
// reconciles the two (a failed call re-reads disk truth). In the browser dev
// build there's no bridge, so the optimistic edit is the only effect. Commit is
// the exception — still optimistic-only until a message flow is wired.
export function useProjectGit(project: Ref<Project>) {
  const git = useGit();

  const loaded = ref(false);
  const repo = ref(true);
  const hasCommits = ref(true);
  const branch = ref<string | null>(null);
  const ahead = ref(0);
  const behind = ref(0);
  const changes = ref<GitChange[]>([]);

  // ── derived, so every surface stays in lockstep with `changes` ──────────────
  const added = computed(() => changes.value.reduce((s, c) => s + (c.added ?? 0), 0));
  const removed = computed(() => changes.value.reduce((s, c) => s + (c.removed ?? 0), 0));
  const fileCount = computed(() => changes.value.length);
  const stagedCount = computed(() => changes.value.filter((c) => c.staged).length);
  const clean = computed(() => changes.value.length === 0);

  // Fold a fresh git status into the model — the one place disk truth lands,
  // shared by the initial read and every live push from the watcher.
  function applyStatus(status: GitStatus) {
    changes.value = status.changes;
    branch.value = status.branch;
    // A null HEAD is an unborn branch — a repo with no commits yet.
    hasCommits.value = status.head !== null;
    ahead.value = status.ahead;
    behind.value = status.behind;
    loaded.value = true;
  }

  // Refresh reads are serialized with latest-wins coalescing: at most one
  // detect+status pair runs at a time, and calls that arrive while a read is
  // running (a mutation's post-action refresh overlapping the watcher's,
  // another action finishing, a project switch) coalesce into exactly one
  // follow-up read of the newest state instead of fanning out concurrent git
  // subprocesses whose stale results could then overwrite fresher ones.
  const { run: refresh } = createLatestWinsRun(async () => {
    try {
      const [detected, status] = await Promise.all([
        git.detect(project.value.path),
        git.status(project.value.path),
      ]);
      repo.value = detected !== null;
      if (status) {
        applyStatus(status);
      } else {
        // Not a repo (or the heavier read is unavailable in dev) — fall back to the
        // lightweight detect summary so the greeting still reads sensibly.
        branch.value = detected?.branch ?? null;
        changes.value = [];
        hasCommits.value = true;
        ahead.value = detected?.ahead ?? 0;
        behind.value = detected?.behind ?? 0;
        loaded.value = true;
      }
    } catch {
      // A rejected IPC/git call must not leave the project home stuck in its
      // loading shell forever — settle the greeting and let the watcher retry.
      loaded.value = true;
    }
  });

  // Live sync: the desktop watcher pushes a fresh status whenever the repo moves
  // on disk (an editor save, a terminal `git add`, a commit). We (re)subscribe
  // per open project and tear the subscription down when the view goes away.
  let unwatch: (() => void) | null = null;
  function startWatch() {
    unwatch?.();
    unwatch = git.watchStatus(project.value.path, applyStatus);
  }

  // ── actions ───────────────────────────────────────────────────────────────
  // Each edits the model optimistically for an instant response, then runs the
  // real git command through the bridge; the watcher's push reconciles the two.
  // If the git call fails, a full re-read puts the UI back on disk truth. In the
  // browser (no bridge) the optimistic edit is the only effect.
  const find = (path: string) => changes.value.find((c) => c.path === path);
  function setStaged(c: GitChange, staged: boolean) {
    c.staged = staged;
    c.unstaged = !staged;
  }
  const dir = () => project.value.path;
  function run(op: Promise<void>) {
    op.catch(() => {
      void refresh();
    });
  }

  // Bulk primitives — every staging action funnels through one of these three,
  // so per-lane "all" and any future per-file action address an arbitrary set of
  // paths the same way.
  function stagePaths(paths: string[]) {
    if (!paths.length) return;
    paths.forEach((p) => {
      const c = find(p);
      if (c) setStaged(c, true);
    });
    if (git.available) run(git.stage(dir(), paths));
  }
  function unstagePaths(paths: string[]) {
    if (!paths.length) return;
    paths.forEach((p) => {
      const c = find(p);
      if (c) setStaged(c, false);
    });
    if (git.available) run(git.unstage(dir(), paths));
  }
  function discardPaths(paths: string[]) {
    if (!paths.length) return;
    const drop = new Set(paths);
    changes.value = changes.value.filter((c) => !drop.has(c.path));
    if (git.available) run(git.discard(dir(), paths));
  }

  // Lane sweeps over the primitives.
  function stageAll() {
    stagePaths(changes.value.filter((c) => !c.staged).map((c) => c.path));
  }
  function unstageAll() {
    unstagePaths(changes.value.filter((c) => c.staged).map((c) => c.path));
  }
  // Commit stays optimistic for now — it's the one action not wired to real git
  // (that needs a message flow). The staged files leave the view and the branch
  // moves one ahead; a real disk change would re-surface them until it's wired.
  function commit() {
    if (stagedCount.value === 0) return;
    changes.value = changes.value.filter((c) => !c.staged);
    ahead.value += 1;
    hasCommits.value = true;
  }

  onMounted(() => {
    void refresh();
    startWatch();
  });
  // Re-read + re-watch if the open project changes under us (defensive — the
  // launcher remounts today, but a direct switch shouldn't leave stale state).
  // Drop back to the loading state so the previous project's cards don't linger.
  watch(() => project.value.path, () => {
    loaded.value = false;
    changes.value = [];
    void refresh();
    startWatch();
  });
  onBeforeUnmount(() => unwatch?.());

  return {
    available: git.available,
    loaded,
    repo,
    hasCommits,
    branch,
    ahead,
    behind,
    changes,
    added,
    removed,
    fileCount,
    stagedCount,
    clean,
    refresh,
    stagePaths,
    unstagePaths,
    discardPaths,
    stageAll,
    unstageAll,
    commit,
  };
}
