import type { ConversationDb } from "./ConversationDb.js";
import { type StoredStudioLayout } from "../conversationStoreTypes.js";

export class StudioRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // ── studio layout ───────────────────────────────────────────────────────────

  /** Read the studio plane. Never throws: a corrupt JSON blob or an
   *  unrecognised shape returns `null` so the app still opens on an empty
   *  plane. Hard structural validation of the rows and their panes is the
   *  renderer's job — this checks only that the document is the shape
   *  this build knows how to hand over. */
  loadStudio(): StoredStudioLayout | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: app_state holds at most one row for key 'studio_layout'.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = 'studio_layout'`)
        .get() as { value: string } | undefined;
      if (!row?.value) return null;
      // SAFETY: value is untrusted disk content — parse to unknown first and
      // let the checks below decide.
      const parsed = JSON.parse(row.value) as unknown;
      // SAFETY: probing two fields of unknown needs the object view; these
      // checks are themselves the validation gate.
      if (
        !parsed ||
        !(parsed instanceof Object) ||
        (parsed as { version?: unknown }).version !== 2 ||
        !Array.isArray((parsed as { rows?: unknown }).rows)
      ) {
        return null;
      }
      // SAFETY: version === 2 and the row array were just verified; deeper
      // per-row and per-pane structure is validated downstream by the renderer.
      return parsed as StoredStudioLayout;
    } catch (err) {
      console.error("[conversation-store] loadStudio failed:", err);
      return null;
    }
  }

  saveStudio(layout: StoredStudioLayout): { savedAt: number } | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const savedAt = Date.now();
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ('studio_layout', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(JSON.stringify(layout), savedAt);
      return { savedAt };
    } catch (err) {
      console.error("[conversation-store] saveStudio failed:", err);
      return null;
    }
  }
}
