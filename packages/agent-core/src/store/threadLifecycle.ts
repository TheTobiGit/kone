import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import { withTransaction } from "../conversationMigrations.js";
import { removeThreadRows } from "./search.js";

/** Callback into the event ingest repo to drop cached ids for deleted threads. */
export type ThreadLifecycleDeps = {
  forgetConversationIds(ids: readonly string[]): void;
};

export class ThreadLifecycleRepo {
  constructor(
    private readonly dbh: ConversationDb,
    private readonly deps?: ThreadLifecycleDeps,
  ) {}

  /** The thread and every spawned descendant (subtree), in stable
   *  ancestor-first order — archive/delete operate on the whole subtree
 */
  subtreeIds(db: DatabaseSync, threadId: string): string[] {
    const out: string[] = [threadId];
    const childOf = db.prepare(`SELECT thread_id FROM threads WHERE parent_thread_id = ?`);
    let frontier = [threadId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        // SAFETY: childOf selects only threads.thread_id.
        for (const r of childOf.all(id) as Array<{ thread_id: string }>) {
          // Cycle-guarded: a corrupted parent pointer must not loop forever.
          if (!out.includes(r.thread_id)) {
            out.push(r.thread_id);
            next.push(r.thread_id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Whether any thread in the set has a live turn — a running assistant
   *  block, or a subagent still starting/running. The busy guard for
   *  archive/delete: a spawned child mid-turn must never be archived or
 */
  private subtreeBusy(db: DatabaseSync, threadIds: string[]): boolean {
    if (threadIds.length === 0) return false;
    const placeholders = threadIds.map(() => "?").join(",");
    const runningBlock = db
      .prepare(
        `SELECT 1 FROM blocks
          WHERE thread_id IN (${placeholders}) AND role = 'assistant' AND state = 'running'
          LIMIT 1`,
      )
      .get(...threadIds);
    if (runningBlock) return true;
    const runningSubagent = db
      .prepare(
        `SELECT 1 FROM subagents
          WHERE thread_id IN (${placeholders}) AND status IN ('starting', 'running')
          LIMIT 1`,
      )
      .get(...threadIds);
    // `null` means "no row" — `!== undefined` would wrongly treat it as busy.
    return Boolean(runningSubagent);
  }

  /** Pre-flight guard for the destructive IPC path: the ipc layer checks this
   *  BEFORE unlinking attachment files (which must happen before the rows go,
   *  so the registry can resolve the paths). */
  canDeleteThread(threadId: string): { ok: true } | { ok: false; reason: "missing" | "busy" } {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "missing" };
    try {
      const exists = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`)
        .get(threadId);
      if (!exists) return { ok: false, reason: "missing" };
      return this.subtreeBusy(db, this.subtreeIds(db, threadId))
        ? { ok: false, reason: "busy" }
        : { ok: true };
    } catch (err) {
      console.error("[conversation-store] canDeleteThread failed:", err);
      return { ok: false, reason: "missing" };
    }
  }

  /** Hide (or restore) a thread and its spawned subtree from the recent list
   *  without destroying them. `archived` is a timestamp so the archived view
   *  can order by when the put-away happened. Refuses (and returns the reason)
   *  when a spawned descendant is mid-turn. On success returns every thread id
   *  the stamp landed on, ancestor-first, so the caller can announce the
   *  change per thread.
   *
   *  This is the pure data primitive: it touches ONLY the threads table. The
   *  caller (AgentService.setThreadArchived) owns everything announcements
   *  need — cancelling the subtree's queued turns, and the thread.archived /
   *  turn.queued-cancelled events that make every surface agree. */
  setArchived(
    threadId: string,
    archived: boolean,
  ): { ok: true; threadIds: string[] } | { ok: false; reason: "missing" | "busy" | "error" } {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "missing" };
    try {
      const ids = this.subtreeIds(db, threadId);
      const exists = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`)
        .get(threadId);
      if (!exists) return { ok: false, reason: "missing" };
      if (archived && this.subtreeBusy(db, ids)) {
        console.warn(
          `[conversation-store] refusing to archive ${threadId}: a spawned descendant is mid-turn`,
        );
        return { ok: false, reason: "busy" };
      }
      // Queued turns are deliberately NOT touched here — the service layer
      // cancels them (and says so over the event stream) as part of the same
      // archive request, so a hidden thread never carries a queue the user
      // can no longer see. Cancelling at that layer rather than this one
      // keeps the store free of event emission, where it has no listeners.
      const stamp = archived ? Date.now() : null;
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`UPDATE threads SET archived_at = ? WHERE thread_id IN (${placeholders})`).run(
        stamp,
        ...ids,
      );
      return { ok: true, threadIds: ids };
    } catch (err) {
      console.error("[conversation-store] setArchived failed:", err);
      return { ok: false, reason: "error" };
    }
  }

  /** Live threads the retention sweep may tidy. Roots only (a spawned child is
   *  archived through its parent — archiving one alone would strand it with no
   *  row to restore it from), never pinned (a pin is a keep-me), never already
   *  archived, and never a subtree with active queued turns (putting those
   *  away would silently cancel work the user asked for). Staleness is the
   *  newest of the thread's own timestamps — a thread only counts as stale
   *  when every signal it carries is past the cutoff — and the stalest come
   *  first, so a backlog drains oldest-first.
   *
   *  `last_visited_at` is one of those signals, and it has to be: the sweep is
   *  answering "has anyone touched this in a week", and reading a thread is
   *  touching it. `done_at` is another: a thread you marked done is work you are
   *  finished with, but only while the agent hasn't spoken since; done expired
   *  by subsequent activity is a thread asking again, not an idle one.
   *  `DONE_CLEARED` (the un-mark sentinel) is ignored — it is the user's
   *  explicit "this is not done", and treating it as a timestamp would place it
   *  at epoch zero and make the thread look older than everything.
   *
   *  Roots with children are tidied only when the whole subtree qualifies — a
   *  parent whose child is still active is kept alive so the child has its
   *  anchor. The recursive query gathers subtree ids and confirms every
   *  descendant is quiet before the root is offered.
   *
   *  `options.undone`: restrict the sweep to threads that are EITHER never
   *  marked done, OR marked done before their latest activity — in other words,
   *  threads the user has NOT said they are finished with. Done = 0 (the sentinel)
   *  is the user's "not finished" answer, which outranks age for good; the
   *  sweep has no business overriding it. */
  staleThreadIds(options: {
    unusedMs: number;
    limit: number;
    undone?: boolean;
  }): string[] {
    const db = this.dbh.handle();
    if (!db) return [];
    const cutoff = Date.now() - Math.max(0, options.unusedMs);
    try {
      // SAFETY: the recursive SELECT projects exactly threads.thread_id.
      const rows = db
        .prepare(
          `WITH RECURSIVE subtree(root_id, id) AS (
             SELECT t.thread_id AS root_id, t.thread_id AS id FROM threads t
             WHERE t.parent_thread_id IS NULL
               AND t.archived_at IS NULL
               AND t.pinned_at IS NULL
               AND MAX(t.last_activity_at, COALESCE(t.last_visited_at, 0)) < ?
               ${options.undone ? `AND (t.done_at IS NULL OR (t.done_at > 0 AND t.done_at < t.last_activity_at))` : ""}
             UNION ALL
             SELECT s.root_id, c.thread_id FROM threads c JOIN subtree s ON c.parent_thread_id = s.id
           )
           SELECT t.thread_id, MAX(t.last_activity_at, COALESCE(t.last_visited_at, 0)) AS activity
           FROM threads t
           WHERE t.thread_id IN (SELECT root_id FROM subtree)
             AND t.parent_thread_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM queued_turns q
               JOIN subtree s ON q.thread_id = s.id
               WHERE s.root_id = t.thread_id
                 AND q.state IN ('queued', 'promoting')
             )
             AND NOT EXISTS (
               SELECT 1 FROM blocks b
               JOIN subtree s ON b.thread_id = s.id
               WHERE s.root_id = t.thread_id
                 AND b.role = 'assistant' AND b.state = 'running'
             )
             AND NOT EXISTS (
               SELECT 1 FROM subagents sa
               JOIN subtree s ON sa.thread_id = s.id
               WHERE s.root_id = t.thread_id
                 AND sa.status IN ('starting', 'running')
             )
           ORDER BY activity ASC
           LIMIT ?`,
        )
        .all(cutoff, options.limit) as Array<{ thread_id: string }>;
      return rows.map((r) => r.thread_id);
    } catch (err) {
      console.error("[conversation-store] staleThreadIds failed:", err);
      return [];
    }
  }

  /** Permanently remove a thread, its spawned subtree, and everything under
   *  them. Irreversible — the renderer confirms before calling. Refuses (and
   *  returns the reason) when a spawned descendant is mid-turn. */
  deleteThread(
    threadId: string,
  ): { ok: true } | { ok: false; reason: "missing" | "busy" | "error" } {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "missing" };
    try {
      const ids = this.subtreeIds(db, threadId);
      const exists = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`)
        .get(threadId);
      if (!exists) return { ok: false, reason: "missing" };
      if (this.subtreeBusy(db, ids)) {
        console.warn(
          `[conversation-store] refusing to delete ${threadId}: a spawned descendant is mid-turn`,
        );
        return { ok: false, reason: "busy" };
      }
      const placeholders = ids.map(() => "?").join(",");
      withTransaction(db, () => {
        // thread_agents has no foreign key to threads (to allow bindings before thread creation),
        // so it is cleared explicitly. All thread-scoped child tables (items, blocks, attachments,
        // subagents, gateway_ops, turn_usage, queued_turns) cascade automatically from threads.
        db.prepare(`DELETE FROM thread_agents WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM threads       WHERE thread_id IN (${placeholders})`).run(...ids);
        // The full-text index is not a child table and cascades nothing — its
        // rows for the subtree are dropped here, in the same transaction, so
        // a deleted thread never answers searches.
        removeThreadRows(db, ids);
      });
      this.deps?.forgetConversationIds?.(ids);
      return { ok: true };
    } catch (err) {
      console.error("[conversation-store] deleteThread failed:", err);
      return { ok: false, reason: "error" };
    }
  }
}
