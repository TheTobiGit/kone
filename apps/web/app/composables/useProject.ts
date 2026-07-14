// The currently opened project. Null on the App Home (first-run) screen.
export type Project = {
  path: string;
  name: string;
};

export function useProject() {
  return useState<Project | null>("kone:project", () => null);
}
