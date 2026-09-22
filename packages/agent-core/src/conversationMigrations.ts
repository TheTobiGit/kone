import { copyFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "./sqlite.js";

export const SCHEMA_VERSION = 13;

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

/** One pre-turn repository snapshot per turn: which checkpoint ref holds the
 *  tree as it was before the turn ran. The composite primary key makes a
 *  second capture for the same turn a no-op — by then the agent has already
 *  modified the tree, so a fresh snapshot would no longer be the pre-turn
 *  state and must not clobber the first. Rows die with their thread. */
function migration0007TurnCheckpoints(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      thread_id     TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      turn_id       TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      ref           TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    );

    CREATE INDEX IF NOT EXISTS idx_turn_checkpoints_thread
      ON turn_checkpoints (thread_id, created_at);
  `);
}


/** Append-only deltas for streaming item text. Rewriting the whole `items`
 *  row per text delta costs O(n^2) bytes for an n-byte message (`item.updated`
 *  fires once per delta, carrying the full accumulated snapshot each time), so
 *  the hot path now appends only the new suffix here — one small row per delta
 *  — and read sites concatenate the chunks in sequence order. `text_json`
 *  holds each delta JSON-encoded rather than raw: the encoding survives bytes
 *  the TEXT column cannot round-trip (an embedded NUL truncates the read, and
 *  an unpaired UTF-16 surrogate has no UTF-8 form), and every value this
 *  writer produces is valid JSON by construction. `char_len` records the
 *  delta's JS-string length alongside it so a restarted process can recover
 *  its append offset from an aggregate instead of re-reading the accumulated
 *  text. `items.text_json` is the same encoding fallback for the settled base
 *  text (NULL in the common case, where the raw `text` column round-trips).
 *  Chunk rows are transient: `item.completed` folds them into `items.text`
 *  and deletes them, so a settled item is exactly one row. Idempotent — the
 *  table, index, and column are all created only when absent. */
function migration0008ItemTextChunks(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_text_chunks (
      thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      turn_id   TEXT NOT NULL,
      item_id   TEXT NOT NULL,
      seq       INTEGER NOT NULL CHECK (seq >= 0),
      text_json TEXT NOT NULL CHECK (json_valid(text_json)),
      char_len  INTEGER NOT NULL CHECK (char_len >= 0),
      PRIMARY KEY (thread_id, turn_id, item_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_item_text_chunks_item
      ON item_text_chunks (thread_id, turn_id, item_id, seq);
  `);
  // Guarded: upgrade fixtures that predate a table (see the v1 queued-turns
  // test) run every later rung without that table present, and there is no
  // column to add to a table that does not exist. Real databases always carry
  // `items` from the baseline, so this skips only synthetic ones.
  if (hasTable(db, "items")) {
    addColumn(db, "items", "text_json", "TEXT");
  }
}


/** Jobs: work the user has described but not necessarily started, and the
 *  attempts made at it.
 *
 *  A job is NOT a thread. A thread is one *attempt* at a job, which is why
 *  the two tables exist rather than a status column on `threads`. The split is
 *  what makes the three things the bench is for possible at all: a draft is
 *  a job with no runs, a retry is a second run against the same job, and a
 *  job that was started, interrupted and picked up again keeps one identity
 *  across both threads. A status column on `threads` could express none of
 *  them — a draft would have to spawn a dead process to exist.
 *
 *  `jobs` holds what the composer captured: where it runs (project, provider,
 *  model, effort, interaction mode, worktree choice) and what to say first.
 *  Those are the fields a session start takes, deliberately — starting a job
 *  is handing this row to the dispatcher, so anything the dispatcher needs is
 *  stored and nothing else is. `workspace_json` and `fallbacks_json` ride as
 *  JSON because they are already structured values elsewhere and splitting
 *  them into columns would need a migration every time their shape grows.
 *
 *  `sort_key` mirrors the queued-turn drain: rows the user reordered sort
 *  first in that order, rows never reordered (NULL) fall back to oldest-first,
 *  with rowid breaking same-millisecond ties. New arrivals after a reorder
 *  carry NULL and queue behind the explicit sequence.
 *
 *  `job_runs.claimed_by` / `lease_expires_at` are what make a crash
 *  recoverable. A runner claims a row before it dispatches, so a process that
 *  dies mid-start leaves a claimed run with an expiring lease rather than a
 *  job that looks queued and silently runs twice on the next launch. The
 *  recovery index is what the sweep reads.
 *
 *  `mode` is captured at file time, not read at dispatch time: a job started
 *  while nobody is watching has to have had its approval posture decided by
 *  the person who filed it, or it parks on a gate with no one there to answer.
 *  Idempotent — every object is created only when absent. */
function migration0009Jobs(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id        TEXT PRIMARY KEY,
      project_path   TEXT NOT NULL,
      title          TEXT NOT NULL,
      body           TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'running', 'done', 'failed', 'cancelled')),
      sort_key       REAL,
      provider       TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'claudeAgent', 'opencode', 'cursor', 'antigravity', 'droid')),
      model          TEXT,
      effort         TEXT,
      mode           TEXT,
      workspace_json TEXT CHECK (workspace_json IS NULL OR json_valid(workspace_json)),
      fallbacks_json TEXT CHECK (fallbacks_json IS NULL OR json_valid(fallbacks_json)),
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      started_at     INTEGER,
      ended_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_project
      ON jobs (project_path, status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_jobs_drain
      ON jobs (project_path, sort_key, created_at)
      WHERE status = 'queued';

    CREATE TABLE IF NOT EXISTS job_runs (
      run_id           TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      attempt          INTEGER NOT NULL CHECK (attempt >= 1),
      thread_id        TEXT REFERENCES threads(thread_id) ON DELETE SET NULL,
      status           TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'done', 'failed', 'cancelled')),
      claimed_by       TEXT,
      claimed_at       INTEGER,
      lease_expires_at INTEGER,
      started_at       INTEGER,
      ended_at         INTEGER,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      UNIQUE (job_id, attempt)
    );

    CREATE INDEX IF NOT EXISTS idx_job_runs_task
      ON job_runs (job_id, attempt DESC);

    CREATE INDEX IF NOT EXISTS idx_job_runs_recovery
      ON job_runs (status, lease_expires_at);

    CREATE INDEX IF NOT EXISTS idx_job_runs_thread
      ON job_runs (thread_id);
  `);
}

/**
 * Jobs, second pass (v10).
 *
 * Three corrections, all additive because every rung of this ladder is: SQLite
 * cannot alter a column's constraints, and rebuilding `jobs` would mean
 * dropping a table `job_runs` points at with ON DELETE CASCADE while
 * `PRAGMA foreign_keys` is on — a rebuild here would cost the runs to fix the
 * parent.
 *
 * 1. `attachments_json` — files filed with a job. They were uploaded and then
 *    dropped, because the row had nowhere to keep them.
 *
 * 2. `sort_key` — "unordered" was encoded as NULL, which SQLite sorts first
 *    while the drain wants it last, so the order needed a CASE no index could
 *    match and every drain sorted the project's queued rows. The sentinel sorts
 *    last on its own. The column stays nullable for want of a rebuild, but this
 *    empties it of NULLs and nothing writes one again: `createJob` writes the
 *    sentinel and the other two writers write a real position.
 *
 * 3. One run per thread, as a partial unique index rather than a table
 *    constraint — the same guarantee, and addable. `getJobRunByThread` asserted
 *    this in a comment and then ordered by attempt to pick a winner among rows
 *    it claimed could not exist.
 *
 * Idempotent, like its neighbours.
 */
function migration0010JobAttachmentsAndOrder(db: DatabaseSync): void {
  addColumn(
    db,
    "jobs",
    "attachments_json",
    "TEXT CHECK (attachments_json IS NULL OR json_valid(attachments_json))",
  );

  // Must match JOB_SORT_UNSET in conversationStoreTypes.
  db.exec(`UPDATE jobs SET sort_key = 1e18 WHERE sort_key IS NULL`);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_runs_thread_unique
      ON job_runs (thread_id)
      WHERE thread_id IS NOT NULL;

    DROP INDEX IF EXISTS idx_job_runs_task;

    CREATE INDEX IF NOT EXISTS idx_job_runs_attempt
      ON job_runs (job_id, attempt DESC);
  `);
}

/**
 * Why a thread's agent is the one it has, when the router chose them.
 *
 * On the binding row rather than in a table of its own: the binding says who
 * works a thread and this says on what grounds, which is one fact about one
 * settlement. Written in the same insert, deleted by the same delete, and it
 * cannot name a thread the bindings have forgotten. `settled_at` already says
 * when, so there is no timestamp here to disagree with it.
 *
 * Both nullable, and NULL is the answer for every thread settled by hand as
 * well as every thread settled before this column existed — both of which
 * correctly read as "nobody routed this", which is exactly what the marker
 * shows for them.
 *
 * `route_outcome` is stored as the renderer's own tag, verbatim: the store
 * keeps it durable without having an opinion on the vocabulary, and the
 * renderer decodes it on the way back in.
 */
function migration0011ThreadAgentRoute(db: DatabaseSync): void {
  addColumn(db, "thread_agents", "route_outcome", "TEXT");
  addColumn(db, "thread_agents", "route_confidence", "REAL");
}

/**
 * What each user request was sent with — the reasoning-effort tier and the
 * model — on the request's own block row rather than in a table of its own:
 * both say how one ask ran, which is one fact about one settlement. Written in
 * the same insert, deleted by the same delete, and neither can name a block the
 * transcript has forgotten. One step for both columns because they are one
 * fact: a rung that added the tier and left the model for later would leave a
 * database that can say half of how a turn ran.
 *
 * Both nullable, and NULL is the answer for every block written before these
 * columns existed — those correctly read as "nothing recorded", which is
 * exactly what the timeline shows for them (no marker, never a guess).
 *
 * Both stored verbatim — the tier as the renderer's own tag, the model as the
 * raw provider id: the store keeps them durable without having an opinion on
 * the vocabulary, and the renderer decodes them on the way back in.
 */
function migration0012BlockTurnStamps(db: DatabaseSync): void {
  // Upgrade fixtures may record the baseline without creating every table —
  // a missing blocks table means there is no transcript to stamp, so there
  // is nothing to do. Real databases always carry the table from rung 1.
  if (!hasTable(db, "blocks")) return;
  addColumn(db, "blocks", "effort", "TEXT");
  addColumn(db, "blocks", "model", "TEXT");
}

/**
 * Which provider owned which stretch of a thread. A thread used to be
 * single-provider — its `threads.provider` column was the whole truth — but a
 * hand-in swaps the provider underneath a thread that keeps its id and its
 * transcript, so that column is now only the *current* owner. This table is
 * the rest: one row per swap, naming what was handed from, what it was handed
 * to, and when.
 *
 * A row per event rather than a row per segment: an event is what actually
 * happens and can be appended once, atomically, at the moment it happens. A
 * segment table would need the open segment's end rewritten on every swap,
 * which is two writes to say one thing and a half-closed row to recover from
 * if the second one is lost. The segments are derivable — the thread's first
 * provider is the oldest row's `from`, and every later stretch starts at a
 * row's `at`.
 *
 * `from_model` / `to_model` are nullable: a thread that never ran a named
 * model has none to record, and NULL reads as "nothing recorded" rather than
 * an empty label the timeline would have to render.
 */
function migration0013ThreadHandIns(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_hand_ins (
      hand_in_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id     TEXT    NOT NULL,
      from_provider TEXT    NOT NULL,
      from_model    TEXT,
      to_provider   TEXT    NOT NULL,
      to_model      TEXT,
      at            INTEGER NOT NULL,
      -- One-shot bootstrap flag, the same shape a fork's context carries:
      -- 'pending' until the first turn after the swap settles, then
      -- 'completed'. It gates the prior-transcript replay so the new session
      -- is handed the conversation exactly once.
      bootstrap_status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  // The only read is "every hand-in of this thread, oldest first" — the
  // timeline's markers — so the index covers exactly that.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thread_hand_ins_thread
      ON thread_hand_ins(thread_id, at);
  `);
}

export const migrationEntries: readonly MigrationEntry[] = [
  { id: 1, name: "Baseline", run: migration0001Baseline },
  { id: 2, name: "QueuedTurnSortKey", run: migration0002QueuedTurnSortKey },
  { id: 3, name: "Compactions", run: migration0003Compactions },
  { id: 4, name: "ThreadWorkspace", run: migration0004ThreadWorkspace },
  { id: 5, name: "RequestedBranch", run: migration0005RequestedBranch },
  { id: 6, name: "ConversationFts", run: migration0006ConversationFts },
  { id: 7, name: "TurnCheckpoints", run: migration0007TurnCheckpoints },
  { id: 8, name: "ItemTextChunks", run: migration0008ItemTextChunks },
  { id: 9, name: "Jobs", run: migration0009Jobs },
  { id: 10, name: "JobAttachmentsAndOrder", run: migration0010JobAttachmentsAndOrder },
  { id: 11, name: "ThreadAgentRoute", run: migration0011ThreadAgentRoute },
  { id: 12, name: "BlockTurnStamps", run: migration0012BlockTurnStamps },
  { id: 13, name: "ThreadHandIns", run: migration0013ThreadHandIns },
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
