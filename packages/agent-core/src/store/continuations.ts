import { randomUUID } from "node:crypto";

import type { ConversationDb } from "./ConversationDb.js";

// Durable scheduled continuations: work the app owes a thread at or after a
// time — resume a chat cut by a quit, resume at a usage-limit reset. The row
// outlives the process, so a continuation due while the app is down is
// recovered at the next boot instead of being lost. Claiming is a single write
// (`claimed_at`), so two boots or a boot and a timer can never both run one.

export type ContinuationDbRow = {
  continuation_id: string;
  thread_id: string;
  kind: string;
  due_at: number;
  payload_json: string | null;
  created_at: number;
  claimed_at: number | null;
  attempts: number;
};

export type ContinuationRecord = {
  continuationId: string;
  threadId: string;
  /** Free text; Phase 3 adds `limit-reset` beside `quit-resume`. */
  kind: string;
  dueAt: number;
  payloadJson: string | null;
  createdAt: number;
  claimedAt: number | null;
  /** Failed dispatch attempts so far; the sweep backs off and then drops. */
  attempts: number;
};

export function rowToContinuation(row: ContinuationDbRow): ContinuationRecord {
  return {
    continuationId: row.continuation_id,
    threadId: row.thread_id,
    kind: row.kind,
    dueAt: row.due_at,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    attempts: row.attempts,
  };
}

export class ContinuationRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Record a continuation due at `dueAt`. Returns the stored row, or null when
   *  the store is unavailable or the thread is unknown (the FK refuses it). */
  schedule(input: {
    threadId: string;
    kind: string;
    dueAt: number;
    payloadJson?: string | null;
    continuationId?: string;
    createdAt?: number;
  }): ContinuationRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const row: ContinuationDbRow = {
      continuation_id: input.continuationId ?? randomUUID(),
      thread_id: input.threadId,
      kind: input.kind,
      due_at: input.dueAt,
      payload_json: input.payloadJson ?? null,
      created_at: input.createdAt ?? Date.now(),
      claimed_at: null,
      attempts: 0,
    };
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `INSERT INTO continuations
             (continuation_id, thread_id, kind, due_at, payload_json, created_at, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          row.continuation_id,
          row.thread_id,
          row.kind,
          row.due_at,
          row.payload_json,
          row.created_at,
        );
      });
      return rowToContinuation(row);
    } catch (err) {
      console.error("[conversation-store] scheduleContinuation failed:", err);
      return null;
    }
  }

  /** Take every unclaimed continuation due at or before `now`, marking it
   *  claimed in the same statement. Atomic: a second caller sees the rows
   *  already claimed and gets none. */
  claimDue(now: number): ContinuationRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      let claimed: ContinuationRecord[] = [];
      this.dbh.durably(db, () => {
        // SAFETY: RETURNING * of continuations is exactly ContinuationDbRow —
        // the columns this schema creates.
        const rows = db
          .prepare(
            `UPDATE continuations SET claimed_at = ?
              WHERE claimed_at IS NULL AND due_at <= ?
              RETURNING *`,
          )
          .all(now, now) as ContinuationDbRow[];
        claimed = rows.map(rowToContinuation);
      });
      return claimed;
    } catch (err) {
      console.error("[conversation-store] claimDueContinuations failed:", err);
      return [];
    }
  }

  /** Boot recovery: no dispatcher is live on a fresh process, so every claim
   *  belongs to a boot that died before settling it. Release them all so their
   *  continuations become due again. */
  releaseOrphanedClaims(): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () => {
        db.prepare(`UPDATE continuations SET claimed_at = NULL WHERE claimed_at IS NOT NULL`).run();
      });
    } catch (err) {
      console.error("[conversation-store] releaseOrphanedContinuationClaims failed:", err);
    }
  }

  /** Record a failed dispatch: bump the attempt count, clear the claim, and
   *  push the due time out by the caller's backoff. Returns the new attempt
   *  count, so the caller can drop the row once it passes a cap. */
  fail(continuationId: string, nextDueAt: number): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      let attempts = 0;
      this.dbh.durably(db, () => {
        // SAFETY: RETURNING attempts names one INTEGER column.
        const row = db
          .prepare(
            `UPDATE continuations SET attempts = attempts + 1, claimed_at = NULL, due_at = ?
              WHERE continuation_id = ? RETURNING attempts`,
          )
          .get(nextDueAt, continuationId) as { attempts: number } | undefined;
        attempts = row?.attempts ?? 0;
      });
      return attempts;
    } catch (err) {
      console.error("[conversation-store] failContinuation failed:", err);
      return 0;
    }
  }

  /** Put a claimed continuation back for a later attempt, after a dispatch
   *  threw. */
  clearClaim(continuationId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () => {
        db.prepare(`UPDATE continuations SET claimed_at = NULL WHERE continuation_id = ?`).run(
          continuationId,
        );
      });    } catch (err) {
      console.error("[conversation-store] clearContinuationClaim failed:", err);
    }
  }

  /** Consume a continuation that was dispatched. */
  deleteContinuation(continuationId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () => {
        db.prepare(`DELETE FROM continuations WHERE continuation_id = ?`).run(continuationId);
      });
    } catch (err) {
      console.error("[conversation-store] deleteContinuation failed:", err);
    }
  }

  /** Drop a thread's continuations — new work, archive or settle makes them
   *  stale. This includes a claimed-but-not-yet-dispatched row: a sweep that
   *  has claimed one re-reads it before sending, so deleting it here stops the
   *  send. Returns how many were dropped. */
  cancelForThread(threadId: string): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      let dropped = 0;
      this.dbh.durably(db, () => {
        const result = db
          .prepare(`DELETE FROM continuations WHERE thread_id = ?`)
          .run(threadId);
        dropped = Number(result.changes);
      });
      return dropped;
    } catch (err) {
      console.error("[conversation-store] cancelContinuationsForThread failed:", err);
      return 0;
    }
  }

  /** One continuation by id, or null when it is gone (cancelled, consumed or
   *  never there). A sweep re-reads the row it claimed immediately before
   *  dispatching, so a cancellation during session adoption is seen. */
  getContinuation(continuationId: string): ContinuationRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: SELECT * of continuations is exactly ContinuationDbRow.
      const row = db
        .prepare(`SELECT * FROM continuations WHERE continuation_id = ?`)
        .get(continuationId) as ContinuationDbRow | undefined;
      return row ? rowToContinuation(row) : null;
    } catch (err) {
      console.error("[conversation-store] getContinuation failed:", err);
      return null;
    }
  }

  /** When the next unclaimed continuation is due, or null when none is. */
  nextDueAt(): number | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: MIN() over the due_at column answers one nullable integer.
      const row = db
        .prepare(`SELECT MIN(due_at) AS due_at FROM continuations WHERE claimed_at IS NULL`)
        .get() as { due_at: number | null } | undefined;
      return row?.due_at ?? null;
    } catch (err) {
      console.error("[conversation-store] nextContinuationDueAt failed:", err);
      return null;
    }
  }

  /** Every continuation for a thread, oldest first — reads for tests and for a
   *  caller inspecting what is scheduled. */
  listForThread(threadId: string): ContinuationRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: SELECT * of continuations is exactly ContinuationDbRow.
      const rows = db
        .prepare(`SELECT * FROM continuations WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`)
        .all(threadId) as ContinuationDbRow[];
      return rows.map(rowToContinuation);
    } catch (err) {
      console.error("[conversation-store] listContinuationsForThread failed:", err);
      return [];
    }
  }
}
