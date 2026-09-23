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

  // ── idle worktree cleanup ─────────────────────────────────────────────────

  /** Worktree directories every referencing thread has left alone since
   *  `cutoff`, oldest first. "Left alone" is the later of the last activity and
   *  the last visit, the same clock the thread sweep reads, taken across every
   *  thread that shares the directory. A pinned thread keeps its directory, and
   *  so does anything with work in flight: a queued turn, a running reply or a
   *  running subagent on any of them. */
  idleWorktrees(
    cutoff: number,
    limit: number,
  ): Array<{ worktreePath: string; projectPath: string; threadIds: string[] }> {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection names only the three aliases asked for.
      const rows = db
        .prepare(
          `SELECT t.worktree_path AS worktree_path,
                  MIN(t.project_path) AS project_path,
                  GROUP_CONCAT(t.thread_id, char(31)) AS thread_ids
             FROM threads t
            WHERE t.worktree_path IS NOT NULL AND t.worktree_path <> ''
            GROUP BY t.worktree_path
           HAVING MAX(MAX(t.last_activity_at, COALESCE(t.last_visited_at, 0))) < ?
              AND SUM(t.pinned_at IS NOT NULL) = 0
              AND NOT EXISTS (
                SELECT 1 FROM queued_turns q JOIN threads x ON x.thread_id = q.thread_id
                 WHERE x.worktree_path = t.worktree_path AND q.state IN ('queued', 'promoting'))
              AND NOT EXISTS (
                SELECT 1 FROM blocks b JOIN threads x ON x.thread_id = b.thread_id
                 WHERE x.worktree_path = t.worktree_path
                   AND b.role = 'assistant' AND b.state = 'running')
              AND NOT EXISTS (
                SELECT 1 FROM subagents sa JOIN threads x ON x.thread_id = sa.thread_id
                 WHERE x.worktree_path = t.worktree_path
                   AND sa.status IN ('starting', 'running'))
            ORDER BY MAX(MAX(t.last_activity_at, COALESCE(t.last_visited_at, 0))) ASC
            LIMIT ?`,
        )
        .all(cutoff, limit) as Array<{
        worktree_path: string;
        project_path: string | null;
        thread_ids: string | null;
      }>;
      return rows.flatMap((row) =>
        row.project_path
          ? [
              {
                worktreePath: row.worktree_path,
                projectPath: row.project_path,
                threadIds: (row.thread_ids ?? "").split("\u001f").filter(Boolean),
              },
            ]
          : [],
      );
    } catch (err) {
      console.error("[conversation-store] idleWorktrees failed:", err);
      return [];
    }
  }

  /** Forget a directory that cleanup removed, keeping the way back: every
   *  thread that used it becomes a worktree thread still waiting for its
   *  directory, on the branch it left behind, so opening it again builds a
   *  fresh one on that branch with nothing lost. */
  detachWorktree(worktreePath: string, branch: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE threads SET worktree_path = NULL, env_mode = 'worktree', requested_branch = ?
          WHERE worktree_path = ?`,
      ).run(branch, worktreePath);
    } catch (err) {
      console.error("[conversation-store] detachWorktree failed:", err);
    }
  }

  /** Days a worktree may sit unused before cleanup removes it; null is off.
   *  Unset reads as the default. */
  worktreeCleanupDays(): number | null {
    const db = this.dbh.handle();
    if (!db) return DEFAULT_WORKTREE_CLEANUP_DAYS;
    try {
      // SAFETY: app_state holds at most one row for this key.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = '${CLEANUP_DAYS_KEY}'`)
        .get() as { value: string } | undefined;
      return parseCleanupDays(row?.value);
    } catch (err) {
      console.error("[conversation-store] worktreeCleanupDays failed:", err);
      return DEFAULT_WORKTREE_CLEANUP_DAYS;
    }
  }

  setWorktreeCleanupDays(days: number | null): void {
    const db = this.dbh.handle();
    if (!db) return;
    const value = days === null ? "off" : String(Math.max(1, Math.round(days)));
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ('${CLEANUP_DAYS_KEY}', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(value, Date.now());
    } catch (err) {
      console.error("[conversation-store] setWorktreeCleanupDays failed:", err);
    }
  }
}

const CLEANUP_DAYS_KEY = "worktree_cleanup_days";
/** Two weeks: long enough that a thread put down for a holiday is still there,
 *  short enough that the disk does not fill with checkouts nobody opens. */
export const DEFAULT_WORKTREE_CLEANUP_DAYS = 14;

function parseCleanupDays(value: string | undefined): number | null {
  if (value === undefined || value === "") return DEFAULT_WORKTREE_CLEANUP_DAYS;
  if (value === "off") return null;
  const days = Number(value);
  return Number.isFinite(days) && days >= 1 ? Math.round(days) : DEFAULT_WORKTREE_CLEANUP_DAYS;
}
