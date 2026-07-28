import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app } from "electron";

import type {
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
} from "./types.js";

// Durable conversation persistence for the agent layer. Threads, turns, and the
// ordered parts inside a turn are written to a small SQLite database as they
// stream, so a conversation survives reload / quit / project switch instead of
// living only in the renderer's in-memory timeline.
//
// The design is distilled from research's and research's stores (a single SQLite
// file under the per-user state dir, thread → turn → ordered-item model) but
// deliberately simplified for kone's scale: we write the read model directly
// from the normalized RuntimeEvent stream, with none of their event-sourcing /
// CQRS / projection machinery. The one lesson we do keep is schema versioning
// (PRAGMA user_version) so the shape can evolve without losing data.
//
// Persistence is best-effort, exactly like windowState.ts: every call is guarded
// so a storage hiccup can never crash the agent or drop a turn. Plain-TS and
// framework-free to match AgentService / the git + fs modules — no Effect, no DI.

const SCHEMA_VERSION = 7;

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
      -- "ordered-parts" model, the analogue of research's thread activities.
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
    // a row. Same model research use: title lives on the thread, not
    // derived from the first user turn at read time. Backfill existing rows
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

  // Future migrations append here: `if (version < 8) { …; version = 8; }`

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
      migrate(db);
      this.db = db;
      return db;
    } catch (err) {
      console.error("[conversation-store] could not open database:", err);
      return null;
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
  recordUserBlock(input: { threadId: string; text: string; at?: number }): number {
    const db = this.handle();
    if (!db) return 0;
    try {
      const at = input.at ?? Date.now();
      db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, text, at)
         VALUES (?, ?, 'user', ?, ?)`,
      ).run(randomUUID(), input.threadId, input.text, at);
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

  /** Fold one normalized runtime event into the stored read model — the write
   *  half of persistence. Mirrors the renderer's reducer, but to rows. */
  applyEvent(event: RuntimeEvent): void {
    const db = this.handle();
    if (!db) return;
    try {
      switch (event.type) {
        case "turn.started": {
          db.prepare(
            `INSERT INTO blocks (block_id, thread_id, role, turn_id, state, at)
             VALUES (?, ?, 'assistant', ?, 'running', ?)
             ON CONFLICT(block_id) DO NOTHING`,
          ).run(assistantBlockId(event.threadId, event.turnId), event.threadId, event.turnId, event.at);
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const it = event.item;
          db.prepare(
            `INSERT INTO items (item_id, thread_id, turn_id, kind, status, text, name, detail, tasks_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          );
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "turn.completed": {
          db.prepare(
            `UPDATE blocks SET state = 'completed', ended_at = ?
             WHERE block_id = ?`,
          ).run(event.at, assistantBlockId(event.threadId, event.turnId));
          if (event.conversationId) {
            db.prepare(
              `UPDATE threads SET conversation_id = ? WHERE thread_id = ?`,
            ).run(event.conversationId, event.threadId);
          }
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "turn.aborted": {
          const state = event.reason === "interrupted" ? "interrupted" : "failed";
          db.prepare(
            `UPDATE blocks SET state = ?, error = ?, ended_at = ?
             WHERE block_id = ?`,
          ).run(state, event.message ?? null, event.at, assistantBlockId(event.threadId, event.turnId));
          this.touch(db, event.threadId, event.at);
          break;
        }
        case "thread.token-usage.updated": {
          const total = event.usage.total;
          if (typeof total === "number" && Number.isFinite(total)) {
            // Providers report tokens two ways: Codex sends a running thread
            // total (keep the max — it only climbs), Claude sends this turn's
            // spend (sum it into the thread). Provider off the event, so the
            // store stays adapter-agnostic.
            const sql =
              event.provider === "codex"
                ? `UPDATE threads SET tokens = MAX(COALESCE(tokens, 0), ?) WHERE thread_id = ?`
                : `UPDATE threads SET tokens = COALESCE(tokens, 0) + ? WHERE thread_id = ?`;
            db.prepare(sql).run(Math.round(total), event.threadId);
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
      db.prepare(`DELETE FROM items  WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM blocks WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM threads WHERE thread_id = ?`).run(threadId);
      db.exec("COMMIT");
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

      // Group items by turn once, then attach — avoids a query per assistant block.
      const itemsByTurn = new Map<string, RuntimeItem[]>();
      for (const r of itemRows) {
        const list = itemsByTurn.get(r.turn_id) ?? [];
        list.push(rowToItem(r));
        itemsByTurn.set(r.turn_id, list);
      }

      const blocks: StoredBlock[] = blockRows.map((b) =>
        b.role === "user"
          ? { id: b.block_id, role: "user", text: b.text ?? "", at: b.at }
          : {
              id: b.block_id,
              role: "assistant",
              turnId: b.turn_id ?? b.block_id,
              items: itemsByTurn.get(b.turn_id ?? "") ?? [],
              state: (b.state as StoredAssistantState | null) ?? "completed",
              error: b.error ?? undefined,
              at: b.at,
              endedAt: b.ended_at ?? undefined,
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
  archived: number | null;
  title: string | null;
  base_tree: string | null;
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
};

type ItemRow = {
  item_id: string;
  turn_id: string;
  kind: string;
  status: string;
  text: string;
  name: string | null;
  detail: string | null;
  tasks_json: string | null;
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
    title: row.title ?? undefined,
  };
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

// ── singleton ────────────────────────────────────────────────────────────────

let store: ConversationStore | null = null;

/** The single ConversationStore instance (lazily created). */
export function getConversationStore(): ConversationStore {
  if (!store) store = new ConversationStore();
  return store;
}
