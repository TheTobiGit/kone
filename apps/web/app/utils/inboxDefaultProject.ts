// Which project a new thread in the inbox defaults to.
//
// Everywhere else in the app a new thread inherits its project from where you
// were standing. The inbox is the exception — it deliberately spans every
// project and shows you none — so the one thing a new thread needs here is the
// one thing this surface does not know.
//
// It takes the project the newest thread ran in. When no thread has run anywhere
// yet (fresh data, or empty projects), it falls back to the current/only project
// or the most recent one. When no projects exist at all, it resolves null so the
// surface can offer project creation actions instead.

export interface InboxDefaultProjectInput {
  newestProjectPath: string | null;
  activeProjectPath: string | null;
  recents: readonly { path: string; name: string }[];
  loading: boolean;
}

export function resolveInboxDefaultProject({
  newestProjectPath,
  activeProjectPath,
  recents,
  loading,
}: InboxDefaultProjectInput): string | null {
  // 1. A thread has already run: the inbox runs where the work has been.
  if (newestProjectPath) {
    return newestProjectPath;
  }

  // 2. Only one project exists: it is unequivocally the only place a thread can run.
  if (recents.length === 1) {
    return recents[0]?.path ?? null;
  }

  // 3. While still querying sessions across multiple projects, wait for it to settle
  // before guessing which project to use.
  if (loading && recents.length > 1) {
    return null;
  }

  // 4. No threads exist across any projects: fall back to the active project if open,
  // or the first recent project.
  if (activeProjectPath) {
    return activeProjectPath;
  }
  if (recents.length > 0) {
    return recents[0]?.path ?? null;
  }

  // 5. No project in the app at all.
  return null;
}
