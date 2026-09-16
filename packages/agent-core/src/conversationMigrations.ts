import { copyFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "./sqlite.js";

export const SCHEMA_VERSION = 6;

/** Whether `table` already has `column`. Used for idempotent DDL steps. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    // SAFETY: the row shape is fixed by the SQL's single selected column.
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return true;
  }
}

/** Whether `table` exists in sqlite_master. */
export function hasTable(db: DatabaseSync, table: string): boolean {
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) != null
    );
  } catch {
    return false;
  }
}

/** Add a column unless it already exists. */
export function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Open the transaction one rung of the migration ladder runs in. */
export function beginStep(db: DatabaseSync): void {
  db.exec("BEGIN");
}

/** Record the migration rung and commit it atomically. Stamping per rung is what makes
 *  a multi-rung upgrade resumable. Both the named tracking table and user_version are updated. */
export function commitStep(db: DatabaseSync, migrationId: number, name: string): void {
  db.prepare(
    `INSERT INTO schema_migrations (migration_id, name, applied_at)
     VALUES (?, ?, ?)
     ON CONFLICT(migration_id) DO UPDATE SET
       name = excluded.name,
       applied_at = excluded.applied_at`,
  ).run(migrationId, name, Date.now());
  db.exec(`PRAGMA user_version = ${migrationId}`);
  db.exec("COMMIT");
}

/** Run `fn` inside a transaction, rolling back and rethrowing on failure. */
export function withTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw err;
  }
}

export const REOPEN_COOLDOWN_MS = 30_000;

/** A database this build must not touch, because a newer build wrote it. */
export class UnsupportedSchemaError extends Error {}

/** Failure thrown when recorded migration names diverge from the code manifest. */
export class MigrationLineageError extends Error {}

/** Whether any conversation exists — gates snapshots so an empty database is not snapshotted. */
export function hasAnyThread(db: DatabaseSync): boolean {
  if (!hasTable(db, "threads")) return false;
  try {
    return db.prepare(`SELECT 1 FROM threads LIMIT 1`).get() != null;
  } catch {
    return false;
  }
}

export const MIGRATION_BACKUP_RETENTION = 3;

/** Delete all but the newest `MIGRATION_BACKUP_RETENTION` snapshots of `dbFile`. */
export function pruneMigrationBackups(dbFile: string): void {
  const prefix = `${path.basename(dbFile)}.bak-`;
  const dir = path.dirname(dbFile);
  try {
    const dated = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .map((name) => ({ name, at: Number(name.slice(prefix.length)) }))
      .sort((a, b) => b.at - a.at);
    for (const stale of dated.slice(MIGRATION_BACKUP_RETENTION)) {
      rmSync(path.join(dir, stale.name), { force: true });
    }
  } catch (err) {
    console.error("[conversation-store] could not prune old database backups:", err);
  }
}

/** Snapshot the database file before a migration step. */
export function backupBeforeStep(db: DatabaseSync, dbFile: string): void {
  try {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* Best-effort checkpoint: a snapshot of the main file alone still beats none. */
    }
    copyFileSync(dbFile, `${dbFile}.bak-${Date.now()}`);
  } catch (err) {
    console.error(
      "[conversation-store] could not back up the database before a migration:",
      err,
    );
    return;
  }
  pruneMigrationBackups(dbFile);
}

export const backupBeforeDestructiveStep = backupBeforeStep;

/** Storage id for an assistant turn's block. Claude numbers turns per session
 *  ("turn_1", "turn_2", ...), so every thread's first turn shares "turn_1".
 *  Namespacing by thread restores global uniqueness across threads. */
export function assistantBlockId(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

export interface MigrationEntry {
  readonly id: number;
  readonly name: string;
  readonly run: (db: DatabaseSync, dbFile: string) => void;
}

function migration0001Baseline(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id                TEXT PRIMARY KEY,
      project_path             TEXT NOT NULL,
      provider                 TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'claudeAgent', 'opencode', 'cursor', 'antigravity', 'droid')),
      model                    TEXT,
      conversation_id          TEXT,
      created_at               INTEGER NOT NULL,
      last_activity_at         INTEGER NOT NULL,
      branch                   TEXT,
      added                    INTEGER,
      removed                  INTEGER,
      tokens                   INTEGER,
      context_used             INTEGER,
      context_window           INTEGER,
      compacts_auto            INTEGER CHECK (compacts_auto IS NULL OR compacts_auto IN (0, 1)),
      archived_at              INTEGER,
      pinned_at                INTEGER,
      title                    TEXT,
      base_tree                TEXT,
      source_thread_id         TEXT,
      parent_thread_id         TEXT REFERENCES threads(thread_id) ON DELETE CASCADE,
      relationship_to_parent   TEXT CHECK (relationship_to_parent IS NULL OR relationship_to_parent IN ('subagent', 'side_chat', 'delegation')),
      fork_context_json        TEXT CHECK (fork_context_json IS NULL OR json_valid(fork_context_json)),
      request_id               TEXT,
      model_selection_json     TEXT CHECK (model_selection_json IS NULL OR json_valid(model_selection_json)),
      resume_session_at        TEXT,
      done_at                  INTEGER,
      last_visited_at          INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_threads_recency
      ON threads (project_path, last_activity_at DESC);

    CREATE INDEX IF NOT EXISTS idx_threads_parent
      ON threads (parent_thread_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_threads_source
      ON threads (source_thread_id) WHERE source_thread_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_threads_request
      ON threads (request_id) WHERE request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS items (
      seq                  INTEGER PRIMARY KEY,
      item_id              TEXT NOT NULL,
      thread_id            TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      turn_id              TEXT NOT NULL,
      kind                 TEXT NOT NULL CHECK (kind IN ('assistant_text', 'reasoning_text', 'plan_text', 'tool_call')),
      status               TEXT NOT NULL CHECK (status IN ('in-progress', 'completed', 'failed')),
      text                 TEXT,
      name                 TEXT,
      detail               TEXT,
      tasks_json           TEXT CHECK (tasks_json IS NULL OR json_valid(tasks_json)),
      subagent_tool_use_id TEXT,
      at                   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      UNIQUE (thread_id, turn_id, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_turn
      ON items (thread_id, turn_id, seq);

    CREATE INDEX IF NOT EXISTS idx_items_thread_seq
      ON items (thread_id, seq DESC);

    CREATE TABLE IF NOT EXISTS blocks (
      seq              INTEGER PRIMARY KEY,
      block_id         TEXT NOT NULL UNIQUE,
      thread_id        TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      turn_id          TEXT,
      text             TEXT,
      state            TEXT CHECK (state IS NULL OR state IN ('running', 'completed', 'failed', 'interrupted')),
      error            TEXT,
      at               INTEGER NOT NULL,
      ended_at         INTEGER,
      attachments_json TEXT CHECK (attachments_json IS NULL OR json_valid(attachments_json)),
      source           TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'fork-import'))
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_keyset
      ON blocks (thread_id, seq);

    CREATE INDEX IF NOT EXISTS idx_blocks_user_probe
      ON blocks (thread_id) WHERE role = 'user';

    CREATE INDEX IF NOT EXISTS idx_blocks_running
      ON blocks (thread_id) WHERE state = 'running';

    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY,
      thread_id     TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      type          TEXT NOT NULL,
      name          TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      rel_path      TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_thread
      ON attachments (thread_id);

    CREATE TABLE IF NOT EXISTS subagents (
      seq             INTEGER PRIMARY KEY,
      tool_use_id     TEXT NOT NULL,
      thread_id       TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      turn_id         TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      parent_item_id  TEXT NOT NULL,
      agent_type      TEXT NOT NULL,
      description     TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      model           TEXT NOT NULL,
      effort          TEXT,
      background      INTEGER,
      status          TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'stopped')),
      summary         TEXT,
      last_tool_name  TEXT,
      tokens          INTEGER NOT NULL DEFAULT 0,
      tool_uses       INTEGER NOT NULL DEFAULT 0,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      UNIQUE (thread_id, turn_id, tool_use_id)
    );

    CREATE INDEX IF NOT EXISTS idx_subagents_thread
      ON subagents (thread_id, turn_id);

    CREATE INDEX IF NOT EXISTS idx_subagents_busy
      ON subagents (thread_id) WHERE status IN ('starting', 'running');

    CREATE TABLE IF NOT EXISTS turn_usage (
      thread_id             TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      turn_id               TEXT NOT NULL,
      input_tokens          INTEGER,
      output_tokens         INTEGER,
      total_tokens          INTEGER,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
      provider              TEXT,
      model                 TEXT,
      at                    INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    );

    CREATE INDEX IF NOT EXISTS idx_turn_usage_at
      ON turn_usage (at);

    CREATE TABLE IF NOT EXISTS queued_turns (
      queue_id         TEXT PRIMARY KEY,
      thread_id        TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      user_block_id    TEXT NOT NULL,
      dispatch_mode    TEXT NOT NULL CHECK (dispatch_mode IN ('followup', 'steer', 'direct', 'queue')),
      state            TEXT NOT NULL CHECK (state IN ('queued', 'promoting', 'promoted', 'failed', 'cancelled')),
      input            TEXT NOT NULL,
      attachments_json TEXT CHECK (attachments_json IS NULL OR json_valid(attachments_json)),
      model            TEXT,
      mode             TEXT,
      effort           TEXT,
      service_tier     TEXT,
      context_window   TEXT,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      promoted_at      INTEGER,
      sort_key         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_queued_turns_pending
      ON queued_turns (thread_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_queued_turns_thread_state
      ON queued_turns (thread_id, state);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_turns_active_user_block
      ON queued_turns (thread_id, user_block_id)
      WHERE state IN ('queued', 'promoting');

    CREATE TABLE IF NOT EXISTS scratchpads (
      id           TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title        TEXT,
      body         TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      sort_index   INTEGER NOT NULL,
      revision     INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_scratchpads_project
      ON scratchpads (project_path, sort_index ASC);

    CREATE TABLE IF NOT EXISTS gateway_ops (
      thread_id   TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      turn_id     TEXT NOT NULL,
      request_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT,
      status      TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'dispatching', 'completed', 'failed')),
      PRIMARY KEY (thread_id, turn_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_ops_status
      ON gateway_ops (kind, status);

    CREATE TABLE IF NOT EXISTS agents (
      agent_id     TEXT PRIMARY KEY,
      preset_id    TEXT,
      name         TEXT,
      role         TEXT,
      instructions TEXT,
      face_body    TEXT,
      face_ink     TEXT,
      skills       TEXT,
      models       TEXT,
      avatar       TEXT,
      bot          TEXT,
      sort_order   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      deleted_at   INTEGER,
      CHECK (preset_id IS NOT NULL OR (name IS NOT NULL AND length(trim(name)) > 0))
    );

    CREATE TABLE IF NOT EXISTS project_agents (
      project_path TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      sort_order   INTEGER NOT NULL,
      added_at     INTEGER NOT NULL,
      PRIMARY KEY (project_path, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_agents_agent
      ON project_agents (agent_id);

    CREATE TABLE IF NOT EXISTS thread_agents (
      thread_id  TEXT PRIMARY KEY,
      agent_id   TEXT,
      settled_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subagent_presets (
      preset_id    TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      instructions TEXT,
      models       TEXT,
      sort_order   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** Explicit queue position for queued_turns. Ordering used to overload
 *  created_at, so a drag rewrote creation times and partial lists interleaved
 *  with untouched rows. sort_key carries the user's order instead: NULL means
 *  never reordered and falls back to the steer-first then FIFO order, while a
 *  set key wins outright. Idempotent — fresh databases already carry the
 *  column from the baseline. */
function migration0002QueuedTurnSortKey(db: DatabaseSync): void {
  addColumn(db, "queued_turns", "sort_key", "INTEGER");
}

/** Durable compaction markers: one row per settled `thread.state.changed`
 *  "compacted" boundary, so the timeline can show when/where the context was
 *  compacted long after the live event is gone. Counts are whatever the
 *  provider reported (either side may be NULL); rows die with their thread.
 *  Idempotent — fresh databases could carry it from a newer baseline, but it
 *  lives here so existing databases gain it without a rebuild. */
function migration0003Compactions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compactions (
      seq           INTEGER PRIMARY KEY,
      thread_id     TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      at            INTEGER NOT NULL,
      before_tokens INTEGER,
      after_tokens  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_compactions_thread
      ON compactions (thread_id, at);
  `);
}

/** A thread's place, as distinct from its identity. `project_path` says which
 *  project the conversation belongs to and never changes meaning; these two say
 *  where its turns actually run.
 *
 *  `env_mode` is the declared intent ("local" / "worktree"), chosen before the
 *  first message. `worktree_path` is the materialized directory, and stays NULL
 *  until `git worktree add` has actually succeeded — the gap between the two is
 *  a real state, not a transient, and the resolver treats it as one.
 *
 *  Both are nullable with no default: an existing row reads as local, which is
 *  exactly what it is. */
function migration0004ThreadWorkspace(db: DatabaseSync): void {
  addColumn(db, "threads", "env_mode", "TEXT");
  addColumn(db, "threads", "worktree_path", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_worktree
      ON threads (worktree_path) WHERE worktree_path IS NOT NULL;
  `);
}

/** The branch a pending worktree was asked for, kept beside the intent it
 *  refines. Nullable with no default: rows written before the request was
 *  persisted read as no requested branch, which rebuilds with a generated
 *  name — the same outcome as before. Cleared when the worktree materializes
 *  or the thread returns to local, so it lives only in the pending gap. */
function migration0005RequestedBranch(db: DatabaseSync): void {
  addColumn(db, "threads", "requested_branch", "TEXT");
}

/** Full-text index over conversation text: one row per user block and one
 *  row per turn item, carrying the thread, the containing block, the
 *  turn/item identity and the text. The live indexer (store/search.ts) keeps
 *  it in step at item/turn completion; this migration backfills what is
 *  already stored so long history is searchable without a reindex command.
 *
 *  Rows are copied in bounded batches — a large store must not hold one
 *  giant statement. Item text follows the same rule the live indexer uses
 *  (body + tool name + payload joined); blocks index their text as-is.
 *  Idempotent — a resumed run re-creates the table and re-copies, and the
 *  delete-before-insert discipline means re-copied rows never duplicate. */
function migration0006ConversationFts(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
      thread_id  UNINDEXED,
      entry_kind UNINDEXED,
      block_id   UNINDEXED,
      turn_id    UNINDEXED,
      item_id    UNINDEXED,
      at         UNINDEXED,
      text,
      tokenize='porter unicode61'
    );
  `);

  const BATCH = 500;
  // A rung must never assume an earlier rung's tables exist: databases
  // rebuilt from a partial schema (or stopped mid-ladder) still have to
  // migrate, so each backfill pass is skipped when its source is absent.
  // Preparing against a missing table throws, so even the statements stay
  // inside the guards.
  if (hasTable(db, "blocks")) {
    const insertBlock = db.prepare(
      `INSERT INTO conversation_fts
         (thread_id, entry_kind, block_id, turn_id, item_id, at, text)
       VALUES (?, 'block', ?, ?, NULL, ?, ?)`,
    );
    let blockOffset = 0;
    for (;;) {
      // SAFETY: the projection names exactly the block columns read below.
      const blocks = db
        .prepare(
          `SELECT block_id, thread_id, turn_id, text, at FROM blocks
            ORDER BY seq ASC
            LIMIT ? OFFSET ?`,
        )
        .all(BATCH, blockOffset) as Array<{
        block_id: string;
        thread_id: string;
        turn_id: string | null;
        text: string | null;
        at: number;
      }>;
      if (blocks.length === 0) break;
      for (const block of blocks) {
        if (!block.text || block.text.trim().length === 0) continue;
        insertBlock.run(block.thread_id, block.block_id, block.turn_id, block.at, block.text);
      }
      if (blocks.length < BATCH) break;
      blockOffset += blocks.length;
    }
  }

  if (hasTable(db, "items")) {
    const insertItem = db.prepare(
      `INSERT INTO conversation_fts
         (thread_id, entry_kind, block_id, turn_id, item_id, at, text)
       VALUES (?, 'item', ?, ?, ?, ?, ?)`,
    );
    // The parent lookup needs the blocks table; without it items still
    // index, just with no containing block to jump to.
    const parentBlock = hasTable(db, "blocks")
      ? db.prepare(
          `SELECT block_id FROM blocks
            WHERE thread_id = ? AND turn_id = ? AND role = 'assistant'
            LIMIT 1`,
        )
      : null;
    let itemOffset = 0;
    for (;;) {
      // SAFETY: the projection names exactly the item columns read below.
      const items = db
        .prepare(
          `SELECT thread_id, turn_id, item_id, text, name, detail, at FROM items
            ORDER BY seq ASC
            LIMIT ? OFFSET ?`,
        )
        .all(BATCH, itemOffset) as Array<{
        thread_id: string;
        turn_id: string;
        item_id: string;
        text: string | null;
        name: string | null;
        detail: string | null;
        at: number;
      }>;
      if (items.length === 0) break;
      for (const item of items) {
        const parts: string[] = [];
        if (item.text) parts.push(item.text);
        if (item.name) parts.push(item.name);
        if (item.detail) parts.push(item.detail);
        const combined = parts.join("\n");
        if (combined.trim().length === 0) continue;
        // SAFETY: the projection names only blocks.block_id (NOT NULL TEXT).
        const parent = parentBlock?.get(item.thread_id, item.turn_id) as
          | { block_id: string }
          | undefined;
        insertItem.run(
          item.thread_id,
          parent?.block_id ?? null,
          item.turn_id,
          item.item_id,
          item.at,
          combined,
        );
      }
      if (items.length < BATCH) break;
      itemOffset += items.length;
    }
  }
}

export const migrationEntries: readonly MigrationEntry[] = [
  { id: 1, name: "Baseline", run: migration0001Baseline },
  { id: 2, name: "QueuedTurnSortKey", run: migration0002QueuedTurnSortKey },
  { id: 3, name: "Compactions", run: migration0003Compactions },
  { id: 4, name: "ThreadWorkspace", run: migration0004ThreadWorkspace },
  { id: 5, name: "RequestedBranch", run: migration0005RequestedBranch },
  { id: 6, name: "ConversationFts", run: migration0006ConversationFts },
];

export interface MigrationOptions {
  toMigrationInclusive?: number;
}

/** Run the migration ladder against `db`, bringing it up to `SCHEMA_VERSION`. */
export function migrate(
  db: DatabaseSync,
  dbFile: string,
  options?: MigrationOptions,
): void {
  // Ensure the named migration tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      applied_at   INTEGER NOT NULL
    );
  `);

  // SAFETY: query matches schema_migrations definition above.
  const recordedRows = db
    .prepare("SELECT migration_id, name FROM schema_migrations ORDER BY migration_id ASC")
    .all() as Array<{ migration_id: number; name: string }>;

  // SAFETY: the user_version pragma returns a single object with the user_version number.
  const userVersionRow = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const userVersion = userVersionRow?.user_version ?? 0;

  const maxRecorded =
    recordedRows.length > 0 ? (recordedRows[recordedRows.length - 1]?.migration_id ?? 0) : 0;
  const highestVersion = Math.max(userVersion, maxRecorded);

  if (highestVersion > SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(
      `[conversation-store] database schema v${highestVersion} is newer than this build supports ` +
        `(v${SCHEMA_VERSION}); refusing to migrate. Upgrade the app, or remove the database ` +
        "to start fresh.",
    );
  }

  // Verify recorded names match the code manifest
  for (const recorded of recordedRows) {
    const manifestEntry = migrationEntries.find((e) => e.id === recorded.migration_id);
    if (!manifestEntry || manifestEntry.name !== recorded.name) {
      throw new MigrationLineageError(
        `[conversation-store] migration lineage mismatch at rung ${recorded.migration_id}: ` +
          `expected "${manifestEntry?.name ?? "<unknown>"}", found "${recorded.name}" in database.`,
      );
    }
  }

  const appliedIds = new Set<number>(recordedRows.map((r) => r.migration_id));
  const targetMax = options?.toMigrationInclusive ?? SCHEMA_VERSION;

  for (const entry of migrationEntries) {
    if (entry.id <= targetMax && !appliedIds.has(entry.id)) {
      if (hasAnyThread(db)) {
        backupBeforeStep(db, dbFile);
      }
      beginStep(db);
      try {
        entry.run(db, dbFile);
        commitStep(db, entry.id, entry.name);
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* noop */
        }
        throw err;
      }
    }
  }
}
