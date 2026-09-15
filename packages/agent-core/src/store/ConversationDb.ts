import path from "node:path";
import { DatabaseSync, type StatementSync } from "../sqlite.js";
import { isSpawnedRelationship } from "../types.js";
import type { RelationshipToParent } from "../types.js";
import { readAntigravityConversationUsage, resolveAntigravityContextWindow } from "../usage/local/antigravityScan.js";
import { getUserDataDir } from "../userDataDir.js";
import { REOPEN_COOLDOWN_MS, UnsupportedSchemaError, assistantBlockId, migrate } from "../conversationMigrations.js";

export class ConversationDb {
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
  prepare(db: DatabaseSync, sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /** Open (and migrate) the database lazily on first use. Returns null and
   *  disables the store for the process if the DB can't be opened — persistence
   *  is a convenience, never a hard dependency. */
  handle(): DatabaseSync | null {
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
  durably(db: DatabaseSync, write: () => void): void {
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
