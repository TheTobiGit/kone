import {
  onScopeDispose,
  watch,
  type Directive,
  type MaybeRefOrGetter,
  toValue,
} from "vue";
import type { FolderFile } from "~/types/folder";
import type { GitFileStatus, GitStatus } from "~/types/desktop";

export interface ProjectSummary {
  loading: boolean;
  repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  added: number;
  removed: number;
  files: FolderFile[];
}

function isNew(status: GitFileStatus): boolean {
  return status === "added" || status === "untracked";
}

// Live watchers behind the launcher grid + switchers, one fs watch per repo,
// shared (refcounted) across every surface that shows the same folder. Lives at
// module scope so the reference count spans components — the open project's tile
// and the cycle-switcher can watch the same repo through one subscription. Only
// touched on the client (git.watchStatus is a no-op without the desktop bridge).
interface Sub {
  count: number;
  stop: (() => void) | null;
}
const subs = new Map<string, Sub>();

export function useProjectSummaries() {
  const git = useGit();
  // Shared, SSR-safe cache: keyed by path and kept in useState so it survives
  // component unmounts (the switcher remounts on every open) and is reused across
  // the launcher grid and the switcher — so a reopen draws from the same model.
  const summaries = useState<Record<string, ProjectSummary>>(
    "kone:project-summaries",
    () => ({}),
  ).value;

  // Fold a fresh git status into the cache — the single source of truth for
  // every summary field. Line counts are the *sum of the per-file counts on
  // `status.changes`*, exactly as the open project derives them (useProjectGit),
  // so a folder's ± reads identically on the launcher and inside the project.
  // (The old path used `detect().added/removed` = `git diff --shortstat HEAD`,
  // which omits untracked files, so the two disagreed whenever a repo had new
  // files.)
  function applyStatus(path: string, status: GitStatus | null): void {
    if (!status) {
      summaries[path] = {
        loading: false,
        repo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        added: 0,
        removed: 0,
        files: [],
      };
      return;
    }
    summaries[path] = {
      loading: false,
      repo: true,
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      added: status.changes.reduce((s, c) => s + (c.added ?? 0), 0),
      removed: status.changes.reduce((s, c) => s + (c.removed ?? 0), 0),
      files: status.changes.slice(0, 3).map((c) => ({
        change:
          c.status === "deleted"
            ? "deleted"
            : isNew(c.status)
              ? "new"
              : "edit",
        added: c.added ?? 0,
        removed: c.removed ?? 0,
        name: c.path,
      })),
    };
  }

  // Initial disk read for a path. The watcher only pushes on *change*, so the
  // first paint still needs one explicit status read.
  async function load(path: string): Promise<void> {
    applyStatus(path, await git.status(path));
  }

  // Take a live subscription to a path: start the fs watch on the first
  // reference (and prime it with an initial read), refcount every subsequent
  // one, and route the watcher's pushes straight into the shared cache.
  function acquire(path: string): void {
    let sub = subs.get(path);
    if (!sub) {
      sub = { count: 0, stop: null };
      subs.set(path, sub);
      if (!summaries[path]) {
        summaries[path] = {
          loading: true,
          repo: true,
          branch: null,
          ahead: 0,
          behind: 0,
          added: 0,
          removed: 0,
          files: [],
        };
      }
      void load(path);
      sub.stop = git.watchStatus(path, (status) => applyStatus(path, status));
    }
    sub.count += 1;
  }

  function release(path: string): void {
    const sub = subs.get(path);
    if (!sub) return;
    sub.count -= 1;
    if (sub.count > 0) return;
    sub.stop?.();
    subs.delete(path);
  }

  // Keep live summaries for exactly the set of paths a component shows: acquire
  // as folders appear, release as they leave, and release everything when the
  // component unmounts. Bound to the calling component's scope, so call it once
  // in setup with a reactive getter for the visible paths.
  function subscribe(paths: MaybeRefOrGetter<string[]>): void {
    let current: string[] = [];
    const stop = watch(
      () => toValue(paths),
      (next) => {
        const nextSet = new Set(next);
        for (const p of next) if (!current.includes(p)) acquire(p);
        for (const p of current) if (!nextSet.has(p)) release(p);
        current = [...next];
      },
      { immediate: true },
    );
    onScopeDispose(() => {
      stop();
      for (const p of current) release(p);
      current = [];
    });
  }

  // Visibility-gated variant for long grids: watch a folder only while its tile
  // is on screen (plus a small prefetch margin), releasing the fs watch as it
  // scrolls out. A launcher listing dozens of repos then holds a handful of live
  // watchers, not one per project. Returns a directive to put on each tile
  // element — `v-git-watch="project.path"` — scoped to the calling component, so
  // its observer and every watch it holds are torn down on unmount.
  function watchVisible(): Directive<Element, string> {
    // el → its path, and the set currently acquired, so a scroll out (or an
    // unmount mid-view) releases exactly what it took. A Map (not WeakMap) so
    // scope-dispose can release whatever's still live.
    const paths = new Map<Element, string>();
    const active = new Set<Element>();
    let observer: IntersectionObserver | null = null;

    function ensureObserver(): void {
      if (observer || !import.meta.client) return;
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const path = paths.get(e.target);
            if (!path) continue;
            if (e.isIntersecting && !active.has(e.target)) {
              active.add(e.target);
              acquire(path);
            } else if (!e.isIntersecting && active.has(e.target)) {
              active.delete(e.target);
              release(path);
            }
          }
        },
        // Prefetch a screenful early so a tile is already warm as it slides in.
        { rootMargin: "300px 0px" },
      );
    }

    onScopeDispose(() => {
      observer?.disconnect();
      observer = null;
      for (const el of active) {
        const path = paths.get(el);
        if (path) release(path);
      }
      active.clear();
      paths.clear();
    });

    return {
      mounted(el, binding) {
        ensureObserver();
        paths.set(el, binding.value);
        observer?.observe(el);
      },
      unmounted(el) {
        observer?.unobserve(el);
        if (active.has(el)) {
          active.delete(el);
          const path = paths.get(el);
          if (path) release(path);
        }
        paths.delete(el);
      },
    };
  }

  return { summaries, subscribe, watchVisible };
}
