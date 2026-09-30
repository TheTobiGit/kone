import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "./conversationMigrations.js";

// Migration 14 widens the provider CHECK on `threads` and `jobs` — SQLite can't
// alter a constraint, so it rebuilds both tables. These tests build a real v13
// database with children pointing at both, then prove the rebuild lost nothing:
// no row, no child (the cascade FKs are the reason it runs with foreign keys
// off), no index, no rowid.

function v13Database() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-migration-cline-"));
  const file = path.join(dir, "kone.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, file, { toMigrationInclusive: 13 });
  return { db, file };
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at, request_id)
      VALUES ('t-droid', '/p', 'droid', 1, 1, 'req-1'),
             ('t-codex', '/p', 'codex', 2, 2, NULL);
    INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at, parent_thread_id)
      VALUES ('t-child', '/p', 'codex', 3, 3, 't-codex');
    INSERT INTO items (item_id, thread_id, turn_id, kind, status)
      VALUES ('i-1', 't-droid', 'turn-1', 'assistant_text', 'completed');
    INSERT INTO jobs (job_id, project_path, title, body, status, sort_key, provider, created_at, updated_at)
      VALUES ('j-1', '/p', 'one', 'b', 'queued', 1e18, 'codex', 1, 1),
             ('j-2', '/p', 'two', 'b', 'queued', 1e18, 'droid', 2, 2);
    INSERT INTO job_runs (run_id, job_id, attempt, thread_id, status, created_at)
      VALUES ('r-1', 'j-1', 1, 't-droid', 'running', 1);
  `);
}

/** One integer PRAGMA, e.g. `foreign_keys` or `user_version`. */
function pragma(db: Database, name: string): number | undefined {
  // SAFETY: an integer PRAGMA answers one row whose only column is named for it.
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return row?.[name];
}

const count = (db: Database, table: string): number =>
  // SAFETY: COUNT(*) answers one row with one integer column.
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("migration 14: ClineProvider", () => {
  test("a v13 database cannot hold a cline thread or job — the reason the rung exists", () => {
    const { db } = v13Database();
    expect(() =>
      db.exec(`INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
               VALUES ('t-cline', '/p', 'cline', 1, 1)`),
    ).toThrow(/CHECK/);
    db.close();
  });

  test("after it, threads and jobs accept cline, still reject unknown providers, and lose nothing", () => {
    const { db, file } = v13Database();
    seed(db);
    // SAFETY: rowid is selected by name; jobs has a TEXT primary key so it is a plain rowid.
    const rowidsBefore = db.prepare("SELECT job_id, rowid FROM jobs ORDER BY job_id").all();

    migrate(db, file, { toMigrationInclusive: 14 });

    expect(pragma(db, "user_version")).toBe(14);
    expect(count(db, "threads")).toBe(3);
    expect(count(db, "items")).toBe(1);
    expect(count(db, "jobs")).toBe(2);
    expect(count(db, "job_runs")).toBe(1);
    expect(db.prepare("SELECT job_id, rowid FROM jobs ORDER BY job_id").all()).toEqual(rowidsBefore);

    db.exec(`INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
             VALUES ('t-cline', '/p', 'cline', 4, 4)`);
    db.exec(`INSERT INTO jobs (job_id, project_path, title, body, status, sort_key, provider, created_at, updated_at)
             VALUES ('j-cline', '/p', 'c', 'b', 'draft', 1e18, 'cline', 3, 3)`);
    expect(() =>
      db.exec(`INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
               VALUES ('t-nope', '/p', 'nope', 5, 5)`),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(`INSERT INTO jobs (job_id, project_path, title, body, status, provider, created_at, updated_at)
               VALUES ('j-nope', '/p', 'c', 'b', 'draft', 'nope', 3, 3)`),
    ).toThrow(/CHECK/);
    db.close();
  });

  test("references survive: foreign keys are back on, the cascades still fire, and nothing is orphaned", () => {
    const { db, file } = v13Database();
    seed(db);
    migrate(db, file, { toMigrationInclusive: 14 });

    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // Deleting a thread cascades to its items, its subthread, and (SET NULL) its job run's link.
    db.exec("DELETE FROM threads WHERE thread_id = 't-droid'");
    expect(count(db, "items")).toBe(0);
    expect(db.prepare("SELECT thread_id FROM job_runs WHERE run_id = 'r-1'").get()).toEqual({ thread_id: null });
    db.exec("DELETE FROM threads WHERE thread_id = 't-codex'");
    expect(count(db, "threads")).toBe(0);
    // Deleting a job cascades to its runs.
    db.exec("DELETE FROM jobs WHERE job_id = 'j-1'");
    expect(count(db, "job_runs")).toBe(0);
    db.close();
  });

  test("the rebuilt tables keep their indexes, columns and partial-index predicates", () => {
    const { db, file } = v13Database();
    const columns = (table: string): string[] =>
      // SAFETY: table_info answers one row per column carrying its name.
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const indexSql = (): Array<{ name: string; sql: string }> =>
      // SAFETY: sqlite_master rows carry the index name and DDL.
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('threads', 'jobs') AND sql IS NOT NULL ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
    const before = { threads: columns("threads"), jobs: columns("jobs"), indexes: indexSql() };
    expect(before.indexes.length).toBeGreaterThan(5);

    migrate(db, file, { toMigrationInclusive: 14 });

    expect(columns("threads")).toEqual(before.threads);
    expect(columns("jobs")).toEqual(before.jobs);
    expect(indexSql()).toEqual(before.indexes);
    // No scratch table is left behind.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__cline_rebuild'").all()).toEqual([]);
    db.close();
  });

  test("a store that already lists cline is left alone", () => {
    const { db, file } = v13Database();
    migrate(db, file, { toMigrationInclusive: 14 });
    db.exec(`INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
             VALUES ('t-cline', '/p', 'cline', 1, 1)`);
    // Re-running the rung by hand (a crash between the rebuild and its stamp) changes nothing.
    db.exec("DELETE FROM schema_migrations WHERE migration_id = 14");
    db.exec("PRAGMA user_version = 13");
    migrate(db, file, { toMigrationInclusive: 14 });
    expect(count(db, "threads")).toBe(1);
    db.close();
  });

  test("a failed rung rolls back whole and still restores foreign keys", () => {
    const { db, file } = v13Database();
    seed(db);
    // An orphan the rebuild can't fix: foreign_key_check must trip and undo everything.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`INSERT INTO items (item_id, thread_id, turn_id, kind, status)
             VALUES ('i-orphan', 'no-such-thread', 'turn-1', 'assistant_text', 'completed')`);
    db.exec("PRAGMA foreign_keys = ON");

    expect(() => migrate(db, file)).toThrow(/orphaned/);

    expect(pragma(db, "user_version")).toBe(13);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(count(db, "threads")).toBe(3);
    expect(() =>
      db.exec(`INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
               VALUES ('t-cline', '/p', 'cline', 1, 1)`),
    ).toThrow(/CHECK/);
    db.close();
  });
});
