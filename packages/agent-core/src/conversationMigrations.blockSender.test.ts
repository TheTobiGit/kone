import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "./conversationMigrations.js";

// Migration 15 adds `blocks.sender_json`. Every row already on disk was typed
// by a person, so the upgrade must leave them all reading as the user (NULL),
// and the column must refuse anything that isn't JSON.

function v14Database() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-migration-sender-"));
  const file = path.join(dir, "kone.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, file, { toMigrationInclusive: 14 });
  db.exec(`
    INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
      VALUES ('t-1', '/p', 'codex', 1, 1);
    INSERT INTO blocks (block_id, thread_id, role, text, at)
      VALUES ('b-1', 't-1', 'user', 'hello', 1);
  `);
  return { db, file };
}

describe("migration 15: BlockSender", () => {
  test("existing prompts keep reading as the user", () => {
    const { db, file } = v14Database();
    migrate(db, file);
    // SAFETY: one row projecting the TEXT sender_json column.
    const row = db.prepare("SELECT sender_json FROM blocks WHERE block_id = 'b-1'").get() as {
      sender_json: string | null;
    };
    expect(row.sender_json).toBeNull();
    db.close();
  });

  test("the column takes a JSON sender and refuses anything else", () => {
    const { db, file } = v14Database();
    migrate(db, file);
    db.exec(`INSERT INTO blocks (block_id, thread_id, role, text, at, sender_json)
             VALUES ('b-2', 't-1', 'user', 'brief', 2, '{"kind":"agent","threadId":"t-0","relationship":"parent"}')`);
    expect(() =>
      db.exec(`INSERT INTO blocks (block_id, thread_id, role, text, at, sender_json)
               VALUES ('b-3', 't-1', 'user', 'x', 3, 'not json')`),
    ).toThrow(/CHECK/);
    db.close();
  });
});
