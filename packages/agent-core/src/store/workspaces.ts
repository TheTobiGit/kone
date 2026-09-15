import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import { threadEnvMode, type ThreadEnvMode, type ThreadWorkspace } from "../threadWorkspace.js";

/** Subtree reader owned by the lifecycle repo, injected so this module never imports it. */
export type WorkspaceDeps = {
  subtreeIds(db: DatabaseSync, threadId: string): string[];
};

export class WorkspaceRepo {
  constructor(
    private readonly dbh: ConversationDb,
    private readonly deps: WorkspaceDeps,
  ) {}

  /** A thread's declared environment and its materialized worktree, as one read.
   *  Returns null only when the thread is unknown — a thread that exists always
   *  has an answer, even if that answer is "local, nothing materialized".
   *
   *  Throws when the store cannot be read. Callers must fail closed: an
   *  unreadable workspace is not local, and running the thread in the shared
   *  checkout would break the isolation a worktree was asked for.
   *
   *  Never read either field alone: the gap between an intent and a directory is
   *  its own state, and `threadWorkspaceState` is what holds all three. */
  threadWorkspace(threadId: string): ThreadWorkspace | null {
    const db = this.dbh.handle();
    if (!db) throw new Error("Thread workspace is unavailable: the conversation store could not be opened.");
    try {
      // SAFETY: the projection names only env_mode, worktree_path and
      // requested_branch, all nullable TEXT.
      const row = db
        .prepare(
          `SELECT env_mode, worktree_path, requested_branch FROM threads WHERE thread_id = ?`,
        )
        // SAFETY: the selected columns arrive under the aliases asked for.
        .get(threadId) as
        | { env_mode: string | null; worktree_path: string | null; requested_branch: string | null }
        | undefined;
      if (!row) return null;
      return {
        envMode: threadEnvMode(row.env_mode),
        worktreePath: row.worktree_path ?? null,
        requestedBranch: row.requested_branch?.trim() ? row.requested_branch : null,
      };
    } catch (err) {
      console.error("[conversation-store] threadWorkspace failed:", err);
      throw err instanceof Error ? err : new Error("Thread workspace is unavailable.");
    }
  }

  /** Record what a thread asked for, and where it ended up.
   *
   *  Each field is written only when given, so materializing a worktree does not
   *  have to restate the mode and switching a thread back to local does not have
   *  to remember its path. Pass `worktreePath: null` deliberately to clear it —
   *  that is what "the worktree is gone" looks like. The requested branch is
   *  the same: set alongside the intent, cleared (null) when the worktree
   *  materializes or the thread returns to local. */
  setThreadWorkspace(
    threadId: string,
    input: { envMode?: ThreadEnvMode; worktreePath?: string | null; requestedBranch?: string | null },
  ): void {
    const db = this.dbh.handle();
    if (!db) return;
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (input.envMode !== undefined) {
      sets.push("env_mode = ?");
      values.push(input.envMode);
    }
    if (input.worktreePath !== undefined) {
      sets.push("worktree_path = ?");
      values.push(input.worktreePath);
    }
    if (input.requestedBranch !== undefined) {
      sets.push("requested_branch = ?");
      const branch = input.requestedBranch?.trim() ? input.requestedBranch.trim() : null;
      values.push(branch);
    }
    if (sets.length === 0) return;
    try {
      db.prepare(
        `UPDATE threads SET ${sets.join(", ")} WHERE thread_id = ?`,
      ).run(...values, threadId);
    } catch (err) {
      console.error("[conversation-store] setThreadWorkspace failed:", err);
    }
  }

  /** Every materialized worktree directory a thread subtree owns, with the
   *  project each one was built from. Read BEFORE deleteThread: the rows are
   *  gone afterwards, and with them the only record of which directories the
   *  delete orphaned. Threads still waiting on a worktree (a path never
   *  written) contribute nothing — there is no directory to clean.
   *
   *  One entry per thread row, ancestor-first like subtreeIds: callers dedupe
   *  paths that siblings share. */
  subtreeWorkspaces(
    threadId: string,
  ): Array<{ threadId: string; projectPath: string; worktreePath: string }> {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      const ids = this.deps.subtreeIds(db, threadId);
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      // SAFETY: the projection names only threads.thread_id,
      // threads.project_path and threads.worktree_path.
      const rows = db
        .prepare(
          `SELECT thread_id, project_path, worktree_path FROM threads
            WHERE thread_id IN (${placeholders})`,
        )
        .all(...ids) as Array<{
        thread_id: string;
        project_path: string;
        worktree_path: string | null;
      }>;
      const byId = new Map(rows.map((row) => [row.thread_id, row]));
      const out: Array<{ threadId: string; projectPath: string; worktreePath: string }> = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) continue;
        const worktreePath = row.worktree_path?.trim() ? row.worktree_path : null;
        if (!worktreePath || !row.project_path) continue;
        out.push({ threadId: id, projectPath: row.project_path, worktreePath });
      }
      return out;
    } catch (err) {
      console.error("[conversation-store] subtreeWorkspaces failed:", err);
      return [];
    }
  }

  /** Whether any remaining thread row still names this worktree directory.
   *  Read AFTER deleteThread: a path the deleted subtree shared with a thread
   *  outside it (a reopened thread adopting its predecessor's directory) must
   *  survive. An unreadable store answers true — when the answer is unknown
   *  the directory stays, which is the failure that cleans itself up next
   *  time rather than the one that deletes a live checkout. */
  isWorktreePathReferenced(worktreePath: string): boolean {
    const db = this.dbh.handle();
    if (!db) return true;
    try {
      // SAFETY: the projection is the constant 1 under the alias asked for.
      const row = db
        .prepare(`SELECT 1 AS one FROM threads WHERE worktree_path = ? LIMIT 1`)
        .get(worktreePath) as { one: number } | undefined;
      return row !== null && row !== undefined;
    } catch (err) {
      console.error("[conversation-store] isWorktreePathReferenced failed:", err);
      return true;
    }
  }
}
