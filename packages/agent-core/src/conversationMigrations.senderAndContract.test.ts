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

describe("migration 16: ThreadContract", () => {
  test("existing threads carry no contract, and the column refuses anything but JSON", () => {
    const { db, file } = v14Database();
    migrate(db, file);
    // SAFETY: one row projecting the TEXT contract_json column.
    const row = db.prepare("SELECT contract_json FROM threads WHERE thread_id = 't-1'").get() as {
      contract_json: string | null;
    };
    expect(row.contract_json).toBeNull();
    expect(() => db.exec(`UPDATE threads SET contract_json = 'not json' WHERE thread_id = 't-1'`)).toThrow(/CHECK/);
    db.close();
  });
});

describe("migration 29: ContractClosed", () => {
  test("every contract on disk reads as open, and the reason takes only delivered or withdrawn", () => {
    const { db, file } = v14Database();
    migrate(db, file);
    // SAFETY: one row projecting the two contract-closed columns.
    const row = db.prepare("SELECT contract_closed_at, contract_closed_reason FROM threads WHERE thread_id = 't-1'").get() as {
      contract_closed_at: number | null;
      contract_closed_reason: string | null;
    };
    expect(row).toEqual({ contract_closed_at: null, contract_closed_reason: null });
    db.exec(`UPDATE threads SET contract_closed_at = 5, contract_closed_reason = 'delivered' WHERE thread_id = 't-1'`);
    expect(() => db.exec(`UPDATE threads SET contract_closed_reason = 'done' WHERE thread_id = 't-1'`)).toThrow(/CHECK/);
    db.close();
  });
});

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
