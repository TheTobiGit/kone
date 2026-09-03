import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "./sqlite.js";

import { isSpawnedRelationship } from "./types.js";
import type {
  ChatAttachment,
  ForkContext,
  InteractionMode,
  ProfileStats,
  ProviderKind,
  RelationshipToParent,
  RuntimeEvent,
  StoredThread,
  StoredThreadMeta,
  ThreadLineage,
  TokenUsage,
} from "./types.js";
import type { TokenUsageSplits, UsageRange } from "./usage/report.js";
import { usageReportFromStore } from "./usage/storeUsage.js";
import {
  readAntigravityConversationUsage,
  resolveAntigravityContextWindow,
} from "./usage/local/antigravityScan.js";
import { getUserDataDir } from "./userDataDir.js";

import {
  REOPEN_COOLDOWN_MS,
  UnsupportedSchemaError,
  assistantBlockId,
  migrate,
  withTransaction,
} from "./conversationMigrations.js";

import {
  AGENT_COLUMNS,
  AGENT_NAME_MAX,
  AGENT_PAINT_MAX,
  AGENT_PROSE_MAX,
  AGENT_ROLE_MAX,
  SUBAGENT_PRESET_COLUMNS,
  clampAgentField,
  normalizeSkillRef,
  rowToAgent,
  rowToSubagentPreset,
  serializeAgentAvatar,
  serializeAgentBot,
  serializeAgentList,
  serializeModelRef,
  type AgentCreateInput,
  type AgentDuplicateInput,
  type AgentPatch,
  type AgentRecord,
  type AgentRow,
  type SubagentPresetCreateInput,
  type SubagentPresetPatch,
  type SubagentPresetRecord,
  type SubagentPresetRow,
  type ThreadAgentBinding,
} from "./rosterRecord.js";

import {
  DONE_CLEARED,
  PAGE_DEFAULT_USER_BLOCKS,
  PAGE_RAW_FANOUT,
  assembleBlocks,
  computeStreaks,
  decodeThreadPageCursor,
  encodeThreadPageCursor,
  parseJsonObject,
  rowToAttachment,
  rowToMeta,
  rowToQueuedTurn,
  rowToScratchpad,
  type AttachmentRow,
  type BlockRow,
  type ItemRow,
  type QueuedTurnDbRow,
  type QueuedTurnEnqueueInput,
  type QueuedTurnRow,
  type ScratchpadRecord,
  type ScratchpadRow,
  type StoredAttachment,
  type StoredStudioLayout,
  type StoredThreadPage,
  type SubagentRow,
  type ThreadRow,
  type TurnPartRows,
  type TurnSpan,
  GLOBAL_ASSISTANT_PROJECT_PATH,
} from "./conversationStoreTypes.js";

export { GLOBAL_ASSISTANT_PROJECT_PATH };

export class ConversationStore {
  private db: DatabaseSync | null = null;
  /** Set when the database can never be opened by this build (see
   *  UnsupportedSchemaError). Nothing is retried after this. */
  private unusable = false;
  /** When a failed open may be attempted again. Every other failure — a file a
   *  backup or sync client has locked, a momentarily full disk, a migration step
   *  that threw — gets to heal, but not at the cost of a retry per call:
   *  `handle()` sits on every read and write here and the streaming path reaches
   *  it per event, so an unguarded retry would re-run the whole migration ladder
   *  thousands of times in a turn. Persistence is a convenience, so the app runs
   *  on without it until the cooldown expires. */
  private retryOpenAfter = 0;
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
    if (this.unusable || Date.now() < this.retryOpenAfter) return null;
    let opened: DatabaseSync | null = null;
    try {
      const file = path.join(this.userDataDir ?? getUserDataDir(), "kone.sqlite");
      const db = new DatabaseSync(file);
      opened = db;
      // Timeout first: switching journal mode takes a lock, so it is the earliest
      // statement that can lose a race with another reader and the first that
      // wants the patience configured here.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      // WAL's default `synchronous = NORMAL` doesn't fsync on commit: the file
      // stays consistent through a crash, but transactions committed since the
      // last checkpoint can be *rolled back* by a power cut (SIGKILL is safe —
      // the page cache outlives the process; losing mains power is not). Rather
      // than pay an fsync on the streaming path — `item.updated` fires per text
      // delta, so that would be thousands per turn — the few low-frequency rows a
      // conversation can't be reconstructed without are committed through
      // `durably()` below, and the per-delta churn stays at NORMAL.
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA foreign_keys = ON");
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
      // Fourth pass: populate token totals for stored Antigravity threads whose
      // tokens were not backfilled at turn run time.
      this.backfillAntigravityTokens(db);
      return db;
    } catch (err) {
      // The constructor opens the file, so anything that throws after it — a
      // rejected schema, a migration step — leaves a live connection holding the
      // WAL. Close it before giving up, and forget the half-open handle so no
      // caller can reach a database we never finished migrating.
      if (err instanceof UnsupportedSchemaError) this.unusable = true;
      else this.retryOpenAfter = Date.now() + REOPEN_COOLDOWN_MS;
      this.db = null;
      this.statements.clear();
      // A migration rung that threw is still inside its transaction. Discard it
      // explicitly rather than leaving it to the close below: a driver is free
      // to hold the write lock it took until the handle is actually collected,
      // and then the next open blocks on a database this process already gave
      // up on. Rolling back here also fixes the version the file reports at the
      // last rung that committed.
      try {
        opened?.exec("ROLLBACK");
      } catch {
        /* The rung committed, or never opened one — nothing to unwind. */
      }
      try {
        opened?.close();
      } catch {
        /* Never opened, or already closed by the failure itself. */
      }
      console.error(
        "[conversation-store] could not open database; continuing without persistence:",
        err,
      );
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
      // SAFETY: the projection names exactly these four gateway_ops columns,
      // all written by reserveGatewayOp/setGatewayOpResult.
      const rows = db
        .prepare(
          `SELECT thread_id, turn_id, request_id, result_json FROM gateway_ops
            WHERE kind = 'spawn.thread' AND status = 'dispatching' AND result_json IS NOT NULL`,
        )
        .all() as Array<{
        thread_id: string;
        turn_id: string;
        request_id: string;
        result_json: string;
      }>;
      const childMeta = db.prepare(
        `SELECT relationship_to_parent FROM threads WHERE thread_id = ?`,
      );
      const hasAssistantBlock = db.prepare(
        `SELECT 1 FROM blocks WHERE thread_id = ? AND role = 'assistant' LIMIT 1`,
      );
      const insertFailedTurn = db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, turn_id, state, error, at, ended_at)
         VALUES (?, ?, 'assistant', '<undispatched>', 'failed', ?, ?, ?)
         ON CONFLICT(block_id) DO NOTHING`,
      );
      const markFailed = db.prepare(
        `UPDATE gateway_ops SET status = 'failed'
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      );
      for (const row of rows) {
        let childId: string | undefined;
        try {
          // SAFETY: result_json here is only ever written by setGatewayOpResult
          // from the spawn engine's own { threadId } payload.
          const parsed = JSON.parse(row.result_json) as { threadId?: string };
          if (parsed.threadId) {
            childId = String(parsed.threadId).trim() || undefined;
          }
        } catch {
          childId = undefined;
        }
        if (!childId) continue;
        // The child row must still exist with spawned lineage (an anonymous
        // subagent or a delegation to a named agent) and no real turns yet —
        // never clobber a child that actually ran.
        // SAFETY: childMeta selects only threads.relationship_to_parent.
        const meta = childMeta.get(childId) as
          | { relationship_to_parent: RelationshipToParent | null }
          | undefined;
        if (!meta || !isSpawnedRelationship(meta.relationship_to_parent)) continue;
        if (hasAssistantBlock.get(childId)) continue;
        insertFailedTurn.run(
          assistantBlockId(childId, "<undispatched>"),
          childId,
          "The app exited before this thread's first turn was dispatched — the spawn never started. Ask the parent to spawn it again with a fresh requestId.",
          now,
          now,
        );
        markFailed.run(row.thread_id, row.turn_id, row.request_id);
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

  /** Backfill token totals and context window for stored Antigravity threads. */
  private backfillAntigravityTokens(db: DatabaseSync): void {
    try {
      // SAFETY: SQLite query returns row objects matching the queried thread columns.
      const rows = db
        .prepare(
          `SELECT thread_id, conversation_id, model FROM threads
           WHERE provider = 'antigravity'`,
        )
        .all() as Array<{ thread_id: string; conversation_id: string | null; model: string | null }>;

      for (const row of rows) {
        const contextWindow = resolveAntigravityContextWindow(row.model ?? undefined);
        let tokens: number | undefined;
        let contextUsed: number | undefined;

        if (row.conversation_id) {
          const usage = readAntigravityConversationUsage([row.conversation_id]);
          if (usage && usage.totalTokens > 0) {
            tokens = Math.round(usage.totalTokens);
            contextUsed = usage.latestContextUsed !== undefined ? Math.round(usage.latestContextUsed) : tokens;
          }
        }

        db.prepare(
          `UPDATE threads
             SET tokens = COALESCE(?, tokens),
                 context_used = COALESCE(?, context_used),
                 context_window = COALESCE(context_window, ?),
                 compacts_auto = COALESCE(compacts_auto, 1)
           WHERE thread_id = ?`,
        ).run(
          tokens ?? null,
          contextUsed ?? null,
          contextWindow,
          row.thread_id,
        );
      }
    } catch (err) {
      console.error("[conversation-store] could not backfill antigravity tokens:", err);
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
      // `last_visited_at` is stamped on the insert and left alone on the
      // conflict. Unread is a comparison against when you last looked, so a row
      // born with no visit is born unread — a thread you are creating, and
      // therefore looking at, would carry a mark for whatever it says first
      // until some surface got around to stamping it. Updating it on conflict
      // would be the opposite mistake: ensureThread runs on every session start,
      // and that is not a visit.
      db.prepare(
        `INSERT INTO threads (
           thread_id, project_path, provider, model, created_at, last_activity_at,
           last_visited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           project_path = excluded.project_path,
           provider     = excluded.provider,
           model        = COALESCE(excluded.model, threads.model),
           last_activity_at = excluded.last_activity_at`,
      ).run(
        input.threadId,
        input.projectPath,
        input.provider,
        input.model ?? null,
        now,
        now,
        now,
      );
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
      // SAFETY: COUNT(*) always arrives under the alias asked for.
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
      // SAFETY: `SELECT *` of attachments is exactly AttachmentRow — the
      // columns this schema creates.
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
      // SAFETY: `SELECT *` of attachments is exactly AttachmentRow — the
      // columns this schema creates.
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
      // SAFETY: `SELECT *` of attachments keyed on the primary key is at most
      // one row of exactly AttachmentRow.
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
      // SAFETY: the projection names only the nullable TEXT title column.
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
      // SAFETY: same single-column projection as getTitle.
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
      db.prepare(`UPDATE threads SET pinned_at = ? WHERE thread_id = ?`).run(
        pinned ? Date.now() : null,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setPinned failed:", err);
    }
  }

  /** Mark a thread done, or take the mark off. Done says you are finished with
   *  the thread's claim on your attention — it does not stop the agent, close
   *  the thread, or archive it, and the work is untouched either way.
   *
   *  Stamped rather than flagged, because the mark expires on its own: a thread
   *  the agent has spoken in since carries a `done_at` older than its
   *  `last_activity_at`, and reads compare the two instead of trusting the
   *  stamp alone. So nothing has to clear this when a turn lands, and no crash
   *  between a turn and a clear can leave a live thread silently marked done.
   *
   *  Un-marking writes epoch zero, not NULL. The two are different answers:
   *  NULL is "you never said", which leaves a thread free to be counted done by
   *  age once it has been quiet long enough, and zero is "you said you are not
   *  finished", which outranks age for good. Writing NULL for both would make
   *  the un-mark silently reverse itself on exactly the old threads someone is
   *  most likely to press it on. Zero is safe as the marker because it is not a
   *  time any thread was ever marked at. */
  setDone(threadId: string, done: boolean): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET done_at = ? WHERE thread_id = ?`).run(
        done ? Date.now() : DONE_CLEARED,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setDone failed:", err);
    }
  }

  /** Record that the user has just had this thread in front of them.
   *
   *  Monotonic on purpose: a stamp only ever moves forward, so two surfaces
   *  showing the same thread (a studio column and the inbox reader) cannot have
   *  the slower one's write undo the faster one's, and a late-arriving write
   *  from a pane that has since been closed cannot re-hide a reply that landed
   *  after it. The one caller that needs to go backwards is marking a thread
   *  unread again, which passes the earlier time deliberately — hence `force`.
   */
  setVisited(threadId: string, at: number, force = false): void {
    const db = this.handle();
    if (!db) return;
    try {
      if (force) {
        db.prepare(`UPDATE threads SET last_visited_at = ? WHERE thread_id = ?`).run(at, threadId);
        return;
      }
      db.prepare(
        `UPDATE threads SET last_visited_at = ?
         WHERE thread_id = ? AND (last_visited_at IS NULL OR last_visited_at < ?)`,
      ).run(at, threadId, at);
    } catch (err) {
      console.error("[conversation-store] setVisited failed:", err);
    }
  }

  /** Persist the user's per-thread picker selection so a reopened thread
   *  restores it exactly (agent:set-thread-selection; fix_registry contract).
   *  `model` lands on the existing threads.model column (the display model);
   *  effort / serviceTier / contextWindow / mode ride `model_selection_json` — the
   *  same axes SendTurnInput carries. Absent fields are left untouched. */
  setThreadSelection(
    threadId: string,
    selection: {
      model?: string;
      effort?: string;
      serviceTier?: string;
      contextWindow?: string;
      mode?: InteractionMode | string;
    },
  ): void {
    const db = this.handle();
    if (!db) return;
    try {
      // Merge over the stored knobs: a partial update (the picker commits one
      // axis at a time) must never wipe the knobs it didn't touch.
      // SAFETY: the projection names only model_selection_json, the nullable
      // TEXT knob blob this class writes via JSON.stringify.
      const row = db
        .prepare(`SELECT model_selection_json FROM threads WHERE thread_id = ?`)
        .get(threadId) as { model_selection_json: string | null } | undefined;
      const knobs: {
        effort?: string;
        serviceTier?: string;
        contextWindow?: string;
        mode?: string;
      } =
        parseJsonObject<{
          effort?: string;
          serviceTier?: string;
          contextWindow?: string;
          mode?: string;
        }>(row?.model_selection_json ?? null) ?? {};
      if (selection.effort !== undefined) knobs.effort = selection.effort;
      if (selection.serviceTier !== undefined) knobs.serviceTier = selection.serviceTier;
      if (selection.contextWindow !== undefined) knobs.contextWindow = selection.contextWindow;
      if (selection.mode !== undefined) knobs.mode = selection.mode;
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
          // No touch() here: `item.updated` fires once per text delta, so a
          // recency stamp on this branch would rewrite the thread row thousands
          // of times a turn. `last_activity_at` only needs turn granularity —
          // turn.started and turn.completed already stamp it — so the per-delta
          // churn is pure write amplification with no ordering consequence.
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
            if (total !== undefined && total !== null && Number.isFinite(total)) {
              // Codex, OpenCode, Cursor and Antigravity report running thread totals
              // (keep the max); Claude reports per-turn spend (accumulate).
              const isRunningTotal =
                event.provider === "codex" ||
                event.provider === "opencode" ||
                event.provider === "cursor" ||
                event.provider === "antigravity";
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
              (contextWindow !== undefined && contextWindow !== null && Number.isFinite(contextWindow)) ||
              (contextUsed !== undefined && contextUsed !== null && Number.isFinite(contextUsed))
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
                contextUsed !== undefined && contextUsed !== null && Number.isFinite(contextUsed)
                  ? Math.round(contextUsed)
                  : null,
                contextWindow !== undefined && contextWindow !== null && Number.isFinite(contextWindow)
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
            // SAFETY: the projection names only the latest assistant block's
            // nullable turn_id.
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
              // SAFETY: the split counts ride beyond TokenUsage's declared
              // fields; every read below defaults them.
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
      usage.input !== undefined && usage.input !== null && Number.isFinite(usage.input) ? Math.round(usage.input) : null,
      usage.output !== undefined && usage.output !== null && Number.isFinite(usage.output) ? Math.round(usage.output) : null,
      usage.total !== undefined && usage.total !== null && Number.isFinite(usage.total) ? Math.round(usage.total) : null,
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
      `UPDATE threads SET last_activity_at = ? WHERE thread_id = ?`,
    ).run(at, threadId);
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
      // SAFETY: the projection names only base_tree, nullable TEXT.
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
   *  FIFO by created_at, with the table's insertion order (rowid) as the final
   *  tiebreak. rowid rather than queue_id: created_at is a millisecond clock,
   *  so two rows enqueued in the same tick tie on it, and breaking that tie by
   *  a random UUID ordered them arbitrarily instead of by arrival. Returns the
   *  row now in 'promoting' (attempt_count already bumped), or null when the
   *  thread has nothing active to claim. */
  claimNextQueuedTurn(threadId: string, staleTimeoutMs = 120_000): QueuedTurnRow | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const now = Date.now();
      const cutoff = now - staleTimeoutMs;
      db.prepare(
        `UPDATE queued_turns
            SET state = 'queued', updated_at = ?
          WHERE thread_id = ? AND state = 'promoting' AND updated_at <= ?`,
      ).run(now, threadId, cutoff);

      // SAFETY: RETURNING * of queued_turns is exactly QueuedTurnDbRow — the
      // columns this schema creates.
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
                 CASE WHEN dispatch_mode = 'steer' THEN rowid END DESC,
                 created_at ASC,
                 rowid ASC
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

  /** Release every queued turn stranded in 'promoting' whose claim has expired
   *  (not updated within `staleTimeoutMs`). Returns the count of recovered rows. */
  recoverStaleClaims(staleTimeoutMs = 120_000): number {
    const db = this.handle();
    if (!db) return 0;
    try {
      const now = Date.now();
      const cutoff = now - staleTimeoutMs;
      const result = db
        .prepare(
          `UPDATE queued_turns
              SET state = 'queued', updated_at = ?
            WHERE state = 'promoting' AND updated_at <= ?`,
        )
        .run(now, cutoff);
      return Number(result.changes);
    } catch (err) {
      console.error("[conversation-store] recoverStaleClaims failed:", err);
      return 0;
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

  /** Cancel ONE queued turn (the UI's per-item cancel). Only a row still
   *  WAITING can flip: 'promoting' means a drain has already claimed it and
   *  handed it to the adapter, so flipping it would report a cancellation for
   *  a turn that is running — the chip would vanish, turn.queued-cancelled
   *  would go out with reason "user", and the agent would answer the message
   *  anyway. Losing the race is the honest answer (false); the row promotes
   *  and the chip is replaced by the running turn. The stop/delete path keeps
   *  cancelling 'promoting' rows on purpose — see cancelQueuedTurnsForThread,
   *  where the session is being torn down regardless. Returns whether a row
   *  flipped. */
  cancelQueuedTurn(queueId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(
          `UPDATE queued_turns SET state = 'cancelled', updated_at = ?
            WHERE queue_id = ? AND state = 'queued'`,
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
      // SAFETY: RETURNING names only queue_id.
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
      // SAFETY: `SELECT *` of queued_turns is exactly QueuedTurnDbRow — the
      // columns this schema creates.
      const rows = db
        .prepare(
          `SELECT * FROM queued_turns
            WHERE thread_id = ? AND state IN ('queued', 'promoting')
            ORDER BY
              CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
              CASE WHEN dispatch_mode = 'steer' THEN created_at END DESC,
              CASE WHEN dispatch_mode = 'steer' THEN rowid END DESC,
              created_at ASC,
              rowid ASC`,
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
        // SAFETY: childOf selects only threads.thread_id.
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
   *  without destroying them. `archived` is a timestamp so the archived view
   *  can order by when the put-away happened. Refuses (and returns the reason)
   *  when a spawned descendant is mid-turn. On success returns every thread id
   *  the stamp landed on, ancestor-first, so the caller can announce the
   *  change per thread.
   *
   *  This is the pure data primitive: it touches ONLY the threads table. The
   *  caller (AgentService.setThreadArchived) owns everything announcements
   *  need — cancelling the subtree's queued turns, and the thread.archived /
   *  turn.queued-cancelled events that make every surface agree. */
  setArchived(
    threadId: string,
    archived: boolean,
  ): { ok: true; threadIds: string[] } | { ok: false; reason: "missing" | "busy" | "error" } {
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
      // Queued turns are deliberately NOT touched here — the service layer
      // cancels them (and says so over the event stream) as part of the same
      // archive request, so a hidden thread never carries a queue the user
      // can no longer see. Cancelling at that layer rather than this one
      // keeps the store free of event emission, where it has no listeners.
      const stamp = archived ? Date.now() : null;
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`UPDATE threads SET archived_at = ? WHERE thread_id IN (${placeholders})`).run(
        stamp,
        ...ids,
      );
      return { ok: true, threadIds: ids };
    } catch (err) {
      console.error("[conversation-store] setArchived failed:", err);
      return { ok: false, reason: "error" };
    }
  }

  /** Live threads the retention sweep may tidy. Roots only (a spawned child is
   *  archived through its parent — archiving one alone would strand it with no
   *  row to restore it from), never pinned (a pin is a keep-me), never already
   *  archived, and never a subtree with active queued turns (putting those
   *  away would silently cancel work the user asked for). Staleness is the
   *  newest of the thread's own timestamps — a thread only counts as stale
   *  when every signal it carries is past the cutoff — and the stalest come
   *  first, so a backlog drains oldest-first.
   *
   *  `last_visited_at` is one of those signals, and it has to be: the sweep is
   *  answering "has anyone touched this in a week", and reading a thread is
   *  touching it. `done_at` is another: a thread you marked done is work you are
   *  finished with, but only while the agent hasn't spoken since; done expired
   *  by subsequent activity is a thread asking again, not an idle one.
   *  `DONE_CLEARED` (the un-mark sentinel) is ignored — it is the user's
   *  explicit "this is not done", and treating it as a timestamp would place it
   *  at epoch zero and make the thread look older than everything.
   *
   *  Roots with children are tidied only when the whole subtree qualifies — a
   *  parent whose child is still active is kept alive so the child has its
   *  anchor. The recursive query gathers subtree ids and confirms every
   *  descendant is quiet before the root is offered.
   *
   *  `options.undone`: restrict the sweep to threads that are EITHER never
   *  marked done, OR marked done before their latest activity — in other words,
   *  threads the user has NOT said they are finished with. Done = 0 (the sentinel)
   *  is the user's "not finished" answer, which outranks age for good; the
   *  sweep has no business overriding it. */
  staleThreadIds(options: {
    unusedMs: number;
    limit: number;
    undone?: boolean;
  }): string[] {
    const db = this.handle();
    if (!db) return [];
    const cutoff = Date.now() - Math.max(0, options.unusedMs);
    try {
      // SAFETY: the recursive SELECT projects exactly threads.thread_id.
      const rows = db
        .prepare(
          `WITH RECURSIVE subtree(root_id, id) AS (
             SELECT t.thread_id AS root_id, t.thread_id AS id FROM threads t
             WHERE t.parent_thread_id IS NULL
               AND t.archived_at IS NULL
               AND t.pinned_at IS NULL
               AND MAX(t.last_activity_at, COALESCE(t.last_visited_at, 0)) < ?
               ${options.undone ? `AND (t.done_at IS NULL OR (t.done_at > 0 AND t.done_at < t.last_activity_at))` : ""}
             UNION ALL
             SELECT s.root_id, c.thread_id FROM threads c JOIN subtree s ON c.parent_thread_id = s.id
           )
           SELECT t.thread_id, MAX(t.last_activity_at, COALESCE(t.last_visited_at, 0)) AS activity
           FROM threads t
           WHERE t.thread_id IN (SELECT root_id FROM subtree)
             AND t.parent_thread_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM queued_turns q
               JOIN subtree s ON q.thread_id = s.id
               WHERE s.root_id = t.thread_id
                 AND q.state IN ('queued', 'promoting')
             )
             AND NOT EXISTS (
               SELECT 1 FROM blocks b
               JOIN subtree s ON b.thread_id = s.id
               WHERE s.root_id = t.thread_id
                 AND b.role = 'assistant' AND b.state = 'running'
             )
             AND NOT EXISTS (
               SELECT 1 FROM subagents sa
               JOIN subtree s ON sa.thread_id = s.id
               WHERE s.root_id = t.thread_id
                 AND sa.status IN ('starting', 'running')
             )
           ORDER BY activity ASC
           LIMIT ?`,
        )
        .all(cutoff, options.limit) as Array<{ thread_id: string }>;
      return rows.map((r) => r.thread_id);
    } catch (err) {
      console.error("[conversation-store] staleThreadIds failed:", err);
      return [];
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
        // thread_agents has no foreign key to threads (to allow bindings before thread creation),
        // so it is cleared explicitly. All thread-scoped child tables (items, blocks, attachments,
        // subagents, gateway_ops, turn_usage, queued_turns) cascade automatically from threads.
        db.prepare(`DELETE FROM thread_agents WHERE thread_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM threads       WHERE thread_id IN (${placeholders})`).run(...ids);
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
      // SAFETY: `SELECT *` of attachments is exactly AttachmentRow — the
      // columns this schema creates.
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
      // SAFETY: the projection names only project_path, NOT NULL TEXT.
      const row = db
        .prepare(`SELECT project_path FROM threads WHERE thread_id = ?`)
        .get(threadId) as { project_path: string } | undefined;
      return row?.project_path ?? null;
    } catch (err) {
      console.error("[conversation-store] threadProjectPath failed:", err);
      return null;
    }
  }

  /** Whether a thread belongs to the global assistant rather than a project. */
  isAssistantThread(threadId: string): boolean {
    return this.threadProjectPath(threadId) === GLOBAL_ASSISTANT_PROJECT_PATH;
  }

  /** All non-archived assistant threads in recency order. */
  listAssistantThreads(): StoredThreadMeta[] {
    return this.listThreads(GLOBAL_ASSISTANT_PROJECT_PATH);
  }

  /** Cheap metadata lookup by id — used when the live session isn't in memory
   *  (e.g. title naming right after send) but the store row already exists. */
  threadMeta(threadId: string): StoredThreadMeta | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
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
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
      const row = db
        .prepare(
          `SELECT * FROM threads WHERE project_path = ? AND archived_at IS NULL
           ORDER BY last_activity_at DESC LIMIT 1`,
        )
        .get(projectPath) as ThreadRow | undefined;
      return row ? rowToMeta(row) : null;
    } catch (err) {
      console.error("[conversation-store] latestThreadMeta failed:", err);
      return null;
    }
  }

  /** Fast indexed lookup for the ID of the most recent user block in a thread,
   *  avoiding full-transcript parsing on turn enqueues. */
  latestUserBlockId(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names only the newest user block's block_id
      // (NOT NULL TEXT).
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
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
      const threadRow = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(threadId) as ThreadRow | undefined;
      if (!threadRow) return null;

      // SAFETY: `SELECT *` of blocks in seq order is exactly BlockRow.
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
  ): TurnPartRows {
    if (turnIds && turnIds.length === 0) {
      return { itemRows: [], subagentRows: [] };
    }
    // SAFETY: both branches are `SELECT *` of items — exactly ItemRow.
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
    // SAFETY: both branches are `SELECT *` of subagents — exactly SubagentRow.
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
   * The walk itself is ordered by `seq` — arrival order — but the cursor
   * deliberately encodes (at, block_id) rather than that seq: seq is
   * renumbered by the delete+reinsert of fork-import copying and any future
   * compaction/rebuild, which would silently invalidate every persisted
   * cursor. `at` and `block_id` are event-derived content, so cursors survive
   * rewrites; the boundary's seq is resolved from its block_id at query time,
   * and the thread id rides inside the cursor so it can never be replayed
   * against a different thread (a foreign or malformed cursor degrades to a
   * first-page request). */
  loadThreadPage(
    threadId: string,
    options?: { limit?: number; maxRaw?: number; cursor?: string },
  ): StoredThreadPage | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
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
      // The boundary's `seq`, resolved from the block id the cursor carries.
      // Null when the cursor's block is gone (a fork-import rewrite, a delete),
      // and the walk falls back to the `at` it also carries — still strictly
      // older blocks, just with the millisecond as the boundary.
      // SAFETY: the projection names only blocks.seq (INTEGER PRIMARY KEY), and
      // the lookup is on the block_id UNIQUE index, so it is one row or none.
      const boundaryRow = boundary
        ? (this.prepare(
            db,
            `SELECT seq FROM blocks WHERE thread_id = ? AND block_id = ?`,
          ).get(threadId, boundary.beforeBlockId) as { seq: number } | undefined)
        : undefined;
      const boundarySeq = boundaryRow?.seq ?? null;

      // Ordered by `seq` — arrival order, the only order in which a turn's
      // assistant block is guaranteed to follow the prompt that started it.
      // `at` cannot carry that: the user block's insert and the turn.started
      // that opens the assistant block land in the same millisecond often
      // enough, and the string tiebreak on block_id then puts the reply
      // *before* its own prompt — which rendered the reply above the prompt,
      // and dropped it from the page entirely whenever the inverted pair
      // straddled the window boundary below (the walk stops on the limit-th
      // user block, so an assistant block sorted after it never got kept).
      // SAFETY: all three branches are `SELECT *` of blocks — exactly BlockRow.
      const candidates = (
        boundarySeq !== null
          ? db
              .prepare(
                `SELECT * FROM blocks
                  WHERE thread_id = ? AND seq < ?
                  ORDER BY seq DESC
                  LIMIT ?`,
              )
              .all(threadId, boundarySeq, maxRaw)
          : boundary
            ? db
                .prepare(
                  `SELECT * FROM blocks
                    WHERE thread_id = ? AND at < ?
                    ORDER BY seq DESC
                    LIMIT ?`,
                )
                .all(threadId, boundary.beforeAnchorAt, maxRaw)
            : db
                .prepare(`SELECT * FROM blocks WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`)
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
          .prepare(`SELECT 1 FROM blocks WHERE thread_id = ? AND seq < ? LIMIT 1`)
          .get(threadId, oldest.seq) != null;

      const turnIds = [...new Set(kept.map((b) => b.turn_id).filter((t): t is string => Boolean(t)))];
      const parts = this.loadTurnParts(db, threadId, turnIds);
      // Oldest-first, the renderer timeline order. Reversing the DESC walk is
      // exactly `seq` ASC — the same order the full read uses, and total, so a
      // cursor walk can never skip or repeat a block.
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
   *  of the list).
   *
   *  The two states are disjoint views of the same table, never a union: by
   *  default the live threads, and with `archived: true` only the put-away
   *  ones. A caller asking for archived threads is looking at the archive as a
   *  place, so mixing the live ones back in would defeat the request. */
  listThreads(projectPath: string, options?: { archived?: boolean }): StoredThreadMeta[] {
    const db = this.handle();
    if (!db) return [];
    const archivedOnly = options?.archived === true;
    try {
      // SAFETY: `t.*` plus computed snippet matches ThreadRow.
      const rows = db
        .prepare(
          `SELECT t.*,
            (SELECT text FROM items WHERE thread_id = t.thread_id AND kind = 'assistant_text' AND text IS NOT NULL AND trim(text) != '' ORDER BY seq DESC LIMIT 1) AS snippet
          FROM threads t
            WHERE t.project_path = ?
              AND t.archived_at IS ${archivedOnly ? "NOT NULL" : "NULL"}
              AND EXISTS (
                SELECT 1 FROM blocks b
                WHERE b.thread_id = t.thread_id AND b.role = 'user'
              )
            ORDER BY ${archivedOnly ? "t.archived_at DESC" : "t.last_activity_at DESC"}`,
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

      // SAFETY: two aliased COUNT aggregates, exactly the names below.
      const totalsRow = db
        .prepare(
          `SELECT COUNT(*) AS threads, COUNT(DISTINCT project_path) AS projects
            FROM (${REAL})`,
        )
        .get() as { threads: number; projects: number };

      // SAFETY: COUNT(*) aliased to n, as everywhere in this file.
      const prompts = (
        db.prepare(`SELECT COUNT(*) AS n FROM blocks WHERE role = 'user'`).get() as { n: number }
      ).n;

      // Tokens: aggregated from the per-turn audit trail.
      // SAFETY: three COALESCE'd SUM aggregates under the aliases read below.
      const usage = db
        .prepare(
          `SELECT COALESCE(SUM(total_tokens), 0) AS total,
                  COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output
            FROM turn_usage`,
        )
        .get() as { total: number; input: number; output: number };
      const totalTokens = usage.total;

      // Activity + hours by local calendar (user blocks carry the timestamp).
      // SAFETY: the GROUP BY returns exactly the aliased date/count pair.
      const activity = db
        .prepare(
          `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS date,
                  COUNT(*) AS count
            FROM blocks WHERE role = 'user'
            GROUP BY date ORDER BY date ASC`,
        )
        .all() as Array<{ date: string; count: number }>;

      // SAFETY: same shape — an aliased hour/count pair per bucket.
      const hours = db
        .prepare(
          `SELECT CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                  COUNT(*) AS count
            FROM blocks WHERE role = 'user'
            GROUP BY hour ORDER BY count DESC`,
        )
        .all() as Array<{ hour: number; count: number }>;

      // SAFETY: GROUP BY returns exactly the aliased provider/count pair
      // ProfileStats["providers"] is declared from.
      const providers = db
        .prepare(
          `SELECT provider, COUNT(*) AS count FROM (${REAL})
            GROUP BY provider ORDER BY count DESC`,
        )
        .all() as ProfileStats["providers"];

      // SAFETY: same — model/provider/count is ProfileStats["models"]'s shape.
      const models = db
        .prepare(
          `SELECT model, provider, COUNT(*) AS count FROM (${REAL})
            WHERE model IS NOT NULL AND model <> ''
            GROUP BY model, provider ORDER BY count DESC`,
        )
        .all() as ProfileStats["models"];

      // SAFETY: same — effort/count is ProfileStats["reasoning"]'s shape.
      const reasoning = db
        .prepare(
          `SELECT json_extract(model_selection_json, '$.effort') AS effort, COUNT(*) AS count
           FROM (${REAL})
           WHERE effort IS NOT NULL AND effort <> ''
           GROUP BY effort ORDER BY count DESC`,
        )
        .all() as ProfileStats["reasoning"];

      // SAFETY: an aliased path/prompts pair per project group.
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
      // SAFETY: the projection names only thread_id (TEXT primary key).
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
      // SAFETY: the projection names the two NOT NULL/declared columns read
      // below; provider is written only from ProviderKind inputs.
      const row = db
        .prepare(
          `SELECT thread_id, provider FROM threads
            WHERE source_thread_id = ?
            ORDER BY created_at ASC LIMIT 1`,
        )
        .get(sourceThreadId) as { thread_id: string; provider: string } | undefined;
      // SAFETY: threads.provider only ever stores ProviderKind strings — every
      // writer takes input.provider typed as ProviderKind.
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
      // SAFETY: the projection names only fork_context_json, the nullable TEXT
      // blob this class writes via JSON.stringify(ForkContext).
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
           thread_id, project_path, provider, model, created_at, last_activity_at,
           title, source_thread_id, fork_context_json, relationship_to_parent, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertBlock = db.prepare(
        `INSERT INTO blocks (block_id, thread_id, role, turn_id, text, state, at, ended_at, attachments_json, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fork-import')`,
      );
      const insertNarrativeItem = db.prepare(
        `INSERT INTO items (item_id, thread_id, turn_id, kind, status, text, at)
         VALUES (?, ?, ?, 'assistant_text', 'completed', ?, ?)`,
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
            input.lineage.relationshipToParent ?? null,
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
                block.at,
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
      // SAFETY: same single-column projection as threadForkContext.
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
             thread_id, project_path, provider, model, created_at,
             last_activity_at, title, relationship_to_parent, parent_thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.threadId,
          input.projectPath,
          input.provider,
          input.model ?? null,
          input.createdAt,
          input.createdAt,
          input.title,
          input.lineage.relationshipToParent ?? null,
          input.lineage.parentThreadId,
        );
      });
      return true;
    } catch (err) {
      console.error("[conversation-store] writeSpawnedThread failed:", err);
      return false;
    }
  }

  /** Rewrite a spawned child's stored provider/model after a spawn-time
   *  failover. The row is written before dispatch, so a child that actually
   *  started on a later candidate would otherwise keep showing the model that
   *  could not start. */
  retargetSpawnedThread(threadId: string, provider: ProviderKind, model?: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      this.durably(db, () => {
        db.prepare(`UPDATE threads SET provider = ?, model = ? WHERE thread_id = ?`).run(
          provider,
          model ?? null,
          threadId,
        );
      });
    } catch (err) {
      console.error("[conversation-store] retargetSpawnedThread failed:", err);
    }
  }

  /** The thread's stored lineage block, or null when the thread has none (a
   *  plain root, or a missing row). Reconstructs lineage from parent_thread_id
   *  and relationship_to_parent, walking parent pointers to derive the root. */
  threadLineage(threadId: string): ThreadLineage | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: query selects only parent_thread_id and relationship_to_parent.
      const row = db
        .prepare(
          `SELECT parent_thread_id, relationship_to_parent FROM threads WHERE thread_id = ?`,
        )
        .get(threadId) as
        | { parent_thread_id: string | null; relationship_to_parent: RelationshipToParent | null }
        | undefined;
      if (!row || (!row.parent_thread_id && !row.relationship_to_parent)) {
        return null;
      }
      let rootThreadId = row.parent_thread_id ?? threadId;
      if (row.parent_thread_id) {
        const parentStmt = db.prepare(`SELECT parent_thread_id FROM threads WHERE thread_id = ?`);
        const visited = new Set<string>([threadId, row.parent_thread_id]);
        let current = row.parent_thread_id;
        for (let hops = 0; hops < 64; hops++) {
          // SAFETY: query selects only parent_thread_id.
          const pRow = parentStmt.get(current) as
            | { parent_thread_id: string | null }
            | undefined;
          const nextParent = pRow?.parent_thread_id;
          if (!nextParent || visited.has(nextParent)) {
            rootThreadId = current;
            break;
          }
          visited.add(nextParent);
          current = nextParent;
        }
      }
      return {
        parentThreadId: row.parent_thread_id,
        relationshipToParent: row.relationship_to_parent,
        rootThreadId,
      };
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
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
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
      // SAFETY: the projection names only parent_thread_id (nullable TEXT).
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
      // SAFETY: the DISTINCT projection names only threads.thread_id.
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
   *  demand via kone_read_response). Null when the thread has never produced
   *  assistant text. */
  latestAssistantText(threadId: string): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names only the newest assistant block's
      // nullable turn_id.
      const block = db
        .prepare(
          `SELECT turn_id FROM blocks
            WHERE thread_id = ? AND role = 'assistant'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(threadId) as { turn_id: string | null } | undefined;
      if (!block?.turn_id) return null;
      // SAFETY: the projection names only items.text (NOT NULL TEXT).
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
  threadTurnSpan(threadId: string): TurnSpan | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: every selected value is an aliased aggregate or a scalar
      // subselect named in the projection below.
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
      const span: TurnSpan = {
        startedAt: row.started_at,
        endedAt: row.running > 0 ? null : row.ended_at,
        runningTurns: row.running,
        lastState: row.last_state,
      };
      if (row.last_error) span.lastError = row.last_error;
      return span;
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
      // SAFETY: the projection is the column list ScratchpadRow is declared
      // from.
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
      // SAFETY: same column list keyed on the primary key, so at most one row
      // of exactly that shape.
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
      // SAFETY: four named columns of scratchpads — timestamps and counters
      // are NOT NULL, body is the written TEXT.
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
      // SAFETY: a COALESCE'd MAX aggregate aliased to next, as the roster's.
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
          `INSERT INTO gateway_ops (thread_id, turn_id, request_id, kind, fingerprint, result_json, status)
           VALUES (?, ?, ?, ?, ?, NULL, 'reserved')
           ON CONFLICT(thread_id, turn_id, request_id) DO NOTHING`,
        )
        .run(input.threadId, input.turnId, input.requestId, input.kind, input.fingerprint);
      if (Number(inserted.changes) > 0) return { kind: "reserved" };
      // SAFETY: the projection names the two columns written by reserveGatewayOp/setGatewayOpResult.
      const prior = db
        .prepare(
          `SELECT fingerprint, result_json FROM gateway_ops
            WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
        )
        .get(input.threadId, input.turnId, input.requestId) as
        | { fingerprint: string; result_json: string | null }
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
   *  key + fingerprint replays it. Status transitions to 'dispatching'. */
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
        `UPDATE gateway_ops SET result_json = ?, status = 'dispatching'
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      ).run(input.resultJson, input.threadId, input.turnId, input.requestId);
    } catch (err) {
      console.error("[conversation-store] setGatewayOpResult failed:", err);
    }
  }

  /** Record that a reserved gateway operation's side effect was actually
   *  dispatched. Status transitions to 'completed'. */
  markGatewayOpDispatched(input: {
    threadId: string;
    turnId: string;
    requestId: string;
  }): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE gateway_ops SET status = 'completed'
          WHERE thread_id = ? AND turn_id = ? AND request_id = ?`,
      ).run(input.threadId, input.turnId, input.requestId);
    } catch (err) {
      console.error("[conversation-store] markGatewayOpDispatched failed:", err);
    }
  }

  // ── the roster: agents, and each project's team ────────────────────────────
  // See the v22 rung for the shape. The rule that governs every method here:
  // NULL is returned verbatim, never resolved. A NULL on an overlay row means
  // "inherit from the shipped preset", and only the renderer holds the shipped
  // presets — a store that guessed a default would be inventing an agent's
  // character.

  /** Give every shipped preset an overlay row, in the order they were handed
   *  over. Idempotent, and deliberately unable to resurrect a deleted built-in:
   *  a user who dismissed one does not find it back on next launch.
   *
   *  Called on hydrate rather than from a migration rung, so a built-in added
   *  by a later build gets its row without a schema change — the renderer is
   *  the only layer that knows which presets exist, so it is the layer that
   *  says so. A built-in that arrives that way appends like anything else,
   *  landing after the agents the user already had rather than inserting itself
   *  above them. */
  ensurePresetAgents(presetIds: readonly string[]): void {
    const db = this.handle();
    if (!db) return;
    if (presetIds.length === 0) return;
    try {
      const now = Date.now();
      withTransaction(db, () => {
        const insert = db.prepare(
          `INSERT INTO agents (agent_id, preset_id, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO NOTHING`,
        );
        for (const presetId of presetIds) {
          // Read per insert, not once: the previous row of this loop is already
          // visible inside the transaction, so the first launch lays the
          // presets out in shipped order and no two rows share a position.
          insert.run(presetId, presetId, this.nextAgentSortOrder(db), now, now);
        }
      });
    } catch (err) {
      console.error("[conversation-store] ensurePresetAgents failed:", err);
    }
  }

  /** The roster, in order. Deleted agents are left out unless asked for — the
   *  renderer wants them when it has to name whoever worked an old thread, and
   *  never when it is drawing a list you can pick from. */
  listAgents(options?: { includeDeleted?: boolean }): AgentRecord[] {
    const db = this.handle();
    if (!db) return [];
    try {
      // SAFETY: `AGENT_COLUMNS` is the column list `AgentRow` is declared from,
      // so the projection and the type are the same list in both directions.
      const rows = db
        .prepare(
          `SELECT ${AGENT_COLUMNS} FROM agents
            ${options?.includeDeleted ? "" : "WHERE deleted_at IS NULL"}
            ORDER BY sort_order ASC, created_at ASC, agent_id ASC`,
        )
        .all() as AgentRow[];
      return rows.map(rowToAgent);
    } catch (err) {
      console.error("[conversation-store] listAgents failed:", err);
      return [];
    }
  }

  /** One agent by id, deleted or not. A deleted agent still has to answer for
   *  the threads they worked, so this read is deliberately not filtered — the
   *  caller decides whether a tombstone belongs where it is going. */
  getAgent(agentId: string): AgentRecord | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: same column list `AgentRow` is declared from, and `agent_id` is
      // the primary key, so this is at most one row of exactly that shape.
      const row = db
        .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE agent_id = ?`)
        .get(agentId) as AgentRow | undefined;
      return row ? rowToAgent(row) : null;
    } catch (err) {
      console.error("[conversation-store] getAgent failed:", err);
      return null;
    }
  }

  /** Add a user-made agent to the end of the roster. The caller mints the id so
   *  it can draw the new agent before the write lands. Fields are clamped, not
   *  rejected: the editor is expected to hold the real limits, and this is the
   *  floor that keeps a runaway paste out of the database. */
  createAgent(input: AgentCreateInput): AgentRecord | null {
    const db = this.handle();
    if (!db) return null;
    const name = clampAgentField(input.name, AGENT_NAME_MAX);
    if (!name) return null;
    try {
      const now = Date.now();
      const agentId = input.agentId ?? randomUUID();
      db.prepare(
        `INSERT INTO agents
           (agent_id, preset_id, name, role, instructions,
            face_body, face_ink, skills, models,
            avatar, bot, sort_order, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agentId,
        name,
        clampAgentField(input.role, AGENT_ROLE_MAX),
        clampAgentField(input.instructions, AGENT_PROSE_MAX),
        clampAgentField(input.faceBody, AGENT_PAINT_MAX),
        clampAgentField(input.faceInk, AGENT_PAINT_MAX),
        serializeAgentList(input.skills, normalizeSkillRef),
        serializeModelRef(input.model, input.modelFallbacks),
        serializeAgentAvatar(input.avatar),
        serializeAgentBot(input.bot),
        this.nextAgentSortOrder(db),
        now,
        now,
      );
      return this.getAgent(agentId);
    } catch (err) {
      console.error("[conversation-store] createAgent failed:", err);
      return null;
    }
  }

  /** Edit an agent, one field at a time. A field left out of the patch is left
   *  alone; an explicit `null` clears it, which on an overlay row means handing
   *  the field back to the shipped preset and on a user-made agent means
   *  unsetting it. Refuses a deleted agent — editing a tombstone would put an
   *  agent back in the roster through the side door. */
  updateAgent(agentId: string, patch: AgentPatch): AgentRecord | null {
    const db = this.handle();
    if (!db) return null;
    const edits: Array<[column: string, value: string | null]> = [];
    if (patch.name !== undefined) {
      edits.push(["name", clampAgentField(patch.name, AGENT_NAME_MAX)]);
    }
    if (patch.role !== undefined) {
      edits.push(["role", clampAgentField(patch.role, AGENT_ROLE_MAX)]);
    }
    if (patch.instructions !== undefined) {
      edits.push(["instructions", clampAgentField(patch.instructions, AGENT_PROSE_MAX)]);
    }
    if (patch.faceBody !== undefined) {
      edits.push(["face_body", clampAgentField(patch.faceBody, AGENT_PAINT_MAX)]);
    }
    if (patch.faceInk !== undefined) {
      edits.push(["face_ink", clampAgentField(patch.faceInk, AGENT_PAINT_MAX)]);
    }
    if (patch.skills !== undefined) {
      edits.push(["skills", serializeAgentList(patch.skills, normalizeSkillRef)]);
    }
    if (patch.model !== undefined || patch.modelFallbacks !== undefined) {
      // Primary and fallbacks share one ordered column, so a patch that names
      // only one of them has to be merged against what is stored rather than
      // written alone — otherwise pinning a new primary would silently drop the
      // fallbacks the user had already lined up behind it.
      const current = this.getAgent(agentId);
      const primary = patch.model !== undefined ? patch.model : (current?.model ?? null);
      const fallbacks =
        patch.modelFallbacks !== undefined
          ? patch.modelFallbacks
          : (current?.modelFallbacks ?? null);
      edits.push(["models", serializeModelRef(primary, fallbacks)]);
    }
    if (patch.avatar !== undefined) {
      edits.push(["avatar", serializeAgentAvatar(patch.avatar)]);
    }
    if (patch.bot !== undefined) {
      edits.push(["bot", serializeAgentBot(patch.bot)]);
    }
    if (edits.length === 0) return this.getAgent(agentId);
    try {
      const assignments = edits.map(([column]) => `${column} = ?`).join(", ");
      const values = edits.map(([, value]) => value);
      // The CHECK is the guard, not a read-then-write: clearing the name of an
      // agent that inherits nothing raises rather than storing a nameless row.
      const result = db
        .prepare(
          `UPDATE agents SET ${assignments}, updated_at = ?
            WHERE agent_id = ? AND deleted_at IS NULL`,
        )
        .run(...values, Date.now(), agentId);
      return Number(result.changes) > 0 ? this.getAgent(agentId) : null;
    } catch (err) {
      console.error("[conversation-store] updateAgent failed:", err);
      return null;
    }
  }

  /** Take an agent out of the roster, keeping the row. Returns whether an agent
   *  that was in the roster left it — deleting one twice is not a failure the
   *  second time, it just changes nothing. */
  deleteAgent(agentId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const now = Date.now();
      let changes = 0;
      withTransaction(db, () => {
        const result = db
          .prepare(
            `UPDATE agents SET deleted_at = ?, updated_at = ?
              WHERE agent_id = ? AND deleted_at IS NULL`,
          )
          .run(now, now, agentId);
        changes = Number(result.changes);
        // Nothing may be left pointing at them for work still to come: a
        // selection on a departed agent would send the next turn to nobody.
        // Their thread bindings are untouched — that is the past, and it keeps
        // its record.
        if (changes > 0) {
          db.prepare(
            `UPDATE app_state SET value = '', updated_at = ?
              WHERE key = 'selected_agent' AND value = ?`,
          ).run(now, agentId);
        }
      });
      return changes > 0;
    } catch (err) {
      console.error("[conversation-store] deleteAgent failed:", err);
      return false;
    }
  }

  /** Fork an agent into a new user-made one, sitting straight after the
   *  original.
   *
   *  A copy is a fork, not a second overlay: it keeps no inheritance, so what
   *  it copies is what the source *reads as*, and the fields the source leaves
   *  to its preset have to be supplied by the caller — the renderer is the only
   *  layer holding that text. `inherited` fills exactly those gaps and is
   *  ignored wherever the source row has its own value.
   *
   *  The copy takes the position straight below its original, which means
   *  shifting everybody under it down one. Deliberately not "same position,
   *  younger, let the created-at tiebreak sort it out": a duplicate raised in
   *  the same millisecond as its source has no tiebreak left but the id, and the
   *  copy would land above the thing it was copied from. Renumbering a roster
   *  of a handful of rows costs nothing and can't be ambiguous. */
  duplicateAgent(input: AgentDuplicateInput): AgentRecord | null {
    const db = this.handle();
    if (!db) return null;
    const source = this.getAgent(input.agentId);
    if (!source || source.deletedAt !== null) return null;
    const inherited = input.inherited ?? {};
    const name = clampAgentField(input.name ?? source.name ?? inherited.name, AGENT_NAME_MAX);
    if (!name) return null;
    try {
      const now = Date.now();
      const agentId = input.newAgentId ?? randomUUID();
      withTransaction(db, () => {
        db.prepare(`UPDATE agents SET sort_order = sort_order + 1 WHERE sort_order > ?`).run(
          source.sortOrder,
        );
        db.prepare(
          `INSERT INTO agents
             (agent_id, preset_id, name, role, instructions,
              face_body, face_ink, skills, models,
              avatar, bot, sort_order, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          agentId,
          name,
          clampAgentField(source.role ?? inherited.role, AGENT_ROLE_MAX),
          clampAgentField(source.instructions ?? inherited.instructions, AGENT_PROSE_MAX),
          clampAgentField(source.faceBody ?? inherited.faceBody, AGENT_PAINT_MAX),
          clampAgentField(source.faceInk ?? inherited.faceInk, AGENT_PAINT_MAX),
          serializeAgentList(source.skills ?? inherited.skills, normalizeSkillRef),
          // Primary and fallbacks travel together: a fork that took its
          // primary from the shipped preset must take that preset's chain too,
          // not splice the source row's fallbacks under a different model.
          source.model
            ? serializeModelRef(source.model, source.modelFallbacks)
            : serializeModelRef(inherited.model, inherited.modelFallbacks),
          serializeAgentAvatar(source.avatar ?? inherited.avatar),
          serializeAgentBot(source.bot ?? inherited.bot),
          source.sortOrder + 1,
          now,
          now,
        );
      });
      return this.getAgent(agentId);
    } catch (err) {
      console.error("[conversation-store] duplicateAgent failed:", err);
      return null;
    }
  }

  /** Put an agent on a project's team. Idempotent, and refuses an agent who
   *  isn't in the roster — a team is a list of people you can actually hand work
   *  to, so a missing or deleted id is a no. */
  addAgentToProject(projectPath: string, agentId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const alive = db
        .prepare(`SELECT 1 FROM agents WHERE agent_id = ? AND deleted_at IS NULL`)
        .get(agentId);
      if (alive == null) return false;
      db.prepare(
        `INSERT INTO project_agents (project_path, agent_id, sort_order, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_path, agent_id) DO NOTHING`,
      ).run(projectPath, agentId, this.nextTeamSortOrder(db, projectPath), Date.now());
      return true;
    } catch (err) {
      console.error("[conversation-store] addAgentToProject failed:", err);
      return false;
    }
  }

  /** Take an agent off a project's team. The agent itself is untouched — they
   *  stay in the roster and on every other team. */
  removeAgentFromProject(projectPath: string, agentId: string): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(`DELETE FROM project_agents WHERE project_path = ? AND agent_id = ?`).run(
        projectPath,
        agentId,
      );
    } catch (err) {
      console.error("[conversation-store] removeAgentFromProject failed:", err);
    }
  }

  /** A project's team, in the order they were added. Deleted agents fall out
   *  here rather than being cascaded away on delete, so restoring an agent
   *  restores every team they were on. */
  listProjectAgents(projectPath: string): AgentRecord[] {
    const db = this.handle();
    if (!db) return [];
    try {
      // SAFETY: projecting AGENT_COLUMNS matches AgentRow.
      const rows = db
        .prepare(
          `SELECT ${AGENT_COLUMNS.split(", ").map((col) => `a.${col}`).join(", ")}
             FROM project_agents m
             JOIN agents a ON a.agent_id = m.agent_id
            WHERE m.project_path = ? AND a.deleted_at IS NULL
            ORDER BY m.sort_order ASC, m.added_at ASC, a.agent_id ASC`,
        )
        .all(projectPath) as AgentRow[];
      return rows.map(rowToAgent);
    } catch (err) {
      console.error("[conversation-store] listProjectAgents failed:", err);
      return [];
    }
  }

  /** One past the last roster position, counting deleted rows: a restored agent
   *  has to land back where it was rather than on top of somebody. */
  private nextAgentSortOrder(db: DatabaseSync): number {
    // SAFETY: an aggregate over an INTEGER column, wrapped in COALESCE, so the
    // one row this returns has an integer under the name asked for.
    const row = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM agents`).get() as
      | { next: number }
      | undefined;
    return row?.next ?? 0;
  }

  private nextTeamSortOrder(db: DatabaseSync, projectPath: string): number {
    // SAFETY: as above — a COALESCE'd aggregate over an INTEGER column.
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
           FROM project_agents WHERE project_path = ?`,
      )
      .get(projectPath) as { next: number } | undefined;
    return row?.next ?? 0;
  }

  // ── preset sub-agents ───────────────────────────────────────────────────────

  /** Every preset sub-agent, in the order they were made. Globally available,
   *  so there is no project or team to scope by — one flat list. */
  listSubagentPresets(): SubagentPresetRecord[] {
    const db = this.handle();
    if (!db) return [];
    try {
      // SAFETY: the columns `SubagentPresetRow` is declared from, of the table
      // this schema creates at v26.
      const rows = db
        .prepare(
          `SELECT ${SUBAGENT_PRESET_COLUMNS} FROM subagent_presets
            ORDER BY sort_order ASC, created_at ASC, preset_id ASC`,
        )
        .all() as SubagentPresetRow[];
      return rows.map(rowToSubagentPreset);
    } catch (err) {
      console.error("[conversation-store] listSubagentPresets failed:", err);
      return [];
    }
  }

  /** One preset by id, or null when there is no such preset. */
  getSubagentPreset(presetId: string): SubagentPresetRecord | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: same column list as `SubagentPresetRow`, keyed on the primary
      // key, so at most one row of exactly that shape.
      const row = db
        .prepare(`SELECT ${SUBAGENT_PRESET_COLUMNS} FROM subagent_presets WHERE preset_id = ?`)
        .get(presetId) as SubagentPresetRow | undefined;
      return row ? rowToSubagentPreset(row) : null;
    } catch (err) {
      console.error("[conversation-store] getSubagentPreset failed:", err);
      return null;
    }
  }

  /** Add a preset to the end of the list. The caller mints the id so it can
   *  draw the preset before the write lands. A preset must have a name; the
   *  fields are clamped the way an agent's are — the editor holds the real
   *  limits, this is the floor that keeps a runaway paste out of the database. */
  createSubagentPreset(input: SubagentPresetCreateInput): SubagentPresetRecord | null {
    const db = this.handle();
    if (!db) return null;
    const name = clampAgentField(input.name, AGENT_NAME_MAX);
    if (!name) return null;
    try {
      const now = Date.now();
      const presetId = input.presetId ?? randomUUID();
      db.prepare(
        `INSERT INTO subagent_presets
           (preset_id, name, instructions, models, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        presetId,
        name,
        clampAgentField(input.instructions, AGENT_PROSE_MAX),
        serializeModelRef(input.model, input.modelFallbacks),
        this.nextSubagentPresetSortOrder(db),
        now,
        now,
      );
      return this.getSubagentPreset(presetId);
    } catch (err) {
      console.error("[conversation-store] createSubagentPreset failed:", err);
      return null;
    }
  }

  /** Edit a preset, one field at a time. A field left out of the patch is left
   *  alone. The name is the one field that can't be cleared — a preset with no
   *  name is not a preset, so a patch that would blank it changes nothing. */
  updateSubagentPreset(
    presetId: string,
    patch: SubagentPresetPatch,
  ): SubagentPresetRecord | null {
    const db = this.handle();
    if (!db) return null;
    const edits: Array<[column: string, value: string | null]> = [];
    if (patch.name !== undefined) {
      const name = clampAgentField(patch.name, AGENT_NAME_MAX);
      if (!name) return null;
      edits.push(["name", name]);
    }
    if (patch.instructions !== undefined) {
      edits.push(["instructions", clampAgentField(patch.instructions, AGENT_PROSE_MAX)]);
    }
    if (patch.model !== undefined || patch.modelFallbacks !== undefined) {
      // Same one-column merge as an agent's: see updateAgent.
      const current = this.getSubagentPreset(presetId);
      const primary = patch.model !== undefined ? patch.model : (current?.model ?? null);
      const fallbacks =
        patch.modelFallbacks !== undefined
          ? patch.modelFallbacks
          : (current?.modelFallbacks ?? null);
      edits.push(["models", serializeModelRef(primary, fallbacks)]);
    }
    if (edits.length === 0) return this.getSubagentPreset(presetId);
    try {
      const assignments = edits.map(([column]) => `${column} = ?`).join(", ");
      const values = edits.map(([, value]) => value);
      const result = db
        .prepare(
          `UPDATE subagent_presets SET ${assignments}, updated_at = ? WHERE preset_id = ?`,
        )
        .run(...values, Date.now(), presetId);
      return Number(result.changes) > 0 ? this.getSubagentPreset(presetId) : null;
    } catch (err) {
      console.error("[conversation-store] updateSubagentPreset failed:", err);
      return null;
    }
  }

  /** Remove a preset for good. A preset keeps no thread history — a spawn cut
   *  from it copies the instructions and the resolved model by value — so there
   *  is nothing a tombstone would answer for, and this deletes the row outright.
   *  Returns whether a row was there to remove; deleting a gone preset changes
   *  nothing and is not a failure. */
  deleteSubagentPreset(presetId: string): boolean {
    const db = this.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(`DELETE FROM subagent_presets WHERE preset_id = ?`)
        .run(presetId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] deleteSubagentPreset failed:", err);
      return false;
    }
  }

  private nextSubagentPresetSortOrder(db: DatabaseSync): number {
    // SAFETY: a COALESCE'd aggregate over an INTEGER column, as the roster's.
    const row = db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM subagent_presets`)
      .get() as { next: number } | undefined;
    return row?.next ?? 0;
  }

  // ── who worked a thread, and who is up next ─────────────────────────────────

  /** Every binding there is, so the renderer can answer "who worked this?"
   *  without a round trip per thread. Rows are tiny and one per conversation. */
  listThreadAgents(): ThreadAgentBinding[] {
    const db = this.handle();
    if (!db) return [];
    try {
      // SAFETY: the two columns named, of the table this schema declares —
      // `thread_id` is a TEXT primary key and `agent_id` is nullable TEXT.
      const rows = db
        .prepare(`SELECT thread_id, agent_id FROM thread_agents ORDER BY settled_at ASC`)
        .all() as Array<{ thread_id: string; agent_id: string | null }>;
      return rows.map((row) => ({ threadId: row.thread_id, agentId: row.agent_id }));
    } catch (err) {
      console.error("[conversation-store] listThreadAgents failed:", err);
      return [];
    }
  }

  /** Who worked one thread, or null if it never started. */
  getThreadAgent(threadId: string): ThreadAgentBinding | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: as above, and `thread_id` is the primary key, so this is at most
      // one row of exactly that shape.
      const row = db
        .prepare(`SELECT thread_id, agent_id FROM thread_agents WHERE thread_id = ?`)
        .get(threadId) as { thread_id: string; agent_id: string | null } | undefined;
      return row ? { threadId: row.thread_id, agentId: row.agent_id } : null;
    } catch (err) {
      console.error("[conversation-store] getThreadAgent failed:", err);
      return null;
    }
  }

  /**
   * Settle who works a thread, at the moment it starts.
   *
   * Write-once, in SQL rather than in a read-then-write the renderer could race:
   * a thread that already has a binding keeps it, so a later send can never
   * rewrite who wrote the lines already above it. `null` settles it on a guest,
   * which closes the thread to being claimed afterwards.
   *
   * Returns what the thread is bound to now — which for an already-settled
   * thread is what it was bound to before, not what was just asked for.
   */
  bindThreadAgent(threadId: string, agentId: string | null): ThreadAgentBinding | null {
    const db = this.handle();
    if (!db) return null;
    try {
      db.prepare(
        `INSERT INTO thread_agents (thread_id, agent_id, settled_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      ).run(threadId, agentId, Date.now());
      return this.getThreadAgent(threadId);
    } catch (err) {
      console.error("[conversation-store] bindThreadAgent failed:", err);
      return null;
    }
  }

  /**
   * Hand a new thread the agent an old one had — for a thread reborn under a new
   * id, which is what a provider or model switch does to a live session.
   *
   * The same work continuing under a new id is still the same colleague's, so
   * the record follows it. It carries a guest binding too, and that matters as
   * much: a guest thread restarted has to come back a guest rather than fall
   * through to whoever is picked by then. Write-once at the far end.
   */
  carryThreadAgent(fromThreadId: string, toThreadId: string): ThreadAgentBinding | null {
    const db = this.handle();
    if (!db) return null;
    const source = this.getThreadAgent(fromThreadId);
    if (!source) return null;
    return this.bindThreadAgent(toThreadId, source.agentId);
  }

  /** Who the next turn goes to, or null for a guest — which is also what nobody
   *  having chosen yet reads as. */
  readSelectedAgent(): string | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: one TEXT column of app_state for key 'selected_agent'.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = 'selected_agent'`)
        .get() as { value: string } | undefined;
      return row && row.value.length > 0 ? row.value : null;
    } catch (err) {
      console.error("[conversation-store] readSelectedAgent failed:", err);
      return null;
    }
  }

  /** Point the next turn at an agent, or at a guest with null. */
  writeSelectedAgent(agentId: string | null): void {
    const db = this.handle();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ('selected_agent', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(agentId ?? "", Date.now());
    } catch (err) {
      console.error("[conversation-store] writeSelectedAgent failed:", err);
    }
  }

  // ── studio layout ───────────────────────────────────────────────────────────

  /** Read the studio plane. Never throws: a corrupt JSON blob or an
   *  unrecognised shape returns `null` so the app still opens on an empty
   *  plane. Hard structural validation of the rows and their panes is the
   *  renderer's job — this checks only that the document is the shape
   *  this build knows how to hand over. */
  loadStudio(): StoredStudioLayout | null {
    const db = this.handle();
    if (!db) return null;
    try {
      // SAFETY: app_state holds at most one row for key 'studio_layout'.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = 'studio_layout'`)
        .get() as { value: string } | undefined;
      if (!row?.value) return null;
      // SAFETY: value is untrusted disk content — parse to unknown first and
      // let the checks below decide.
      const parsed = JSON.parse(row.value) as unknown;
      // SAFETY: probing two fields of unknown needs the object view; these
      // checks are themselves the validation gate.
      if (
        !parsed ||
        !(parsed instanceof Object) ||
        (parsed as { version?: unknown }).version !== 2 ||
        !Array.isArray((parsed as { rows?: unknown }).rows)
      ) {
        return null;
      }
      // SAFETY: version === 2 and the row array were just verified; deeper
      // per-row and per-pane structure is validated downstream by the renderer.
      return parsed as StoredStudioLayout;
    } catch (err) {
      console.error("[conversation-store] loadStudio failed:", err);
      return null;
    }
  }

  saveStudio(layout: StoredStudioLayout): { savedAt: number } | null {
    const db = this.handle();
    if (!db) return null;
    const savedAt = Date.now();
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ('studio_layout', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(JSON.stringify(layout), savedAt);
      return { savedAt };
    } catch (err) {
      console.error("[conversation-store] saveStudio failed:", err);
      return null;
    }
  }

  /** Close the open database connection, if any. */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* best-effort */
      }
      this.db = null;
      // Cached statements belong to the connection that compiled them; leaving
      // them behind would hand a reopened store handles into a closed database.
      this.statements.clear();
    }
  }
}

// ── singleton ────────────────────────────────────────────────────────────────

let store: ConversationStore | null = null;

/** The single ConversationStore instance (lazily created). */
export function getConversationStore(): ConversationStore {
  if (!store) store = new ConversationStore();
  return store;
}

/** Drop the module-level singleton so tests start from a clean instance. */
export function resetConversationStoreForTests(): void {
  if (store) {
    store.close();
    store = null;
  }
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export * from "./conversationMigrations.js";
export * from "./rosterRecord.js";
export * from "./conversationStoreTypes.js";
export * from "./conversationWire.js";
