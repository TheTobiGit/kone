import type { ConversationDb } from "./ConversationDb.js";
import {
  threadPullRequestState,
  toThreadPullRequestLink,
  type ThreadPullRequestLink,
  type ThreadPullRequestLinkInput,
} from "../threadPullRequest.js";

/** The columns a linked PR occupies on a thread. */
const LINK_COLUMNS =
  "linked_pr_repository, linked_pr_number, linked_pr_url, linked_pr_state, linked_pr_checked_at, linked_pr_merged_at";

interface LinkRow {
  linked_pr_repository: string | null;
  linked_pr_number: number | null;
  linked_pr_url: string | null;
  linked_pr_state: string | null;
  linked_pr_checked_at: number | null;
  linked_pr_merged_at: number | null;
}

function rowToLink(row: LinkRow): ThreadPullRequestLink {
  return {
    repository: row.linked_pr_repository ?? "",
    number: row.linked_pr_number ?? 0,
    url: row.linked_pr_url ?? "",
    state: threadPullRequestState(row.linked_pr_state),
    checkedAt: row.linked_pr_checked_at ?? null,
    mergedAt: row.linked_pr_merged_at ?? null,
  };
}

/** One thread with a linked PR, as the settle sweep needs it: the link, the
 *  project it belongs to, and where the thread runs (so a branch PR can be
 *  discovered when no explicit link exists). */
export interface LinkedPullRequestThread {
  threadId: string;
  projectPath: string;
  branch: string | null;
  worktreePath: string | null;
  link: ThreadPullRequestLink;
}

/** A thread the settle-on-merge sweep should check: an explicit link, a
 *  worktree branch (whose PR git can discover), or both. `link` is null for a
 *  branch-only candidate — the checker resolves the branch's PR. */
export interface ThreadPullRequestCandidate {
  threadId: string;
  projectPath: string;
  branch: string | null;
  worktreePath: string | null;
  link: ThreadPullRequestLink | null;
}

export class ThreadPullRequestRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** The thread's linked PR, or null when none is set (or the thread is
   *  unknown — the caller cannot tell the two apart from here). */
  link(threadId: string): ThreadPullRequestLink | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names the six nullable link columns exactly.
      const row = db
        .prepare(`SELECT ${LINK_COLUMNS} FROM threads WHERE thread_id = ?`)
        .get(threadId) as LinkRow | undefined;
      if (!row) return null;
      const link = rowToLink(row);
      // No URL and no number means no link: the thread row exists but carries
      // nothing, which reads as "none set" rather than an empty link.
      return link.url || link.number > 0 ? link : null;
    } catch (err) {
      console.error("[conversation-store] threadPullRequest link failed:", err);
      return null;
    }
  }

  /** Persist a linked PR. Returns false when the input names no PR or the
   *  thread row does not exist. */
  setLink(threadId: string, input: ThreadPullRequestLinkInput): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    const link = toThreadPullRequestLink(input);
    if (!link) return false;
    try {
      const result = db
        .prepare(
          `UPDATE threads
              SET linked_pr_repository = ?, linked_pr_number = ?, linked_pr_url = ?,
                  linked_pr_state = ?, linked_pr_checked_at = ?, linked_pr_merged_at = ?
            WHERE thread_id = ?`,
        )
        .run(
          link.repository,
          link.number,
          link.url,
          link.state,
          link.checkedAt,
          link.mergedAt,
          threadId,
        );
      return result.changes > 0;
    } catch (err) {
      console.error("[conversation-store] threadPullRequest setLink failed:", err);
      return false;
    }
  }

  /** Remove the thread's linked PR. Returns whether a row changed. */
  clearLink(threadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(
          `UPDATE threads
              SET linked_pr_repository = NULL, linked_pr_number = NULL, linked_pr_url = NULL,
                  linked_pr_state = NULL, linked_pr_checked_at = NULL, linked_pr_merged_at = NULL
            WHERE thread_id = ?`,
        )
        .run(threadId);
      return result.changes > 0;
    } catch (err) {
      console.error("[conversation-store] threadPullRequest clearLink failed:", err);
      return false;
    }
  }

  /** Re-read one thread as a settle candidate using the same selection as
   *  settleCandidates, ignoring the backoff. Used to validate that a check's
   *  inputs (project, branch, worktree, link) are unchanged after gh ran and to
   *  derive cleanup from the live workspace, not a stale one. */
  threadPullRequestCandidate(threadId: string): ThreadPullRequestCandidate | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names the link columns plus the thread's
      // project/branch/place; branch falls back to requested_branch.
      const row = db
        .prepare(
          `SELECT thread_id, project_path,
                  COALESCE(NULLIF(branch, ''), requested_branch) AS branch,
                  worktree_path, ${LINK_COLUMNS}
             FROM threads
            WHERE thread_id = ?
              AND archived_at IS NULL
              AND NOT (done_at IS NOT NULL AND done_at > 0 AND done_at >= last_activity_at)
              AND (
                (linked_pr_url IS NOT NULL AND linked_pr_url <> '')
                OR (worktree_path IS NOT NULL AND worktree_path <> '')
              )
            LIMIT 1`,
        )
        .get(threadId) as
        | {
            thread_id: string;
            project_path: string;
            branch: string | null;
            worktree_path: string | null;
            linked_pr_repository: string | null;
            linked_pr_number: number | null;
            linked_pr_url: string | null;
            linked_pr_state: string | null;
            linked_pr_checked_at: number | null;
            linked_pr_merged_at: number | null;
          }
        | undefined;
      if (!row) return null;
      const link = rowToLink(row);
      return {
        threadId: row.thread_id,
        projectPath: row.project_path,
        branch: row.branch,
        worktreePath: row.worktree_path,
        link: link.url || link.number > 0 ? link : null,
      };
    } catch (err) {
      console.error("[conversation-store] threadPullRequest candidate failed:", err);
      return null;
    }
  }

  /** Record what the latest check saw without touching the link identity. Used
   *  by the settle sweep so a merge is visible next time without another gh
   *  call. */
  recordChecked(
    threadId: string,
    input: { state: ThreadPullRequestLink["state"]; mergedAt: number | null; checkedAt: number },
  ): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE threads
            SET linked_pr_state = ?, linked_pr_checked_at = ?, linked_pr_merged_at = ?
          WHERE thread_id = ?`,
      ).run(input.state, input.checkedAt, input.mergedAt, threadId);
    } catch (err) {
      console.error("[conversation-store] threadPullRequest recordChecked failed:", err);
    }
  }

  /** Advance a thread's check time without touching PR identity or state. Used
   *  when a check could not produce a result (gh unavailable, an unreadable
   *  link, or a busy thread) so the bounded candidate query moves past it
   *  instead of returning the same first threads forever. */
  recordAttempt(threadId: string, checkedAt: number): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET linked_pr_checked_at = ? WHERE thread_id = ?`).run(
        checkedAt,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] threadPullRequest recordAttempt failed:", err);
    }
  }

  /** Whether a thread is still a settle candidate right now: it exists, is not
   *  archived, and is not already settled. Re-read immediately before actually
   *  settling, because a check is asynchronous and these facts can change while
   *  gh runs. */
  threadIsSettleEligible(threadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      // SAFETY: the projection is the constant 1 under the alias asked for.
      const row = db
        .prepare(
          `SELECT 1 AS one FROM threads
            WHERE thread_id = ? AND archived_at IS NULL
              AND NOT (done_at IS NOT NULL AND done_at > 0 AND done_at >= last_activity_at)
            LIMIT 1`,
        )
        .get(threadId) as { one: number } | undefined;
      return row !== null && row !== undefined;
    } catch (err) {
      console.error("[conversation-store] threadPullRequest threadIsSettleEligible failed:", err);
      return false;
    }
  }

  /** Every thread that has a linked PR, newest check first — the settle
   *  sweep's candidate list. Bounded so one pass never loads an unbounded set. */
  linkedThreads(limit: number): LinkedPullRequestThread[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection names the link columns plus the thread's
      // project/branch/place, all nullable TEXT except the identity columns.
      const rows = db
        .prepare(
          `SELECT thread_id, project_path, branch, worktree_path, ${LINK_COLUMNS}
             FROM threads
            WHERE linked_pr_url IS NOT NULL AND linked_pr_url <> ''
            ORDER BY COALESCE(linked_pr_checked_at, 0) ASC
            LIMIT ?`,
        )
        .all(limit) as Array<{
        thread_id: string;
        project_path: string;
        branch: string | null;
        worktree_path: string | null;
        linked_pr_repository: string | null;
        linked_pr_number: number | null;
        linked_pr_url: string | null;
        linked_pr_state: string | null;
        linked_pr_checked_at: number | null;
        linked_pr_merged_at: number | null;
      }>;
      return rows.map((row) => ({
        threadId: row.thread_id,
        projectPath: row.project_path,
        branch: row.branch,
        worktreePath: row.worktree_path,
        link: rowToLink(row),
      }));
    } catch (err) {
      console.error("[conversation-store] threadPullRequest linkedThreads failed:", err);
      return [];
    }
  }

  /** Threads the settle-on-merge sweep should check, least-recently-checked
   *  first so a single pass keeps every candidate moving. A thread qualifies
   *  when it is neither archived nor already settled (its done mark is newer
   *  than its last activity), and it has an explicit link or — the branch
   *  fallback — its own worktree (a local thread's `branch` is the shared repo
   *  branch, which would settle every thread on one PR, so it is excluded).
   *  `notCheckedAfter` backs off: candidates checked at or after that epoch are
   *  skipped, so a two-minute tick does not fan out a gh call per thread. The
   *  cutoff is required: a caller must say how stale a check may be, rather
   *  than silently getting "everything is due". */
  settleCandidates(limit: number, notCheckedAfter: number): ThreadPullRequestCandidate[] {
    const db = this.dbh.handle();
    if (!db) return [];
    const backoff = notCheckedAfter;
    try {
      // SAFETY: the projection names the link columns plus the thread's
      // project/branch/place; branch falls back to requested_branch for a
      // worktree whose live branch has not been read back yet.
      const rows = db
        .prepare(
          `SELECT thread_id, project_path,
                  COALESCE(NULLIF(branch, ''), requested_branch) AS branch,
                  worktree_path, ${LINK_COLUMNS}
             FROM threads
            WHERE archived_at IS NULL
              AND NOT (done_at IS NOT NULL AND done_at > 0 AND done_at >= last_activity_at)
              AND (linked_pr_checked_at IS NULL OR linked_pr_checked_at <= ?)
              AND (
                (linked_pr_url IS NOT NULL AND linked_pr_url <> '')
                OR (worktree_path IS NOT NULL AND worktree_path <> '')
              )
            ORDER BY COALESCE(linked_pr_checked_at, 0) ASC
            LIMIT ?`,
        )
        .all(backoff, limit) as Array<{
        thread_id: string;
        project_path: string;
        branch: string | null;
        worktree_path: string | null;
        linked_pr_repository: string | null;
        linked_pr_number: number | null;
        linked_pr_url: string | null;
        linked_pr_state: string | null;
        linked_pr_checked_at: number | null;
        linked_pr_merged_at: number | null;
      }>;
      return rows.map((row) => {
        const link = rowToLink(row);
        return {
          threadId: row.thread_id,
          projectPath: row.project_path,
          branch: row.branch,
          worktreePath: row.worktree_path,
          link: link.url || link.number > 0 ? link : null,
        };
      });
    } catch (err) {
      console.error("[conversation-store] threadPullRequest settleCandidates failed:", err);
      return [];
    }
  }
}
