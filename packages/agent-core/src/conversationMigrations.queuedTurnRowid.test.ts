import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "./conversationMigrations.js";

test("migration 27 preserves queue rows, rowids and indexes, and never reuses a deleted id after reopen", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "kone-queue-rowid-")), "kone.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, file, { toMigrationInclusive: 26 });
  db.exec(`
    INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
      VALUES ('t', '/repo', 'codex', 1, 1);
    INSERT INTO queued_turns (rowid, queue_id, thread_id, user_block_id, dispatch_mode, state, input,
                              attachments_json, skills_json, model, mode, effort, service_tier, context_window,
                              attempt_count, created_at, updated_at, promoted_at, sort_key)
      VALUES (8, 'held', 't', 'ub-held', 'queue', 'failed', 'held prompt', '[]', '[]', 'model', 'ask', 'high',
              'fast', 'large', 3, 100, 200, NULL, 1),
             (42, 'done', 't', 'ub-done', 'steer', 'promoted', 'done prompt', NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, 1, 100, 200, 150, 0);
    INSERT INTO queued_turns (rowid, queue_id, thread_id, user_block_id, dispatch_mode, state, input, created_at, updated_at)
      VALUES (17, NULL, 't', 'ub-legacy', 'queue', 'cancelled', 'legacy prompt', 100, 200);
  `);
  const before = db.prepare("SELECT rowid, * FROM queued_turns ORDER BY rowid").all();
  // SAFETY: the projection selects the TEXT index name and non-null SQL definition.
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queued_turns' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string; sql: string }>;
  migrate(db, file);
  expect(db.prepare("SELECT rowid, * FROM queued_turns ORDER BY rowid").all()).toEqual(before);
  // SAFETY: the same index projection is read after rebuilding the table.
  const rebuiltIndexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queued_turns' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string; sql: string }>;
  const normalizeIndexes = (rows: Array<{ name: string; sql: string }>) => rows.map((row) => ({ name: row.name, sql: row.sql.replace(/\s+/g, " ") }));
  expect(normalizeIndexes(rebuiltIndexes)).toEqual(normalizeIndexes(indexes));
  expect(() => db.exec(`INSERT INTO queued_turns (queue_id, thread_id, user_block_id, dispatch_mode, state, input, created_at, updated_at)
                       VALUES ('duplicate', 't', 'ub-held', 'queue', 'queued', 'copy', 300, 300)`)).toThrow(/UNIQUE/);
  db.exec("DELETE FROM queued_turns WHERE rowid = 42");
  db.close();
  const reopened = new Database(file);
  const inserted = reopened.prepare(`INSERT INTO queued_turns (queue_id, thread_id, user_block_id, dispatch_mode, state, input, created_at, updated_at)
                                     VALUES ('new', 't', 'ub-new', 'queue', 'queued', 'new prompt', 300, 300)`).run();
  expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(42);
  reopened.exec("PRAGMA foreign_keys = ON");
  reopened.exec("DELETE FROM threads WHERE thread_id = 't'");
  expect(reopened.prepare("SELECT * FROM queued_turns").all()).toEqual([]);
  reopened.close();
});
