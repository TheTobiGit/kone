import { copyFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "./sqlite.js";

export const SCHEMA_VERSION = 27;

/** Whether `table` already has `column`. Every ALTER TABLE ADD COLUMN in the
 *  partially-applied migration — a crash between statements — re-runs
 *  idempotently instead of failing on a duplicate column. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    // Unknown table / unreadable schema — assume present so the ladder fails
    // loudly on a real problem rather than double-adding a column.
    return true;
  }
}

/** Add a column unless it already exists. */
export function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Open the transaction one rung of the migration ladder runs in. Pairs with
 *  `commitStep`; `migrate` rolls back whatever is open if a rung throws. */
export function beginStep(db: DatabaseSync): void {
  db.exec("BEGIN");
}

/** Record the rung and commit it, in that order and in one transaction, so the
 *  schema version and the writes it describes can never disagree: either the
 *  rung and its number both land, or neither does.
 *
 *  Stamping per rung is what makes a failed upgrade resumable. A ladder that
 *  stamps once at the end throws away every rung it did finish — a failure at
 *  rung 18 leaves the database carrying the work of 1-17 while still calling
 *  itself the version it started at, so the next open replays all of them over
 *  a database that has already moved past them. That only survives while every
 *  step happens to be re-runnable, which is a property nothing checks and a
 *  future step is free to break. */
export function commitStep(db: DatabaseSync, target: number): number {
  db.exec(`PRAGMA user_version = ${target}`);
  db.exec("COMMIT");
  return target;
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

/** How long a failed open is left alone before another attempt. Long enough that
 *  a streaming turn's thousands of writes cost one attempt between them, short
 *  enough that a lock held by a backup or a file-sync client clears well within
 *  a session. */
export const REOPEN_COOLDOWN_MS = 30_000;

/** A database this build must not touch, because a newer build wrote it. Unlike
 *  a busy file or a full disk, no amount of waiting makes this openable, so it's
 *  the one failure the store stops retrying entirely. */
export class UnsupportedSchemaError extends Error {}

/** Whether any conversation exists — the test for "this destructive step has
 *  something to lose". `!= null` rather than `!== undefined` because a driver
 *  that reports "no row" as null would otherwise read as a hit, and the step
 *  would snapshot an already-empty database instead of skipping the copy. */
export function hasAnyThread(db: DatabaseSync): boolean {
  return db.prepare(`SELECT 1 FROM threads LIMIT 1`).get() != null;
}

/** How many `.bak-<millis>` snapshots to keep. Three spans enough upgrades to
 *  recover from a bad one without keeping a full copy of the database for every
 *  destructive step the app has ever shipped. */
export const MIGRATION_BACKUP_RETENTION = 3;

/** Delete all but the newest `MIGRATION_BACKUP_RETENTION` snapshots of `dbFile`.
 *  Age comes from the timestamp in the name rather than mtime, because copying
 *  or restoring a snapshot rewrites mtime and would make the newest one look
 *  like the oldest. A name whose suffix isn't a plain timestamp is left alone:
 *  not being able to date a file is no licence to delete it. */
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

/** Snapshot the database file before a destructive migration step (the v2/v5
  *  transcript wipes) — never destroy data without leaving a restorable copy.
  *  A snapshot that can't be taken logs and doesn't abort the upgrade, because
  *  refusing to migrate would leave the app stuck on an old schema instead of
  *  just degraded.
  *
  *  The checkpoint is part of taking the snapshot, not something the caller
  *  remembers to do first: only the main file gets copied, so pages still living
  *  in the WAL have to be folded into it or the "restorable copy" is whatever
  *  state was last checkpointed. */
export function backupBeforeDestructiveStep(db: DatabaseSync, dbFile: string): void {
  try {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* Best-effort: a snapshot of the main file alone still beats no snapshot. */
    }
    copyFileSync(dbFile, `${dbFile}.bak-${Date.now()}`);
  } catch (err) {
    console.error(
      "[conversation-store] could not back up the database before a destructive migration:",
      err,
    );
    return;
  }
  pruneMigrationBackups(dbFile);
}

/** Storage id for an assistant turn's block. `block_id` is globally UNIQUE, but
 *  a turn id is only unique *within* a thread — Claude numbers turns per session
 *  ("turn_1", "turn_2", …), so every thread's first turn shares the id "turn_1".
 *  Keying the block on the bare turn id let the first thread claim it and every
 *  later thread lose its assistant block to `ON CONFLICT DO NOTHING` (the reply
 *  items, keyed per-thread, survived with no block to render). Namespacing by
 *  thread restores global uniqueness. Codex's turn ids are already globally
 *  unique, so this is a no-op collision-wise for it — just a stable rename. */
export function assistantBlockId(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

/** One-time recovery for threads whose assistant blocks were dropped by the
 *  block-id collision (see {@link assistantBlockId}). For every thread that has
 *  reply items under a turn with no matching assistant block, rebuild the block
 *  list — interleaving user prompts and assistant turns in arrival order — so
 *  the recovered replies render in place. Runs inside the v6 migration; guarded
 *  per-thread so one bad row can't abort the whole upgrade. */
export function backfillOrphanedTurns(db: DatabaseSync): void {
  // Threads with at least one item-turn that has no assistant block to render it.
  const affected = db
    .prepare(
      `SELECT DISTINCT i.thread_id AS thread_id
         FROM items i
         LEFT JOIN blocks b
           ON b.thread_id = i.thread_id
          AND b.turn_id   = i.turn_id
          AND b.role      = 'assistant'
        WHERE b.seq IS NULL`,
    )
    .all() as Array<{ thread_id: string }>;

  for (const { thread_id: threadId } of affected) {
    try {
      // User prompts and any surviving assistant blocks, each in arrival order.
      const users = db
        .prepare(
          `SELECT block_id, text, at FROM blocks
            WHERE thread_id = ? AND role = 'user' ORDER BY seq`,
        )
        .all(threadId) as Array<{ block_id: string; text: string | null; at: number }>;
      const survivingRows = db
        .prepare(
          `SELECT block_id, turn_id, state, error, at, ended_at FROM blocks
            WHERE thread_id = ? AND role = 'assistant' ORDER BY seq`,
        )
        .all(threadId) as Array<{
        block_id: string;
        turn_id: string | null;
        state: string | null;
        error: string | null;
        at: number;
        ended_at: number | null;
      }>;
      const surviving = new Map(survivingRows.filter((r) => r.turn_id).map((r) => [r.turn_id as string, r]));

      // Turns in the order their items first arrived — provider-agnostic (works
      // whether the turn id is "turn_1" or a Codex uuid).
      const turns = db
        .prepare(
          `SELECT turn_id, MIN(seq) AS ms FROM items
            WHERE thread_id = ? GROUP BY turn_id ORDER BY ms`,
        )
        .all(threadId) as Array<{ turn_id: string; ms: number }>;

      // Interleave user[i] then turn[i] — Claude alternates one turn per prompt,
      // so index-pairing reproduces the real order; any surplus on either side
      // is appended rather than dropped.
      const rows: Array<{ user?: (typeof users)[number]; turn?: string }> = [];
      for (let i = 0; i < Math.max(users.length, turns.length); i++) {
        const user = users[i];
        const turn = turns[i];
        if (user) rows.push({ user });
        if (turn) rows.push({ turn: turn.turn_id });
      }

      const insertUser = db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, text, at) VALUES (?, ?, 'user', ?, ?)`,
      );
      const insertAssistant = db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, turn_id, state, error, at, ended_at)
         VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      );
      // Rewrite the thread's blocks in the rebuilt order (fresh seq); items are
      // untouched — they already key on (thread_id, turn_id).
      db.prepare(`DELETE FROM blocks WHERE thread_id = ?`).run(threadId);
      for (const row of rows) {
        if (row.user) {
          insertUser.run(row.user.block_id, threadId, row.user.text, row.user.at);
        } else if (row.turn) {
          const turnId = row.turn;
          const prior = surviving.get(turnId);
          insertAssistant.run(
            prior?.block_id ?? assistantBlockId(threadId, turnId),
            threadId,
            turnId,
            prior?.state ?? "completed",
            prior?.error ?? null,
            prior?.at ?? Date.now(),
            prior?.ended_at ?? null,
          );
        }
      }
    } catch (err) {
      console.error(`[conversation-store] backfill failed for ${threadId}:`, err);
    }
  }
}

/** Bring the database up to the current schema. A tiny migration ladder — each
 *  rung moves user_version forward by one, so future changes append a case
 *  rather than rewriting existing tables.
 *
 *  Each rung runs in its own transaction and records its own version, rather
 *  than the ladder running as one all-or-nothing unit: two rungs snapshot the
 *  file before they destroy anything, and a WAL checkpoint plus a file copy
 *  can't happen inside an open write transaction. A rung that throws unwinds
 *  out of here with its transaction still open; handle() rolls it back on the
 *  way out, leaving the database on the last rung that fully landed. */
export function migrate(db: DatabaseSync, dbFile: string): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row?.user_version ?? 0;

  // A database written by a NEWER app build must never be rewound: downgrading
  // the schema would silently drop rows the older code doesn't know about.
  // Refuse loudly instead — handle() catches this and gives up on persistence for
  // the process (the app keeps running, just without disk history).
  if (version > SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(
      `[conversation-store] database schema v${version} is newer than this build supports ` +
        `(v${SCHEMA_VERSION}); refusing to migrate. Upgrade the app, or remove the database ` +
        "to start fresh.",
    );
  }

  if (version < 1) {
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id       TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        provider        TEXT NOT NULL,
        model           TEXT,
        conversation_id TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_threads_project
        ON threads (project_path, updated_at DESC);

      -- One row per rendered block, in arrival order (the autoincrement seq
      -- interleaves user prompts and assistant turns exactly as they happened).
      CREATE TABLE IF NOT EXISTS blocks (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id  TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        role      TEXT NOT NULL,   -- 'user' | 'assistant'
        turn_id   TEXT,            -- assistant turns only
        text      TEXT,            -- the user prompt, for user blocks
        state     TEXT,            -- assistant lifecycle: running/completed/failed/interrupted
        error     TEXT,
        at        INTEGER NOT NULL,
        ended_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_thread ON blocks (thread_id, seq);

      -- The ordered parts inside a turn (assistant_text / reasoning_text /
      -- plan_text / tool_call), kept in first-seen order via seq — kone's
      -- "ordered-parts" model of the turn's thread activity.
      CREATE TABLE IF NOT EXISTS items (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id   TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id   TEXT NOT NULL,
        kind      TEXT NOT NULL,
        status    TEXT NOT NULL,
        text      TEXT NOT NULL,
        name      TEXT,
        detail    TEXT,
        UNIQUE (thread_id, turn_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_items_turn ON items (thread_id, turn_id, seq);
    `);
    version = commitStep(db, 1);
  }

  if (version < 2) {
    // v2 gives a thread the context the Project Home "recent conversations"
    // block shows: the branch it ran on, its diffstat, and its token spend.
    // Clear the old conversations on the way up — they predate these columns
    // and would render as blank rows, so we start the richer history fresh.
    // Destructive: snapshot the file first (only when there's actually data to
    // lose), and run the wipe + column adds atomically so a crash mid-step
    // can't leave a half-migrated DB.
    if (hasAnyThread(db)) backupBeforeDestructiveStep(db, dbFile);
    beginStep(db);
    db.exec(`
      DELETE FROM items;
      DELETE FROM blocks;
      DELETE FROM threads;
    `);
    addColumn(db, "threads", "branch", "TEXT");
    addColumn(db, "threads", "added", "INTEGER");
    addColumn(db, "threads", "removed", "INTEGER");
    addColumn(db, "threads", "tokens", "INTEGER");
    version = commitStep(db, 2);
  }

  if (version < 3) {
    // v3 lets a thread be hidden from the "recent conversations" block without
    // being destroyed — `archived` is a timestamp (NULL = active). Kept as a
    // nullable column so existing rows read as active with no backfill.
    beginStep(db);
    addColumn(db, "threads", "archived", "INTEGER");
    version = commitStep(db, 3);
  }

  if (version < 4) {
    // v4 persists an agent-generated (or word-fallback) working title so the
    // recent list doesn't have to reconstruct every transcript just to label
    // a row. Title lives on the thread, not derived from the first user turn
    // at read time. Backfill existing rows
    // from their first user prompt (word-capped) so upgraded installs don't
    // flash "Untitled session" for every prior conversation.
    beginStep(db);
    addColumn(db, "threads", "title", "TEXT");
    db.exec(`
      UPDATE threads
      SET title = (
        SELECT TRIM(SUBSTR(
          REPLACE(REPLACE(b.text, CHAR(10), ' '), CHAR(13), ' '),
          1, 60
        ))
        FROM blocks b
        WHERE b.thread_id = threads.thread_id AND b.role = 'user'
        ORDER BY b.seq
        LIMIT 1
      )
      WHERE title IS NULL
    `);
    version = commitStep(db, 4);
  }

  if (version < 5) {
    // v5 rebases the diffstat onto the conversation itself. Old rows recorded
    // the whole working tree's uncommitted diff vs HEAD (the "general diff"),
    // so every conversation showed the same repo-wide numbers instead of what
    // *it* changed. There's no way to reconstruct a true baseline for those
    // historical rows, so — like v2 — we clear all conversations (active and
    // archived alike) and start the corrected, per-conversation history fresh.
    // `base_tree` holds the working-tree snapshot taken when a thread starts;
    // the settled diff is measured against it, not against HEAD.
    //
    // Upgrading through v2 empties the table, so this check fails and only one
    // snapshot is taken per run. A step added between the two that repopulated
    // `threads` would arm both, and two snapshots in the same millisecond share a
    // filename — give the second one a distinct name if that ever happens.
    if (hasAnyThread(db)) backupBeforeDestructiveStep(db, dbFile);
    beginStep(db);
    db.exec(`
      DELETE FROM items;
      DELETE FROM blocks;
      DELETE FROM threads;
    `);
    addColumn(db, "threads", "base_tree", "TEXT");
    version = commitStep(db, 5);
  }

  if (version < 6) {
    // v6 recovers conversations broken by the block-id collision (see
    // assistantBlockId). Assistant blocks were keyed on the bare turn id, which
    // Claude reuses per thread ("turn_1", …) while block_id is globally UNIQUE,
    // so every Claude thread after the first silently lost its assistant blocks
    // — the reply *items* persisted (keyed per-thread) but had no block to hang
    // on, so reopening a thread showed the prompts with no responses. Unlike v2
    // and v5, the data is reconstructable (the items are still here, in arrival
    // order), so we rebuild the affected threads in place rather than wiping.
    beginStep(db);
    backfillOrphanedTurns(db);
    version = commitStep(db, 6);
  }

  if (version < 7) {
    beginStep(db);
    addColumn(db, "items", "tasks_json", "TEXT");
    version = commitStep(db, 7);
  }

  if (version < 8) {
    // v8 adds prompt attachments. Bytes live on disk under the attachments dir
    // (AttachmentStore); this registry keeps the id → on-disk-path mapping the
    // adapters resolve at dispatch, plus enough metadata for GC of orphaned
    // files. The attachment *metadata* is also denormalized onto the owning
    // user block (`attachments_json`) so a reloaded thread rebuilds its chips
    // without a per-block join.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        thread_id     TEXT NOT NULL,
        type          TEXT NOT NULL,   -- 'image' | 'file'
        name          TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        rel_path      TEXT NOT NULL,   -- relative to the attachments dir
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments (thread_id);
    `);
    addColumn(db, "blocks", "attachments_json", "TEXT");
    version = commitStep(db, 8);
  }

  if (version < 9) {
    // v9 — per-project scratchpad documents (markdown source, one row per pad),
    // as first-class rows so a project can hold several open pads with stable
    // ids across reloads.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS scratchpads (
        id          TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        title       TEXT,
        body        TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        sort_index  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scratchpads_project
        ON scratchpads (project_path, sort_index);
    `);
    version = commitStep(db, 9);
  }

  if (version < 10) {
    // v10 — the project board layout, one JSON blob per project. The board is
    // always read and written whole (§6.1), so a normalised panes table would
    // only cost a migration each time a pane field is added — the blob doesn't.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_boards (
        project_path TEXT PRIMARY KEY,
        layout       TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `);
    version = commitStep(db, 10);
  }

  if (version < 11) {
    // v11 persists the last context-window snapshot per thread so a reopened
    // conversation restores its meter fill straight away, rather than showing an
    // empty ring until the next turn re-reports usage. Unlike `tokens` (a spend
    // tally), these are a live snapshot — overwritten each token-usage event.
    beginStep(db);
    addColumn(db, "threads", "context_used", "INTEGER");
    addColumn(db, "threads", "context_window", "INTEGER");
    addColumn(db, "threads", "compacts_auto", "INTEGER");
    version = commitStep(db, 11);
  }

  if (version < 12) {
    // v12 persists nested subagent runs. An item produced *inside* a run carries
    // the spawning Task tool-use id so loadThread can re-nest it, and each run's
    // own snapshot (status, agent type, token/tool counters, summary) lives in a
    // sibling table keyed by that same id. Runs are per-turn, so the key is
    // (thread_id, turn_id, tool_use_id) — the parent item id is stored rather
    // than derived, because a streamed tool call's item id is positional
    // (`turn:msg:index`) and isn't recoverable from the tool-use id.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagents (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_use_id    TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        turn_id        TEXT NOT NULL,
        task_id        TEXT,
        parent_item_id TEXT,
        agent_type     TEXT,
        description    TEXT,
        prompt         TEXT,
        model          TEXT,
        effort         TEXT,
        background     INTEGER,
        status         TEXT NOT NULL,
        summary        TEXT,
        last_tool_name TEXT,
        tokens         INTEGER,
        tool_uses      INTEGER,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        UNIQUE (thread_id, turn_id, tool_use_id)
      );
      CREATE INDEX IF NOT EXISTS idx_subagents_turn ON subagents (thread_id, turn_id, seq);
    `);
    addColumn(db, "items", "subagent_tool_use_id", "TEXT");
    version = commitStep(db, 12);
  }

  if (version < 13) {
    // v13 adds side chats. A side chat is a root thread with a fork pointer
    // back at its source (docs/side-chat-design.md): threads gain the source
    // pointer, the stored handoff context (ForkContext — bootstrap flag and
    // fork point), the lineage block (relationship to the source — side chats
    // are roots, so parentThreadId stays null), and the caller's idempotency
    // key. Blocks gain a `source` column ('native' | 'fork-import') so
    // imported rows render as history rather than activity: they keep their
    // original `at` and never refresh a thread's updated_at.
    beginStep(db);
    addColumn(db, "threads", "source_thread_id", "TEXT");
    addColumn(db, "threads", "fork_context_json", "TEXT");
    addColumn(db, "threads", "lineage_json", "TEXT");
    addColumn(db, "threads", "request_id", "TEXT");
    addColumn(db, "blocks", "source", "TEXT NOT NULL DEFAULT 'native'");
    version = commitStep(db, 13);
  }

  if (version < 14) {
    // v14 enforces one side chat per source thread at the DB level, so a
    // racing second fork can't slip past the app-level join check in
    // createSidechatThread. A unique index on the (nullable) source pointer:
    // NULL rows (every non-side-chat thread) are exempt, so each source can
    // carry at most one fork. Guarded: installs that already hold duplicate
    // side chats (from the pre-v14 lax round) keep the app-level join rule and
    // log instead of failing the migration.
    beginStep(db);
    const dupes = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT source_thread_id FROM threads
            WHERE source_thread_id IS NOT NULL
            GROUP BY source_thread_id HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number };
    if (dupes.n === 0) {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_sidechat_source
           ON threads (source_thread_id) WHERE source_thread_id IS NOT NULL`,
      );
    } else {
      console.warn(
        `[conversation-store] found ${dupes.n} source thread(s) with duplicate side chats; ` +
          "skipping the v14 unique index — the app-level join rule still applies",
      );
    }
    version = commitStep(db, 14);
  }

  if (version < 15) {
    // v15 — the agent-facing MCP gateway (docs/mcp-gateway-design.md):
    // `revision` on scratchpads gives the gateway's kone_scratchpad_write an
    // optimistic concurrency guard against the web editor (the editor is the
    // revision source of truth; agent writes carry the revision they were
    // based on and conflict when it moved). Backfilled to 1 so upgraded pads
    // read as already-written. `gateway_ops` is the idempotency reserve for
    // all future gateway tools (kind = "scratchpad.write" today): agent-side
    // write retries replay the stored result instead of re-applying.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_ops (
        thread_id   TEXT NOT NULL,
        turn_id     TEXT NOT NULL,
        request_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_ops_kind
        ON gateway_ops (kind, created_at);
    `);
    addColumn(db, "scratchpads", "revision", "INTEGER NOT NULL DEFAULT 1");
    version = commitStep(db, 15);
  }

  if (version < 16) {
    // v16 — thread spawning (docs/thread-spawning-design.md): `parent_thread_id`
    // is an indexed projection of lineage_json's parentThreadId — lineage_json
    // stays the source of truth for the relationship, this column exists so
    // "who are my children" and subtree walks are an indexed query instead of a
    // JSON scan of every thread row. No backfill: no thread has ever carried a
    // `subagent` lineage (side chats are roots, parentThreadId null), so the
    // column ships empty, written only by the feature that owns it.
    beginStep(db);
    addColumn(db, "threads", "parent_thread_id", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_parent
        ON threads (parent_thread_id, created_at);
    `);
    version = commitStep(db, 16);
  }

  if (version < 17) {
    // v17 — half-created spawn recovery (docs/thread-spawning-design.md, F8): a
    // `dispatched` bit on gateway_ops marks a spawn.thread op whose startThread
    // actually returned. A reserved op that was never marked dispatched is the
    // durable trace of a crash between the store write and dispatch — at next
    // boot sealUndispatchedSpawns turns the child into a failed thread so it
    // reads terminal instead of projecting idle forever. No backfill: rows
    // written before this migration predate the crash window's meaning, and
    // sealing them would mislabel already-recovered children.
    beginStep(db);
    addColumn(db, "gateway_ops", "dispatched", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_ops_undispatched
        ON gateway_ops (kind, dispatched);
    `);
    version = commitStep(db, 17);
  }

  if (version < 18) {
    // v18 — the persistence-findings sweep:
    //  - `is_pinned` moves pins out of browser localStorage into the DB, so a
    //    pinned thread follows the thread across browser profiles and shows in
    //  - `model_selection_json` persists the user's per-thread picker knobs
    //    (effort / serviceTier / contextWindow — the same axes SendTurnInput
    //    carries; `model` rides the existing column), so a reopened thread
    //    restores the picker instead of boot defaults.
    //  - `resume_session_at` stores Claude's last assistant message uuid for
    //    reliable resume, captured live like conversationId.
    //  - `last_activity_at` separates "when the conversation was last active"
    //    from `updated_at` — title renames and archive stamps also bump the
    //    latter, so recency ordering previously reshuffled under a background
    //    rename. Backfilled from updated_at; every turn event touches it
    //  - `turn_usage` keeps a per-turn token audit trail (input/output/total)
    //    that survives restart; the thread-level `tokens` scalar stays as the
    //    rollup.
    //  - a partial unique index on `threads.request_id` (the side chat's
    //    GLOBAL idempotency key — threadIdForRequestId queries it with no
    //    thread scope) closes the gap where a lax round could mint two
    //    threads for one request key. Existing duplicates are deduped first,
    //    keeping the OLDEST row (the idempotency authority) and nulling the
    //    newer ones.
    beginStep(db);
    addColumn(db, "threads", "is_pinned", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "threads", "model_selection_json", "TEXT");
    addColumn(db, "threads", "resume_session_at", "TEXT");
    addColumn(db, "threads", "last_activity_at", "INTEGER");
    db.exec(`
      UPDATE threads SET last_activity_at = updated_at WHERE last_activity_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_threads_recency
        ON threads (project_path, last_activity_at DESC);
      CREATE TABLE IF NOT EXISTS turn_usage (
        thread_id     TEXT NOT NULL,
        turn_id       TEXT NOT NULL,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        total_tokens  INTEGER,
        at            INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );
    `);
    // Dedupe first: for every request_id, only the row that is oldest by
    // (created_at, thread_id) keeps the key; newer duplicates lose it.
    db.exec(`
      UPDATE threads
         SET request_id = NULL
       WHERE request_id IS NOT NULL
         AND thread_id NOT IN (
           SELECT t.thread_id FROM threads t
            WHERE t.request_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM threads t2
                 WHERE t2.request_id = t.request_id
                   AND (t2.created_at < t.created_at
                     OR (t2.created_at = t.created_at AND t2.thread_id < t.thread_id))
              )
          )
    `);
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_request_id
           ON threads (request_id) WHERE request_id IS NOT NULL`,
      );
    } catch (err) {
      // A duplicate that slipped past the dedupe must not brick the upgrade —
      // the app-level join in createSidechatThread still applies, same
      // posture as the v14 side chat index.
      console.warn(
        "[conversation-store] could not create the request_id unique index:",
        err,
      );
    }
    version = commitStep(db, 18);
  }

  if (version < 19) {
    // behind loadThreadPage's user-anchored windows. Pagination orders blocks
    // by the stable keyset (at, block_id); the pre-existing
    // (thread_id, seq) index cannot serve that order, forcing a temp B-tree
    // over all of a thread's blocks before the page LIMIT applies. With this
    // index the candidates scan is genuinely bounded by the page size.
    beginStep(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_blocks_keyset
        ON blocks (thread_id, at, block_id);
    `);
    version = commitStep(db, 19);
  }

  if (version < 20) {
    // while a turn runs is enqueued here instead of being dropped, promoted
    // when the live turn settles, and cancelled when the thread goes away.
    // `user_block_id` is the journaled user-prompt block UUID (recordUserBlock
    // mints it), so the queued prompt is a pointer into the conversation —
    // never a second copy that could diverge. `dispatch_mode` is the
    // queue/steer axis ('steer' jumps the line, newest steer first, then FIFO);
    // `attempt_count` survives release→reclaim so a poison turn's retries are
    // visible; the nullable knobs (model/mode/effort/service_tier/
    // context_window) are replayed onto the promoted send exactly as the user
    // picked them. The partial unique index on (thread_id, user_block_id) over
    // the ACTIVE states is the replay-safety guard: a replayed enqueue of the
    // same prompt is a no-op, and a row that has settled (promoted/cancelled)
    // no longer blocks anything.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS queued_turns (
        queue_id         TEXT PRIMARY KEY,
        thread_id        TEXT NOT NULL,
        user_block_id    TEXT NOT NULL,
        dispatch_mode    TEXT NOT NULL DEFAULT 'queue'
                         CHECK (dispatch_mode IN ('queue', 'steer')),
        state            TEXT NOT NULL
                         CHECK (state IN ('queued', 'promoting', 'promoted', 'cancelled')),
        input            TEXT NOT NULL,
        attachments_json TEXT,
        model            TEXT,
        mode             TEXT,
        effort           TEXT,
        service_tier     TEXT,
        context_window   TEXT,
        attempt_count    INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        promoted_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_queued_turns_thread_state
        ON queued_turns (thread_id, state, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_turns_active_user_block
        ON queued_turns (thread_id, user_block_id)
        WHERE state IN ('queued', 'promoting');
    `);
    version = commitStep(db, 20);
  }

  if (version < 21) {
    // v21 — the cache/reasoning split of turn_usage's audit trail. Every
    // provider adapter already parses `input`/`output`/`total` off a richer
    // usage payload that also carries cache-read, cache-creation and
    // reasoning token counts (Claude's `cache_read_input_tokens` /
    // `cache_creation_input_tokens`, OpenCode's `tokens.cache.{read,write}` /
    // `tokens.reasoning`, Codex's `cachedInputTokens` /
    // `reasoningOutputTokens`), and until now those counts were folded into
    // input/output and thrown away at the exact moment they reached this
    // table. Cache reads dominate an agentic turn's real prompt cost, so
    // losing that split made every cost figure derived from this table
    // shallower than it needed to be. `ADD COLUMN ... DEFAULT 0` backfills
    // every existing row with 0 for free (SQLite applies the default to
    // history in place, no rewrite pass, no risk to rows already written) —
    // those turns genuinely have no recorded split, so 0 is the honest value
    // rather than NULL standing in for "unknown". Going forward every insert
    // supplies a real count where the provider has one and an explicit 0
    // (never a guess) where it doesn't.
    beginStep(db);
    addColumn(db, "turn_usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "turn_usage", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "turn_usage", "reasoning_tokens", "INTEGER NOT NULL DEFAULT 0");
    version = commitStep(db, 21);
  }

  if (version < 22) {
    // v22 — the roster gets rows. An agent is a persistent actor: an identity
    // that outlives any one conversation, which is exactly the thing browser
    // storage is the wrong home for. Two kinds of row share the table.
    //
    // A row WITH a `preset_id` overlays a built-in the app ships: every column
    // it leaves NULL is inherited from that shipped definition at read time, so
    // a later build's improved wording still reaches a user who never touched
    // that field, and only what they did edit is frozen. A row WITHOUT one is a
    // user-made agent and every column on it is authoritative — which is what
    // the CHECK enforces: a row that inherits nothing must at least carry a
    // name. NULL therefore means "inherit"; '' means "deliberately blank"; the
    // two are different answers and nothing here may collapse them.
    //
    // The shipped definitions are deliberately NOT stored. They live in the
    // renderer — the layer that renders them and the layer the user edits them
    // through — so this table holds only the delta, and no rung ever has to
    // rewrite a copy of prose that shipped in the binary.
    //
    // `deleted_at` is a soft delete because a transcript has to keep naming
    // whoever wrote it. Deleting an agent takes them out of the roster; it can't
    // retroactively orphan the threads they worked, so the row survives as the
    // record of a name and a face that once did work. It also keeps a dismissed
    // built-in dismissed: `ensurePresetAgents` re-seeds a missing row, never a
    // deleted one.
    //
    // Team membership is its own table rather than a column, because an agent
    // belongs to as many projects as you add them to. The join filters on
    // `deleted_at`, so a deleted agent leaves every team without a cascade and
    // comes back to all of them if the row is ever restored.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id     TEXT PRIMARY KEY,
        preset_id    TEXT,
        name         TEXT,
        role         TEXT,
        instructions TEXT,
        face_body    TEXT,
        face_ink     TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        deleted_at   INTEGER,
        CHECK (preset_id IS NOT NULL OR name IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_agents_roster_order
        ON agents (deleted_at, sort_order, created_at, agent_id);

      CREATE TABLE IF NOT EXISTS project_agents (
        project_path TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        added_at     INTEGER NOT NULL,
        PRIMARY KEY (project_path, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_agents_agent
        ON project_agents (agent_id);
    `);
    version = commitStep(db, 22);
  }

  if (version < 23) {
    // v23 — who worked a thread, and who the composer is pointing at.
    //
    // A binding is the record of a decision, not a setting: a thread is one
    // agent's work end to end, so it is written once when the thread starts and
    // never revised. Changing who you work with has to leave started
    // conversations alone, or a transcript would rewrite itself to name whoever
    // was picked last.
    //
    // Three states, and all three are needed. A row with an `agent_id` is that
    // agent's thread. A row with NULL ran as a *guest*, which is a decision like
    // any other — recording it is what stops a guest conversation being claimed
    // later by an agent picked after the fact. No row at all means the thread
    // hasn't started, which is also every thread from before any of this
    // existed, and those correctly read as guests.
    //
    // Deliberately not a column on `threads` and deliberately no foreign key:
    // the binding settles at the moment of the send, which can be ahead of the
    // thread's own row, and it has to outlive the agent it names (an agent's row
    // is soft-deleted precisely so a finished thread still has a name on it).
    //
    // The selection is a single row because it is a single answer: who the next
    // turn goes to. NULL means a guest, and no row means nobody has chosen — the
    // shipped default, which sends work to a guest, so the two behave alike
    // without being written down as the same thing.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_agents (
        thread_id  TEXT PRIMARY KEY,
        agent_id   TEXT,
        settled_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_agents_agent
        ON thread_agents (agent_id);

      CREATE TABLE IF NOT EXISTS roster_selection (
        id         INTEGER PRIMARY KEY CHECK (id = 0),
        agent_id   TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    version = commitStep(db, 23);
  }

  if (version < 24) {
    // v24 — an agent's capabilities: the skills it is assigned, and the
    // providers and models it is allowed to run on.
    //
    // All three are JSON arrays held as TEXT, and each is an overlay field like
    // the prose beside it: NULL means "inherit whatever the shipped preset
    // says", which the renderer resolves — the presets live on the web side.
    // The three are shaped differently on purpose. Skills are additive: an
    // agent is given the ones it needs, so an empty list is a real answer ("no
    // skills"). Providers and models are the opposite — a list is a restriction
    // to exactly those, and having none means no restriction at all, so an
    // empty list reads the same as NULL. A one-entry model list is how "the
    // specific model this agent must use" is written down: a menu of one.
    //
    // Added as columns rather than a table because a capability set is part of
    // one agent's definition, not a relation between agents and skills — it
    // overlays a preset exactly the way the prose does, and a fork copies it by
    // value like everything else on the row.
    beginStep(db);
    addColumn(db, "agents", "skills", "TEXT");
    addColumn(db, "agents", "providers", "TEXT");
    addColumn(db, "agents", "models", "TEXT");
    version = commitStep(db, 24);
  }

  if (version < 25) {
    // v25 — an agent's policies: the things it is permanently forbidden to do,
    // held as one JSON object in TEXT beside the capability columns.
    //
    // Policies are the opposite of capabilities: capabilities say what an agent
    // has available, policies say what it may never do, whatever the thread's
    // interaction mode allows. The object carries two lists today — command
    // lines it may never run and file paths it may never touch — and grows new
    // keys rather than new columns, so a later kind of restriction needs no
    // migration.
    //
    // An overlay field like the rest: NULL means "inherit whatever the shipped
    // preset says", which the renderer resolves. An object with empty lists is a
    // real answer that forbids nothing, the way an empty provider list restricts
    // nothing — and a fork copies the whole object by value like the prose.
    beginStep(db);
    addColumn(db, "agents", "policies", "TEXT");
    version = commitStep(db, 25);
  }

  if (version < 26) {
    // v26 — preset sub-agents: reusable, globally-available definitions an
    // agent can hand a piece of work to. A preset is not a roster member and
    // works no thread of its own — it is a saved shape (a name, a set of
    // instructions, and a model preference) that a spawn is cut from.
    //
    // Its own table rather than columns on `agents` because it is a different
    // kind of thing: an agent is someone work is bound to and who outlives the
    // threads they worked; a preset is a template with no thread history to
    // keep, so it hard-deletes and needs no tombstone.
    //
    // `models` is the ordered model preference held as JSON TEXT: the runtime
    // walks it in order and takes the first model that is available, falling
    // down the list rather than failing when one is unreachable or spent. An
    // empty list is a real answer — no preference, let the runtime choose. It
    // rides in one column as a list, not a relation, the way a capability does.
    beginStep(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_presets (
        preset_id    TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        instructions TEXT,
        models       TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subagent_presets_order
        ON subagent_presets (sort_order, created_at, preset_id);
    `);
    version = commitStep(db, 26);
  }

  if (version < 27) {
    // v27 — how an agent looks: a picture of them, and the bot they drive.
    //
    // Two marks rather than one because they answer different questions. An
    // avatar says who is speaking and belongs beside a name in a transcript; a
    // bot is a creature the agent drives and belongs where the agent is doing
    // something rather than saying it. An agent can have either, both, or
    // neither — with neither, the drawn face it has always had still stands.
    //
    // Both are JSON objects in TEXT, and both overlay like the prose beside
    // them: NULL means "inherit whatever the shipped preset says". The store
    // holds neither shape's meaning. An avatar's `src` is a string it never
    // reads — a shipped asset path today, a data URL for a generated face — and
    // a bot is three ids the renderer's own catalogue resolves, so a bot stored
    // by a build offering a shape this one dropped still draws something.
    //
    // The avatar gets a far larger ceiling than any other field on the row
    // (`AGENT_AVATAR_MAX`) precisely because a generated face is carried by
    // value. It has to be: the source hands back a different face on every
    // request, so storing the URL would give the agent a new face on every
    // paint. A downscaled JPEG data URL is a few tens of kilobytes.
    beginStep(db);
    addColumn(db, "agents", "avatar", "TEXT");
    addColumn(db, "agents", "bot", "TEXT");
    version = commitStep(db, 27);
  }

  // Future migrations append here:
  // `if (version < 28) { beginStep(db); …; version = commitStep(db, 28); }`

  // Every rung stamps itself, so the ladder ending anywhere but the current
  // version means a rung is missing for it — a bumped SCHEMA_VERSION that
  // nobody wrote a step for. Harmless to the running app (the schema simply
  // stays where the last real rung left it), but it silently disables the
  // upgrade the bump was meant to ship, so say so.
  if (version !== SCHEMA_VERSION) {
    console.error(
      `[conversation-store] migration ladder ended at v${version} but this build ` +
        `declares v${SCHEMA_VERSION}; no step exists for the gap.`,
    );
  }
}
