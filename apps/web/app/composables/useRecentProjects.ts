import { computed } from "vue";
import { createGlobalState, useStorage } from "@vueuse/core";
import type { Project } from "~/composables/useProject";

// The projects you've opened, most-recent first. Persisted to localStorage so
// the list survives an app quit (the packaged desktop app keeps localStorage
// per-origin across launches) — the home no longer starts empty every time.
export type RecentProject = Project & {
  /** Epoch ms of the last time this project was opened. */
  lastOpenedAt: number;
  /** Pinned projects lead the grid regardless of last-opened order. */
  pinned?: boolean;
};

const STORAGE_KEY = "kone:recent-projects";
// A generous cap — enough to fill the launcher grid several times over without
// the list growing without bound.
const MAX = 24;

// The backing store lives in one app-scoped effect scope, created once and
// shared by every caller — NOT re-created per component. This matters because
// the in-project switcher records a project (remember) and then swaps the active
// project in the same tick, which remounts <ProjectView> (it's keyed on path).
// If the store were owned by that component's setup, its useStorage persist
// watcher would be torn down by the remount before the localStorage write ever
// flushed — so switching from inside a project silently failed to reorder the
// recents. A global scope keeps the watcher alive across every remount.
const useRecentStore = createGlobalState(() =>
  // useStorage is SSR-safe: it returns the default ([]) on the server and
  // hydrates from localStorage on the client.
  useStorage<RecentProject[]>(STORAGE_KEY, []),
);

export function useRecentProjects() {
  const store = useRecentStore();

  // Pinned first, then newest-first — regardless of write order. This is the
  // launcher-grid order: pins are a "keep it in front" affordance there.
  const recents = computed(() =>
    [...store.value].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.lastOpenedAt - a.lastOpenedAt;
    }),
  );

  // Pure most-recently-used order, pins ignored. The Ctrl+Tab switcher wants
  // this: it's an Alt+Tab-style toggle, so the project you were just on has to
  // sit at the front regardless of what's pinned — otherwise a single tap keeps
  // landing on the pinned lead instead of alternating between your last two.
  const byRecency = computed(() =>
    [...store.value].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
  );

  // Record (or bump) a project as just-opened. Dedupes on path.
  function remember(project: Project): void {
    const entry: RecentProject = { ...project, lastOpenedAt: Date.now() };
    const rest = store.value.filter((p) => p.path !== project.path);
    store.value = [entry, ...rest].slice(0, MAX);
  }

  // Drop a project from the list ("Remove from recents").
  function forget(path: string): void {
    store.value = store.value.filter((p) => p.path !== path);
  }

  // Pin/unpin a project so it leads (or rejoins) the recents order.
  function togglePin(path: string): void {
    store.value = store.value.map((p) =>
      p.path === path ? { ...p, pinned: !p.pinned } : p,
    );
  }

  return { recents, byRecency, remember, forget, togglePin };
}
