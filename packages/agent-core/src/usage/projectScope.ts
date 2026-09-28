import path from "node:path";

/** Whether `dir` is the project folder or somewhere inside it — how a
 *  project-scoped usage report claims a session by its working directory. A
 *  sibling that merely shares the prefix (`app-old` beside `app`) is not in. */
export function isWithinProject(dir: string, projectPath: string): boolean {
  const root = path.resolve(projectPath);
  const target = path.resolve(dir);
  return target === root || target.startsWith(root + path.sep);
}
