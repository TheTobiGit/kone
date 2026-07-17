import { computed } from "vue";
import { useStorage } from "@vueuse/core";
import type { Project } from "~/composables/useProject";

// The projects you've opened, most-recent first. Persisted to localStorage so
// the list survives an app quit (the packaged desktop app keeps localStorage
// per-origin across launches) — the home no longer starts empty every time.
export type RecentProject = Project & {
  /** Epoch ms of the last time this project was opened. */
  lastOpenedAt: number;
};

const STORAGE_KEY = "kone:recent-projects";
// A generous cap — enough to fill the launcher grid several times over without
// the list growing without bound.
const MAX = 24;

export function useRecentProjects() {
  // useStorage is SSR-safe: it returns the default ([]) on the server and
  // hydrates from localStorage on the client.
  const store = useStorage<RecentProject[]>(STORAGE_KEY, []);

  // Always read newest-first, regardless of write order.
  const recents = computed(() =>
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

  return { recents, remember, forget };
}
