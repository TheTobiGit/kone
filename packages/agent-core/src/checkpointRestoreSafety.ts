import { realpathSync } from "node:fs";
import path from "node:path";

// Checkpoint restore safety.
//
// A turn checkpoint snapshots the WHOLE checkout it ran in. Restoring it — a
// hard, full-tree reset — is only safe when that directory belongs to exactly
// one thread. A thread that runs in its project's shared checkout, or in a
// worktree another thread also names, has no such guarantee: restoring would
// silently wipe work another conversation is doing. The service refuses those
// restores and offers a conversation-only rewind instead.
//
// The check is deliberately conservative about paths, not about history: it
// compares real paths (symlinks resolved) for both equality and nesting in
// either direction, so a worktree inside the project root — or the project root
// inside it — counts as shared.

/** One other thread's directory claim, as its resolved working directory. */
export interface RestorePathClaim {
  threadId: string;
  /** The directory the thread runs in, or null when it has none (a worktree
   *  that was never materialized). */
  path: string | null;
}

export type CheckpointRestoreIsolation =
  | { isolated: true }
  | {
      isolated: false;
      /** Human-readable, naming the overlapping thread and path where there is
       *  one — what the UI turns into "rewind the conversation only". */
      detail: string;
    };

/** `realpathSync` can throw on a path that vanished or is unreadable; a
 *  candidate we cannot resolve is unknown, and an unknown path never counts as
 *  a safe overlap-free answer for the restoring thread itself. */
function realOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

/** Whether `parent` is `child` itself or an ancestor of it. Both arguments are
 *  already real paths. */
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Whether restoring a checkpoint at `cwd` is isolated to this thread.
 *
 * `cwd` is the thread's checkpoint directory (the directory the snapshot was
 * taken in); `worktreePath` is the thread's declared worktree, or null when it
 * runs in the shared project checkout. A thread with no worktree, one whose
 * checkpoint directory is not its worktree, and one that shares its worktree
 * with any other thread (nested either way) are all refused.
 */
export function checkpointRestoreIsolation(input: {
  cwd: string;
  worktreePath: string | null;
  otherPaths: ReadonlyArray<RestorePathClaim>;
}): CheckpointRestoreIsolation {
  const cwd = realOrNull(input.cwd);
  if (cwd === null) {
    return { isolated: false, detail: `the checkpoint directory (${input.cwd}) could not be resolved` };
  }
  if (input.worktreePath === null) {
    return {
      isolated: false,
      detail: "this thread runs in its project's shared checkout, not an isolated worktree",
    };
  }
  const worktree = realOrNull(input.worktreePath);
  if (worktree === null || worktree !== cwd) {
    return {
      isolated: false,
      detail: `this thread's checkpoint directory (${cwd}) is not its worktree (${input.worktreePath})`,
    };
  }
  for (const other of input.otherPaths) {
    const otherPath = realOrNull(other.path);
    if (otherPath === null) continue;
    if (contains(cwd, otherPath) || contains(otherPath, cwd)) {
      return {
        isolated: false,
        detail: `thread "${other.threadId}" runs in ${otherPath}, which overlaps this worktree`,
      };
    }
  }
  return { isolated: true };
}

const activeRestoreDirs = new Set<string>();

/**
 * Claim active restore ownership of `dir` while a destructive file restore
 * is in flight, so new sessions cannot start in an overlapping directory
 * during the restore. Returns a release function to be called in try/finally.
 */
export function claimRestoreDir(dir: string): () => void {
  const resolved = realOrNull(dir) ?? path.resolve(dir);
  activeRestoreDirs.add(resolved);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRestoreDirs.delete(resolved);
  };
}

/**
 * Whether an active destructive file restore is currently claiming `dir` or an
 * overlapping directory.
 */
export function isRestoreActive(dir: string): boolean {
  const resolved = realOrNull(dir) ?? path.resolve(dir);
  for (const active of activeRestoreDirs) {
    if (contains(active, resolved) || contains(resolved, active)) {
      return true;
    }
  }
  return false;
}

