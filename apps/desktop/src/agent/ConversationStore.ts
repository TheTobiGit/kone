import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app } from "electron";

import type {
  ChatAttachment,
  ForkContext,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
  SubagentRun,
  ThreadLineage,
} from "./types.js";

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

const SCHEMA_VERSION = 14;

/** Bring the database up to the current schema. A tiny migration ladder — each
 *  step moves user_version forward by one, so future changes append a case
 *  rather than rewriting existing tables (the versioning lesson from both
 *  reference stores). */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row?.user_version ?? 0;

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
    db.exec(`
      DELETE FROM items;
      DELETE FROM blocks;
      DELETE FROM threads;
      ALTER TABLE threads ADD COLUMN branch  TEXT;
      ALTER TABLE threads ADD COLUMN added   INTEGER;
      ALTER TABLE threads ADD COLUMN removed INTEGER;
      ALTER TABLE threads ADD COLUMN tokens  INTEGER;
    `);
    version = 2;
  }

  if (version < 3) {
    // v3 lets a thread be hidden from the "recent conversations" block without
    // being destroyed — `archived` is a timestamp (NULL = active). Kept as a
    // nullable column so existing rows read as active with no backfill.
    db.exec(`ALTER TABLE threads ADD COLUMN archived INTEGER;`);
    version = 3;
  }

  if (version < 4) {
    // v4 persists an agent-generated (or word-fallback) working title so the
    // recent list doesn't have to reconstruct every transcript just to label
    // a row. Title lives on the thread, not derived from the first user turn
    // at read time. Backfill existing rows
    // from their first user prompt (word-capped) so upgraded installs don't
    // flash "Untitled session" for every prior conversation.
    db.exec(`ALTER TABLE threads ADD COLUMN title TEXT;`);
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
    db.exec(`
      DELETE FROM items;
      DELETE FROM blocks;
      DELETE FROM threads;
      ALTER TABLE threads ADD COLUMN base_tree TEXT;
    `);
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
    db.exec(`ALTER TABLE items ADD COLUMN tasks_json TEXT;`);
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
      ALTER TABLE blocks ADD COLUMN attachments_json TEXT;
    `);
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
    db.exec(`
      ALTER TABLE threads ADD COLUMN context_used   INTEGER;
      ALTER TABLE threads ADD COLUMN context_window INTEGER;
      ALTER TABLE threads ADD COLUMN compacts_auto  INTEGER;
    `);
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
      ALTER TABLE items ADD COLUMN subagent_tool_use_id TEXT;

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
    db.exec(`
      ALTER TABLE threads ADD COLUMN source_thread_id TEXT;
      ALTER TABLE threads ADD COLUMN fork_context_json TEXT;
      ALTER TABLE threads ADD COLUMN lineage_json TEXT;
      ALTER TABLE threads ADD COLUMN request_id TEXT;
      ALTER TABLE blocks ADD COLUMN source TEXT NOT NULL DEFAULT 'native';
    `);
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

  if (version !== SCHEMA_VERSION) version = SCHEMA_VERSION;
  db.exec(`PRAGMA user_version = ${version}`);
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
      const file = path.join(app.getPath("userData"), "conversations.sqlite");
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
      migrate(db);
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
        `INSERT INTO threads (thread_id, project_path, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           project_path = excluded.project_path,
           provider     = excluded.provider,
           model        = COALESCE(excluded.model, threads.model),
           updated_at   = excluded.updated_at`,
      ).run(input.threadId, input.projectPath, input.provider, input.model ?? null, now, now);
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

  /** Every attachment registered under a thread — used to unlink the on-disk
   *  files when the thread is destroyed. */
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
   *  subsequent agent-generated rename. */
  setTitle(threadId: string, title: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE thread_id = ?`).run(
        title,
        Date.now(),
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setTitle failed:", err);
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
   *  new id, and never blanks a known one. Mirrors how the reference server
   *  advances its resume cursor as soon as a durable provider message names a
   *  session.
   *
   *  The memo is only set once a row has actually been updated. Adapters emit
   *  `session.started` — which carries the id — from inside startSession, i.e.
   *  before ipc.ts registers the thread, so on a brand-new thread the first
   *  attempt matches no row. Memoizing that would drop the id for the entire
   *  session, which is the very bug this method exists to fix; instead it retries
   *  on the next event, by which time the row exists. */
  private captureConversationId(db: DatabaseSync, event: RuntimeEvent): void {
    const conversationId =
      event.refs?.conversationId ??
      (event.type === "turn.completed" ? event.conversationId : undefined);
    if (!conversationId) return;
    if (this.knownConversationIds.get(event.threadId) === conversationId) return;
    // `item.updated` is the per-delta type — thousands per turn. Every turn also
    // produces item.started and turn.completed, so the id lands from those
    // without hanging a write attempt (and an fsync) off every token.
    if (event.type === "item.updated") return;
    let written = false;
    this.durably(db, () => {
      const result = db
        .prepare(`UPDATE threads SET conversation_id = ? WHERE thread_id = ?`)
        .run(conversationId, event.threadId);
      written = Number(result.changes) > 0;
    });
    if (written) this.knownConversationIds.set(event.threadId, conversationId);
  }

  /** Fold one normalized runtime event into the stored read model — the write
   *  half of persistence. Mirrors the renderer's reducer, but to rows. */
  applyEvent(event: RuntimeEvent): void {
    const db = this.handle();
    if (!db) return;
    try {
      // Before the per-type fold: any envelope may be the one that first names
      // the provider conversation, and the id must not wait for a turn to settle.
      this.captureConversationId(db, event);
      switch (event.type) {
        case "turn.started": {
          // Durable: the block is what anchors every item in the turn, so losing
          // it loses the reply even when the items themselves survived (the
          // failure mode the v6 migration had to repair after the fact).
          this.durably(db, () => {
            db.prepare(
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
          db.prepare(
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
          db.prepare(
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
            db.prepare(
              `UPDATE blocks SET state = 'completed', ended_at = ?
               WHERE block_id = ?`,
            ).run(event.at, assistantBlockId(event.threadId, event.turnId));
            // A side chat's first turn settling consumes the one-shot
            // `<sidechat_context>` bootstrap — the imported transcript has
            // reached the model, so it is never injected again.
            this.completeSidechatBootstrap(db, event.threadId);
          });
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "turn.aborted": {
          const state = event.reason === "interrupted" ? "interrupted" : "failed";
          this.durably(db, () => {
            db.prepare(
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
          // Snapshot the live context-window fill (overwrite, not accumulate) so
          // a reopened thread restores its meter without waiting for a turn. A
          // provider may report only part of the picture (a fresh fill without
          // the window, or a window change without a fill), so each column is
          // overwritten only when that field is present — a partial payload must
          // never blank a value the thread already knew.
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

  private touch(db: DatabaseSync, threadId: string, at: number): void {
    db.prepare(`UPDATE threads SET updated_at = ? WHERE thread_id = ?`).run(at, threadId);
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

  /** Hide (or restore) a thread from the recent list without destroying it.
   *  `archived` is a timestamp so a future "archived" view can order by it. */
  setArchived(threadId: string, archived: boolean): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET archived = ? WHERE thread_id = ?`).run(
        archived ? Date.now() : null,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setArchived failed:", err);
    }
  }

  /** Permanently remove a thread and everything under it. Irreversible — the
   *  renderer confirms before calling. */
  deleteThread(threadId: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.exec("BEGIN");
      db.prepare(`DELETE FROM items       WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM blocks      WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM attachments WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM threads     WHERE thread_id = ?`).run(threadId);
      db.exec("COMMIT");
      this.knownConversationIds.delete(threadId);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      console.error("[conversation-store] deleteThread failed:", err);
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
           ORDER BY updated_at DESC LIMIT 1`,
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
      const itemRows = db
        .prepare(`SELECT * FROM items WHERE thread_id = ? ORDER BY turn_id, seq`)
        .all(threadId) as ItemRow[];

      const subagentRows = db
        .prepare(`SELECT * FROM subagents WHERE thread_id = ? ORDER BY turn_id, seq`)
        .all(threadId) as SubagentRow[];

      // Rebuild the nested runs first: each run is a snapshot plus the items its
      // child emitted, keyed per turn by the spawning tool-use id.
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
        itemsById.set(`${r.turn_id} ${r.item_id}`, item);
        const list = itemsByTurn.get(r.turn_id) ?? [];
        list.push(item);
        itemsByTurn.set(r.turn_id, list);
      }

      for (const [turnId, perTurn] of runsByTurn) {
        for (const run of perTurn.values()) {
          if (!run.parentItemId) continue;
          const parent = itemsById.get(`${turnId} ${run.parentItemId}`);
          if (parent) parent.subagent = run;
        }
      }

      const blocks: StoredBlock[] = blockRows.map((b) =>
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

      return { ...rowToMeta(threadRow), blocks };
    } catch (err) {
      console.error("[conversation-store] loadThread failed:", err);
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
           ORDER BY t.updated_at DESC`,
        )
        .all(projectPath) as ThreadRow[];
      return rows.map(rowToMeta);
    } catch (err) {
      console.error("[conversation-store] listThreads failed:", err);
      return [];
    }
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
            insertNarrativeItem.run(`${block.id}:narrative`, input.threadId, turnId, block.text);
          }
        }
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

  // ── scratchpads ───────────────────────────────────────────────────────────

  listScratchpads(projectPath: string): ScratchpadRecord[] {
    const db = this.handle();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT id, project_path, title, body, created_at, updated_at, sort_index
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

  saveScratchpad(input: {
    padId: string;
    projectPath: string;
    title: string;
    body: string;
  }): { savedAt: number } | null {
    const db = this.handle();
    if (!db) return null;
    const savedAt = Date.now();
    try {
      const existing = db
        .prepare(`SELECT created_at, sort_index FROM scratchpads WHERE id = ?`)
        .get(input.padId) as { created_at: number; sort_index: number } | undefined;
      const sortIndex =
        existing?.sort_index ??
        ((db
          .prepare(
            `SELECT COALESCE(MAX(sort_index), -1) + 1 AS next
               FROM scratchpads WHERE project_path = ?`,
          )
          .get(input.projectPath) as { next: number }).next ?? 0);
      db.prepare(
        `INSERT INTO scratchpads (id, project_path, title, body, created_at, updated_at, sort_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           updated_at = excluded.updated_at`,
      ).run(
        input.padId,
        input.projectPath,
        input.title,
        input.body,
        existing?.created_at ?? savedAt,
        savedAt,
        sortIndex,
      );
      return { savedAt };
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
 *  Kept structural (not imported from the renderer's `~/types/board`) so the
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
};

type ScratchpadRow = {
  id: string;
  project_path: string;
  title: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  sort_index: number;
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

// ── singleton ────────────────────────────────────────────────────────────────

let store: ConversationStore | null = null;

/** The single ConversationStore instance (lazily created). */
export function getConversationStore(): ConversationStore {
  if (!store) store = new ConversationStore();
  return store;
}
