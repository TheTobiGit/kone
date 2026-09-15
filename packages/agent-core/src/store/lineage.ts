import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import type { ChatAttachment, ForkContext, ProviderKind, RelationshipToParent, StoredThreadMeta, ThreadLineage } from "../types.js";
import { withTransaction } from "../conversationMigrations.js";
import { parseJsonObject, rowToMeta, type ThreadRow } from "../conversationStoreTypes.js";

export class LineageRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** The side chat already forked from a source thread, if any — the
   *  one-side-chat-per-source rule. A second fork request joins the existing
   *  one instead of minting another. */
  sidechatForSource(sourceThreadId: string): { threadId: string; provider: ProviderKind } | null {
    const db = this.dbh.handle();
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

  /** The thread's stored fork context (side chat handoff), or null when the
   *  thread isn't a fork. */
  threadForkContext(threadId: string): ForkContext | null {
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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
      this.dbh.durably(db, () => {
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
  completeSidechatBootstrap(db: DatabaseSync, threadId: string): void {
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
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      // The thread row is the anchor every child event hangs off — the same
      // durability class as a fork's row.
      this.dbh.durably(db, () => {
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
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () => {
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
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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
}
