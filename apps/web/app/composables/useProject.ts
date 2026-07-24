// The currently opened project. Null on the App Home (first-run) screen.
export type Project = {
  path: string;
  name: string;
};

export function useProject() {
  return useState<Project | null>("kone:project", () => null);
}

// The single definition of "activate a project": record it in recents, then make
// it the active project. Shared by the launcher entry points (open/clone/create/
// recents) and the in-project switcher so the open flow never drifts between them.
export function useOpenProject() {
  const active = useProject();
  const { remember } = useRecentProjects();
  return (project: Project) => {
    remember(project);
    active.value = project;
  };
}
