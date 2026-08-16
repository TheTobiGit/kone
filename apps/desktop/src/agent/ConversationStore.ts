import { randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  ChatAttachment,
  ForkContext,
  ProfileStats,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
  SubagentRun,
  ThreadLineage,
  TokenUsage,
} from "./types.js";
import type { TokenUsageSplits, UsageRange } from "./usage/report.js";
import { usageReportFromStore } from "./usage/storeUsage.js";
import { getUserDataDir } from "./userDataDir.js";

// Durable conversation persistence for the agent layer. Threads, turns, and the
// ordered parts inside a turn are written to a small SQLite database as they
// stream, so a conversation survives reload / quit / project switch instead of
// living only in the renderer's in-memory timeline.
//
// The design is distilled from a single SQLite file under the per-user state
// dir, using a thread → turn → ordered-item model, but deliberately simplified
// for kone's scale: we write the read model directly from the normalized
// RuntimeEvent stream, without any event-sourcing / CQRS / projection
// machinery. The one lesson we do keep is schema versioning (PRAGMA
// user_version) so the shape can evolve without losing data.
//
// Persistence is best-effort, exactly like windowState.ts: every call is guarded
// so a storage hiccup can never crash the agent or drop a turn. Plain-TS and
// framework-free to match AgentService / the git + fs modules — no Effect, no DI.

const SCHEMA_VERSION = 21;

/** Whether `table` already has `column`. Every ALTER TABLE ADD COLUMN in the
 *  partially-applied migration — a crash between statements — re-runs
 *  idempotently instead of failing on a duplicate column. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
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
function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Run `fn` inside a transaction, rolling back and rethrowing on failure. */
function withTransaction(db: DatabaseSync, fn: () => void): void {
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

/** Snapshot the database file before a destructive migration step (the v2/v5
  *  transcript wipes) — the same "never upgrade without a restorable copy"
  *  but doesn't abort the upgrade, because refusing to migrate would leave the
  *  app stuck on an old schema instead of just degraded. */
function backupBeforeDestructiveStep(dbFile: string): void {
  try {
    copyFileSync(dbFile, `${dbFile}.bak-${Date.now()}`);
  } catch (err) {
    console.error(
      "[conversation-store] could not back up the database before a destructive migration:",
      err,
    );
  }
}

/** Bring the database up to the current schema. A tiny migration ladder — each
 *  step moves user_version forward by one, so future changes append a case
 *  rather than rewriting existing tables. */
function migrate(db: DatabaseSync, dbFile: string): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row?.user_version ?? 0;

  // A database written by a NEWER app build must never be rewound: downgrading
  // the schema would silently drop rows the older code doesn't know about.
  // Refuse loudly instead — handle() catches this and disables persistence for
  // the process (the app keeps running, just without disk history), the same
  // degraded mode a corrupt DB already lands in.
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `[conversation-store] database schema v${version} is newer than this build supports ` +
        `(v${SCHEMA_VERSION}); refusing to migrate. Upgrade the app, or remove the database ` +
        "to start fresh.",
    );
  }

  if (version < 1) {
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
    version = 1;
  }

  if (version < 2) {
    // v2 gives a thread the context the Project Home "recent conversations"
    // block shows: the branch it ran on, its diffstat, and its token spend.
    // Clear the old conversations on the way up — they predate these columns
    // and would render as blank rows, so we start the richer history fresh.
    // Destructive: snapshot the file first (only when there's actually data to
    // lose), and run the wipe + column adds atomically so a crash mid-step
    // can't leave a half-migrated DB.
    const hasRows = db.prepare(`SELECT 1 FROM threads LIMIT 1`).get() !== undefined;
    if (hasRows) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* checkpoint is best-effort — the backup below still captures the main file */
      }
      backupBeforeDestructiveStep(dbFile);
    }
    withTransaction(db, () => {
      db.exec(`
        DELETE FROM items;
        DELETE FROM blocks;
        DELETE FROM threads;
      `);
      addColumn(db, "threads", "branch", "TEXT");
      addColumn(db, "threads", "added", "INTEGER");
      addColumn(db, "threads", "removed", "INTEGER");
      addColumn(db, "threads", "tokens", "INTEGER");
    });
    version = 2;
  }

  if (version < 3) {
    // v3 lets a thread be hidden from the "recent conversations" block without
    // being destroyed — `archived` is a timestamp (NULL = active). Kept as a
    // nullable column so existing rows read as active with no backfill.
    addColumn(db, "threads", "archived", "INTEGER");
    version = 3;
  }

  if (version < 4) {
    // v4 persists an agent-generated (or word-fallback) working title so the
    // recent list doesn't have to reconstruct every transcript just to label
    // a row. Title lives on the thread, not derived from the first user turn
    // at read time. Backfill existing rows
    // from their first user prompt (word-capped) so upgraded installs don't
    // flash "Untitled session" for every prior conversation.
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
    version = 4;
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
    const hasRows = db.prepare(`SELECT 1 FROM threads LIMIT 1`).get() !== undefined;
    if (hasRows) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* best-effort */
      }
      backupBeforeDestructiveStep(dbFile);
    }
    withTransaction(db, () => {
      db.exec(`
        DELETE FROM items;
        DELETE FROM blocks;
        DELETE FROM threads;
      `);
      addColumn(db, "threads", "base_tree", "TEXT");
    });
    version = 5;
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
    backfillOrphanedTurns(db);
    version = 6;
  }

  if (version < 7) {
    addColumn(db, "items", "tasks_json", "TEXT");
    version = 7;
  }

  if (version < 8) {
    // v8 adds prompt attachments. Bytes live on disk under the attachments dir
    // (AttachmentStore); this registry keeps the id → on-disk-path mapping the
    // adapters resolve at dispatch, plus enough metadata for GC of orphaned
    // files. The attachment *metadata* is also denormalized onto the owning
    // user block (`attachments_json`) so a reloaded thread rebuilds its chips
    // without a per-block join.
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
    version = 8;
  }

  if (version < 9) {
    // v9 — per-project scratchpad documents (markdown source, one row per pad),
    // as first-class rows so a project can hold several open pads with stable
    // ids across reloads.
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
    version = 9;
  }

  if (version < 10) {
    // v10 — the project board layout, one JSON blob per project. The board is
    // always read and written whole (§6.1), so a normalised panes table would
    // only cost a migration each time a pane field is added — the blob doesn't.
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_boards (
        project_path TEXT PRIMARY KEY,
        layout       TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `);
    version = 10;
  }

  if (version < 11) {
    // v11 persists the last context-window snapshot per thread so a reopened
    // conversation restores its meter fill straight away, rather than showing an
    // empty ring until the next turn re-reports usage. Unlike `tokens` (a spend
    // tally), these are a live snapshot — overwritten each token-usage event.
    addColumn(db, "threads", "context_used", "INTEGER");
    addColumn(db, "threads", "context_window", "INTEGER");
    addColumn(db, "threads", "compacts_auto", "INTEGER");
    version = 11;
  }

  if (version < 12) {
    // v12 persists nested subagent runs. An item produced *inside* a run carries
    // the spawning Task tool-use id so loadThread can re-nest it, and each run's
    // own snapshot (status, agent type, token/tool counters, summary) lives in a
    // sibling table keyed by that same id. Runs are per-turn, so the key is
    // (thread_id, turn_id, tool_use_id) — the parent item id is stored rather
    // than derived, because a streamed tool call's item id is positional
    // (`turn:msg:index`) and isn't recoverable from the tool-use id.
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
    version = 12;
  }

  // Future migrations append here: `if (version < 13) { …; version = 13; }`

  if (version < 13) {
    // v13 adds side chats. A side chat is a root thread with a fork pointer
    // back at its source (docs/side-chat-design.md): threads gain the source
    // pointer, the stored handoff context (ForkContext — bootstrap flag and
    // fork point), the lineage block (relationship to the source — side chats
    // are roots, so parentThreadId stays null), and the caller's idempotency
    // key. Blocks gain a `source` column ('native' | 'fork-import') so
    // imported rows render as history rather than activity: they keep their
    // original `at` and never refresh a thread's updated_at.
    addColumn(db, "threads", "source_thread_id", "TEXT");
    addColumn(db, "threads", "fork_context_json", "TEXT");
    addColumn(db, "threads", "lineage_json", "TEXT");
    addColumn(db, "threads", "request_id", "TEXT");
    addColumn(db, "blocks", "source", "TEXT NOT NULL DEFAULT 'native'");
    version = 13;
  }

  if (version < 14) {
    // v14 enforces one side chat per source thread at the DB level, so a
    // racing second fork can't slip past the app-level join check in
    // createSidechatThread. A unique index on the (nullable) source pointer:
    // NULL rows (every non-side-chat thread) are exempt, so each source can
    // carry at most one fork. Guarded: installs that already hold duplicate
    // side chats (from the pre-v14 lax round) keep the app-level join rule and
    // log instead of failing the migration.
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
    version = 14;
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
    version = 15;
  }

  if (version < 16) {
    // v16 — thread spawning (docs/thread-spawning-design.md): `parent_thread_id`
    // is an indexed projection of lineage_json's parentThreadId — lineage_json
    // stays the source of truth for the relationship, this column exists so
    // "who are my children" and subtree walks are an indexed query instead of a
    // JSON scan of every thread row. No backfill: no thread has ever carried a
    // `subagent` lineage (side chats are roots, parentThreadId null), so the
    // column ships empty, written only by the feature that owns it.
    addColumn(db, "threads", "parent_thread_id", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_parent
        ON threads (parent_thread_id, created_at);
    `);
    version = 16;
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
    addColumn(db, "gateway_ops", "dispatched", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_ops_undispatched
        ON gateway_ops (kind, dispatched);
    `);
    version = 17;
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
    withTransaction(db, () => {
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
    });
    version = 18;
  }

  if (version < 19) {
    // behind loadThreadPage's user-anchored windows. Pagination orders blocks
    // by the stable keyset (at, block_id); the pre-existing
    // (thread_id, seq) index cannot serve that order, forcing a temp B-tree
    // over all of a thread's blocks before the page LIMIT applies. With this
    // index the candidates scan is genuinely bounded by the page size.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_blocks_keyset
        ON blocks (thread_id, at, block_id);
    `);
    version = 19;
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
    version = 20;
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
    addColumn(db, "turn_usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "turn_usage", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "turn_usage", "reasoning_tokens", "INTEGER NOT NULL DEFAULT 0");
    version = 21;
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// ── windowed thread reads (user-anchored keyset cursor) ───────────────────────
// kone's block model: blocks are the turn analog, the anchor is a block's
// `at` (the user-visible timestamp — the analog of requested_at/started_at),
// and the tiebreak is the content-derived `block_id` string — deliberately NOT
// `seq`, the row_id analog (see loadThreadPage).

/** User blocks (user prompts) per page — each page's window ends at the
 *  limit-th newest prompt. */
const PAGE_DEFAULT_USER_BLOCKS = 10;
/** Ceiling multiplier over the user-block limit that bounds pathological
 *  fan-out (one prompt answered by dozens of turns) before the LIMIT applies
 *  — the raw fanout cap. */
const PAGE_RAW_FANOUT = 8;

/** Opaque, exclusive cursor for windowed thread reads. Encodes the thread id
 *  and the keyset boundary of an already-delivered page: the boundary block's
 *  anchor timestamp (`at`) and block id. Passing it back requests the adjacent
 *  disjoint slice of strictly older blocks under (at, block_id) ordering. */
export type ThreadPageCursor = {
  threadId: string;
  /** The boundary block's `at` — the user-anchored timestamp. */
  beforeAnchorAt: number;
  /** The boundary block's id; the string tiebreak (never the row id). */
  beforeBlockId: string;
};

/** One windowed page of a thread: metadata plus the slice's blocks in
 *  ascending timeline order, and the cursor for the next older page. */
export type StoredThreadPage = {
  threadId: string;
  meta: StoredThreadMeta;
  blocks: StoredBlock[];
  /** Cursor for the next strictly older page; null when the walk is complete.
   *  Opaque — consumers echo it back verbatim. */
  nextCursor: string | null;
  /** Whether older blocks exist beyond this page. */
  hasMore: boolean;
};

export function encodeThreadPageCursor(cursor: ThreadPageCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.threadId, a: cursor.beforeAnchorAt, i: cursor.beforeBlockId }),
  ).toString("base64url");
}

/** Returns null for anything that is not a well-formed cursor. Callers degrade
 *  a malformed or foreign-thread cursor to a first-page request. */
export function decodeThreadPageCursor(encoded: string): ThreadPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.t !== "string" || record.t.length === 0) return null;
  if (typeof record.a !== "number" || !Number.isFinite(record.a)) return null;
  if (typeof record.i !== "string" || record.i.length === 0) return null;
  return {
    threadId: record.t,
    beforeAnchorAt: record.a,
    beforeBlockId: record.i,
  };
}

/** Storage id for an assistant turn's block. `block_id` is globally UNIQUE, but
 *  a turn id is only unique *within* a thread — Claude numbers turns per session
 *  ("turn_1", "turn_2", …), so every thread's first turn shares the id "turn_1".
 *  Keying the block on the bare turn id let the first thread claim it and every
 *  later thread lose its assistant block to `ON CONFLICT DO NOTHING` (the reply
 *  items, keyed per-thread, survived with no block to render). Namespacing by
 *  thread restores global uniqueness. Codex's turn ids are already globally
 *  unique, so this is a no-op collision-wise for it — just a stable rename. */
function assistantBlockId(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

/** Current + longest run of consecutive local days from a sorted-ascending set
 *  of `YYYY-MM-DD` date strings. "Current" counts back from today; a gap of one
 *  day (activity yesterday but not today) still counts as live, so the streak
 *  doesn't reset the instant a new day begins before the first prompt. Days are
 *  compared as UTC-midnight epochs of the local date label, which sidesteps DST
 *  arithmetic (we only ever step by whole days). */
function computeStreaks(datesAsc: string[]): { current: number; longest: number } {
  if (datesAsc.length === 0) return { current: 0, longest: 0 };
  const DAY = 86_400_000;
  const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY;
  const days = datesAsc.map(toDay);

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i]! - days[i - 1]! === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // Walk back from the most recent active day, but only if it's today or
  // yesterday in the machine's local calendar.
  const todayLabel = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
  const today = toDay(todayLabel);
  const last = days[days.length - 1]!;
  let current = 0;
  if (today - last <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0; i--) {
      if (days[i]! - days[i - 1]! === 1) current++;
      else break;
    }
  }
  return { current, longest };
}

/** One-time recovery for threads whose assistant blocks were dropped by the
 *  block-id collision (see {@link assistantBlockId}). For every thread that has
 *  reply items under a turn with no matching assistant block, rebuild the block
 *  list — interleaving user prompts and assistant turns in arrival order — so
 *  the recovered replies render in place. Runs inside the v6 migration; guarded
 *  per-thread so one bad row can't abort the whole upgrade. */
function backfillOrphanedTurns(db: DatabaseSync): void {
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

export class ConversationStore {
  private db: DatabaseSync | null = null;
  private readonly statements = new Map<string, StatementSync>();

  /** @param userDataDir per-user state dir; defaults to the one the host
   *  injected at startup (see userDataDir.ts). Tests pass a temp dir. */
  constructor(private readonly userDataDir?: string) {}

  /** Cached statement preparation to avoid parsing and compiling SQL strings
   *  repeatedly on the high-frequency streaming path. */
  private prepare(db: DatabaseSync, sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }
  /** threadId → the provider conversation id already written for it. Events carry
   *  the id on every envelope (see ProviderRefs), including one per streamed text
   *  delta, so this memo keeps the capture to a single write per session instead
   *  of an UPDATE (and an fsync) per token. */
  private readonly knownConversationIds = new Map<string, string>();

  /** Open (and migrate) the database lazily on first use. Returns null and
   *  disables the store for the process if the DB can't be opened — persistence
   *  is a convenience, never a hard dependency. */
  private handle(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      const file = path.join(this.userDataDir ?? getUserDataDir(), "conversations.sqlite");
      const db = new DatabaseSync(file);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 2000");
      // WAL's default `synchronous = NORMAL` doesn't fsync on commit: the file
      // stays consistent through a crash, but transactions committed since the
      // last checkpoint can be *rolled back* by a power cut (SIGKILL is safe —
      // the page cache outlives the process; losing mains power is not). Rather
      // than pay an fsync on the streaming path — `item.updated` fires per text
      // delta, so that would be thousands per turn — the few low-frequency rows a
      // conversation can't be reconstructed without are committed through
      // `durably()` below, and the per-delta churn stays at NORMAL.
      db.exec("PRAGMA synchronous = NORMAL");
      migrate(db, file);
      this.db = db;
      // Recovery: this is the first DB open of a fresh process, so no session is
      // live — any assistant block still 'running' belongs to a turn whose
      // provider process died (quit/crash) without a session.exited seal. That
      // includes a turn parked waiting on an unanswered AskUserQuestion /
      // requestUserInput: the parked promise is in-memory only and cannot
      // survive a restart. Seal them here, once, so the
      // rehydrated thread reads settled — otherwise a stale 'running' block keeps
      // the renderer's `busy` true forever and the composer stays disabled. This
      // is reconciling orphaned pending state at the recovery point; kone's
      // simpler read model makes it a single UPDATE.
      this.sealOrphanedTurns(db);
      // Same recovery point, second pass: a spawned child that was reserved but
      // never dispatched (a crash between the row write and startThread) reads
      // terminal now, not "idle forever" (F8).
      this.sealUndispatchedSpawns(db);
      // Third pass: a queued turn stranded in 'promoting' (a crash between
      // claim and promote/release) belongs to no live process — release it
      // back to 'queued' so the next drain retries instead of skipping it.
      this.releaseOrphanedClaims(db);
      return db;
    } catch (err) {
      console.error("[conversation-store] could not open database:", err);
      return null;
    }
  }

  /** Commit `write` with an fsync behind it, so the rows it touches survive a
   *  power cut and not just a process kill. Scoped to one call because
   *  `synchronous` is a connection-level setting: raise it, commit, put it back.
   *  Reserved for the handful of writes a conversation can't be rebuilt without
   *  (the user's prompt, the provider resume id, a turn's start/settle) — never
   *  the per-delta item churn.
   *
   *  Must be called outside a transaction: SQLite rejects a safety-level change
   *  inside one ("Safety level may not be changed inside a transaction"), and the
   *  catch below would swallow that into a silently unfsynced write. Every write
   *  path here runs statement-per-statement; deleteThread is the only BEGIN, and
   *  it doesn't route through here. */
  private durably(db: DatabaseSync, write: () => void): void {
    try {
      db.exec("PRAGMA synchronous = FULL");
    } catch {
      // Couldn't raise it — the write below is still correct, just not fsynced.
    }
    try {
      write();
    } finally {
      try {
        db.exec("PRAGMA synchronous = NORMAL");
      } catch {
        /* leave it raised rather than fail the write */
      }
    }
  }

  /** Seal everything left mid-flight by a previous process. Safe to run only at
   *  first DB open (no live session yet): after startup a 'running' block is a
   *  genuinely live turn, so this must never be called on a per-thread read.
   *
   *  Two levels, because a crashed turn strands state at both. The assistant
   *  *block* goes 'interrupted' — otherwise a stale 'running' keeps the
   *  renderer's `busy` true forever and the composer stays disabled. The *items*
   *  inside it (a tool call that was executing, the reply text mid-stream) are
   *  sealed too: they have no live process to finish them, and a reopened thread
   *  that renders a settled turn around a permanently spinning tool row is the
   *  same stuck-state bug one level down. Best-effort — a failure just leaves the
   *  stale state, which is what we already had. */
  private sealOrphanedTurns(db: DatabaseSync): void {
    try {
      const now = Date.now();
      db.prepare(
        `UPDATE blocks SET state = 'interrupted', ended_at = ?
         WHERE role = 'assistant' AND state = 'running'`,
      ).run(now);
      // 'failed' rather than 'interrupted': RuntimeItemStatus has no interrupted
      // rung, and a half-run tool call did not succeed.
      db.prepare(
        `UPDATE items SET status = 'failed'
         WHERE status = 'in-progress'`,
      ).run();
      // Only the live rungs of SubagentStatus — 'stopped' is already settled.
      db.prepare(
        `UPDATE subagents SET status = 'failed', ended_at = COALESCE(ended_at, ?)
         WHERE status IN ('starting', 'running')`,
      ).run(now);
    } catch (err) {
      console.error("[conversation-store] could not seal orphaned turns:", err);
    }
  }

  /** Mark half-created spawned children as failed. A spawn reserves its
   *  gateway_ops row BEFORE the child thread is written and marks it dispatched
   *  only AFTER startThread returns (threadSpawn.ts); a crash in between — or
   *  right after the row write — leaves a `spawn.thread` op that was reserved
   *  but never dispatched, a durable "child exists" answer for a thread that
   *  never ran. Safe to run only at first DB open (no live session yet). Each
   *  such child gets a synthetic failed turn, so the spawn engine's boot
   *  fallback reads it as failed + terminal (with the reason) instead of
   *  projecting idle forever while the parent's wait times out (F8). Best-effort
   *  — a failure just leaves the stillborn read, which is already terminal. */
  private sealUndispatchedSpawns(db: DatabaseSync): void {
    try {
      const now = Date.now();
      const rows = db
        .prepare(
          `SELECT thread_id, turn_id, request_id, result_json FROM gateway_ops
            WHERE kind = 'spawn.thread' AND dispatched = 0 AND result_json != ''`,
        )
        .all() as Array<{
        thread_id: string;
        turn_id: string;
        request_id: string;
        result_json: string;
      }>;
      const childMeta = db.prepare(`SELECT lineage_json FROM threads WHERE thread_id = ?`);
      const hasAssistantBlock = db.prepare(
        `SELECT 1 FROM blocks WHERE thread_id = ? AND role = 'assistant' LIMIT 1`,
      );
      const insertFailedTurn = db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, turn_id, state, error, at, ended_at)
         VALUES (?, ?, 'assistant', '<undispatched>', 'failed', ?, ?, ?)
         ON CONFLICT(block_id) DO NOTHING`,
      );
      const markDispatched = db.prepare(
        `UPDATE gateway_ops SET dispatched = 1
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      );
      for (const row of rows) {
        let childId: string | undefined;
        try {
          const parsed = JSON.parse(row.result_json) as { threadId?: string };
          if (typeof parsed.threadId === "string") childId = parsed.threadId;
        } catch {
          childId = undefined;
        }
        if (!childId) continue;
        // The child row must still exist with subagent lineage and no real
        // turns yet — never clobber a child that actually ran.
        const meta = childMeta.get(childId) as { lineage_json: string } | undefined;
        if (!meta) continue;
        try {
          const lineage = JSON.parse(meta.lineage_json) as { relationshipToParent?: string };
          if (lineage.relationshipToParent !== "subagent") continue;
        } catch {
          continue;
        }
        if (hasAssistantBlock.get(childId)) continue;
        insertFailedTurn.run(
          assistantBlockId(childId, "<undispatched>"),
          childId,
          "The app exited before this thread's first turn was dispatched — the spawn never started. Ask the parent to spawn it again with a fresh requestId.",
          now,
          now,
        );
        // Mark the op dispatched so this is one-shot, not re-sealed every boot.
        markDispatched.run(row.thread_id, row.turn_id, row.request_id);
      }
    } catch (err) {
      console.error("[conversation-store] could not seal undispatched spawns:", err);
    }
  }

  /** Release every queued turn stranded in 'promoting'. Safe to run only at
   *  first DB open (no live session yet): after startup a 'promoting' row is a
   *  genuinely claimed turn, so this must never run against a live drain. A
   *  claim is a store-side state flip (attempt_count bump, no owner/expiry
   *  columns — the service layer owns those semantics), so a process killed
   *  between claim and promote/release leaves the row promotable-by-no-one;
   *  returning it to 'queued' (attempt_count preserved, exactly like
   *  releaseQueuedTurn) lets the next drain claim it again. */
  private releaseOrphanedClaims(db: DatabaseSync): void {
    try {
      const now = Date.now();
      db.prepare(
        `UPDATE queued_turns SET state = 'queued', updated_at = ?
          WHERE state = 'promoting'`,
      ).run(now);
    } catch (err) {
      console.error("[conversation-store] could not release orphaned claims:", err);
    }
  }

  /** Record (or refresh) the thread a session belongs to. Called when a session
   *  starts, so the project/provider/model association exists before any turn
   *  streams in. */
  ensureThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
  }): void {
    const db = this.handle();
    if (!db) return;
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO threads (
           thread_id, project_path, provider, model, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           project_path = excluded.project_path,
           provider     = excluded.provider,
           model        = COALESCE(excluded.model, threads.model),
           updated_at   = excluded.updated_at,
           last_activity_at = excluded.last_activity_at`,
      ).run(input.threadId, input.projectPath, input.provider, input.model ?? null, now, now, now);
    } catch (err) {
      console.error("[conversation-store] ensureThread failed:", err);
    }
  }

  /** Persist a user prompt as its own block. Written on send-turn, before the
   *  turn.started event, so it precedes the assistant turn in arrival order.
   *  Returns the 1-based user-turn count after the insert (so IPC can detect
   *  the first turn and kick off title naming). `0` on failure. */
  recordUserBlock(input: {
    threadId: string;
    text: string;
    at?: number;
    attachments?: ChatAttachment[];
  }): number {
    const db = this.handle();
    if (!db) return 0;
    try {
      const at = input.at ?? Date.now();
      // Durable: the prompt is the one row in a conversation that cannot be
      // reconstructed from anywhere else — the provider's own transcript may hold
      // the reply, but if kone loses the ask, the thread reads as an answer to
      // nothing. Cheap here: once per user turn, not per streamed delta.
      this.durably(db, () => {
        db.prepare(
          `INSERT INTO blocks (block_id, thread_id, role, text, at, attachments_json)
           VALUES (?, ?, 'user', ?, ?, ?)`,
        ).run(
          randomUUID(),
          input.threadId,
          input.text,
          at,
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
        );
      });
      this.touch(db, input.threadId, at);
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM blocks WHERE thread_id = ? AND role = 'user'`,
        )
        .get(input.threadId) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      console.error("[conversation-store] recordUserBlock failed:", err);
      return 0;
    }
  }

  /** Register an uploaded attachment's bytes-free metadata + on-disk path, so
   *  adapters can resolve `id → file` at dispatch (even after a reload) and a
   *  future GC pass can find orphaned files. Called by AttachmentStore right
   *  after the bytes are written. */
  registerAttachment(row: StoredAttachment): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO attachments
           (attachment_id, thread_id, type, name, mime_type, size_bytes, rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_id) DO UPDATE SET
           thread_id  = excluded.thread_id,
           type       = excluded.type,
           name       = excluded.name,
           mime_type  = excluded.mime_type,
           size_bytes = excluded.size_bytes,
           rel_path   = excluded.rel_path`,
      ).run(
        row.id,
        row.threadId,
        row.type,
        row.name,
        row.mimeType,
        row.sizeBytes,
        row.relPath,
        row.createdAt ?? Date.now(),
      );
    } catch (err) {
      console.error("[conversation-store] registerAttachment failed:", err);
    }
  }

  /** Every attachment registered under a single thread, not its descendants. */
  listThreadAttachments(threadId: string): StoredAttachment[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(`SELECT * FROM attachments WHERE thread_id = ?`)
        .all(threadId) as AttachmentRow[];
      return rows.map(rowToAttachment);
    } catch (err) {
      console.error("[conversation-store] listThreadAttachments failed:", err);
      return [];
    }
  }

  /** Every attachment registered under a thread and its spawned descendants —
   *  used to unlink on-disk files when the thread is destroyed. Delete drops
   *  the whole subtree's rows in one transaction; the files must go first
   *  while the registry can still resolve their paths, including children. */
  listSubtreeAttachments(threadId: string): StoredAttachment[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const ids = this.subtreeIds(db, threadId);
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT * FROM attachments WHERE thread_id IN (${placeholders})`)
        .all(...ids) as AttachmentRow[];
      return rows.map(rowToAttachment);
    } catch (err) {
      console.error("[conversation-store] listSubtreeAttachments failed:", err);
      return [];
    }
  }

  /** Resolve an attachment id back to its metadata + on-disk relative path.
   *  Null when unknown (never uploaded, or GC'd). */
  getAttachment(id: string): StoredAttachment | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT * FROM attachments WHERE attachment_id = ?`)
        .get(id) as AttachmentRow | undefined;
      return row ? rowToAttachment(row) : null;
    } catch (err) {
      console.error("[conversation-store] getAttachment failed:", err);
      return null;
    }
  }

  /** Read the thread's current working title, or null if unset / missing. */
  getTitle(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT title FROM threads WHERE thread_id = ?`)
        .get(threadId) as { title: string | null } | undefined;
      return row?.title ?? null;
    } catch (err) {
      console.error("[conversation-store] getTitle failed:", err);
      return null;
    }
  }

  /** Persist a working title. Used for the first-turn word fallback and the
   *  subsequent agent-generated rename. Deliberately does NOT touch
   *  `updated_at` / `last_activity_at`: a rename is bookkeeping, not
   *  conversation activity, and must not reshuffle the recents list. */
  setTitle(threadId: string, title: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET title = ? WHERE thread_id = ?`).run(title, threadId);
    } catch (err) {
      console.error("[conversation-store] setTitle failed:", err);
    }
  }

  /** User-initiated rename (agent:rename-thread). Same title-only semantics as
   *  setTitle — recency ordering is untouched, and an unchanged title is a
   *  no-op. Returns whether the title actually changed, so the IPC layer only
   *  broadcasts when something user-visible happened. */
  renameThread(threadId: string, title: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const current = db
        .prepare(`SELECT title FROM threads WHERE thread_id = ?`)
        .get(threadId) as { title: string | null } | undefined;
      if (!current) return false;
      if (current.title === title) return false;
      db.prepare(`UPDATE threads SET title = ? WHERE thread_id = ?`).run(title, threadId);
      return true;
    } catch (err) {
      console.error("[conversation-store] renameThread failed:", err);
      return false;
    }
  }

  /** Pin (or unpin) a thread. Pins live in the DB — not browser localStorage —
   *  so a pinned thread follows the thread across browser profiles and shows
 */
  setPinned(threadId: string, pinned: boolean): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET is_pinned = ? WHERE thread_id = ?`).run(
        pinned ? 1 : 0,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setPinned failed:", err);
    }
  }

  /** Persist the user's per-thread picker selection so a reopened thread
   *  restores it exactly (agent:set-thread-selection; fix_registry contract).
   *  `model` lands on the existing threads.model column (the display model);
   *  effort / serviceTier / contextWindow ride `model_selection_json` — the
   *  same axes SendTurnInput carries. Absent fields are left untouched. */
  setThreadSelection(
    threadId: string,
    selection: { model?: string; effort?: string; serviceTier?: string; contextWindow?: string },
  ): void {
    const db = this.handle();
    if (!db) return;
    try {
      // Merge over the stored knobs: a partial update (the picker commits one
      // axis at a time) must never wipe the knobs it didn't touch.
      const row = db
        .prepare(`SELECT model_selection_json FROM threads WHERE thread_id = ?`)
        .get(threadId) as { model_selection_json: string | null } | undefined;
      const knobs: { effort?: string; serviceTier?: string; contextWindow?: string } =
        parseJsonObject<{ effort?: string; serviceTier?: string; contextWindow?: string }>(
          row?.model_selection_json ?? null,
        ) ?? {};
      if (selection.effort !== undefined) knobs.effort = selection.effort;
      if (selection.serviceTier !== undefined) knobs.serviceTier = selection.serviceTier;
      if (selection.contextWindow !== undefined) knobs.contextWindow = selection.contextWindow;
      const json = Object.keys(knobs).length ? JSON.stringify(knobs) : null;
      db.prepare(
        `UPDATE threads
           SET model = COALESCE(?, model),
               model_selection_json = COALESCE(?, model_selection_json)
         WHERE thread_id = ?`,
      ).run(selection.model ?? null, json, threadId);
    } catch (err) {
      console.error("[conversation-store] setThreadSelection failed:", err);
    }
  }

  /** Persist the provider's own conversation id the moment it is first seen on an
   *  event envelope, rather than waiting for the turn that carries it to finish.
   *
   *  This is the fix for the hard-crash case. The id used to be written only by
   *  `turn.completed`, so a turn that never completed — power cut, SIGKILL, a
   *  crash mid-tool — left `conversation_id` NULL. On reopen the renderer had
   *  nothing to stage as a resume (useAgent's `pendingResumeId`), so the next
   *  send spawned a *fresh* CLI with no history: the transcript still rendered
   *  from `blocks`, but the provider behind it was blank, and "continue" meant
   *  nothing to it. Capturing on arrival means a thread is resumable from its
   *  first streamed event onward.
   *
   *  Memoized per thread so one write covers a whole session rather than one per
   *  event. Only ever moves the value forward — a resumed session reports its own
   *  new id, and never blanks a known one. The resume cursor advances as soon
   *  as a durable provider message names a session.
   *
   *  The memo is only set once a row has actually been updated. Adapters emit
   *  `session.started` — which carries the id — from inside startSession, i.e.
   *  before ipc.ts registers the thread, so on a brand-new thread the first
   *  attempt matches no row. Memoizing that would drop the id for the entire
   *  session, which is the very bug this method exists to fix; instead it retries
   *  on the next event, by which time the row exists. */
  /** Public entry for the session lifecycle layer (dispatch.startThread):
   *  persist the provider conversation id the moment startSession resolves —
   *  the crash window before the session.started fold — so a thread killed
   *  between session start and first event still reopens resumable. Same
   *  memoized, durable-write discipline as the event path. */
  captureConversationId(threadId: string, conversationId: string): void {
    const db = this.handle();
    if (!db || !conversationId) return;
    if (this.knownConversationIds.get(threadId) === conversationId) return;
    let written = false;
    this.durably(db, () => {
      const result = db
        .prepare(`UPDATE threads SET conversation_id = ? WHERE thread_id = ?`)
        .run(conversationId, threadId);
      written = Number(result.changes) > 0;
    });
    if (written) this.knownConversationIds.set(threadId, conversationId);
  }

  private captureConversationIdFromEvent(db: DatabaseSync, event: RuntimeEvent): void {
    const conversationId =
      event.refs?.conversationId ??
      (event.type === "turn.completed" ? event.conversationId : undefined);
    // `item.updated` is the per-delta type — thousands per turn. Every turn also
    // produces item.started and turn.completed, so the id lands from those
    // without hanging a write attempt (and an fsync) off every token.
    if (event.type === "item.updated") return;
    if (conversationId) this.captureConversationId(event.threadId, conversationId);
    this.captureResumeSessionAtFromEvent(db, event);
  }

  /** Claude's last assistant message uuid, captured live off every envelope's
   *  `refs.resumeSessionAt` — the anchor Claude's SDK needs for a reliable
   *  resume. Same discipline as conversationId:
   *  memoized per thread, written durably, never off an item.updated delta.
   *  Cleared on `session.started` when the anchor is absent — a fresh session,
   *  or a resume the provider refused (the adapter stops carrying the anchor,
   *  so the stored one is stale). */
  private readonly knownResumeAnchors = new Map<string, string | null>();

  private captureResumeSessionAtFromEvent(db: DatabaseSync, event: RuntimeEvent): void {
    const anchor = event.refs?.resumeSessionAt ?? null;
    if (event.type === "item.updated") return;
    if (event.type === "session.started" && !anchor) {
      // Fresh session (or a refused resume): the stored anchor is stale.
      if (this.knownResumeAnchors.get(event.threadId) === null) return;
      this.durably(db, () => {
        db.prepare(`UPDATE threads SET resume_session_at = NULL WHERE thread_id = ?`).run(
          event.threadId,
        );
      });
      this.knownResumeAnchors.set(event.threadId, null);
      return;
    }
    if (!anchor) return;
    if (this.knownResumeAnchors.get(event.threadId) === anchor) return;
    this.durably(db, () => {
      db.prepare(`UPDATE threads SET resume_session_at = ? WHERE thread_id = ?`).run(
        anchor,
        event.threadId,
      );
    });
    this.knownResumeAnchors.set(event.threadId, anchor);
  }

  /** Fold one normalized runtime event into the stored read model — the write
   *  half of persistence. Mirrors the renderer's reducer, but to rows. */
  applyEvent(event: RuntimeEvent): void {
    const db = this.handle();
    if (!db) return;
    try {
      // Before the per-type fold: any envelope may be the one that first names
      // the provider conversation, and the id must not wait for a turn to settle.
      this.captureConversationIdFromEvent(db, event);
      switch (event.type) {
        case "turn.started": {
          // Durable: the block is what anchors every item in the turn, so losing
          // it loses the reply even when the items themselves survived (the
          // failure mode the v6 migration had to repair after the fact).
          this.durably(db, () => {
            this.prepare(
              db,
              `INSERT INTO blocks (block_id, thread_id, role, turn_id, state, at)
               VALUES (?, ?, 'assistant', ?, 'running', ?)
               ON CONFLICT(block_id) DO NOTHING`,
            ).run(
              assistantBlockId(event.threadId, event.turnId),
              event.threadId,
              event.turnId,
              event.at,
            );
          });
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const it = event.item;
          this.prepare(
            db,
            `INSERT INTO items (item_id, thread_id, turn_id, kind, status, text, name, detail, tasks_json, subagent_tool_use_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id, turn_id, item_id) DO UPDATE SET
               kind        = excluded.kind,
               status      = excluded.status,
               text        = excluded.text,
               name        = excluded.name,
               detail      = excluded.detail,
               tasks_json  = excluded.tasks_json`,
          ).run(
            it.itemId,
            event.threadId,
            event.turnId,
            it.kind,
            it.status,
            it.text,
            it.name ?? null,
            it.detail ?? null,
            it.tasks?.length ? JSON.stringify(it.tasks) : null,
            event.subagentToolUseId ?? null,
          );
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "subagent.started":
        case "subagent.updated":
        case "subagent.completed": {
          // Whole-snapshot upsert, matching the item.* convention: the adapter
          // sends the full run each time, so there's no patch to merge here.
          const s = event.subagent;
          this.prepare(
            db,
            `INSERT INTO subagents (
               tool_use_id, thread_id, turn_id, task_id, parent_item_id, agent_type,
               description, prompt, model, effort, background, status, summary,
               last_tool_name, tokens, tool_uses, started_at, ended_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id, turn_id, tool_use_id) DO UPDATE SET
               task_id        = COALESCE(excluded.task_id, subagents.task_id),
               parent_item_id = COALESCE(excluded.parent_item_id, subagents.parent_item_id),
               agent_type     = COALESCE(excluded.agent_type, subagents.agent_type),
               description    = COALESCE(excluded.description, subagents.description),
               prompt         = COALESCE(excluded.prompt, subagents.prompt),
               model          = COALESCE(excluded.model, subagents.model),
               effort         = COALESCE(excluded.effort, subagents.effort),
               background     = COALESCE(excluded.background, subagents.background),
               status         = excluded.status,
               summary        = COALESCE(excluded.summary, subagents.summary),
               last_tool_name = COALESCE(excluded.last_tool_name, subagents.last_tool_name),
               tokens         = COALESCE(excluded.tokens, subagents.tokens),
               tool_uses      = COALESCE(excluded.tool_uses, subagents.tool_uses),
               ended_at       = COALESCE(excluded.ended_at, subagents.ended_at)`,
          ).run(
            s.toolUseId,
            event.threadId,
            event.turnId,
            s.taskId ?? null,
            s.parentItemId ?? null,
            s.agentType ?? null,
            s.description ?? null,
            s.prompt ?? null,
            s.model ?? null,
            s.effort ?? null,
            s.background === undefined ? null : s.background ? 1 : 0,
            s.status,
            s.summary ?? null,
            s.lastToolName ?? null,
            s.tokens ?? null,
            s.toolUses ?? null,
            s.startedAt,
            s.endedAt ?? null,
          );
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "turn.completed": {
          // `conversationId` is already handled by captureConversationId above —
          // it no longer waits for this event, which is the whole point of the
          // crash fix.
          this.durably(db, () => {
            // One transaction: the block settle and the side chat bootstrap
            // consumption must land together — a crash between them would
            // re-inject `<sidechat_context>` into the next turn.
            withTransaction(db, () => {
              this.prepare(
                db,
                `UPDATE blocks SET state = 'completed', ended_at = ?
                 WHERE block_id = ?`,
              ).run(event.at, assistantBlockId(event.threadId, event.turnId));
              // A side chat's first turn settling consumes the one-shot
              // `<sidechat_context>` bootstrap — the imported transcript has
              // reached the model, so it is never injected again.
              this.completeSidechatBootstrap(db, event.threadId);
            });
          });
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "turn.aborted": {
          const state = event.reason === "interrupted" ? "interrupted" : "failed";
          this.durably(db, () => {
            this.prepare(
              db,
              `UPDATE blocks SET state = ?, error = ?, ended_at = ?
               WHERE block_id = ?`,
            ).run(
              state,
              event.message ?? null,
              event.at,
              assistantBlockId(event.threadId, event.turnId),
            );
          });
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "thread.token-usage.updated": {
          // The rollup update, the context snapshot and the per-turn audit row
          // are one fold — wrap them so a crash can't leave a half-written
          // usage state.
          withTransaction(db, () => {
            const total = event.usage.total;
            if (typeof total === "number" && Number.isFinite(total)) {
              // Codex, OpenCode and Cursor report running thread totals (keep the
              // max); Claude reports per-turn spend (accumulate).
              const isRunningTotal =
                event.provider === "codex" ||
                event.provider === "opencode" ||
                event.provider === "cursor";
              const sql = isRunningTotal
                  ? `UPDATE threads SET tokens = MAX(COALESCE(tokens, 0), ?) WHERE thread_id = ?`
                  : `UPDATE threads SET tokens = COALESCE(tokens, 0) + ? WHERE thread_id = ?`;
              db.prepare(sql).run(Math.round(total), event.threadId);
            }
            // Snapshot the live context-window fill (overwrite, not accumulate)
            // so a reopened thread restores its meter without waiting for a
            // turn. A provider may report only part of the picture (a fresh
            // fill without the window, or a window change without a fill), so
            // each column is overwritten only when that field is present — a
            // partial payload must never blank a value the thread already knew.
            const { contextUsed, contextWindow, compactsAutomatically } = event.usage;
            if (
              (typeof contextWindow === "number" && Number.isFinite(contextWindow)) ||
              (typeof contextUsed === "number" && Number.isFinite(contextUsed))
            ) {
              const compacts =
                compactsAutomatically === undefined ? null : compactsAutomatically ? 1 : 0;
              db.prepare(
                `UPDATE threads
                   SET context_used   = COALESCE(?, context_used),
                       context_window = COALESCE(?, context_window),
                       compacts_auto  = COALESCE(?, compacts_auto)
                 WHERE thread_id = ?`,
              ).run(
                typeof contextUsed === "number" && Number.isFinite(contextUsed)
                  ? Math.round(contextUsed)
                  : null,
                typeof contextWindow === "number" && Number.isFinite(contextWindow)
                  ? Math.round(contextWindow)
                  : null,
                compacts,
                event.threadId,
              );
            }
            // Per-turn audit trail (v18): keep the input/output/total split for
            // the turn currently streaming — keyed by the latest assistant
            // block, which is the turn these numbers belong to. Survives
            // restart even though the thread-level `tokens` scalar only keeps
            // the rollup.
            const turnRow = db
              .prepare(
                `SELECT turn_id FROM blocks
                  WHERE thread_id = ? AND role = 'assistant'
                  ORDER BY seq DESC LIMIT 1`,
              )
              .get(event.threadId) as { turn_id: string | null } | undefined;
            if (turnRow?.turn_id) {
              const { input, output } = event.usage;
              // The cache/reasoning split rides on `event.usage` as extra
              // properties beyond TokenUsage's declared shape (see
              // TokenUsageSplits in usage/report.ts for why it isn't a
              // first-class field on that type yet) — every adapter now
              // attaches it, defaulting to 0 itself where it has no such
              // count, but this read defaults again so a payload from an
              // adapter this store doesn't recognise (or a test) still
              // records real zeros instead of throwing.
              const splits = event.usage as TokenUsage & Partial<TokenUsageSplits>;
              this.recordTurnUsage(db, event.threadId, turnRow.turn_id, event.at, {
                input,
                output,
                total,
                cacheReadTokens: splits.cacheReadTokens ?? 0,
                cacheCreationTokens: splits.cacheCreationTokens ?? 0,
                reasoningTokens: splits.reasoningTokens ?? 0,
              });
            }
          });
          break;
        }
        case "session.exited": {
          // Seal any turn left running when the process died — mirrors the
          // renderer marking in-flight assistant blocks as failed.
          db.prepare(
            `UPDATE blocks SET state = 'failed', ended_at = ?
             WHERE thread_id = ? AND role = 'assistant' AND state = 'running'`,
          ).run(event.at, event.threadId);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("[conversation-store] applyEvent failed:", err);
    }
  }

  /** Upsert one turn's usage audit row (v18's input/output/total, v21's
   *  cache/reasoning split) — a full replacement of the row's numbers, never
   *  an accumulation, because `thread.token-usage.updated` always carries the
   *  turn's latest known totals rather than a delta. The three split counts
   *  default to 0 rather than staying `undefined`/NULL: a provider that
   *  hasn't reported one yet and a provider that structurally never will
   *  should look identical in this table (both "no cache tokens for this
   *  turn"), so SUM() over the column is always correct without a COALESCE
   *  at every read site. */
  private recordTurnUsage(
    db: DatabaseSync,
    threadId: string,
    turnId: string,
    at: number,
    usage: {
      input?: number;
      output?: number;
      total?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      reasoningTokens?: number;
    },
  ): void {
    db.prepare(
      `INSERT INTO turn_usage
         (thread_id, turn_id, input_tokens, output_tokens, total_tokens,
          cache_read_tokens, cache_creation_tokens, reasoning_tokens, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, turn_id) DO UPDATE SET
         input_tokens          = excluded.input_tokens,
         output_tokens         = excluded.output_tokens,
         total_tokens          = excluded.total_tokens,
         cache_read_tokens     = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         reasoning_tokens      = excluded.reasoning_tokens,
         at                    = excluded.at`,
    ).run(
      threadId,
      turnId,
      typeof usage.input === "number" && Number.isFinite(usage.input) ? Math.round(usage.input) : null,
      typeof usage.output === "number" && Number.isFinite(usage.output) ? Math.round(usage.output) : null,
      typeof usage.total === "number" && Number.isFinite(usage.total) ? Math.round(usage.total) : null,
      Math.round(usage.cacheReadTokens ?? 0),
      Math.round(usage.cacheCreationTokens ?? 0),
      Math.round(usage.reasoningTokens ?? 0),
      at,
    );
  }

  private touch(db: DatabaseSync, threadId: string, at: number): void {
    // Bumps both clocks: `updated_at` is the generic "row changed" stamp,
    // `last_activity_at` is the recency ordering key (title/archive bookkeeping
    // touches only the former — see renameThread).
    this.prepare(
      db,
      `UPDATE threads SET updated_at = ?, last_activity_at = ? WHERE thread_id = ?`,
    ).run(at, at, threadId);
  }

  /** Snapshot the project's branch + working-tree diffstat onto the thread.
   *  Called (best-effort, off an async git read) when a turn settles, so the
   *  row reflects the repo state the session left behind. */
  recordRepoStats(input: {
    threadId: string;
    branch?: string | null;
    added?: number;
    removed?: number;
  }): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE threads SET
           branch  = ?,
           added   = ?,
           removed = ?
         WHERE thread_id = ?`,
      ).run(
        input.branch ?? null,
        input.added ?? null,
        input.removed ?? null,
        input.threadId,
      );
    } catch (err) {
      console.error("[conversation-store] recordRepoStats failed:", err);
    }
  }

  /** The working-tree snapshot recorded when this thread began, or null if none
   *  has been set yet. The settled diffstat is measured against this, so the
   *  numbers reflect only what the conversation changed. */
  getBaseline(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT base_tree FROM threads WHERE thread_id = ?`)
        .get(threadId) as { base_tree: string | null } | undefined;
      return row?.base_tree ?? null;
    } catch (err) {
      console.error("[conversation-store] getBaseline failed:", err);
      return null;
    }
  }

  /** Record the conversation's baseline snapshot. Written once, when the thread
   *  starts — later calls are guarded by the caller so a resumed session never
   *  rebases an in-flight conversation's diff onto a fresh baseline. */
  setBaseline(threadId: string, baseTree: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET base_tree = ? WHERE thread_id = ?`).run(
        baseTree,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setBaseline failed:", err);
    }
  }

  // A follow-up sent while a turn runs is durably enqueued here, claimed by
  // the service layer when the live turn settles, and cancelled when the
  // thread is deleted. Lifecycle: 'queued' → 'promoting' → 'promoted'
  // (claim → promote), 'promoting' → 'queued' (claim → release: the drain
  // failed and the turn must not be lost), and any active state → 'cancelled'
  // (stop/delete). Only the ACTIVE states count as pending: a settled row
  // (promoted/cancelled) is inert history, and a later releaseClaim must never
  // match a cancelled row — that resurrection bug is why cancel flips BOTH

  /** Durably enqueue a turn for `threadId`. The partial unique index on
   *  (thread_id, user_block_id) over the active states makes a replayed
   *  enqueue — the same prompt delivered twice by a retrying caller — a
   *  no-op. Returns whether a row was actually inserted. */
  enqueueQueuedTurn(input: QueuedTurnEnqueueInput): boolean {
    const db = this.handle();
    if (!db) return false;
    const now = input.at ?? Date.now();
    let inserted = false;
    this.durably(db, () => {
      const result = db
        .prepare(
          `INSERT INTO queued_turns (
             queue_id, thread_id, user_block_id, dispatch_mode, state, input,
             attachments_json, model, mode, effort, service_tier, context_window,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (thread_id, user_block_id)
             WHERE state IN ('queued', 'promoting') DO NOTHING`,
        )
        .run(
          input.queueId,
          input.threadId,
          input.userBlockId,
          input.dispatchMode ?? "queue",
          input.input,
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
          input.model ?? null,
          input.mode ?? null,
          input.effort ?? null,
          input.serviceTier ?? null,
          input.contextWindow ?? null,
          now,
          now,
        );
      inserted = Number(result.changes) > 0;
    });
    return inserted;
  }

  /** Claim the next queued turn for `threadId` (atomically — one statement:
   *  the candidate subquery and the state flip share the statement's write
   *  lock, so two racing drains serialize and the loser sees no 'queued'
   *  candidate). Steer rows jump the line, most recent steer first, then plain
   *  FIFO by created_at
   *  `CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END, steer seq DESC,
   *  seq ASC`, with queue_id as the final deterministic tiebreak. Returns the
   *  row now in 'promoting' (attempt_count already bumped), or null when the
   *  thread has nothing active to claim. */
  claimNextQueuedTurn(threadId: string): QueuedTurnRow | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const now = Date.now();
      const row = db
        .prepare(
          `UPDATE queued_turns
              SET state = 'promoting',
                  attempt_count = attempt_count + 1,
                  updated_at = ?
            WHERE queue_id = (
              SELECT queue_id FROM queued_turns
               WHERE thread_id = ? AND state = 'queued'
               ORDER BY
                 CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
                 CASE WHEN dispatch_mode = 'steer' THEN created_at END DESC,
                 created_at ASC,
                 queue_id ASC
               LIMIT 1
            )
           RETURNING *`,
        )
        .get(now, threadId) as QueuedTurnDbRow | undefined;
      return row ? rowToQueuedTurn(row) : null;
    } catch (err) {
      console.error("[conversation-store] claimNextQueuedTurn failed:", err);
      return null;
    }
  }

  /** Settle a claimed turn: 'promoting' → 'promoted'. WHERE state='promoting'
   *  makes a lost claim fail loudly — promoting a row nobody claimed would
   *  silently drop a queued turn's retry (return false and the service layer
   *  falls back to release/reclaim). */
  markQueuedTurnPromoted(queueId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const now = Date.now();
      const result = db
        .prepare(
          `UPDATE queued_turns
              SET state = 'promoted', promoted_at = ?, updated_at = ?
            WHERE queue_id = ? AND state = 'promoting'`,
        )
        .run(now, now, queueId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] markQueuedTurnPromoted failed:", err);
      return false;
    }
  }

  /** Give a claimed turn back: 'promoting' → 'queued' so the next drain
   *  retries it. attempt_count is preserved (the retry ledger stays honest).
   *  Returns false when the row is not in 'promoting' — the cancelled-row
   *  resurrection guard: cancelQueuedTurnsForThread flips 'promoting' rows to
   *  'cancelled' first, so a drain's late release can no longer match. */
  releaseQueuedTurn(queueId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(
          `UPDATE queued_turns SET state = 'queued', updated_at = ?
            WHERE queue_id = ? AND state = 'promoting'`,
        )
        .run(Date.now(), queueId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] releaseQueuedTurn failed:", err);
      return false;
    }
  }

  /** Cancel ONE queued turn (the UI's per-item cancel). Only active rows can
   *  flip — a promoted turn already started, so claiming it was cancelled
   *  would be a lie. Returns whether a row flipped. */
  cancelQueuedTurn(queueId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(
          `UPDATE queued_turns SET state = 'cancelled', updated_at = ?
            WHERE queue_id = ? AND state IN ('queued', 'promoting')`,
        )
        .run(Date.now(), queueId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] cancelQueuedTurn failed:", err);
      return false;
    }
  }

  /** Cancel every active queued turn for a thread (stop/delete path). Flips
   *  racing the cancellation may hold a row in 'promoting'; if only 'queued'
   *  flipped, that drain's error path could `releaseQueuedTurn` the row back
   *  to 'queued', resurrecting a turn the user cancelled. Returns the
   *  cancelled queue ids. */
  cancelQueuedTurnsForThread(threadId: string): string[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `UPDATE queued_turns SET state = 'cancelled', updated_at = ?
            WHERE thread_id = ? AND state IN ('queued', 'promoting')
           RETURNING queue_id`,
        )
        .all(Date.now(), threadId) as Array<{ queue_id: string }>;
      return rows.map((r) => r.queue_id);
    } catch (err) {
      console.error("[conversation-store] cancelQueuedTurnsForThread failed:", err);
      return [];
    }
  }

  /** Active queued turns for a thread, in execution order — the same steer-
   *  first (newest steer first) then FIFO ordering claimNext uses, so the UI
   *  shows exactly what will run next. Settled rows (promoted/cancelled) are
   *  excluded: they are history, not queue. */
  listQueuedTurns(threadId: string): QueuedTurnRow[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT * FROM queued_turns
            WHERE thread_id = ? AND state IN ('queued', 'promoting')
            ORDER BY
              CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
              CASE WHEN dispatch_mode = 'steer' THEN created_at END DESC,
              created_at ASC,
              queue_id ASC`,
        )
        .all(threadId) as QueuedTurnDbRow[];
      return rows.map(rowToQueuedTurn);
    } catch (err) {
      console.error("[conversation-store] listQueuedTurns failed:", err);
      return [];
    }
  }

  /** The thread and every spawned descendant (subtree), in stable
   *  ancestor-first order — archive/delete operate on the whole subtree
 */
  private subtreeIds(db: DatabaseSync, threadId: string): string[] {
    const out: string[] = [threadId];
    const childOf = db.prepare(`SELECT thread_id FROM threads WHERE parent_thread_id = ?`);
    let frontier = [threadId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const r of childOf.all(id) as Array<{ thread_id: string }>) {
          // Cycle-guarded: a corrupted parent pointer must not loop forever.
          if (!out.includes(r.thread_id)) {
            out.push(r.thread_id);
            next.push(r.thread_id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Whether any thread in the set has a live turn — a running assistant
   *  block, or a subagent still starting/running. The busy guard for
   *  archive/delete: a spawned child mid-turn must never be archived or
 */
  private subtreeBusy(db: DatabaseSync, threadIds: string[]): boolean {
    if (threadIds.length === 0) return false;
    const placeholders = threadIds.map(() => "?").join(",");
    const runningBlock = db
      .prepare(
        `SELECT 1 FROM blocks
          WHERE thread_id IN (${placeholders}) AND role = 'assistant' AND state = 'running'
          LIMIT 1`,
      )
      .get(...threadIds);
    if (runningBlock) return true;
    const runningSubagent = db
      .prepare(
        `SELECT 1 FROM subagents
          WHERE thread_id IN (${placeholders}) AND status IN ('starting', 'running')
          LIMIT 1`,
      )
      .get(...threadIds);
    // `null` means "no row" — `!== undefined` would wrongly treat it as busy.
    return Boolean(runningSubagent);
  }

  /** Pre-flight guard for the destructive IPC path: the ipc layer checks this
   *  BEFORE unlinking attachment files (which must happen before the rows go,
   *  so the registry can resolve the paths). */
  canDeleteThread(threadId: string): { ok: true } | { ok: false; reason: "missing" | "busy" } {
    const db = this.handle();
    if (!db) return { ok: false, reason: "missing" };
    try {
      const exists = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`)
        .get(threadId);
      if (!exists) return { ok: false, reason: "missing" };
      return this.subtreeBusy(db, this.subtreeIds(db, threadId))
        ? { ok: false, reason: "busy" }
        : { ok: true };
    } catch (err) {
      console.error("[conversation-store] canDeleteThread failed:", err);
      return { ok: false, reason: "missing" };
    }
  }

  /** Hide (or restore) a thread and its spawned subtree from the recent list
   *  without destroying them. `archived` is a timestamp so a future "archived"
   *  view can order by it. Refuses (and returns the reason) when a spawned
   *  descendant is mid-turn. */
  setArchived(
    threadId: string,
    archived: boolean,
  ): { ok: true } | { ok: false; reason: "missing" | "busy" | "error" } {
    const db = this.handle();
    if (!db) return { ok: false, reason: "missing" };
    try {
      const ids = this.subtreeIds(db, threadId);
      const exists = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`)
        .get(threadId);
      if (!exists) return { ok: false, reason: "missing" };
      if (archived && this.subtreeBusy(db, ids)) {
        console.warn(
          `[conversation-store] refusing to archive ${threadId}: a spawned descendant is mid-turn`,
        );
        return { ok: false, reason: "busy" };
      }
      // Queued turns deliberately SURVIVE archive: kone's archive is a
      // reversible hide/reveal toggle — it never stops a session and nothing
      // gates sends on `archived`, so a restored thread's queue is still
      // thread.archived STOPS the provider session; kone has no such stop.
      // Queued rows are cancelled on deleteThread only (the durable-queue
      // contract: a deleted thread's turns can never resurrect).
      const stamp = archived ? Date.now() : null;
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`UPDATE threads SET archived = ? WHERE thread_id IN (${placeholders})`).run(
        stamp,
        ...ids,
      );
      return { ok: true };
    } catch (err) {
      console.error("[conversation-store] setArchived failed:", err);
      return { ok: false, reason: "error" };
    }
  }

  /** Permanently remove a thread, its spawned subtree, and everything under
   *  them. Irreversible — the renderer confirms before calling. Refuses (and
   *  returns the reason) when a spawned descendant is mid-turn. */
  deleteThread(
    threadId: string,
  ): { ok: true } | { ok: false; reason: "missing" | "busy" | "error" } {
    const db = this.handle();
    if (!db) return { ok: false, reason: "missing" };
    try {
      const ids = this.subtreeIds(db, threadId);
      const exists = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`)
        .get(threadId);
      if (!exists) return { ok: false, reason: "missing" };
      if (this.subtreeBusy(db, ids)) {
        console.warn(
          `[conversation-store] refusing to delete ${threadId}: a spawned descendant is mid-turn`,
        );
        return { ok: false, reason: "busy" };
      }
      const placeholders = ids.map(() => "?").join(",");
      withTransaction(db, () => {
        db.prepare(`DELETE FROM items       WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM blocks      WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM attachments WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM subagents   WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM gateway_ops WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM turn_usage  WHERE thread_id IN (${placeholders})`).run(...ids);
        // Queued turns die with the thread: a deleted thread's follow-ups must
        // never survive to resurrect (same contract as cancelQueuedTurnsForThread
        // on the stop path — the rows are gone either way, so no in-flight
        // release can bring them back).
        db.prepare(`DELETE FROM queued_turns WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM threads     WHERE thread_id IN (${placeholders})`).run(...ids);
      });
      for (const id of ids) this.knownConversationIds.delete(id);
      return { ok: true };
    } catch (err) {
      console.error("[conversation-store] deleteThread failed:", err);
      return { ok: false, reason: "error" };
    }
  }

  /** Every attachment row in the registry, across all threads — the GC sweep's
   *  "referenced set" (orphaned on-disk files are anything NOT in this set). */
  listAllAttachments(): StoredAttachment[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db.prepare(`SELECT * FROM attachments`).all() as AttachmentRow[];
      return rows.map(rowToAttachment);
    } catch (err) {
      console.error("[conversation-store] listAllAttachments failed:", err);
      return [];
    }
  }

  /** Drop one attachment's registry row. Used by AttachmentStore when unlinking
   *  its bytes failed — the row must not keep claiming a file that GC will
   *  otherwise sweep (the file becomes orphan-eligible instead of owned). */
  forgetAttachment(attachmentId: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`DELETE FROM attachments WHERE attachment_id = ?`).run(attachmentId);
    } catch (err) {
      console.error("[conversation-store] forgetAttachment failed:", err);
    }
  }

  /** The project path a thread belongs to — so the IPC layer can run git against
   *  it after a turn without threading the cwd through the event stream. */
  threadProjectPath(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT project_path FROM threads WHERE thread_id = ?`)
        .get(threadId) as { project_path: string } | undefined;
      return row?.project_path ?? null;
    } catch (err) {
      console.error("[conversation-store] threadProjectPath failed:", err);
      return null;
    }
  }

  /** Cheap metadata lookup by id — used when the live session isn't in memory
   *  (e.g. title naming right after send) but the store row already exists. */
  threadMeta(threadId: string): StoredThreadMeta | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(threadId) as ThreadRow | undefined;
      return row ? rowToMeta(row) : null;
    } catch (err) {
      console.error("[conversation-store] threadMeta failed:", err);
      return null;
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The most recently active thread for a project, without its transcript.
   *  Cheap enough to poll when opening a project. */
  latestThreadMeta(projectPath: string): StoredThreadMeta | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT * FROM threads WHERE project_path = ? AND archived IS NULL
           ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 1`,
        )
        .get(projectPath) as ThreadRow | undefined;
      return row ? rowToMeta(row) : null;
    } catch (err) {
      console.error("[conversation-store] latestThreadMeta failed:", err);
      return null;
    }
  }

  /** The most recently active thread for a project, fully reconstructed into the
   *  same UserBlock | AssistantBlock shape the renderer timeline uses — so the
   *  renderer can drop it straight into `blocks` on rehydrate. */
  latestThread(projectPath: string): StoredThread | null {
    const meta = this.latestThreadMeta(projectPath);
    return meta ? this.loadThread(meta.threadId) : null;
  }

  /** Fast indexed lookup for the ID of the most recent user block in a thread,
   *  avoiding full-transcript parsing on turn enqueues. */
  latestUserBlockId(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = this.prepare(
        db,
        `SELECT block_id FROM blocks WHERE thread_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
      ).get(threadId) as { block_id: string } | undefined;
      return row?.block_id ?? null;
    } catch {
      return null;
    }
  }

  /** Reconstruct one thread by id: its metadata plus every block in arrival
   *  order, each assistant turn carrying its ordered items. */
  loadThread(threadId: string): StoredThread | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const threadRow = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(threadId) as ThreadRow | undefined;
      if (!threadRow) return null;

      const blockRows = db
        .prepare(`SELECT * FROM blocks WHERE thread_id = ? ORDER BY seq`)
        .all(threadId) as BlockRow[];
      const items = this.loadTurnParts(db, threadId);

      return {
        ...rowToMeta(threadRow),
        blocks: assembleBlocks(blockRows, items.itemRows, items.subagentRows),
      };
    } catch (err) {
      console.error("[conversation-store] loadThread failed:", err);
      return null;
    }
  }

  /** Load a thread's items + subagent rows (the "parts" inside its turns).
   *  Shared by the full read and the windowed page read, which slices blocks
   *  first and then fetches parts only for the turns the slice covers. */
  private loadTurnParts(
    db: DatabaseSync,
    threadId: string,
    turnIds?: string[],
  ): { itemRows: ItemRow[]; subagentRows: SubagentRow[] } {
    if (turnIds && turnIds.length === 0) {
      return { itemRows: [], subagentRows: [] };
    }
    const itemRows = turnIds
      ? (db
          .prepare(
            `SELECT * FROM items WHERE thread_id = ? AND turn_id IN (${turnIds.map(() => "?").join(",")})
             ORDER BY turn_id, seq`,
          )
          .all(threadId, ...turnIds) as ItemRow[])
      : (db
          .prepare(`SELECT * FROM items WHERE thread_id = ? ORDER BY turn_id, seq`)
          .all(threadId) as ItemRow[]);
    const subagentRows = turnIds
      ? (db
          .prepare(
            `SELECT * FROM subagents WHERE thread_id = ? AND turn_id IN (${turnIds.map(() => "?").join(",")})
             ORDER BY turn_id, seq`,
          )
          .all(threadId, ...turnIds) as SubagentRow[])
      : (db
          .prepare(`SELECT * FROM subagents WHERE thread_id = ? ORDER BY turn_id, seq`)
          .all(threadId) as SubagentRow[]);
    return { itemRows, subagentRows };
  }

  /** Windowed thread read — kone's blocks are the turn analog. Loads the newest page of blocks whose
   *  window ends at the `limit`-th newest user prompt (the user-anchored
   *  boundary), walking back from the exclusive keyset cursor when one is
   *  given. Blocks come back in ascending timeline order, each assistant turn
   *  carrying its ordered items, plus the opaque cursor for the next older
   *  page (null when the thread has no older blocks).
   *
   * The cursor deliberately encodes (at, block_id) — NOT `seq`, the row-id
   * analog: seq is renumbered by the delete+reinsert of fork-import copying
   * and any future compaction/rebuild, which would silently invalidate every
   * persisted cursor. `at` and `block_id` are event-derived content, so
   * cursors survive rewrites, and the thread id rides inside the cursor so it
   * can never be replayed against a different thread (a foreign or malformed
   * cursor degrades to a first-page request). */
  loadThreadPage(
    threadId: string,
    options?: { limit?: number; maxRaw?: number; cursor?: string },
  ): StoredThreadPage | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const threadRow = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(threadId) as ThreadRow | undefined;
      if (!threadRow) return null;

      const limit = Math.max(1, Math.min(options?.limit ?? PAGE_DEFAULT_USER_BLOCKS, 200));
      const maxRaw = Math.max(limit, options?.maxRaw ?? limit * PAGE_RAW_FANOUT);
      const cursor = options?.cursor
        ? decodeThreadPageCursor(options.cursor)
        : null;
      // A cursor minted for a different thread must not walk this one — treat
      // it as a first-page request.
      const boundary = cursor && cursor.threadId === threadId ? cursor : null;

      const candidates = (
        boundary
          ? db
              .prepare(
                `SELECT * FROM blocks
                  WHERE thread_id = ?
                    AND (at < ? OR (at = ? AND block_id < ?))
                  ORDER BY at DESC, block_id DESC
                  LIMIT ?`,
              )
              .all(threadId, boundary.beforeAnchorAt, boundary.beforeAnchorAt, boundary.beforeBlockId, maxRaw)
          : db
              .prepare(`SELECT * FROM blocks WHERE thread_id = ? ORDER BY at DESC, block_id DESC LIMIT ?`)
              .all(threadId, maxRaw)
      ) as BlockRow[];

      // Walk newest → oldest until the limit-th user prompt is included (the
      // user-anchored window boundary; a fan-out run of assistant blocks
      // between prompts rides along). The maxRaw ceiling bounds pathological
      // fan-out — a walk cut by it simply pages an unanchored slice and keeps
      // going, capped by the raw fanout limit.
      const kept: BlockRow[] = [];
      let userSeen = 0;
      for (const row of candidates) {
        kept.push(row);
        if (row.role === "user") {
          userSeen += 1;
          if (userSeen >= limit) break;
        }
      }
      if (kept.length === 0) {
        return {
          threadId,
          meta: rowToMeta(threadRow),
          blocks: [],
          nextCursor: null,
          hasMore: false,
        };
      }

      const oldest = kept[kept.length - 1]!;
      const hasMore =
        db
          .prepare(
            `SELECT 1 FROM blocks
              WHERE thread_id = ? AND (at < ? OR (at = ? AND block_id < ?))
              LIMIT 1`,
          )
          .get(threadId, oldest.at, oldest.at, oldest.block_id) != null;

      const turnIds = [...new Set(kept.map((b) => b.turn_id).filter((t): t is string => Boolean(t)))];
      const parts = this.loadTurnParts(db, threadId, turnIds);
      // Oldest-first, the renderer timeline order. Reversing the DESC walk is
      // exactly (at, block_id) ASC — deterministic across pages, so a cursor
      // walk can never skip or repeat a block.
      const blocks = assembleBlocks(kept.reverse(), parts.itemRows, parts.subagentRows);

      return {
        threadId,
        meta: rowToMeta(threadRow),
        blocks,
        nextCursor: hasMore
          ? encodeThreadPageCursor({
              threadId,
              beforeAnchorAt: oldest.at,
              beforeBlockId: oldest.block_id,
            })
          : null,
        hasMore,
      };
    } catch (err) {
      console.error("[conversation-store] loadThreadPage failed:", err);
      return null;
    }
  }

  /** Every thread for a project (metadata only), newest first — the backing
   *  read for the "recent conversations" block. Only threads that have at
   *  least one user turn are returned (a started-but-empty session stays out
   *  of the list). */
  listThreads(projectPath: string): StoredThreadMeta[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT t.* FROM threads t
           WHERE t.project_path = ? AND t.archived IS NULL
             AND EXISTS (
               SELECT 1 FROM blocks b
               WHERE b.thread_id = t.thread_id AND b.role = 'user'
             )
           ORDER BY COALESCE(t.last_activity_at, t.updated_at) DESC`,
        )
        .all(projectPath) as ThreadRow[];
      return rows.map(rowToMeta);
    } catch (err) {
      console.error("[conversation-store] listThreads failed:", err);
      return [];
    }
  }

  /** Lifetime, fully-local usage stats for the profile board. Every figure is
   *  aggregated in SQL across *all* projects (no project filter) — a handful of
   *  grouped scans over the existing indexes, so it stays cheap even on a large
   *  store. Day/hour buckets use SQLite's `localtime` modifier so the heatmap
   *  and "most active hour" read in the user's own timezone. A "prompt" is one
   *  user block; only threads that carry at least one user prompt are counted,
   *  matching listThreads (archived threads are kept — they are still history). */
  profileStats(): ProfileStats {
    const empty: ProfileStats = {
      generatedAt: Date.now(),
      totals: { threads: 0, prompts: 0, tokens: 0, inputTokens: 0, outputTokens: 0, projects: 0 },
      streak: { current: 0, longest: 0, peakDay: null },
      activity: [],
      hours: [],
      mostActiveHour: null,
      providers: [],
      models: [],
      reasoning: [],
      projects: [],
    };
    const db = this.handle();
    if (!db) return empty;
    try {
      // Threads with a real user turn — the population every count below rides.
      const REAL = `SELECT thread_id, project_path, provider, model, model_selection_json
        FROM threads t WHERE EXISTS (
          SELECT 1 FROM blocks b WHERE b.thread_id = t.thread_id AND b.role = 'user'
        )`;

      const totalsRow = db
        .prepare(
          `SELECT COUNT(*) AS threads, COUNT(DISTINCT project_path) AS projects
           FROM (${REAL})`,
        )
        .get() as { threads: number; projects: number };

      const prompts = (
        db.prepare(`SELECT COUNT(*) AS n FROM blocks WHERE role = 'user'`).get() as { n: number }
      ).n;

      // Tokens: prefer the per-turn audit trail; fall back to the threads'
      // cumulative scalar when no turn_usage rows exist yet (older stores).
      const usage = db
        .prepare(
          `SELECT COALESCE(SUM(total_tokens), 0) AS total,
                  COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output
           FROM turn_usage`,
        )
        .get() as { total: number; input: number; output: number };
      let totalTokens = usage.total;
      if (totalTokens === 0) {
        totalTokens = (
          db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS n FROM threads`).get() as { n: number }
        ).n;
      }

      // Activity + hours by local calendar (user blocks carry the timestamp).
      const activity = db
        .prepare(
          `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS date,
                  COUNT(*) AS count
           FROM blocks WHERE role = 'user'
           GROUP BY date ORDER BY date ASC`,
        )
        .all() as Array<{ date: string; count: number }>;

      const hours = db
        .prepare(
          `SELECT CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                  COUNT(*) AS count
           FROM blocks WHERE role = 'user'
           GROUP BY hour ORDER BY count DESC`,
        )
        .all() as Array<{ hour: number; count: number }>;

      const providers = db
        .prepare(
          `SELECT provider, COUNT(*) AS count FROM (${REAL})
           GROUP BY provider ORDER BY count DESC`,
        )
        .all() as ProfileStats["providers"];

      const models = db
        .prepare(
          `SELECT model, provider, COUNT(*) AS count FROM (${REAL})
           WHERE model IS NOT NULL AND model <> ''
           GROUP BY model, provider ORDER BY count DESC`,
        )
        .all() as ProfileStats["models"];

      const reasoning = db
        .prepare(
          `SELECT json_extract(model_selection_json, '$.effort') AS effort, COUNT(*) AS count
           FROM (${REAL})
           WHERE effort IS NOT NULL AND effort <> ''
           GROUP BY effort ORDER BY count DESC`,
        )
        .all() as ProfileStats["reasoning"];

      const projectRows = db
        .prepare(
          `SELECT t.project_path AS path, COUNT(*) AS prompts
           FROM blocks b JOIN threads t ON t.thread_id = b.thread_id
           WHERE b.role = 'user'
           GROUP BY t.project_path ORDER BY prompts DESC LIMIT 8`,
        )
        .all() as Array<{ path: string; prompts: number }>;
      const projects = projectRows.map((r) => ({
        path: r.path,
        name: r.path.split("/").filter(Boolean).pop() ?? r.path,
        prompts: r.prompts,
      }));

      // Streaks + peak day, walked over the ascending activity dates.
      const peakDay =
        activity.length > 0
          ? activity.reduce((a, b) => (b.count > a.count ? b : a))
          : null;
      const { current, longest } = computeStreaks(activity.map((a) => a.date));

      return {
        generatedAt: Date.now(),
        totals: {
          threads: totalsRow.threads,
          prompts,
          tokens: totalTokens,
          inputTokens: usage.input,
          outputTokens: usage.output,
          projects: totalsRow.projects,
        },
        streak: {
          current,
          longest,
          peakDay: peakDay ? { date: peakDay.date, count: peakDay.count } : null,
        },
        activity,
        hours,
        mostActiveHour: hours.length > 0 ? hours[0]!.hour : null,
        providers,
        models,
        reasoning,
        projects,
      };
    } catch (err) {
      console.error("[conversation-store] profileStats failed:", err);
      return empty;
    }
  }

  /** Store-backed usage rows — supplement for providers without CLI transcript
   *  scanning. Called from buildAgentUsageReport, not the IPC surface directly. */
  readStoreUsageReport(options: {
    range: UsageRange;
    projectPath?: string | null;
    excludeProviders?: string[];
    onlyProviders?: readonly string[];
  }) {
    return usageReportFromStore(this.handle(), options);
  }

  /** Whether this thread has ever had a user turn — i.e. whether there is a
   *  conversation here that a fresh provider session would be missing. Cheap
   *  enough for the session-open path, unlike loadThread. */
  hasUserTurn(threadId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const row = db
        .prepare(`SELECT 1 FROM blocks WHERE thread_id = ? AND role = 'user' LIMIT 1`)
        .get(threadId);
      return row !== undefined;
    } catch (err) {
      console.error("[conversation-store] hasUserTurn failed:", err);
      return false;
    }
  }

  // ── side chats (fork pointer, lineage, fork-import blocks) ─────────────────

  /** Whether a thread row already exists under this id. The natural
   *  idempotency for client-minted thread ids: a replayed create resolves as
   *  "exists" instead of writing a second row. */
  threadExists(threadId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      return (
        db.prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`).get(threadId) !==
        undefined
      );
    } catch (err) {
      console.error("[conversation-store] threadExists failed:", err);
      return false;
    }
  }

  /** The thread id a caller's idempotency key was already used for, if any.
   *  A replayed requestId must land on the same thread — a different threadId
   *  with the same key is an idempotency conflict. */
  threadIdForRequestId(requestId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT thread_id FROM threads WHERE request_id = ? LIMIT 1`)
        .get(requestId) as { thread_id: string } | undefined;
      return row?.thread_id ?? null;
    } catch (err) {
      console.error("[conversation-store] threadIdForRequestId failed:", err);
      return null;
    }
  }

  /** The side chat already forked from a source thread, if any — the
   *  one-side-chat-per-source rule. A second fork request joins the existing
   *  one instead of minting another. */
  sidechatForSource(sourceThreadId: string): { threadId: string; provider: ProviderKind } | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT thread_id, provider FROM threads
            WHERE source_thread_id = ?
            ORDER BY created_at ASC LIMIT 1`,
        )
        .get(sourceThreadId) as { thread_id: string; provider: string } | undefined;
      return row ? { threadId: row.thread_id, provider: row.provider as ProviderKind } : null;
    } catch (err) {
      console.error("[conversation-store] sidechatForSource failed:", err);
      return null;
    }
  }

  /** Whether the thread has a live (native) assistant turn yet. Fork-imported
   *  assistant blocks are the source's history, not the side chat's own
   *  activity — only a native assistant block means the child has actually
   *  answered. This is the one-shot gate for the `<sidechat_context>` bootstrap
 */
  hasNativeAssistantTurn(threadId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const row = db
        .prepare(
          `SELECT 1 FROM blocks
            WHERE thread_id = ? AND role = 'assistant'
              AND (source IS NULL OR source = 'native')
            LIMIT 1`,
        )
        .get(threadId);
      return row !== undefined;
    } catch (err) {
      console.error("[conversation-store] hasNativeAssistantTurn failed:", err);
      return false;
    }
  }

  /** The thread's stored fork context (side chat handoff), or null when the
   *  thread isn't a fork. */
  threadForkContext(threadId: string): ForkContext | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT fork_context_json FROM threads WHERE thread_id = ?`)
        .get(threadId) as { fork_context_json: string | null } | undefined;
      return parseJsonObject<ForkContext>(row?.fork_context_json ?? null) ?? null;
    } catch (err) {
      console.error("[conversation-store] threadForkContext failed:", err);
      return null;
    }
  }

  /** Persist a side-chat fork: the thread row (with its fork pointer, stored
   *  handoff context, lineage block and idempotency key) and the imported
   *  blocks, in one transaction. Imported blocks keep their original `at`
   *  timestamps and never touch the thread's `updated_at` — they are history,
   *  not activity. Returns false when the thread id is already taken
   *  (requireThreadAbsent — the caller's natural idempotency). */
  writeForkThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
    createdAt: number;
    title?: string;
    sourceThreadId: string;
    forkContext: ForkContext;
    lineage: ThreadLineage;
    requestId?: string;
    /** Imported blocks in arrival order. Assistant rows carry their narrative
     *  as text — the source's tool items are not imported — and get a
     *  synthetic turn id so loadThread re-attaches that narrative as one
     *  `assistant_text` item (an assistant block with no items would read as
     *  an empty reply). */
    importedBlocks: Array<{
      id: string;
      role: "user" | "assistant";
      text: string;
      at: number;
      attachments?: ChatAttachment[];
    }>;
  }): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const insertThread = db.prepare(
        `INSERT INTO threads (
           thread_id, project_path, provider, model, created_at, updated_at,
           title, source_thread_id, fork_context_json, lineage_json, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertBlock = db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, turn_id, text, state, at, ended_at, attachments_json, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fork-import')`,
      );
      const insertNarrativeItem = db.prepare(
        `INSERT INTO items (item_id, thread_id, turn_id, kind, status, text)
         VALUES (?, ?, ?, 'assistant_text', 'completed', ?)`,
      );
      this.durably(db, () => {
        // One transaction: the thread row, every imported block and every
        // narrative item must land together — a crash mid-fork would leave a
        // half-imported side chat.
        withTransaction(db, () => {
          const now = input.createdAt;
          insertThread.run(
            input.threadId,
            input.projectPath,
            input.provider,
            input.model ?? null,
            now,
            now,
            input.title ?? null,
            input.sourceThreadId,
            JSON.stringify(input.forkContext),
            JSON.stringify(input.lineage),
            input.requestId ?? null,
          );
          for (const block of input.importedBlocks) {
            const turnId = block.role === "assistant" ? `fork-import:${block.id}` : null;
            insertBlock.run(
              block.id,
              input.threadId,
              block.role,
              turnId,
              block.text,
              block.role === "assistant" ? "completed" : null,
              block.at,
              block.role === "assistant" ? block.at : null,
              block.attachments?.length ? JSON.stringify(block.attachments) : null,
            );
            if (turnId) {
              insertNarrativeItem.run(
                `${block.id}:narrative`,
                input.threadId,
                turnId,
                block.text,
              );
            }
          }
        });
      });
      return true;
    } catch (err) {
      // A duplicate thread id surfaces here as a UNIQUE constraint violation —
      // the caller checks threadExists() first, but a race still lands here.
      console.error("[conversation-store] writeForkThread failed:", err);
      return false;
    }
  }

  /** Flip a side chat's one-shot bootstrap flag to "completed" — called when
   *  its first turn settles, so the imported-transcript injection never runs
   *  twice. No-op for non-forks and already-completed forks. */
  private completeSidechatBootstrap(db: DatabaseSync, threadId: string): void {
    try {
      const row = db
        .prepare(`SELECT fork_context_json FROM threads WHERE thread_id = ?`)
        .get(threadId) as { fork_context_json: string | null } | undefined;
      const ctx = parseJsonObject<ForkContext>(row?.fork_context_json ?? null);
      if (!ctx || ctx.bootstrapStatus !== "pending") return;
      ctx.bootstrapStatus = "completed";
      db.prepare(`UPDATE threads SET fork_context_json = ? WHERE thread_id = ?`).run(
        JSON.stringify(ctx),
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] completeSidechatBootstrap failed:", err);
    }
  }

  // ── thread spawning (agent-owned child threads) ────────────────────────────
  // A running agent opens a NEW thread on any installed provider via the MCP
  // gateway (docs/thread-spawning-design.md): the child is a first-class
  // thread — same rows, same event stream — plus a parent pointer so the UI
  // can nest it and the engine can enforce the depth/breadth caps.
  // `lineage_json` (shared with side chats) stays the source of truth for the
  // relationship; `parent_thread_id` is the indexed projection the v16
  // migration added so "who are my children" is one indexed query instead of
  // a JSON scan.

  /** Create the row for a spawned child thread. Returns false when the thread
   *  id is already taken (a UNIQUE violation lands in the catch — same shape
   *  as writeForkThread, the caller's natural idempotency for client-minted
   *  ids).
   *
   *  Deliberately does NOT write `threads.request_id`. That column is the
   *  side chat's *global* idempotency key — threadIdForRequestId queries it
   *  with no thread scope — while a spawn's requestId is only unique within
   *  its parent turn. Writing it would make an unrelated side chat report a
   *  bogus idempotency conflict. Spawn idempotency rides gateway_ops
   *  (reserveGatewayOp on (thread, turn, requestId)), never this column. */
  writeSpawnedThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
    createdAt: number;
    title: string;
    lineage: ThreadLineage;
  }): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      // The thread row is the anchor every child event hangs off — the same
      // durability class as a fork's row.
      this.durably(db, () => {
        db.prepare(
          `INSERT INTO threads (
             thread_id, project_path, provider, model, created_at, updated_at,
             last_activity_at, title, lineage_json, parent_thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.threadId,
          input.projectPath,
          input.provider,
          input.model ?? null,
          input.createdAt,
          input.createdAt,
          input.createdAt,
          input.title,
          JSON.stringify(input.lineage),
          input.lineage.parentThreadId,
        );
      });
      return true;
    } catch (err) {
      console.error("[conversation-store] writeSpawnedThread failed:", err);
      return false;
    }
  }

  /** The thread's stored lineage block, or null when the thread has none (a
   *  plain root, or a missing row). Reads `lineage_json` — the source of
   *  truth; callers that walk the tree use the indexed parent pointer instead. */
  threadLineage(threadId: string): ThreadLineage | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT lineage_json FROM threads WHERE thread_id = ?`)
        .get(threadId) as { lineage_json: string | null } | undefined;
      return parseJsonObject<ThreadLineage>(row?.lineage_json ?? null) ?? null;
    } catch (err) {
      console.error("[conversation-store] threadLineage failed:", err);
      return null;
    }
  }

  /** Every thread that names this one as its parent, oldest first — the
   *  "who are my children" query the v16 parent index exists for. */
  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT * FROM threads
            WHERE parent_thread_id = ?
            ORDER BY created_at ASC`,
        )
        .all(parentThreadId) as ThreadRow[];
      return rows.map(rowToMeta);
    } catch (err) {
      console.error("[conversation-store] spawnedChildren failed:", err);
      return [];
    }
  }

  /** How many spawn hops above a root this thread sits — a root is 0, its
   *  child 1, and so on; the engine's depth guard (MAX_SPAWN_DEPTH) refuses
   *  past that.
   *
   *  Walks `parent_thread_id` upward and is deliberately cycle-guarded: a
   *  corrupted row (a pointer loop) must return a large finite depth that the
   *  guard refuses, never hang the store. A missing parent terminates the
   *  walk — deleteThread now cascades to the whole subtree in one transaction,
   *  so an orphaned parent pointer only appears if a row was lost another way,
   *  and the chain simply stops there. */
  spawnDepth(threadId: string): number {
    const db = this.handle();
    if (!db) return 0;
    try {
      const parentOf = db.prepare(
        `SELECT parent_thread_id FROM threads WHERE thread_id = ?`,
      );
      const visited = new Set<string>([threadId]);
      let current = threadId;
      let depth = 0;
      // 64 is far past the real ceiling (MAX_SPAWN_DEPTH = 2): anything that
      // reaches it is a cycle or a corrupted chain, and the caller's guard
      // treats the finite-but-absurd value as "too deep to trust".
      while (depth < 64) {
        const row = parentOf.get(current) as
          | { parent_thread_id: string | null }
          | undefined;
        const parent = row?.parent_thread_id;
        if (!parent) break;
        if (visited.has(parent)) return 64;
        visited.add(parent);
        current = parent;
        depth++;
      }
      return depth;
    } catch (err) {
      console.error("[conversation-store] spawnDepth failed:", err);
      return 0;
    }
  }

  /** Every spawned thread with at least one assistant block still running —
   *  the DB's notion of "still in flight", backing the breadth caps
   *  (MAX_LIVE_CHILDREN_PER_PARENT, MAX_LIVE_SPAWNED_THREADS). One query, no
   *  N+1: the EXISTS is served by the blocks (thread_id, seq) index. */
  liveSpawnedThreadIds(): string[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT t.thread_id
             FROM threads t
            WHERE t.parent_thread_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM blocks b
                 WHERE b.thread_id = t.thread_id
                   AND b.role = 'assistant'
                   AND b.state = 'running'
              )`,
        )
        .all() as Array<{ thread_id: string }>;
      return rows.map((r) => r.thread_id);
    } catch (err) {
      console.error("[conversation-store] liveSpawnedThreadIds failed:", err);
      return [];
    }
  }

  /** The most recent assistant block's narrative text — its `assistant_text`
   *  items concatenated in arrival order, trimmed. This is what becomes the
   *  child's summary, so it is the narrative only: reasoning, plan and tool
   *  calls are excluded (they stay in the child's transcript, readable on
   *  demand via kone_read_thread). Null when the thread has never produced
   *  assistant text. */
  latestAssistantText(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const block = db
        .prepare(
          `SELECT turn_id FROM blocks
            WHERE thread_id = ? AND role = 'assistant'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(threadId) as { turn_id: string | null } | undefined;
      if (!block?.turn_id) return null;
      const items = db
        .prepare(
          `SELECT text FROM items
            WHERE thread_id = ? AND turn_id = ? AND kind = 'assistant_text'
            ORDER BY seq`,
        )
        .all(threadId, block.turn_id) as Array<{ text: string }>;
      const text = items.map((i) => i.text).join("").trim();
      return text || null;
    } catch (err) {
      console.error("[conversation-store] latestAssistantText failed:", err);
      return null;
    }
  }

  /** The child's elapsed-time readout: when its first turn started, when its
   *  last turn ended, how many turns are still running, and how the NEWEST
   *  assistant block settled. `endedAt` is null while anything is running — the
   *  readout measures against "now" until the thread settles. `lastState` is
   *  the state of the newest assistant block by `at`, so a caller that cannot
   *  see the live projection (the spawn engine's boot fallback after a restart)
   *  can tell a turn sealed 'interrupted' by sealOrphanedTurns from a turn that
   *  genuinely completed. Null when the thread has no assistant blocks at all. */
  threadTurnSpan(threadId: string): {
    startedAt: number;
    endedAt: number | null;
    runningTurns: number;
    lastState: "running" | "interrupted" | "failed" | "completed" | null;
    /** The NEWEST assistant block's `error`, when it has one — carried up so
     *  the boot-fallback projection can surface the reason a child failed
     *  (e.g. the undispatched-spawn seal), not just the bare status. */
    lastError?: string;
  } | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT MIN(at) AS started_at,
                  MAX(ended_at) AS ended_at,
                  COUNT(CASE WHEN state = 'running' THEN 1 END) AS running,
                  (SELECT state FROM blocks
                    WHERE thread_id = ? AND role = 'assistant'
                    ORDER BY at DESC, seq DESC LIMIT 1) AS last_state,
                  (SELECT error FROM blocks
                    WHERE thread_id = ? AND role = 'assistant'
                    ORDER BY at DESC, seq DESC LIMIT 1) AS last_error
             FROM blocks
            WHERE thread_id = ? AND role = 'assistant'`,
        )
        .get(threadId, threadId, threadId) as
        | {
            started_at: number | null;
            ended_at: number | null;
            running: number;
            last_state: "running" | "interrupted" | "failed" | "completed" | null;
            last_error: string | null;
          }
        | undefined;
      if (!row || row.started_at === null) return null;
      return {
        startedAt: row.started_at,
        endedAt: row.running > 0 ? null : row.ended_at,
        runningTurns: row.running,
        lastState: row.last_state,
        ...(row.last_error ? { lastError: row.last_error } : {}),
      };
    } catch (err) {
      console.error("[conversation-store] threadTurnSpan failed:", err);
      return null;
    }
  }

  // ── scratchpads ───────────────────────────────────────────────────────────

  listScratchpads(projectPath: string): ScratchpadRecord[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT id, project_path, title, body, created_at, updated_at, sort_index, revision
             FROM scratchpads
            WHERE project_path = ?
            ORDER BY sort_index ASC, created_at ASC`,
        )
        .all(projectPath) as ScratchpadRow[];
      return rows.map(rowToScratchpad);
    } catch (err) {
      console.error("[conversation-store] listScratchpads failed:", err);
      return [];
    }
  }

  /** Read one pad by id, or null when it doesn't exist. */
  getScratchpad(padId: string): ScratchpadRecord | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT id, project_path, title, body, created_at, updated_at, sort_index, revision
             FROM scratchpads WHERE id = ?`,
        )
        .get(padId) as ScratchpadRow | undefined;
      return row ? rowToScratchpad(row) : null;
    } catch (err) {
      console.error("[conversation-store] getScratchpad failed:", err);
      return null;
    }
  }

  /** Upsert a pad. `expectedRevision` is an optimistic lock: when given and it
   *  doesn't match the row's current revision the write is refused and the
   *  current revision returned — the caller (the gateway tool) surfaces it as a
   *  `revision_conflict` so the agent can re-send against fresh state. Omitting
   *  it overwrites unconditionally (the web editor's first save of a pad it
   *  just created). `append: true` merges server-side (current body + "\n\n" +
   *  new body) so agent appends race nothing — the merge and the revision bump
   *  happen in the same statement sequence. Every write bumps `revision`. */
  saveScratchpad(input: {
    padId: string;
    projectPath: string;
    title: string;
    body: string;
    expectedRevision?: number;
    append?: boolean;
  }): { savedAt: number; revision: number } | { conflict: number } | null {
    const db = this.handle();
    if (!db) return null;
    const savedAt = Date.now();
    try {
      const existing = db
        .prepare(
          `SELECT created_at, sort_index, revision, body FROM scratchpads WHERE id = ?`,
        )
        .get(input.padId) as
        | { created_at: number; sort_index: number; revision: number; body: string }
        | undefined;
      if (
        existing &&
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) {
        return { conflict: existing.revision };
      }
      const sortIndex =
        existing?.sort_index ??
        ((db
          .prepare(
            `SELECT COALESCE(MAX(sort_index), -1) + 1 AS next
               FROM scratchpads WHERE project_path = ?`,
          )
          .get(input.projectPath) as { next: number }).next ?? 0);
      const revision = existing ? existing.revision + 1 : 1;
      const body =
        input.append && existing && existing.body.trim()
          ? `${existing.body}\n\n${input.body}`
          : input.body;
      db.prepare(
        `INSERT INTO scratchpads (id, project_path, title, body, created_at, updated_at, sort_index, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           updated_at = excluded.updated_at,
           revision = excluded.revision`,
      ).run(
        input.padId,
        input.projectPath,
        input.title,
        body,
        existing?.created_at ?? savedAt,
        savedAt,
        sortIndex,
        revision,
      );
      return { savedAt, revision };
    } catch (err) {
      console.error("[conversation-store] saveScratchpad failed:", err);
      return null;
    }
  }

  deleteScratchpad(padId: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`DELETE FROM scratchpads WHERE id = ?`).run(padId);
    } catch (err) {
      console.error("[conversation-store] deleteScratchpad failed:", err);
    }
  }

  // ── gateway idempotency ops (docs/mcp-gateway-design.md §7) ───────────────
  // One table for every gateway tool: agent write tools carry a clientRequestId
  // so ambiguous-network-failure retries replay instead of re-applying. Keys
  // come from the bound authority context (thread + turn + agent-supplied
  // request id); the fingerprint is over the canonicalized request.

  /** Reserve one gateway operation, or resolve a prior one:
   *  - "reserved" — first sighting; the caller performs the work, then
   *    `setGatewayOpResult`.
   *  - { kind: "replay"; result } — same key + same fingerprint, completed
   *    before: return the stored post-write result. If a crash between the
   *    write and `setGatewayOpResult` left the row without a result, the
   *    retry falls through to "reserved" and re-applies (the revision guard
   *    catches a write that actually landed).
   *  - "conflict" — same key, different fingerprint: the agent re-sent the
   *    same request id with different content.
   *  - null — store failure. */
  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const inserted = db
        .prepare(
          `INSERT INTO gateway_ops (thread_id, turn_id, request_id, kind, fingerprint, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, '', ?)
           ON CONFLICT(thread_id, turn_id, request_id) DO NOTHING`,
        )
        .run(input.threadId, input.turnId, input.requestId, input.kind, input.fingerprint, Date.now());
      if (Number(inserted.changes) > 0) return { kind: "reserved" };
      const prior = db
        .prepare(
          `SELECT fingerprint, result_json FROM gateway_ops
            WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
        )
        .get(input.threadId, input.turnId, input.requestId) as
        | { fingerprint: string; result_json: string }
        | undefined;
      if (prior && prior.fingerprint === input.fingerprint && prior.result_json) {
        try {
          return { kind: "replay", result: JSON.parse(prior.result_json) };
        } catch {
          return { kind: "conflict" };
        }
      }
      return { kind: "conflict" };
    } catch (err) {
      console.error("[conversation-store] reserveGatewayOp failed:", err);
      return null;
    }
  }

  /** Record a completed gateway operation's result so a retry with the same
   *  key + fingerprint replays it. Best-effort: an op row without a result is
   *  treated as never-completed by `reserveGatewayOp`. */
  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE gateway_ops SET result_json = ?
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      ).run(input.resultJson, input.threadId, input.turnId, input.requestId);
    } catch (err) {
      console.error("[conversation-store] setGatewayOpResult failed:", err);
    }
  }

  /** Record that a reserved gateway operation's side effect was actually
   *  dispatched. For spawn.thread this runs AFTER startThread returns; a row
   *  reserved but never marked dispatched is the durable trace of a
   *  half-created child, which sealUndispatchedSpawns turns into a failed
   *  thread at next boot. Best-effort — a missed mark only means the child
   *  would be re-sealed at a later boot, which is idempotent. */
  markGatewayOpDispatched(input: {
    threadId: string;
    turnId: string;
    requestId: string;
  }): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE gateway_ops SET dispatched = 1
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      ).run(input.threadId, input.turnId, input.requestId);
    } catch (err) {
      console.error("[conversation-store] markGatewayOpDispatched failed:", err);
    }
  }

  // ── project board layout ────────────────────────────────────────────────────

  /** Read a project's persisted board layout. Never throws: a corrupt JSON blob
   *  or an unrecognised shape returns `null` so the project still opens (the
   *  renderer falls back to today's single-thread board). Hard structural
   *  validation of the panes themselves is the renderer's job (§6.4). */
  loadBoard(projectPath: string): StoredBoardLayout | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT layout FROM project_boards WHERE project_path = ?`)
        .get(projectPath) as { layout: string } | undefined;
      if (!row?.layout) return null;
      const parsed = JSON.parse(row.layout) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { version?: unknown }).version !== 1 ||
        !Array.isArray((parsed as { panes?: unknown }).panes)
      ) {
        return null;
      }
      return parsed as StoredBoardLayout;
    } catch (err) {
      console.error("[conversation-store] loadBoard failed:", err);
      return null;
    }
  }

  saveBoard(projectPath: string, layout: StoredBoardLayout): { savedAt: number } | null {
    const db = this.handle();
    if (!db) return null;
    const savedAt = Date.now();
    try {
      db.prepare(
        `INSERT INTO project_boards (project_path, layout, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
           layout = excluded.layout,
           updated_at = excluded.updated_at`,
      ).run(projectPath, JSON.stringify(layout), savedAt);
      return { savedAt };
    } catch (err) {
      console.error("[conversation-store] saveBoard failed:", err);
      return null;
    }
  }
}

/** The board document as it lives in the store — a serialisable layout blob.
 *  desktop package stays free of a web-package dependency; the renderer owns the
 *  canonical `BoardLayout` type and the hard pane validation. */
export type StoredBoardLayout = {
  version: 1;
  panes: unknown[];
  focusedId: string | null;
};

export type ScratchpadRecord = {
  id: string;
  projectPath: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  sortIndex: number;
  /** Optimistic-concurrency counter, bumped on every write (v15). The web
   *  editor sends its last-known value with each save; gateway agent writes
   *  guard on it so user and agent edits never silently clobber each other. */
  revision: number;
};

type ScratchpadRow = {
  id: string;
  project_path: string;
  title: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  sort_index: number;
  revision: number;
};

function rowToScratchpad(row: ScratchpadRow): ScratchpadRecord {
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title ?? "",
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortIndex: row.sort_index,
    revision: row.revision,
  };
}

// ── row → domain mapping ──────────────────────────────────────────────────────

type StoredAssistantState = "running" | "completed" | "failed" | "interrupted";

type ThreadRow = {
  thread_id: string;
  project_path: string;
  provider: string;
  model: string | null;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
  branch: string | null;
  added: number | null;
  removed: number | null;
  tokens: number | null;
  context_used: number | null;
  context_window: number | null;
  compacts_auto: number | null;
  archived: number | null;
  title: string | null;
  base_tree: string | null;
  source_thread_id: string | null;
  fork_context_json: string | null;
  lineage_json: string | null;
  request_id: string | null;
  parent_thread_id: string | null;
  is_pinned: number;
  model_selection_json: string | null;
  resume_session_at: string | null;
  last_activity_at: number | null;
};

type BlockRow = {
  block_id: string;
  thread_id: string;
  role: "user" | "assistant";
  turn_id: string | null;
  text: string | null;
  state: string | null;
  error: string | null;
  at: number;
  ended_at: number | null;
  attachments_json: string | null;
  source: string | null;
};

/** An attachment's registry row — its metadata plus where the bytes live. */
export type StoredAttachment = ChatAttachment & {
  threadId: string;
  /** Path to the file relative to the attachments dir. */
  relPath: string;
  createdAt?: number;
};

type AttachmentRow = {
  attachment_id: string;
  thread_id: string;
  type: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  rel_path: string;
  created_at: number;
};

function rowToAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.attachment_id,
    threadId: row.thread_id,
    type: row.type === "image" ? "image" : "file",
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    relPath: row.rel_path,
    createdAt: row.created_at,
  };
}

/** Parse a user block's denormalized attachment metadata, tolerating bad JSON
 *  (an older/corrupt row just renders without chips). */
function parseAttachments(json: string | null): ChatAttachment[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatAttachment[]) : undefined;
  } catch {
    return undefined;
  }
}

// ── durable turn queue (v20) ─────────────────────────────────────────────────

/** How a queued follow-up runs when the live turn settles: 'queue' joins the
 *  FIFO line, 'steer' jumps it (most recent steer first). */
export type QueuedTurnDispatchMode = "queue" | "steer";

/** Lifecycle of a queued turn: 'queued' → 'promoting' (claimed) → 'promoted'
 *  (ran), 'promoting' → 'queued' (released after a failed drain), and either
 *  active state → 'cancelled' (stop/delete). Only the active states are
 *  pending; promoted/cancelled rows are inert history. */
export type QueuedTurnState = "queued" | "promoting" | "promoted" | "cancelled";

/** The enqueue payload the service layer hands the store. `userBlockId` is the
 *  journaled user-prompt block UUID (recordUserBlock mints it) — the replay
 *  idempotency key: the same prompt re-delivered by a retrying caller is a
 *  no-op, not a duplicate. The nullable knobs are replayed onto the promoted
 *  send exactly as the user picked them. */
export type QueuedTurnEnqueueInput = {
  /** kone-minted UUID (randomUUID). */
  queueId: string;
  threadId: string;
  userBlockId: string;
  dispatchMode?: QueuedTurnDispatchMode;
  /** The final prompt text (already merged with any prior prompt edits). */
  input: string;
  /** File/image metadata (bytes live on disk; JSON-serialized on the row). */
  attachments?: ChatAttachment[];
  /** Enqueue timestamp; defaults to now (callers pass it for ordering tests). */
  at?: number;
  model?: string;
  mode?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
};

/** A queued turn as read back from the store — the shape the service layer
 *  promotes (claim returns it) and the UI lists. */
export type QueuedTurnRow = {
  queueId: string;
  threadId: string;
  userBlockId: string;
  dispatchMode: QueuedTurnDispatchMode;
  state: QueuedTurnState;
  input: string;
  attachments?: ChatAttachment[];
  model?: string;
  mode?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
  /** Times this turn was claimed; survives release→reclaim (the retry ledger). */
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  promotedAt?: number;
};

type QueuedTurnDbRow = {
  queue_id: string;
  thread_id: string;
  user_block_id: string;
  dispatch_mode: QueuedTurnDispatchMode;
  state: QueuedTurnState;
  input: string;
  attachments_json: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  service_tier: string | null;
  context_window: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  promoted_at: number | null;
};

function rowToQueuedTurn(row: QueuedTurnDbRow): QueuedTurnRow {
  const attachments = parseAttachments(row.attachments_json);
  return {
    queueId: row.queue_id,
    threadId: row.thread_id,
    userBlockId: row.user_block_id,
    dispatchMode: row.dispatch_mode,
    state: row.state,
    input: row.input,
    ...(attachments?.length ? { attachments } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.mode ? { mode: row.mode } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.service_tier ? { serviceTier: row.service_tier } : {}),
    ...(row.context_window ? { contextWindow: row.context_window } : {}),
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.promoted_at !== null ? { promotedAt: row.promoted_at } : {}),
  };
}

type ItemRow = {
  item_id: string;
  turn_id: string;
  kind: string;
  status: string;
  text: string;
  name: string | null;
  detail: string | null;
  tasks_json: string | null;
  subagent_tool_use_id: string | null;
};

type SubagentRow = {
  tool_use_id: string;
  turn_id: string;
  task_id: string | null;
  parent_item_id: string | null;
  agent_type: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  effort: string | null;
  background: number | null;
  status: string;
  summary: string | null;
  last_tool_name: string | null;
  tokens: number | null;
  tool_uses: number | null;
  started_at: number;
  ended_at: number | null;
};

function rowToMeta(row: ThreadRow): StoredThreadMeta {
  const selection = parseJsonObject<{ effort?: string; serviceTier?: string; contextWindow?: string }>(
    row.model_selection_json,
  );
  return {
    threadId: row.thread_id,
    projectPath: row.project_path,
    provider: row.provider as ProviderKind,
    model: row.model ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    branch: row.branch ?? null,
    added: row.added ?? undefined,
    removed: row.removed ?? undefined,
    tokens: row.tokens ?? undefined,
    contextUsed: row.context_used ?? undefined,
    contextWindow: row.context_window ?? undefined,
    compactsAutomatically: row.compacts_auto ? true : undefined,
    title: row.title ?? undefined,
    /** Pins live in the DB (v18) so they follow the thread across profiles. */
    isPinned: row.is_pinned === 1,
    /** Recency ordering key (v18): last conversation activity, distinct from
     *  `updatedAt` which title/archive bookkeeping also bumps. Backfilled from
     *  updated_at for pre-v18 rows. */
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    resumeSessionAt: row.resume_session_at ?? undefined,
    ...(selection ? { selection } : {}),
    ...(parseJsonObject<StoredThreadMeta["forkContext"]>(row.fork_context_json)
      ? { forkContext: parseJsonObject<StoredThreadMeta["forkContext"]>(row.fork_context_json) }
      : {}),
    ...(parseJsonObject<StoredThreadMeta["lineage"]>(row.lineage_json)
      ? { lineage: parseJsonObject<StoredThreadMeta["lineage"]>(row.lineage_json) }
      : {}),
  };
}

/** Parse a JSON blob column, tolerating bad/absent JSON (a corrupt row reads
 *  as absent — persistence is best-effort). */
function parseJsonObject<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function rowToItem(row: ItemRow): RuntimeItem {
  let tasks: RuntimeItem["tasks"];
  if (row.tasks_json) {
    try {
      const parsed = JSON.parse(row.tasks_json) as unknown;
      if (Array.isArray(parsed)) tasks = parsed as RuntimeItem["tasks"];
    } catch {
      tasks = undefined;
    }
  }
  return {
    itemId: row.item_id,
    kind: row.kind as RuntimeItem["kind"],
    status: row.status as RuntimeItem["status"],
    text: row.text,
    name: row.name ?? undefined,
    detail: row.detail ?? undefined,
    ...(tasks?.length ? { tasks } : {}),
  };
}

// ── IPC wire projection ───────────────────────────────────────────────────────
// payload projection): a tool_call's expandable body (`detail`) can carry the
// provider's FULL tool result — MBs of stdout/stderr/diff on Codex's MCP and
// shell calls — and it dominates wire size on tool-heavy threads. The store
// keeps the full payload (persistence is the source of truth); only the copy
// crossing IPC is bounded. The three text kinds are NEVER touched: their
// `text` is the streamed reply and must arrive byte-identical.
//
// The superseded-update half of that model — dropping tool.updated rows a
// completion supersedes — has no kone equivalent: kone's
// store upserts one row per item per turn and the renderer replaces items by
// itemId in place, so an in-flight tool call never accumulates rows anywhere —
// there is no history of updates to drop (verified in conversationStore.test.ts
// and the renderer's upsertItem). Live updates still stream, slimmed, matching

/** Wire cap for a tool_call's expandable body. Bounded, but generous enough
 *  that the expandable row still shows real content (kone renders `detail`
 */
export const TOOL_DETAIL_WIRE_CAP = 8_000;

function capDetail(detail: string | undefined): string | undefined {
  if (!detail || detail.length <= TOOL_DETAIL_WIRE_CAP) return detail;
  return (
    detail.slice(0, TOOL_DETAIL_WIRE_CAP) +
    "\n\n… (output truncated; the full result stays in this thread's local history)"
  );
}

/** Project one item for the wire. Returns the same object when nothing
 *  changes, so the hot streaming path allocates nothing per event. */
export function projectRuntimeItemForIpc(item: RuntimeItem): RuntimeItem {
  if (item.kind !== "tool_call") return item;
  const detail = capDetail(item.detail);
  let subagent = item.subagent;
  if (subagent) {
    const items = subagent.items.map(projectRuntimeItemForIpc);
    if (items.some((it, index) => it !== subagent?.items[index])) {
      subagent = { ...subagent, items };
    }
  }
  if (detail === item.detail && subagent === item.subagent) return item;
  return { ...item, ...(detail !== item.detail ? { detail } : {}), ...(subagent ? { subagent } : {}) };
}

/** Project a runtime event for the wire. Only the item-carrying events can
 *  hold tool bodies; everything else crosses unchanged (same object). */
export function projectRuntimeEventForIpc(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  const item = projectRuntimeItemForIpc(event.item);
  return item === event.item ? event : { ...event, item };
}

/** Project a stored thread's blocks for the wire (history reads — the renderer
 *  rehydrates from these, so a reloaded thread lands with bounded bodies too). */
export function projectStoredBlocksForIpc(blocks: StoredBlock[]): StoredBlock[] {
  let changed = false;
  const projected = blocks.map((b) => {
    if (b.role !== "assistant") return b;
    const items = b.items.map((it) => projectRuntimeItemForIpc(it));
    const blockChanged = items.some((it, index) => it !== b.items[index]);
    if (!blockChanged) return b;
    changed = true;
    return { ...b, items };
  });
  return changed ? projected : blocks;
}

export function projectStoredThreadForIpc(thread: StoredThread): StoredThread {
  const blocks = projectStoredBlocksForIpc(thread.blocks);
  return blocks === thread.blocks ? thread : { ...thread, blocks };
}

function rowToSubagent(row: SubagentRow): SubagentRun {
  return {
    toolUseId: row.tool_use_id,
    taskId: row.task_id ?? undefined,
    parentItemId: row.parent_item_id ?? undefined,
    agentType: row.agent_type ?? undefined,
    description: row.description ?? undefined,
    prompt: row.prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    background: row.background === null ? undefined : row.background === 1,
    status: row.status as SubagentRun["status"],
    summary: row.summary ?? undefined,
    lastToolName: row.last_tool_name ?? undefined,
    tokens: row.tokens ?? undefined,
    toolUses: row.tool_uses ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    items: [],
  };
}

/** Rebuild the nested runs first: each run is a snapshot plus the items its
 *  child emitted, keyed per turn by the spawning tool-use id. */
function assembleBlocks(
  blockRows: BlockRow[],
  itemRows: ItemRow[],
  subagentRows: SubagentRow[],
): StoredBlock[] {
  const runsByTurn = new Map<string, Map<string, SubagentRun>>();
  for (const r of subagentRows) {
    const perTurn = runsByTurn.get(r.turn_id) ?? new Map<string, SubagentRun>();
    perTurn.set(r.tool_use_id, rowToSubagent(r));
    runsByTurn.set(r.turn_id, perTurn);
  }

  // Group items by turn once, then attach — avoids a query per assistant
  // block. Items tagged with a run's tool-use id go into that run instead of
  // the turn body, and the run is hung off its parent tool_call item below.
  const itemsByTurn = new Map<string, RuntimeItem[]>();
  const itemsById = new Map<string, RuntimeItem>();
  for (const r of itemRows) {
    const item = rowToItem(r);
    const run = r.subagent_tool_use_id
      ? runsByTurn.get(r.turn_id)?.get(r.subagent_tool_use_id)
      : undefined;
    if (run) {
      run.items.push(item);
      continue;
    }
    itemsById.set(`${r.turn_id}\u0000${r.item_id}`, item);
    const list = itemsByTurn.get(r.turn_id) ?? [];
    list.push(item);
    itemsByTurn.set(r.turn_id, list);
  }

  for (const [turnId, perTurn] of runsByTurn) {
    for (const run of perTurn.values()) {
      if (!run.parentItemId) continue;
      const parent = itemsById.get(`${turnId}\u0000${run.parentItemId}`);
      if (parent) parent.subagent = run;
    }
  }

  return blockRows.map((b) =>
    b.role === "user"
      ? {
          id: b.block_id,
          role: "user",
          text: b.text ?? "",
          at: b.at,
          ...(parseAttachments(b.attachments_json)?.length
            ? { attachments: parseAttachments(b.attachments_json) }
            : {}),
          ...(b.source === "fork-import" ? { source: "fork-import" } : {}),
        }
      : {
          id: b.block_id,
          role: "assistant",
          turnId: b.turn_id ?? b.block_id,
          items: itemsByTurn.get(b.turn_id ?? "") ?? [],
          state: (b.state as StoredAssistantState | null) ?? "completed",
          error: b.error ?? undefined,
          at: b.at,
          endedAt: b.ended_at ?? undefined,
          ...(b.source === "fork-import" ? { source: "fork-import" } : {}),
        },
  );
}

// ── singleton ────────────────────────────────────────────────────────────────

let store: ConversationStore | null = null;

/** The single ConversationStore instance (lazily created). */
export function getConversationStore(): ConversationStore {
  if (!store) store = new ConversationStore();
  return store;
}
