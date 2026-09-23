// Where a thread's turns actually run.
//
// A branch belongs to a working directory, not to a process: two conversations
// cannot hold two branches in one checkout, because git will not let them. So a
// conversation that wants its own branch needs its own directory — a linked
// worktree — and the thread has to carry two facts to say so.
//
// `envMode` is the declared intent, chosen before the first message. `worktreePath`
// is the materialized fact, written only once `git worktree add` has actually
// succeeded. They are separate because there is a real window between them, and
// that window is a state of its own: a thread that has asked for a worktree but
// does not have one yet has NO directory to run in. Collapsing that into "local"
// is the bug this whole feature exists to remove — it would run the turn in the
// shared checkout while the thread claimed to be isolated. So the resolver
// returns null there, and callers have to deal with it.
//
// The fact outranks the intention: a thread with a materialized path is in a
// worktree whatever its mode says.
//
// `projectPath` is not touched by any of this. It stays the thread's identity —
// which project this conversation belongs to — while the worktree is its place.
// Keeping the two apart is what lets a thread be listed under its project while
// running somewhere else.

import { workingDirFor } from "./assistantWorkspace.js";

/** What a thread asked for. Absent or unrecognized reads as "local". */
export type ThreadEnvMode = "local" | "worktree";

/**
 * Where a thread stands between asking for a worktree and having one.
 *
 * - `local` — runs in the project's own checkout and shares its branch. The
 *   default, and how every thread behaved before worktrees existed.
 * - `worktree-pending` — a worktree was chosen but does not exist yet. No
 *   directory, so nothing can run.
 * - `worktree-ready` — owns a directory and runs there.
 */
export type ThreadWorkspaceState = "local" | "worktree-pending" | "worktree-ready";

/** The two stored fields, as they come off a thread row. */
export type ThreadWorkspace = {
  envMode?: ThreadEnvMode | null;
  worktreePath?: string | null;
  /** The branch the worktree was asked for, while it is still being built.
   *  Null once the worktree materializes or the thread returns to local — the
   *  request lives only in the pending gap, not beside the outcome. */
  requestedBranch?: string | null;
};

/** A worktree directory every thread that uses it has left alone — what the
 *  store hands the cleanup sweep. `threadIds` is every thread that shares it. */
export type IdleWorktree = { worktreePath: string; projectPath: string; threadIds: string[] };

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** Read a stored mode. Anything but the literal "worktree" — null, absent, a
 *  value written by a newer build — is local, which is the safe reading: a
 *  thread that runs in the project's checkout is the behaviour that has always
 *  worked. */
export function threadEnvMode(value: string | null | undefined): ThreadEnvMode {
  return trimmed(value) === "worktree" ? "worktree" : "local";
}

export function threadWorkspaceState(input: ThreadWorkspace): ThreadWorkspaceState {
  if (trimmed(input.worktreePath)) return "worktree-ready";
  return threadEnvMode(input.envMode) === "worktree" ? "worktree-pending" : "local";
}

/**
 * The directory a thread's processes run in, or null when it has none yet.
 *
 * Null is not an error and not a fallback to the project — it is the pending
 * state, and it means "this thread cannot run until its worktree is built".
 * Every caller that spawns something reads this, and nobody re-derives it.
 */
export function threadWorkingDir(
  input: ThreadWorkspace & { projectPath: string },
): string | null {
  switch (threadWorkspaceState(input)) {
    case "worktree-ready":
      return trimmed(input.worktreePath);
    case "worktree-pending":
      return null;
    default:
      // Including the global assistant, whose project path is a sentinel rather
      // than a place and resolves to the directory the app keeps for it.
      return workingDirFor(input.projectPath);
  }
}
