import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "./conversationMigrations.js";

// Migration 22 adds the agent inbox. Nothing is backfilled: mail held in
// memory before the upgrade went with the process that held it.

function v21Database() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-migration-inbox-"));
  const file = path.join(dir, "kone.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, file, { toMigrationInclusive: 21 });
  db.exec(`
    INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
      VALUES ('t-1', '/p', 'codex', 1, 1);
  `);
  return { db, file };
}

function insert(db: Database, over: Record<string, string> = {}): void {
  const row = {
    inbox_id: `'msg_${Math.random()}'`,
    recipient_thread_id: "'t-1'",
    sender_json: `'{"kind":"courier"}'`,
    kind: "'note'",
    body: "'hi'",
    state: "'unseen'",
    seen_via: "NULL",
    project_path: "'/p'",
    created_at: "1",
    ...over,
  };
  db.exec(`INSERT INTO agent_inbox (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).join(", ")})`);
}

describe("migration 22: AgentInbox", () => {
  test("creates the table empty, with its pending index", () => {
    const { db, file } = v21Database();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_inbox'").get()).toBeNull();
    migrate(db, file);
    // SAFETY: COUNT answers one row with one integer column.
    const count = db.prepare("SELECT COUNT(*) AS n FROM agent_inbox").get() as { n: number };
    expect(count.n).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_agent_inbox_pending'").get()).not.toBeNull();
    db.close();
  });

  test("refuses an unknown kind, state or seen_via, and a sender that is not JSON", () => {
    const { db, file } = v21Database();
    migrate(db, file);
    insert(db);
    insert(db, { sender_json: "'null'" });
    expect(() => insert(db, { kind: "'shout'" })).toThrow(/CHECK/);
    expect(() => insert(db, { state: "'lost'" })).toThrow(/CHECK/);
    expect(() => insert(db, { seen_via: "'magic'" })).toThrow(/CHECK/);
    expect(() => insert(db, { sender_json: "'not json'" })).toThrow(/CHECK/);
    db.close();
  });

  test("a row needs a real recipient thread, and goes when the thread does", () => {
    const { db, file } = v21Database();
    migrate(db, file);
    expect(() => insert(db, { recipient_thread_id: "'nobody'" })).toThrow(/FOREIGN KEY/);
    insert(db);
    db.exec("DELETE FROM threads WHERE thread_id = 't-1'");
    // SAFETY: COUNT answers one row with one integer column.
    const count = db.prepare("SELECT COUNT(*) AS n FROM agent_inbox").get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  test("a dedupe key is unique; rows without one are not", () => {
    const { db, file } = v21Database();
    migrate(db, file);
    insert(db);
    insert(db);
    insert(db, { dedupe_key: "'report:c:1'" });
    expect(() => insert(db, { dedupe_key: "'report:c:1'" })).toThrow(/UNIQUE/);
    db.close();
  });
});

// Migration 23 marks whether a row rings. Every row stored before it rang, so
// each keeps doing so.
describe("migration 23: InboxRings", () => {
  test("rows stored before it ring; a new row may be held", () => {
    const { db, file } = v21Database();
    migrate(db, file, { toMigrationInclusive: 22 });
    insert(db, { inbox_id: "'msg_old'" });
    migrate(db, file);
    insert(db, { inbox_id: "'msg_held'", rings: "0" });
    // SAFETY: the projection is two columns, TEXT and INTEGER.
    const rows = db.prepare("SELECT inbox_id, rings FROM agent_inbox ORDER BY inbox_id").all() as Array<{
      inbox_id: string;
      rings: number;
    }>;
    expect(rows).toEqual([
      { inbox_id: "msg_held", rings: 0 },
      { inbox_id: "msg_old", rings: 1 },
    ]);
    db.close();
  });
});
