import { useSessionList } from "~/composables/useSessionList";

// Feeds the Project Home "recent conversations" block (PINNED / RECENT). It
// reads the project's persisted agent threads back off disk (the main-process
// ConversationStore, via the history bridge) and splits them into pinned vs.
// recent.
//
// The shared behaviour — the pinned/recent split, recency sort, pin/archive/
// delete actions, the one-time localStorage→DB pin lift and the live
// event-driven refresh — lives in useSessionList; this wrapper only owns how the
// raw metadata for the single open project is gathered.

export function useRecentSessions(cwd: () => string) {
  return useSessionList({
    fetch: async (history) => {
      const projectPath = cwd();
      const metas = await history.list(projectPath);
      return metas.map((meta) => ({ meta, project: { projectPath } }));
    },
    trigger: cwd,
  });
}
