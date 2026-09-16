import type { ConversationDb } from "./ConversationDb.js";
import {
  rowToTurnCheckpoint,
  type TurnCheckpointDbRow,
  type TurnCheckpointRecord,
} from "../conversationStoreTypes.js";

export class TurnCheckpointRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // One pre-turn repository snapshot per turn: the checkpoint ref holding the
  // tree as it was before the turn ran. The composite primary key makes a
  // second record for the same turn a no-op — by then the agent has already
  // modified the tree, so a fresh snapshot would no longer be the pre-turn
  // state and must not clobber the first. Rows die with their thread.

  /** Record a turn's checkpoint, keeping the first write on conflict. Returns
   *  whether a row was actually inserted — false means this turn already has
   *  a checkpoint and the existing one stands. */
  recordTurnCheckpoint(input: {
    threadId: string;
    turnId: string;
    checkpointId: string;
    ref: string;
    createdAt?: number;
  }): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      let inserted = false;
      this.dbh.durably(db, () => {
        const result = db
          .prepare(
            `INSERT INTO turn_checkpoints (thread_id, turn_id, checkpoint_id, ref, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (thread_id, turn_id) DO NOTHING`,
          )
          .run(
            input.threadId,
            input.turnId,
            input.checkpointId,
            input.ref,
            input.createdAt ?? Date.now(),
          );
        inserted = Number(result.changes) > 0;
      });
      return inserted;
    } catch (err) {
      console.error("[conversation-store] recordTurnCheckpoint failed:", err);
      return false;
    }
  }

  /** The checkpoint recorded for one turn, or null when the turn has none
   *  (non-repo thread, or capture degraded on a git error). */
  getTurnCheckpoint(threadId: string, turnId: string): TurnCheckpointRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of turn_checkpoints is exactly TurnCheckpointDbRow —
      // the columns this schema creates.
      const row = db
        .prepare(`SELECT * FROM turn_checkpoints WHERE thread_id = ? AND turn_id = ?`)
        .get(threadId, turnId) as TurnCheckpointDbRow | undefined;
      return row ? rowToTurnCheckpoint(row) : null;
    } catch (err) {
      console.error("[conversation-store] getTurnCheckpoint failed:", err);
      return null;
    }
  }

  /** Every checkpoint recorded for a thread, oldest first — the order a
   *  revert picker walks. */
  listTurnCheckpoints(threadId: string): TurnCheckpointRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of turn_checkpoints is exactly TurnCheckpointDbRow —
      // the columns this schema creates.
      const rows = db
        .prepare(
          `SELECT * FROM turn_checkpoints
            WHERE thread_id = ?
            ORDER BY created_at ASC, rowid ASC`,
        )
        .all(threadId) as TurnCheckpointDbRow[];
      return rows.map(rowToTurnCheckpoint);
    } catch (err) {
      console.error("[conversation-store] listTurnCheckpoints failed:", err);
      return [];
    }
  }

  /** Drop one turn's checkpoint row. Returns the dropped row so the caller
   *  can delete the git ref alongside it — the ref and the row are freed
   *  together, never one without the other. */
  deleteTurnCheckpoint(threadId: string, turnId: string): TurnCheckpointRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      let dropped: TurnCheckpointRecord | null = null;
      this.dbh.durably(db, () => {
        // SAFETY: `SELECT *` of turn_checkpoints is exactly TurnCheckpointDbRow —
        // the columns this schema creates.
        const row = db
          .prepare(`SELECT * FROM turn_checkpoints WHERE thread_id = ? AND turn_id = ?`)
          .get(threadId, turnId) as TurnCheckpointDbRow | undefined;
        if (!row) return;
        db.prepare(
          `DELETE FROM turn_checkpoints WHERE thread_id = ? AND turn_id = ?`,
        ).run(threadId, turnId);
        dropped = rowToTurnCheckpoint(row);
      });
      return dropped;
    } catch (err) {
      console.error("[conversation-store] deleteTurnCheckpoint failed:", err);
      return null;
    }
  }

  /** Keep only the newest `keep` checkpoints for a thread, dropping the
   *  oldest rows first. Returns the evicted rows so the caller can delete
   *  their git refs alongside them. */
  pruneTurnCheckpoints(threadId: string, keep: number): TurnCheckpointRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      let evicted: TurnCheckpointRecord[] = [];
      this.dbh.durably(db, () => {
        // SAFETY: `SELECT *` of turn_checkpoints is exactly TurnCheckpointDbRow —
        // the columns this schema creates.
        const rows = db
          .prepare(
            `SELECT * FROM turn_checkpoints
              WHERE thread_id = ?
              ORDER BY created_at ASC, rowid ASC`,
          )
          .all(threadId) as TurnCheckpointDbRow[];
        if (rows.length <= keep) return;
        const stale = rows.slice(0, rows.length - keep);
        const stmt = db.prepare(
          `DELETE FROM turn_checkpoints WHERE thread_id = ? AND turn_id = ?`,
        );
        for (const row of stale) {
          stmt.run(threadId, row.turn_id);
        }
        evicted = stale.map(rowToTurnCheckpoint);
      });
      return evicted;
    } catch (err) {
      console.error("[conversation-store] pruneTurnCheckpoints failed:", err);
      return [];
    }
  }
}
