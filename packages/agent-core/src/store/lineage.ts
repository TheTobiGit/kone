import { randomUUID } from "node:crypto";
import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import type { ChatAttachment, ForkContext, ProviderKind, RelationshipToParent, StoredThreadMeta, ThreadLineage } from "../types.js";
import { withTransaction } from "../conversationMigrations.js";
import { parseJsonObject, rowToMeta, type ThreadRow } from "../conversationStoreTypes.js";
import { WITHOUT_ACTIVE_QUEUE } from "./sql.js";
import {
  buildEditForkTitle,
  findEditLineageRoot,
  LINEAGE_FAMILY_CAP,
  type EditForkFamily,
  type ForkLineageNode,
} from "../editForkTitle.js";

/** Why an edit-fork refused to write. `unknown-thread` / `unknown-block` name
 *  a missing row; `not-user-block` means the fork point is an assistant block
 *  (only user messages are editable); `queued-turn` means the message hasn't
 *  run yet — forking answered history out of an unanswered prompt would lie
 *  about what the model saw; `empty-edit` is a blank replacement;
 *  `thread-exists` is the idempotent replay of an already-created fork. */
export type ForkThreadAtBlockError =
  | "unknown-thread"
  | "unknown-block"
  | "not-user-block"
  | "queued-turn"
  | "empty-edit"
  | "thread-exists"
  | "error";

export type ForkThreadAtBlockResult =
  | {
      ok: true;
      threadId: string;
      title: string;
      editedBlockId: string;
      /** How many prefix blocks were copied ahead of the edited message. */
      copiedBlocks: number;
    }
  | { ok: false; reason: ForkThreadAtBlockError };

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

  /** Fork a thread at one of its user blocks: edit-and-resend of an earlier
   *  message without mutating the source.
   *
   *  The fork is a new root thread (`parent_thread_id` stays null, so
   *  archive/retention subtree walks treat it as independent, exactly like a
   *  side chat) pointing back at the source via `source_thread_id` plus a
   *  `fork_context_json` naming the replaced block. Blocks strictly before
   *  the fork point are copied verbatim — same `turn_id`s (so blocks, items,
   *  subagent runs and per-turn usage stay linked), same `at` timestamps,
   *  same attachment metadata, same settlement states — then the edited text
   *  is journaled as the fork's newest native user block, carrying the
   *  original's attachments. Only block ids are re-minted (`block_id` is
   *  globally unique, so the source's ids cannot be reused).
   *
   *  The copy also ranges over the turn's satellite tables for the copied
   *  turns: full item rows (tool calls with their detail bodies, not just
   *  narrative text), subagent runs, per-turn usage, and compaction markers
   *  at or before the edit point. Live intent is never copied: queued-turn
   *  rows and gateway-op reservations belong to the source's future, not the
   *  fork's history, and prompts still waiting behind the running turn are
   *  excluded from the prefix by the same active-queue predicate live reads
   *  use. The provider session is never inherited either (no
   *  `conversation_id`/`resume_session_at` copy) — the fork starts a fresh
   *  conversation whose first turn carries the copied history as its handoff.
   *
   *  One transaction: the thread row, every copied row and the edited block
   *  land together, so a crash mid-fork leaves no half-imported thread. The
   *  source thread is only read, never written. Returns the fork's title
   *  (a lineage-wide version suffix over the source's title, or a word-cap
   *  of the edited text when the source is untitled) for the caller to
   *  announce. */
  forkThreadAtBlock(input: {
    threadId: string;
    sourceThreadId: string;
    blockId: string;
    editedText: string;
    editedAt?: number;
    editedBlockId?: string;
    requestId?: string;
  }): ForkThreadAtBlockResult {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "error" };
    const editedText = input.editedText.trim();
    if (!editedText) return { ok: false, reason: "empty-edit" };
    try {
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
      const source = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(input.sourceThreadId) as ThreadRow | undefined;
      if (!source) return { ok: false, reason: "unknown-thread" };
      const existing = db
        .prepare(`SELECT 1 FROM threads WHERE thread_id = ?`)
        .get(input.threadId);
      if (existing) return { ok: false, reason: "thread-exists" };
      // SAFETY: the projection names only the fork point's own columns.
      const forkPoint = db
        .prepare(
          `SELECT seq, role, text, attachments_json, at FROM blocks
            WHERE thread_id = ? AND block_id = ?`,
        )
        .get(input.sourceThreadId, input.blockId) as
        | {
            seq: number;
            role: string;
            text: string | null;
            attachments_json: string | null;
            at: number;
          }
        | undefined;
      if (!forkPoint) return { ok: false, reason: "unknown-block" };
      if (forkPoint.role !== "user") return { ok: false, reason: "not-user-block" };
      // A message that hasn't run yet must not become answered history: refuse
      // while its queue row is still active instead of forking a lie about
      // what the model saw.
      const queued = db
        .prepare(
          `SELECT 1 FROM queued_turns
            WHERE thread_id = ? AND user_block_id = ? AND state IN ('queued', 'promoting')`,
        )
        .get(input.sourceThreadId, input.blockId);
      if (queued) return { ok: false, reason: "queued-turn" };

      // The prefix: every settled block strictly before the fork point, in
      // arrival order. A `running` mark is never copied as running — with no
      // live turn behind the fork that flag would wedge the new thread's
      // composer; the turn provably did not finish here, so it reads as
      // interrupted. (Unreachable while the service's busy guard holds; this
      // is the crash-orphan case the boot seal would otherwise have owned.)
      // SAFETY: the projection names only blocks columns the copy inserts.
      const prefix = db
        .prepare(
          `SELECT role, turn_id, text,
                  CASE WHEN state = 'running' THEN 'interrupted' ELSE state END AS state,
                  error, at, ended_at, attachments_json, source
             FROM blocks
            WHERE thread_id = ? AND seq < ? AND ${WITHOUT_ACTIVE_QUEUE}
            ORDER BY seq`,
        )
        .all(input.sourceThreadId, forkPoint.seq) as Array<{
        role: "user" | "assistant";
        turn_id: string | null;
        text: string | null;
        state: string | null;
        error: string | null;
        at: number;
        ended_at: number | null;
        attachments_json: string | null;
        source: string;
      }>;
      const turnIds = [...new Set(prefix.map((b) => b.turn_id).filter((t): t is string => Boolean(t)))];

      const family = this.editForkFamily(db, input.sourceThreadId);
      const sourceTitle = source.title?.trim() || null;
      const title = sourceTitle
        ? buildEditForkTitle(
            sourceTitle,
            family.titles,
          )
        : editedText.split("\n")[0]!.trim().slice(0, 48) || "Edited message";

      const now = input.editedAt ?? Date.now();
      const editedBlockId = input.editedBlockId ?? randomUUID();
      const forkContext: ForkContext = {
        sourceThreadId: input.sourceThreadId,
        forkPointBlockId: input.blockId,
        importedAt: now,
        bootstrapStatus: "pending",
        forkKind: "edit",
      };
      // SAFETY: the provider column only ever stores ProviderKind strings —
      // every writer takes input.provider typed as ProviderKind.
      const provider = source.provider as ProviderKind;

      this.dbh.durably(db, () => {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO threads (
               thread_id, project_path, provider, model, created_at, last_activity_at,
               last_visited_at, title, branch, added, removed, compacts_auto,
               source_thread_id, parent_thread_id, relationship_to_parent,
               fork_context_json, request_id, model_selection_json,
               env_mode, worktree_path, requested_branch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.threadId,
            source.project_path,
            provider,
            source.model,
            now,
            now,
            now,
            title,
            source.branch,
            source.added,
            source.removed,
            source.compacts_auto,
            input.sourceThreadId,
            JSON.stringify(forkContext),
            input.requestId ?? null,
            source.model_selection_json,
            source.env_mode,
            source.worktree_path,
            source.requested_branch ?? null,
          );
          const insertBlock = db.prepare(
            `INSERT INTO blocks (block_id, thread_id, role, turn_id, text, state, error, at, ended_at, attachments_json, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const block of prefix) {
            insertBlock.run(
              randomUUID(),
              input.threadId,
              block.role,
              block.turn_id,
              block.text,
              block.state,
              block.error,
              block.at,
              block.ended_at,
              block.attachments_json,
              block.source,
            );
          }
          // The edited replacement: this thread's own message (native, not an
          // import), carrying the original's attachments — a text edit must
          // not silently drop the images/files the turn was asked about.
          // Attachment bytes stay shared with the source (the registry row
          // keeps living under the source's id); deleting the source orphans
          // these chips the same way it orphans a side chat's.
          insertBlock.run(
            editedBlockId,
            input.threadId,
            "user",
            null,
            editedText,
            null,
            null,
            now,
            null,
            forkPoint.attachments_json,
            "native",
          );
          if (turnIds.length > 0) {
            const placeholders = turnIds.map(() => "?").join(",");
            // Full item rows in arrival order — tool calls keep their detail
            // bodies, tasks and subagent links, not just narrative text. New
            // `seq`s are assigned in the same order, so the (turn_id, seq)
            // read the timeline uses comes back identical.
            // SAFETY: the projection names only items columns the copy inserts.
            const items = db
              .prepare(
                `SELECT item_id, turn_id, kind, status, text, name, detail,
                        tasks_json, subagent_tool_use_id, at
                   FROM items
                  WHERE thread_id = ? AND turn_id IN (${placeholders})
                  ORDER BY seq`,
              )
              .all(input.sourceThreadId, ...turnIds) as Array<{
              item_id: string;
              turn_id: string;
              kind: string;
              status: string;
              text: string;
              name: string | null;
              detail: string | null;
              tasks_json: string | null;
              subagent_tool_use_id: string | null;
              at: number;
            }>;
            const insertItem = db.prepare(
              `INSERT INTO items (item_id, thread_id, turn_id, kind, status, text, name, detail, tasks_json, subagent_tool_use_id, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const item of items) {
              insertItem.run(
                item.item_id,
                input.threadId,
                item.turn_id,
                item.kind,
                item.status,
                item.text,
                item.name,
                item.detail,
                item.tasks_json,
                item.subagent_tool_use_id,
                item.at,
              );
            }
            // SAFETY: the projection names only subagents columns the copy inserts.
            const runs = db
              .prepare(
                `SELECT tool_use_id, turn_id, task_id, parent_item_id, agent_type,
                        description, prompt, model, effort, background, status,
                        summary, last_tool_name, tokens, tool_uses, started_at, ended_at
                   FROM subagents
                  WHERE thread_id = ? AND turn_id IN (${placeholders})
                  ORDER BY seq`,
              )
              .all(input.sourceThreadId, ...turnIds) as Array<{
              tool_use_id: string;
              turn_id: string;
              task_id: string;
              parent_item_id: string;
              agent_type: string;
              model: string;
              description: string | null;
              prompt: string | null;
              effort: string | null;
              background: number | null;
              status: string;
              summary: string | null;
              last_tool_name: string | null;
              tokens: number | null;
              tool_uses: number | null;
              started_at: number;
              ended_at: number | null;
            }>;
            const insertRun = db.prepare(
              `INSERT INTO subagents (tool_use_id, thread_id, turn_id, task_id, parent_item_id, agent_type,
                                      description, prompt, model, effort, background, status, summary,
                                      last_tool_name, tokens, tool_uses, started_at, ended_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const run of runs) {
              insertRun.run(
                run.tool_use_id,
                input.threadId,
                run.turn_id,
                run.task_id,
                run.parent_item_id,
                run.agent_type,
                run.description,
                run.prompt,
                run.model,
                run.effort,
                run.background,
                run.status,
                run.summary,
                run.last_tool_name,
                run.tokens,
                run.tool_uses,
                run.started_at,
                run.ended_at,
              );
            }
            // SAFETY: the projection names only turn_usage columns the copy inserts.
            const usage = db
              .prepare(
                `SELECT turn_id, input_tokens, output_tokens, total_tokens,
                        cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                        provider, model, at
                   FROM turn_usage
                  WHERE thread_id = ? AND turn_id IN (${placeholders})`,
              )
              .all(input.sourceThreadId, ...turnIds) as Array<{
              turn_id: string;
              input_tokens: number | null;
              output_tokens: number | null;
              total_tokens: number | null;
              cache_read_tokens: number | null;
              cache_creation_tokens: number | null;
              reasoning_tokens: number | null;
              provider: string | null;
              model: string | null;
              at: number;
            }>;
            const insertUsage = db.prepare(
              `INSERT INTO turn_usage (thread_id, turn_id, input_tokens, output_tokens, total_tokens,
                                       cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                                       provider, model, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const row of usage) {
              insertUsage.run(
                input.threadId,
                row.turn_id,
                row.input_tokens,
                row.output_tokens,
                row.total_tokens,
                row.cache_read_tokens,
                row.cache_creation_tokens,
                row.reasoning_tokens,
                row.provider,
                row.model,
                row.at,
              );
            }
          }
          // Markers at or before the edit point are this thread's history too;
          // anything newer never happened here.
          db.prepare(
            `INSERT INTO compactions (thread_id, at, before_tokens, after_tokens)
             SELECT ?, at, before_tokens, after_tokens FROM compactions
              WHERE thread_id = ? AND at <= ?
              ORDER BY at`,
          ).run(input.threadId, input.sourceThreadId, forkPoint.at);
        });
      });
      return {
        ok: true,
        threadId: input.threadId,
        title,
        editedBlockId,
        copiedBlocks: prefix.length,
      };
    } catch (err) {
      // A duplicate fork id racing the exists-check lands here as a UNIQUE
      // violation and reads as a replay, not a failure.
      if (this.threadExistsQuiet(db, input.threadId)) return { ok: false, reason: "thread-exists" };
      console.error("[conversation-store] forkThreadAtBlock failed:", err);
      return { ok: false, reason: "error" };
    }
  }

  /** The title-versioning family for an edit fork off `sourceThreadId`: the
   *  lineage root (walking `source_thread_id` upward, cycle- and
   *  cross-project-guarded) plus every thread below it, same project only.
   *  Corrupted chains terminate instead of looping — a partial family only
   *  ever yields a higher suffix, never a wrong transcript. */
  private editForkFamily(
    db: DatabaseSync,
    sourceThreadId: string,
  ): EditForkFamily {
    // SAFETY: the projection names only the columns the walk reads.
    const byId = db.prepare(
      `SELECT thread_id, project_path, title, source_thread_id FROM threads WHERE thread_id = ?`,
    );
    // SAFETY: the projection names only the columns the walk reads.
    const childrenOf = db.prepare(
      `SELECT thread_id, project_path, title, source_thread_id FROM threads WHERE source_thread_id = ?`,
    );
    type ChainRow = {
      thread_id: string;
      project_path: string;
      title: string | null;
      source_thread_id: string | null;
    };
    const toNode = (row: ChainRow): ForkLineageNode => ({
      id: row.thread_id,
      projectPath: row.project_path,
      title: row.title,
      sourceThreadId: row.source_thread_id,
    });
    // SAFETY: byId selects only the ChainRow columns for the thread primary key.
    const sourceRow = byId.get(sourceThreadId) as ChainRow | undefined;
    if (!sourceRow) return { rootId: sourceThreadId, titles: [] };
    // Walk upward, collecting the chain for the pure root resolver (bounded:
    // the resolver itself caps hops, and the visited set below is the second
    // guard).
    const nodes = new Map<string, ForkLineageNode>();
    const seenUp = new Set<string>([sourceThreadId]);
    nodes.set(sourceThreadId, toNode(sourceRow));
    let cursor: string | null = sourceRow.source_thread_id;
    while (cursor && !seenUp.has(cursor)) {
      seenUp.add(cursor);
      // SAFETY: byId returns at most one ChainRow for the primary key.
      const row = byId.get(cursor) as ChainRow | undefined;
      if (!row) break;
      nodes.set(cursor, toNode(row));
      cursor = row.source_thread_id;
    }
    const sourceNode = nodes.get(sourceThreadId);
    const root = sourceNode ? findEditLineageRoot(sourceNode, nodes).root : toNode(sourceRow);
    // Breadth-first descent from the root over fork edges, same project only.
    const titles: string[] = [];
    const visited = new Set<string>([root.id]);
    let frontier = [root.id];
    while (frontier.length > 0 && visited.size < LINEAGE_FAMILY_CAP) {
      const next: string[] = [];
      for (const id of frontier) {
        // SAFETY: childrenOf selects only ChainRow columns.
        for (const row of childrenOf.all(id) as ChainRow[]) {
          if (visited.has(row.thread_id)) continue;
          if (row.project_path !== root.projectPath) continue;
          visited.add(row.thread_id);
          next.push(row.thread_id);
          if (row.title?.trim()) titles.push(row.title.trim());
          if (visited.size >= LINEAGE_FAMILY_CAP) break;
        }
      }
      frontier = next;
    }
    if (root.title?.trim()) titles.push(root.title.trim());
    return { rootId: root.id, titles };
  }

  /** Best-effort existence probe for mapping a UNIQUE race onto the replay
   *  reason. Never throws — the caller already handles the failure. */
  private threadExistsQuiet(db: DatabaseSync, threadId: string): boolean {
    try {
      return (
        db.prepare(`SELECT 1 FROM threads WHERE thread_id = ?`).get(threadId) != null
      );
    } catch {
      return false;
    }
  }

  /** Flip a side chat's one-shot bootstrap flag to "completed" — called when   *  its first turn settles, so the imported-transcript injection never runs
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
