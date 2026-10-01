import type { ConversationDb } from "./ConversationDb.js";
import type { ColumnValue } from "../rosterRecord.js";
import {
  defaultModelPreferences,
  normalizeModelPreferences,
  type ModelPreference,
} from "../modelPreference.js";

/** The user's model preferences by kind of work, kept as one JSON document in
 *  app_state for the same reason the native preset config is: the list is
 *  small, read whole by every consumer, and written whole by its one editor. */
export class ModelPreferenceRepo {
  private static readonly KEY = "model_preferences";

  constructor(private readonly dbh: ConversationDb) {}

  /** The saved list, or the suggested kinds with no models when nothing was
   *  ever saved. Never throws: a corrupt document reads as the suggestions —
   *  every kind dormant, so every spawn runs where its caller runs, as before
   *  the feature. */
  listModelPreferences(): ModelPreference[] {
    const db = this.dbh.handle();
    if (!db) return defaultModelPreferences();
    try {
      // SAFETY: app_state holds at most one row for this key, one TEXT column.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = ?`)
        .get(ModelPreferenceRepo.KEY) as { value: string } | undefined;
      if (!row?.value) return defaultModelPreferences();
      // SAFETY: disk content is untrusted — parse to the column-value shape
      // and let the normalizer decide what survives.
      const parsed = JSON.parse(row.value) as ColumnValue;
      return Array.isArray(parsed) ? normalizeModelPreferences(parsed) : defaultModelPreferences();
    } catch (err) {
      console.error("[conversation-store] listModelPreferences failed:", err);
      return defaultModelPreferences();
    }
  }

  /** Replace the whole list, in the order given. Returns what was stored — the
   *  submitted list through the normalizer — or null when the write failed. An
   *  empty list is a real answer (the user removed every kind) and is kept. */
  saveModelPreferences(list: readonly ColumnValue[]): ModelPreference[] | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const clean = normalizeModelPreferences(list);
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(ModelPreferenceRepo.KEY, JSON.stringify(clean), Date.now());
      return clean;
    } catch (err) {
      console.error("[conversation-store] saveModelPreferences failed:", err);
      return null;
    }
  }
}
