import type { ConversationDb } from "./ConversationDb.js";
import { rowToScratchpad, type ScratchpadRecord, type ScratchpadRow } from "../conversationStoreTypes.js";

export class ScratchpadRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // ── scratchpads ───────────────────────────────────────────────────────────

  listScratchpads(projectPath: string): ScratchpadRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list ScratchpadRow is declared
      // from.
      const rows = db
        .prepare(
          `SELECT id, project_path, title, body, created_at, updated_at, sort_index, revision
             FROM scratchpads
            WHERE project_path = ?
            ORDER BY sort_index ASC, created_at ASC`,
        )
        .all(projectPath) as ScratchpadRow[];
      return rows.map(rowToScratchpad);
    } catch (err) {
      console.error("[conversation-store] listScratchpads failed:", err);
      return [];
    }
  }

  /** Read one pad by id, or null when it doesn't exist. */
  getScratchpad(padId: string): ScratchpadRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: same column list keyed on the primary key, so at most one row
      // of exactly that shape.
      const row = db
        .prepare(
          `SELECT id, project_path, title, body, created_at, updated_at, sort_index, revision
             FROM scratchpads WHERE id = ?`,
        )
        .get(padId) as ScratchpadRow | undefined;
      return row ? rowToScratchpad(row) : null;
    } catch (err) {
      console.error("[conversation-store] getScratchpad failed:", err);
      return null;
    }
  }

  /** Upsert a pad. `expectedRevision` is an optimistic lock: when given and it
   *  doesn't match the row's current revision the write is refused and the
   *  current revision returned — the caller (the gateway tool) surfaces it as a
   *  `revision_conflict` so the agent can re-send against fresh state. Omitting
   *  it overwrites unconditionally (the web editor's first save of a pad it
   *  just created). `append: true` merges server-side (current body + "\n\n" +
   *  new body) so agent appends race nothing — the merge and the revision bump
   *  happen in the same statement sequence. Every write bumps `revision`. */
  saveScratchpad(input: {
    padId: string;
    projectPath: string;
    title: string;
    body: string;
    expectedRevision?: number;
    append?: boolean;
  }): { savedAt: number; revision: number } | { conflict: number } | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const savedAt = Date.now();
    try {
      // SAFETY: four named columns of scratchpads — timestamps and counters
      // are NOT NULL, body is the written TEXT.
      const existing = db
        .prepare(
          `SELECT created_at, sort_index, revision, body FROM scratchpads WHERE id = ?`,
        )
        .get(input.padId) as
        | { created_at: number; sort_index: number; revision: number; body: string }
        | undefined;
      if (
        existing &&
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) {
        return { conflict: existing.revision };
      }
      // SAFETY: a COALESCE'd MAX aggregate aliased to next, as the roster's.
      const sortIndex =
        existing?.sort_index ??
        ((db
          .prepare(
            `SELECT COALESCE(MAX(sort_index), -1) + 1 AS next
               FROM scratchpads WHERE project_path = ?`,
          )
          .get(input.projectPath) as { next: number }).next ?? 0);
      const revision = existing ? existing.revision + 1 : 1;
      const body =
        input.append && existing && existing.body.trim()
          ? `${existing.body}\n\n${input.body}`
          : input.body;
      db.prepare(
        `INSERT INTO scratchpads (id, project_path, title, body, created_at, updated_at, sort_index, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           updated_at = excluded.updated_at,
           revision = excluded.revision`,
      ).run(
        input.padId,
        input.projectPath,
        input.title,
        body,
        existing?.created_at ?? savedAt,
        savedAt,
        sortIndex,
        revision,
      );
      return { savedAt, revision };
    } catch (err) {
      console.error("[conversation-store] saveScratchpad failed:", err);
      return null;
    }
  }

  deleteScratchpad(padId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`DELETE FROM scratchpads WHERE id = ?`).run(padId);
    } catch (err) {
      console.error("[conversation-store] deleteScratchpad failed:", err);
    }
  }
}
