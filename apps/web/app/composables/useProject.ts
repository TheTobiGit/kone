// The currently opened project. Null on the App Home (first-run) screen.
export type Project = {
  path: string;
  name: string;
};

export function useProject() {
  return useState<Project | null>("kone:project", () => null);
}

// A thread to open the moment a project becomes active, set by the App Home
// "recent sessions" list (which spans every project) just before it switches the
// active project. ProjectView reads and clears it on mount, opening that thread
// instead of rehydrating the project's latest. Null means "just open the project".
//
// The request is namespaced to the project it belongs to: the thread id means
// nothing inside any other project's board, so a resume that outlives the mount
// it was meant for (a mount torn down mid-chain, say) can never fire inside the
// wrong project — ProjectView only honours a request whose path matches.
export type PendingThread = { path: string; threadId: string };
export function usePendingThread() {
  return useState<PendingThread | null>("kone:pending-thread", () => null);
}

// The single definition of "activate a project": record it in recents, then make
// it the active project. Shared by the launcher entry points (open/clone/create/
// recents) and the in-project switcher so the open flow never drifts between them.
export function useOpenProject() {
  const active = useProject();
  const pending = usePendingThread();
  const { remember } = useRecentProjects();
  // Pass a threadId to resume a specific conversation once the project opens
  // (the App Home sessions list does this); omit it to land on the project home.
  return (project: Project, threadId?: string) => {
    remember(project);
    pending.value = threadId ? { path: project.path, threadId } : null;
    active.value = project;
  };
}
