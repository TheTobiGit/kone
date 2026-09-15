import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import { rowToQueuedTurn, type QueuedTurnDbRow, type QueuedTurnEnqueueInput, type QueuedTurnRow } from "../conversationStoreTypes.js";

/** Queue drain order, shared by claim and list so the UI shows exactly what
 *  runs next. Rows with an explicit position (set by reorder) drain first in
 *  that order regardless of dispatch mode; rows never reordered (sort_key
 *  NULL) fall back to the default steer-first (newest steer first) then FIFO
 *  order, with rowid as the final tiebreak for same-millisecond enqueues.
 *  New arrivals after a reorder carry NULL and queue behind the explicit
 *  sequence until the next reorder. */
const QUEUED_TURN_ORDER = `CASE WHEN sort_key IS NULL THEN 1 ELSE 0 END ASC,
                  sort_key ASC,
                  CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
                  CASE WHEN dispatch_mode = 'steer' THEN created_at END DESC,
                  CASE WHEN dispatch_mode = 'steer' THEN rowid END DESC,
                  created_at ASC,
                  rowid ASC`;


export class QueuedTurnRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // A follow-up sent while a turn runs is durably enqueued here, claimed by
  // the service layer when the live turn settles, and cancelled when the
  // thread is deleted. Lifecycle: 'queued' → 'promoting' → 'promoted'
  // (claim → promote), 'promoting' → 'queued' (claim → release: the drain
  // failed and the turn must not be lost), and any active state → 'cancelled'
  // (stop/delete). Only the ACTIVE states count as pending: a settled row
  // (promoted/cancelled) is inert history, and a later releaseClaim must never
  // match a cancelled row — that resurrection bug is why cancel flips BOTH

  /** Durably enqueue a turn for `threadId`. The partial unique index on
   *  (thread_id, user_block_id) over the active states makes a replayed
   *  enqueue — the same prompt delivered twice by a retrying caller — a
   *  no-op. Returns whether a row was actually inserted. */
  enqueueQueuedTurn(input: QueuedTurnEnqueueInput): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    const now = input.at ?? Date.now();
    let inserted = false;
    this.dbh.durably(db, () => {
      const result = db
        .prepare(
          `INSERT INTO queued_turns (
             queue_id, thread_id, user_block_id, dispatch_mode, state, input,
             attachments_json, model, mode, effort, service_tier, context_window,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (thread_id, user_block_id)
             WHERE state IN ('queued', 'promoting') DO NOTHING`,
        )
        .run(
          input.queueId,
          input.threadId,
          input.userBlockId,
          input.dispatchMode ?? "queue",
          input.input,
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
          input.model ?? null,
          input.mode ?? null,
          input.effort ?? null,
          input.serviceTier ?? null,
          input.contextWindow ?? null,
          now,
          now,
        );
      inserted = Number(result.changes) > 0;
    });
    return inserted;
  }

  /** Claim the next queued turn for `threadId` (atomically — one statement:
   *  the candidate subquery and the state flip share the statement's write
   *  lock, so two racing drains serialize and the loser sees no 'queued'
   *  candidate). Drain order is QUEUED_TURN_ORDER: an explicit reorder wins
   *  over dispatch mode, otherwise steer rows jump the line (most recent
   *  steer first) then plain FIFO by created_at, with the table's insertion
   *  order (rowid) as the final tiebreak. rowid rather than queue_id:
   *  created_at is a millisecond clock, so two rows enqueued in the same tick
   *  tie on it, and breaking that tie by a random UUID ordered them
   *  arbitrarily instead of by arrival. Returns the row now in 'promoting'
   *  (attempt_count already bumped), or null when the thread has nothing
   *  active to claim. */
  claimNextQueuedTurn(threadId: string, staleTimeoutMs = 120_000): QueuedTurnRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      const now = Date.now();
      const cutoff = now - staleTimeoutMs;
      db.prepare(
        `UPDATE queued_turns
            SET state = 'queued', updated_at = ?
          WHERE thread_id = ? AND state = 'promoting' AND updated_at <= ?`,
      ).run(now, threadId, cutoff);

      // SAFETY: RETURNING * of queued_turns is exactly QueuedTurnDbRow — the
      // columns this schema creates.
      const row = db
        .prepare(
          `UPDATE queued_turns
              SET state = 'promoting',
                  attempt_count = attempt_count + 1,
                  updated_at = ?
            WHERE queue_id = (
              SELECT queue_id FROM queued_turns
               WHERE thread_id = ? AND state = 'queued'
               ORDER BY ${QUEUED_TURN_ORDER}
               LIMIT 1
            )
           RETURNING *`,
        )
        .get(now, threadId) as QueuedTurnDbRow | undefined;
      return row ? rowToQueuedTurn(row) : null;
    } catch (err) {
      console.error("[conversation-store] claimNextQueuedTurn failed:", err);
      return null;
    }
  }

  /** Release every queued turn stranded in 'promoting' whose claim has expired
   *  (not updated within `staleTimeoutMs`). Returns the count of recovered rows. */
  recoverStaleClaims(staleTimeoutMs = 120_000): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      const now = Date.now();
      const cutoff = now - staleTimeoutMs;
      const result = db
        .prepare(
          `UPDATE queued_turns
              SET state = 'queued', updated_at = ?
            WHERE state = 'promoting' AND updated_at <= ?`,
        )
        .run(now, cutoff);
      return Number(result.changes);
    } catch (err) {
      console.error("[conversation-store] recoverStaleClaims failed:", err);
      return 0;
    }
  }

  /** Settle a claimed turn: 'promoting' → 'promoted'. WHERE state='promoting'
   *  makes a lost claim fail loudly — promoting a row nobody claimed would
   *  silently drop a queued turn's retry (return false and the service layer
   *  falls back to release/reclaim). */
  markQueuedTurnPromoted(queueId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const now = Date.now();
      let promoted = false;
      this.dbh.durably(db, () => {
        // SAFETY: projecting thread_id and user_block_id from queued_turns
        const row = db
          .prepare(
            `SELECT thread_id, user_block_id FROM queued_turns WHERE queue_id = ? AND state = 'promoting'`,
          )
          .get(queueId) as { thread_id: string; user_block_id: string } | undefined;
        if (!row) return;

        const result = db
          .prepare(
            `UPDATE queued_turns
                SET state = 'promoted', promoted_at = ?, updated_at = ?
              WHERE queue_id = ? AND state = 'promoting'`,
          )
          .run(now, now, queueId);
        promoted = Number(result.changes) > 0;
        if (promoted) {
          // Re-sequence the user block to the current head of the thread's blocks
          // so its arrival order in the transcript matches its promotion order.
          // `at` stays the original send instant — it is the user-visible time.
          // SAFETY: aggregate MAX returns a single number
          const maxSeqRow = db
            .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM blocks WHERE thread_id = ?`)
            .get(row.thread_id) as { max_seq: number } | undefined;
          const nextSeq = (maxSeqRow?.max_seq ?? 0) + 1;
          db.prepare(
            `UPDATE blocks SET seq = ? WHERE thread_id = ? AND block_id = ?`,
          ).run(nextSeq, row.thread_id, row.user_block_id);
        }
      });
      return promoted;
    } catch (err) {
      console.error("[conversation-store] markQueuedTurnPromoted failed:", err);
      return false;
    }
  }

  /** Give a claimed turn back: 'promoting' → 'queued' so the next drain
   *  retries it. attempt_count is preserved (the retry ledger stays honest).
   *  Returns false when the row is not in 'promoting' — the cancelled-row
   *  resurrection guard: cancelQueuedTurnsForThread flips 'promoting' rows to
   *  'cancelled' first, so a drain's late release can no longer match. */
  releaseQueuedTurn(queueId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(
          `UPDATE queued_turns SET state = 'queued', updated_at = ?
            WHERE queue_id = ? AND state = 'promoting'`,
        )
        .run(Date.now(), queueId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] releaseQueuedTurn failed:", err);
      return false;
    }
  }

  /** Reorder the active queued turns for `threadId`. Writes the caller's
   *  explicit order into sort_key (0-based over the FULL active set), so
   *  listings (`listQueuedTurns`) and claims (`claimNextQueuedTurn`) — which
   *  share QUEUED_TURN_ORDER — drain in the updated order. An explicit order
   *  wins over dispatch mode: dragging a plain row above a steer row runs the
   *  plain row first, matching what the strip shows. A partial list still
   *  re-keys every active row — listed ids first in the caller's order, then
   *  unlisted rows in their current display order — so no row is left on a
   *  stale key to interleave arbitrarily. created_at is never touched: it
   *  keeps meaning when the turn arrived. Returns whether any rows were
   *  updated. */
  reorderQueuedTurns(threadId: string, queueIds: string[]): boolean {
    const db = this.dbh.handle();
    if (!db || queueIds.length === 0) return false;
    try {
      let updated = false;
      this.dbh.durably(db, () => {
        // SAFETY: selecting only the active queue ids in current display order.
        const activeRows = db
          .prepare(
            `SELECT queue_id FROM queued_turns
              WHERE thread_id = ? AND state IN ('queued', 'promoting')
              ORDER BY ${QUEUED_TURN_ORDER}`,
          )
          .all(threadId) as Array<{ queue_id: string }>;
        if (activeRows.length === 0) return;

        const active = new Set(activeRows.map((r) => r.queue_id));
        const seen = new Set<string>();
        const head: string[] = [];
        for (const qId of queueIds) {
          if (!active.has(qId) || seen.has(qId)) continue;
          seen.add(qId);
          head.push(qId);
        }
        if (head.length === 0) return;
        const tail = activeRows.map((r) => r.queue_id).filter((id) => !seen.has(id));
        const finalOrder = [...head, ...tail];

        const updateStmt = db.prepare(
          `UPDATE queued_turns SET sort_key = ?, updated_at = ?
            WHERE thread_id = ? AND queue_id = ? AND state IN ('queued', 'promoting')`,
        );

        const now = Date.now();
        for (let i = 0; i < finalOrder.length; i++) {
          const result = updateStmt.run(i, now, threadId, finalOrder[i]!);
          if (Number(result.changes) > 0) updated = true;
        }
      });
      return updated;
    } catch (err) {
      console.error("[conversation-store] reorderQueuedTurns failed:", err);
      return false;
    }
  }

  /** Delete the journaled prompt a queue row was enqueued for. The one place
   *  journaled-block removal lives: both cancel paths route through here, and
   *  the renderer's turn.queued-cancelled only ever drops its own optimistic
   *  blocks — never this id. User blocks journal without a turn_id, so this
   *  only ever matches the prompt the enqueue itself journaled — never a
   *  block a started turn later adopted. */
  private deleteQueuedPromptBlock(db: DatabaseSync, threadId: string, userBlockId: string): void {
    db.prepare(
      `DELETE FROM blocks
        WHERE thread_id = ? AND block_id = ? AND role = 'user' AND turn_id IS NULL`,
    ).run(threadId, userBlockId);
  }

  /** Cancel ONE queued turn (the UI's per-item cancel). Only a row still
   *  WAITING can flip: 'promoting' means a drain has already claimed it and
   *  handed it to the adapter, so flipping it would report a cancellation for
   *  a turn that is running — the strip row would vanish,
   *  turn.queued-cancelled would go out with reason "user", and the agent
   *  would answer the message anyway. Losing the race is the honest answer
   *  (false); the row promotes and the running turn replaces it in the strip. The stop/delete path keeps
   *  cancelling 'promoting' rows on purpose — see cancelQueuedTurnsForThread,
   *  where the session is being torn down regardless. A successful flip also
   *  removes the row's journaled prompt: only 'queued' flips here, so the turn
   *  provably never started and its block has no reply and never will —
   *  leaving it would strand an unanswered prompt in the transcript.
   *  Returns whether a row flipped. */
  cancelQueuedTurn(queueId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      let cancelled = false;
      this.dbh.durably(db, () => {
        // SAFETY: the projection names only the row's thread + journaled block.
        const row = db
          .prepare(
            `SELECT thread_id, user_block_id FROM queued_turns WHERE queue_id = ? AND state = 'queued'`,
          )
          .get(queueId) as { thread_id: string; user_block_id: string } | undefined;
        if (!row) return;
        const result = db
          .prepare(
            `UPDATE queued_turns SET state = 'cancelled', updated_at = ?
            WHERE queue_id = ? AND state = 'queued'`,
          )
          .run(Date.now(), queueId);
        if (Number(result.changes) === 0) return;
        this.deleteQueuedPromptBlock(db, row.thread_id, row.user_block_id);
        cancelled = true;
      });
      return cancelled;
    } catch (err) {
      console.error("[conversation-store] cancelQueuedTurn failed:", err);
      return false;
    }
  }

  /** Cancel every active queued turn for a thread (stop/delete path). Flips
   *  BOTH active states: a drain racing the cancellation may hold a row in
   *  'promoting'; if only 'queued' flipped, that drain's error path could
   *  `releaseQueuedTurn` the row back to 'queued', resurrecting a turn the
   *  user cancelled. Rows that never started ('queued') take their journaled
   *  prompt with them, exactly like cancelQueuedTurn — a claimed row
   *  ('promoting') may already have a running turn behind it, so its prompt
   *  stays, the same way a single cancel refuses a claimed row. Returns the
   *  cancelled queue ids. */
  cancelQueuedTurnsForThread(threadId: string): string[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      let queueIds: string[] = [];
      this.dbh.durably(db, () => {
        // SAFETY: the projection names only the row's queue id, thread, prior
        // state, and journaled block.
        const active = db
          .prepare(
            `SELECT queue_id, thread_id, user_block_id, state FROM queued_turns
              WHERE thread_id = ? AND state IN ('queued', 'promoting')`,
          )
          .all(threadId) as Array<{
          queue_id: string;
          thread_id: string;
          user_block_id: string;
          state: string;
        }>;
        if (active.length === 0) return;
        db.prepare(
          `UPDATE queued_turns SET state = 'cancelled', updated_at = ?
            WHERE thread_id = ? AND state IN ('queued', 'promoting')`,
        ).run(Date.now(), threadId);
        for (const row of active) {
          // Only 'queued' flips provably never started; a 'promoting' row was
          // claimed by a drain and may own a live turn, so its prompt stays.
          if (row.state !== "queued") continue;
          this.deleteQueuedPromptBlock(db, row.thread_id, row.user_block_id);
        }
        queueIds = active.map((r) => r.queue_id);
      });
      return queueIds;
    } catch (err) {
      console.error("[conversation-store] cancelQueuedTurnsForThread failed:", err);
      return [];
    }
  }

  /** Active queued turns for a thread, in execution order — QUEUED_TURN_ORDER,
   *  the same explicit-first then steer-first-then-FIFO ordering claimNext
   *  uses, so the UI shows exactly what will run next. Settled rows
   *  (promoted/cancelled) are excluded: they are history, not queue. */
  listQueuedTurns(threadId: string): QueuedTurnRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of queued_turns is exactly QueuedTurnDbRow — the
      // columns this schema creates.
      const rows = db
        .prepare(
          `SELECT * FROM queued_turns
            WHERE thread_id = ? AND state IN ('queued', 'promoting')
            ORDER BY ${QUEUED_TURN_ORDER}`,
        )
        .all(threadId) as QueuedTurnDbRow[];
      return rows.map(rowToQueuedTurn);
    } catch (err) {
      console.error("[conversation-store] listQueuedTurns failed:", err);
      return [];
    }
  }
}
