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

// Migration 24 records when a hand-over went to the provider. Nothing stored
// before it was on its way anywhere.
describe("migration 24: InboxSentAt", () => {
  test("rows stored before it were never sent", () => {
    const { db, file } = v21Database();
    migrate(db, file, { toMigrationInclusive: 23 });
    insert(db, { inbox_id: "'msg_old'" });
    migrate(db, file);
    // SAFETY: the projection is one nullable INTEGER column.
    const row = db.prepare("SELECT sent_at FROM agent_inbox WHERE inbox_id = 'msg_old'").get() as { sent_at: number | null };
    expect(row.sent_at).toBeNull();
    db.close();
  });
});

// Migration 25 lets a row be uncertain. The table is rebuilt for it, and every
// row comes through as it was.
describe("migration 25: InboxUncertain", () => {
  test("keeps every row and column, and takes an uncertain row", () => {
    const { db, file } = v21Database();
    migrate(db, file, { toMigrationInclusive: 24 });
    insert(db, { inbox_id: "'msg_old'", state: "'handing'", rings: "0", sent_at: "7" });
    migrate(db, file);
    // SAFETY: the projection is four columns, TEXT and nullable INTEGERs.
    const row = db.prepare("SELECT inbox_id, state, rings, sent_at FROM agent_inbox").get() as Record<
      string,
      string | number | null
    >;
    expect(row).toEqual({ inbox_id: "msg_old", state: "handing", rings: 0, sent_at: 7 });
    insert(db, { inbox_id: "'msg_uncertain'", state: "'uncertain'" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_agent_inbox_pending'").get()).not.toBeNull();
    db.close();
  });
});

describe("migration 26: InboxUncertainAt", () => {
  test("an uncertain row keeps when it turned uncertain; nothing else gets a time", () => {
    const { db, file } = v21Database();
    migrate(db, file, { toMigrationInclusive: 25 });
    insert(db, { inbox_id: "'msg_uncertain'", state: "'uncertain'", sent_at: "7" });
    insert(db, { inbox_id: "'msg_seen'", state: "'seen'", sent_at: "8" });
    migrate(db, file);
    // SAFETY: the projection is a TEXT column and a nullable INTEGER.
    const rows = db.prepare("SELECT inbox_id, uncertain_at FROM agent_inbox ORDER BY inbox_id").all() as Array<
      Record<string, string | number | null>
    >;
    expect(rows).toEqual([
      { inbox_id: "msg_seen", uncertain_at: null },
      { inbox_id: "msg_uncertain", uncertain_at: 7 },
    ]);
    db.close();
  });
});
