import { createGlobalState } from "@vueuse/core";
import type { StoredThreadMeta } from "~/types/desktop";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSessionList } from "~/composables/useSessionList";

// The App Home ("launcher") counterpart to useRecentSessions: the same PINNED /
// RECENT conversations block, but pooled across *every* recent project instead
// of the one that's open. It fans out over the recent-projects list, reads each
// project's persisted threads off disk (the history bridge), tags every row with
// the project it came from, then merges and sorts them into one recency-ranked
// stream.
//
// Pins and archive/delete work by thread id alone, so they share the exact same
// stores and bridge calls as the in-project block — a session pinned here shows
// pinned there, and vice versa. The shared behaviour lives in useSessionList;
// this wrapper only owns the cross-project fan-out and the clickable-path guard.
//
// One hard rule on the open path: a row is only clickable when its stored
// project path is one of the recents grid's paths. The fan-out reads each
// recent project's history, but a thread's `projectPath` can trail behind the
// grid (a project removed from recents, or a path that drifted after a rename
// or symlink change). Clicking such a row would silently re-add a project under
// a path the user never opened — and open the board under that path, so the
// saved layout and known-thread set wouldn't match the project the row came
// from. Filtering keeps the launcher list exactly "every recent project's
// conversations", with every row's target fields consistent with the grid.

export interface AllRecentSessionsOptions {
  /** Read the archive instead of the live list. The two are disjoint views of
   *  the same table, so an instance shows one or the other, never both. */
  archived?: boolean;
}

export function useAllRecentSessions(options?: AllRecentSessionsOptions) {
  const archived = options?.archived === true;
  return archived ? useArchivedAllRecentSessions() : useLiveAllRecentSessions();
}

// One live pipeline per source key (live vs archived), shared by every caller.
// The backing store lives in an app-scoped effect scope, created once and shared
// by every caller — NOT re-created per component. Each useSessionList instance
// eagerly load()s (one SQLite list() per recent project) and subscribes to the
// event pump with its own debounced refetch, so per-component instances drift:
// a menu pin flips one copy while the rendered rows hold another. Sharing one
// instance per archived flag means togglePin/archive mutate once and every
// reader (launcher rows, menu target resolution, inbox live/archived lists)
// sees it. Live and archived are disjoint queries over one column, so they stay
// separate pipelines keyed by the flag.
function buildAllRecentSessions(archived: boolean) {
  const { recents } = useRecentProjects();
  return useSessionList({
    fetch: async (history) => {
      const projects = recents.value;
      const nameByPath = new Map(projects.map((p) => [p.path, p.name]));
      // One local SQLite read per project; a failed project drops to an empty
      // list rather than sinking the whole aggregate.
      const lists = await Promise.all(
        // SAFETY: history.list resolves StoredThreadMeta[]; the catch substitutes
        // an empty list of that same element type.
        projects.map((p) => history.list(p.path, { archived }).catch(() => [] as StoredThreadMeta[])),
      );
      return lists
        .flat()
        .filter((m) => nameByPath.has(m.projectPath))
        .map((meta) => ({
          meta,
          project: {
            projectName: nameByPath.get(meta.projectPath)!,
            projectPath: meta.projectPath,
          },
        }));
    },
    trigger: () => recents.value.map((p) => p.path).join("\n"),
  });
}

// createGlobalState is SSR-safe here for the same reason as the recent-projects
// store: the server has no bridge, so the shared scope holds an empty list there
// and hydrates from SQLite on the client.
const useLiveAllRecentSessions = createGlobalState(() => buildAllRecentSessions(false));
const useArchivedAllRecentSessions = createGlobalState(() => buildAllRecentSessions(true));
