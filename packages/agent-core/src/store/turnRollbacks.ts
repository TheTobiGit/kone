import type { ConversationDb } from "./ConversationDb.js";

// Turns whose work a file revert discarded.
//
// A file revert to turn N's checkpoint restores the working tree to before N
// ran, so it rolls back N and every later turn of the thread — not only N.
// The revert itself lives in AgentService (Phase 2); this repo only records
// the fact, so a fork can refuse to start from a turn that no longer stands.
// The stamp is write-once per turn (the first rollback is the truth) and rows
// die with their thread.

export class TurnRollbackRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Stamp `fromTurnId` and every later turn of the thread as rolled back, in
   *  arrival order. Returns the stamped turn ids (empty when the boundary turn
   *  has no blocks, or the write fails). A turn with no blocks cannot be
   *  located, so there is nothing to roll back. */
  markTurnsRolledBack(threadId: string, fromTurnId: string, at = Date.now()): string[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // The boundary is the first block of the rolled-back turn; every block
      // at or after it belongs to that turn or a later one.
      // SAFETY: the projection names one aggregate over blocks.seq (INTEGER).
      const boundary = db
        .prepare(`SELECT MIN(seq) AS seq FROM blocks WHERE thread_id = ? AND turn_id = ?`)
        .get(threadId, fromTurnId) as { seq: number | null } | undefined;
      if (boundary?.seq == null) return [];
      // SAFETY: the projection names blocks.turn_id (TEXT, nullable), filtered
      // to the blocks at or after the boundary.
      const rows = db
        .prepare(
          `SELECT DISTINCT turn_id FROM blocks
            WHERE thread_id = ? AND seq >= ? AND turn_id IS NOT NULL
            ORDER BY seq`,
        )
        .all(threadId, boundary.seq) as Array<{ turn_id: string }>;
      const turnIds = rows.map((row) => row.turn_id);
      if (turnIds.length === 0) return [];
      this.dbh.durably(db, () => {
        const stmt = db.prepare(
          `INSERT INTO turn_rollbacks (thread_id, turn_id, rolled_back_at)
           VALUES (?, ?, ?)
           ON CONFLICT (thread_id, turn_id) DO UPDATE SET rolled_back_at = excluded.rolled_back_at`,
        );
        for (const turnId of turnIds) stmt.run(threadId, turnId, at);
      });
      return turnIds;
    } catch (err) {
      console.error("[conversation-store] markTurnsRolledBack failed:", err);
      return [];
    }
  }

  /** Every turn of the thread stamped rolled back. */
  rolledBackTurnIds(threadId: string): Set<string> {
    const db = this.dbh.handle();
    if (!db) return new Set();
    try {
      // SAFETY: the projection names turn_rollbacks.turn_id only.
      const rows = db
        .prepare(`SELECT turn_id FROM turn_rollbacks WHERE thread_id = ?`)
        .all(threadId) as Array<{ turn_id: string }>;
      return new Set(rows.map((row) => row.turn_id));
    } catch (err) {
      console.error("[conversation-store] rolledBackTurnIds failed:", err);
      return new Set();
    }
  }

  /** Whether one turn was rolled back. */
  isTurnRolledBack(threadId: string, turnId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      return (
        db
          .prepare(`SELECT 1 FROM turn_rollbacks WHERE thread_id = ? AND turn_id = ?`)
          .get(threadId, turnId) != null
      );
    } catch (err) {
      console.error("[conversation-store] isTurnRolledBack failed:", err);
      return false;
    }
  }
}
