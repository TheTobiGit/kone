import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import { rowToQueuedTurn, serializeAttachments, serializeSkillReferences, type QueuedTurnDbRow, type QueuedTurnEnqueueInput, type QueuedTurnRow } from "../conversationStoreTypes.js";
import { moveBlockToTail, PENDING_QUEUE_STATES } from "./sql.js";

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

  /** Move a claimed row's user block to the end of its thread's block order, so
   *  the prompt sits immediately before the assistant turn about to be
   *  journaled for it.
   *
   *  This belongs at CLAIM time, not at settle. The service dispatches to the
   *  provider first — and the adapter emits turn.started from inside sendTurn,
   *  which journals the assistant block — settling the row only afterwards. A
   *  re-sequencing done at settle therefore lands the prompt AFTER its own
   *  reply, which is the order the transcript reads in until the thread is
   *  reloaded. A claimed row is committed to run next (one live turn per
   *  thread, deliveries serialized), so claiming is the last moment the block
   *  is still free to move. `at` is left alone — it stays the original send
   *  instant, which is the user-visible time.
   *
   *  A delivery that fails after this releases the row back to 'queued', where
   *  the block is hidden from the timeline anyway and the next claim moves it
   *  again; no undo is needed. */
  private moveBlockToTail(threadId: string, blockId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    moveBlockToTail(db, threadId, blockId);
  }

  // A follow-up sent while a turn runs is durably enqueued here, claimed by
  // the service layer when the live turn settles, and cancelled when the
  // thread is deleted. Lifecycle: 'queued' → 'promoting' → 'promoted'
  // (claim → promote), 'promoting' → 'queued' (claim → release: the drain
  // failed and the turn must not be lost), 'promoting' → 'failed' (released
  // as held once its retries ran out), and any pending state → 'cancelled'
  // (stop/delete). Only the PENDING states (PENDING_QUEUE_STATES) count: a
  // settled row (promoted/cancelled) is inert history, and a later
  // releaseClaim must never match a cancelled row — that resurrection bug is
  // why cancel flips every pending state.

  /** Durably enqueue a turn for `threadId`. The partial unique index on
   *  (thread_id, user_block_id) over the pending states makes a replayed
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
             attachments_json, skills_json, model, mode, effort, service_tier, context_window,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (thread_id, user_block_id)
             WHERE state IN ${PENDING_QUEUE_STATES} DO NOTHING`,
        )
        .run(
          input.queueId,
          input.threadId,
          input.userBlockId,
          input.dispatchMode ?? "queue",
          input.input,
          serializeAttachments(input.attachments),
          serializeSkillReferences(input.skills),
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
   *  arbitrarily instead of by arrival. A held ('failed') row pauses what
   *  runs after it: the candidate is the first waiting-or-held row in run
   *  order, and it is only claimed when it is waiting. Rows ahead of a held
   *  one (a Send now moved them there) still run. Returns the row now in
   *  'promoting' (attempt_count already bumped), or null when the thread has
   *  nothing to claim. */
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

      let queued: QueuedTurnRow | null = null;
      // One transaction: a claim whose block could not move is no claim, so
      // the row is not left 'promoting' with nobody delivering it.
      this.dbh.atomically(db, () => {
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
                 WHERE thread_id = ? AND state IN ('queued', 'failed')
                 ORDER BY ${QUEUED_TURN_ORDER}
                 LIMIT 1
              )
                AND state = 'queued'
             RETURNING *`,
          )
          .get(now, threadId) as QueuedTurnDbRow | undefined;
        if (!row) return;
        const claimed = rowToQueuedTurn(row);
        // Ahead of the dispatch that journals this row's assistant turn, never
        // behind it — see moveBlockToTail.
        if (claimed.userBlockId) this.moveBlockToTail(threadId, claimed.userBlockId);
        queued = claimed;
      });
      return queued;
    } catch (err) {
      console.error("[conversation-store] claimNextQueuedTurn failed:", err);
      return null;
    }
  }

  /** Claim one named row for an immediate send (the strip's "Send now"),
   *  whether it is waiting or held. Same flip as claimNext — 'promoting',
   *  attempt_count bumped — so a drain can't take it meanwhile and a single
   *  cancel refuses it. `from` is the state it left, which is the state a
   *  failed send puts it back in. Null when the row is not waiting or held
   *  (already claimed, promoted or cancelled). */
  claimQueuedTurn(queueId: string): { row: QueuedTurnRow; from: "queued" | "failed" } | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      let claimed: { row: QueuedTurnRow; from: "queued" | "failed" } | null = null;
      this.dbh.durably(db, () => this.dbh.atomically(db, () => {
        // SAFETY: the projection names only the row's state column.
        const prior = db
          .prepare(`SELECT state FROM queued_turns WHERE queue_id = ? AND state IN ('queued', 'failed')`)
          .get(queueId) as { state: "queued" | "failed" } | undefined;
        if (!prior) return;
        // SAFETY: RETURNING * of queued_turns is exactly QueuedTurnDbRow.
        const row = db
          .prepare(
            `UPDATE queued_turns
                SET state = 'promoting', attempt_count = attempt_count + 1, updated_at = ?
              WHERE queue_id = ? AND state = ?
             RETURNING *`,
          )
          .get(Date.now(), queueId, prior.state) as QueuedTurnDbRow | undefined;
        if (row) {
          const queued = rowToQueuedTurn(row);
          // Same placement as the drain's claim — see moveBlockToTail.
          if (queued.userBlockId) this.moveBlockToTail(row.thread_id, queued.userBlockId);
          claimed = { row: queued, from: prior.state };
        }
      }));
      return claimed;
    } catch (err) {
      console.error("[conversation-store] claimQueuedTurn failed:", err);
      return null;
    }
  }

  /** Whether a claim on this row still stands — still 'promoting', not
   *  cancelled by a stop or delete since it was taken. A claimant checks this
   *  last thing before handing the row to a provider. */
  isQueuedTurnClaimed(queueId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      return (
        db.prepare(`SELECT 1 FROM queued_turns WHERE queue_id = ? AND state = 'promoting'`).get(queueId) !==
        undefined
      );
    } catch (err) {
      console.error("[conversation-store] isQueuedTurnClaimed failed:", err);
      return false;
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
        // No block re-sequencing here: the prompt was placed ahead of its turn
        // when the row was claimed, which is the only moment it still could be
        // (see moveBlockToTail). By now the assistant block is journaled.
      });
      return promoted;
    } catch (err) {
      console.error("[conversation-store] markQueuedTurnPromoted failed:", err);
      return false;
    }
  }

  /** Give a claimed turn back: 'promoting' → 'queued' so a later drain
   *  retries it, or → 'failed' to hold it for the user once its retries ran
   *  out. attempt_count is preserved (the retry ledger stays honest).
   *  Returns false when the row is not in 'promoting' — the cancelled-row
   *  resurrection guard: cancelQueuedTurnsForThread flips 'promoting' rows to
   *  'cancelled' first, so a drain's late release can no longer match. */
  releaseQueuedTurn(queueId: string, to: "queued" | "failed" = "queued"): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(
          `UPDATE queued_turns SET state = ?, updated_at = ?
            WHERE queue_id = ? AND state = 'promoting'`,
        )
        .run(to, Date.now(), queueId);
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
              WHERE thread_id = ? AND state IN ${PENDING_QUEUE_STATES}
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
            WHERE thread_id = ? AND queue_id = ? AND state IN ${PENDING_QUEUE_STATES}`,
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
   *  WAITING (or held after its retries ran out) can flip: 'promoting' means a drain has already claimed it and
   *  handed it to the adapter, so flipping it would report a cancellation for
   *  a turn that is running — the strip row would vanish,
   *  turn.queued-cancelled would go out with reason "user", and the agent
   *  would answer the message anyway. Losing the race is the honest answer
   *  (false); the row promotes and the running turn replaces it in the strip. The stop/delete path keeps
   *  cancelling 'promoting' rows on purpose — see cancelQueuedTurnsForThread,
   *  where the session is being torn down regardless. A successful flip also
   *  removes the row's journaled prompt: only 'queued'/'failed' flip here, so the turn
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
            `SELECT thread_id, user_block_id FROM queued_turns WHERE queue_id = ? AND state IN ('queued', 'failed')`,
          )
          .get(queueId) as { thread_id: string; user_block_id: string } | undefined;
        if (!row) return;
        const result = db
          .prepare(
            `UPDATE queued_turns SET state = 'cancelled', updated_at = ?
            WHERE queue_id = ? AND state IN ('queued', 'failed')`,
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

  /** Cancel every pending queued turn for a thread (stop/delete path). Flips
   *  every pending state: a drain racing the cancellation may hold a row in
   *  'promoting'; if only 'queued' flipped, that drain's error path could
   *  `releaseQueuedTurn` the row back to 'queued', resurrecting a turn the
   *  user cancelled. Rows that never started ('queued'/'failed') take their
   *  journaled prompt with them, exactly like cancelQueuedTurn — a claimed row
   *  ('promoting') may already have a running turn behind it, so its prompt
   *  stays, the same way a single cancel refuses a claimed row. Returns the
   *  cancelled queue ids, in queue order. */
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
              WHERE thread_id = ? AND state IN ${PENDING_QUEUE_STATES}
              ORDER BY ${QUEUED_TURN_ORDER}`,
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
            WHERE thread_id = ? AND state IN ${PENDING_QUEUE_STATES}`,
        ).run(Date.now(), threadId);
        for (const row of active) {
          // Only 'queued'/'failed' rows provably never started; a 'promoting'
          // row was claimed by a drain and may own a live turn, so its prompt
          // stays.
          if (row.state === "promoting") continue;
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

  /** Pending queued turns for a thread, in execution order — QUEUED_TURN_ORDER,
   *  the same explicit-first then steer-first-then-FIFO ordering claimNext
   *  uses, so the UI shows exactly what will run next. Held ('failed') rows
   *  are listed in their place: they are still the user's unsent messages.
   *  Settled rows (promoted/cancelled) are excluded: they are history, not
   *  queue. */
  listQueuedTurns(threadId: string): QueuedTurnRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of queued_turns is exactly QueuedTurnDbRow — the
      // columns this schema creates — plus its block's sender columns.
      // Who wrote each row is read from its block, which is durable and hidden
      // from the transcript while the row waits.
      const rows = db
        .prepare(
          `SELECT queued_turns.*,
                  (SELECT b.sender_json FROM blocks b
                    WHERE b.thread_id = queued_turns.thread_id AND b.block_id = queued_turns.user_block_id) AS sender_json,
                  EXISTS (SELECT 1 FROM blocks b
                    WHERE b.thread_id = queued_turns.thread_id AND b.block_id = queued_turns.user_block_id) AS has_block
             FROM queued_turns
            WHERE thread_id = ? AND state IN ${PENDING_QUEUE_STATES}
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
