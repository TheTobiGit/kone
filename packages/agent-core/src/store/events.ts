import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import { cleanCompactedCount } from "../types.js";
import type { CompactionRecord, RuntimeEvent, TokenUsage } from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";
import { assistantBlockId, withTransaction } from "../conversationMigrations.js";
import { indexItemRow, indexTurnRows, parentBlockIdForTurn } from "./search.js";

/** Narrow collaborators owned by other repos, injected so ingest never reaches back. */
export type EventIngestDeps = {
  touch(db: DatabaseSync, threadId: string, at: number): void;
  completeSidechatBootstrap(db: DatabaseSync, threadId: string): void;
};

/** Decode one settled-compaction boundary into its durable record, parsing
 *  and validating once here so the two writes below share one validated
 *  value instead of each re-probing the event. Counts are cleaned numbers
 *  or explicit null — never optional — matching CompactionRecord. */
function decodeCompactionRecord(
  threadId: string,
  at: number,
  beforeTokens: number | null | undefined,
  afterTokens: number | null | undefined,
): CompactionRecord {
  return {
    threadId,
    at,
    beforeTokens: cleanCompactedCount(beforeTokens),
    afterTokens: cleanCompactedCount(afterTokens),
  };
}


export class EventIngestRepo {
  constructor(
    private readonly dbh: ConversationDb,
    private readonly deps: EventIngestDeps,
  ) {}

  /** threadId → the provider conversation id already written for it. Events carry
   *  the id on every envelope (see ProviderRefs), including one per streamed text
   *  delta, so this memo keeps the capture to a single write per session instead
   *  of an UPDATE (and an fsync) per token. */
  private readonly knownConversationIds = new Map<string, string>();

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
    const db = this.dbh.handle();
    if (!db || !conversationId) return;
    if (this.knownConversationIds.get(threadId) === conversationId) return;
    let written = false;
    this.dbh.durably(db, () => {
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
      this.dbh.durably(db, () => {
        db.prepare(`UPDATE threads SET resume_session_at = NULL WHERE thread_id = ?`).run(
          event.threadId,
        );
      });
      this.knownResumeAnchors.set(event.threadId, null);
      return;
    }
    if (!anchor) return;
    if (this.knownResumeAnchors.get(event.threadId) === anchor) return;
    this.dbh.durably(db, () => {
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
    const db = this.dbh.handle();
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
          this.dbh.durably(db, () => {
            this.dbh.prepare(
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
          this.deps.touch(db, event.threadId, event.at);
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
          this.dbh.prepare(
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
          // Index on completion only, never on started/updated: `updated`
          // fires per text delta, so indexing here would rewrite the FTS row
          // thousands of times a turn for text the next delta supersedes. A
          // settled item's text is final, and the turn-settle re-sync below
          // backfills anything that never completed on its own.
          if (event.type === "item.completed") {
            indexItemRow(db, {
              threadId: event.threadId,
              turnId: event.turnId,
              itemId: it.itemId,
              blockId: parentBlockIdForTurn(db, event.threadId, event.turnId),
              at: event.at,
              text: it.text,
              name: it.name ?? null,
              detail: it.detail ?? null,
            });
          }
          break;
        }
        case "subagent.started":
        case "subagent.updated":
        case "subagent.completed": {
          // Whole-snapshot upsert, matching the item.* convention: the adapter
          // sends the full run each time, so there's no patch to merge here.
          const s = event.subagent;
          this.dbh.prepare(
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
          this.dbh.durably(db, () => {
            // One transaction: the block settle and the side chat bootstrap
            // consumption must land together — a crash between them would
            // re-inject `<sidechat_context>` into the next turn.
            withTransaction(db, () => {
              this.dbh.prepare(
                db,
                `UPDATE blocks SET state = 'completed', ended_at = ?
                 WHERE block_id = ?`,
              ).run(event.at, assistantBlockId(event.threadId, event.turnId));
              // A side chat's first turn settling consumes the one-shot
              // `<sidechat_context>` bootstrap — the imported transcript has
              // reached the model, so it is never injected again.
              this.deps.completeSidechatBootstrap(db, event.threadId);
            });
          });
          this.deps.touch(db, event.threadId, event.at);
          // The turn's text is final now — re-sync the whole turn so items
          // that streamed without their own completion still land in the
          // index. One pass per turn, not per delta.
          indexTurnRows(db, event.threadId, event.turnId);
          break;
        }
        case "turn.aborted": {
          const state = event.reason === "interrupted" ? "interrupted" : "failed";
          this.dbh.durably(db, () => {
            this.dbh.prepare(
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
          this.deps.touch(db, event.threadId, event.at);
          // Same settle re-sync as the completed path: failed text is still
          // text worth finding.
          indexTurnRows(db, event.threadId, event.turnId);
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
          // SAFETY: the projection names only the live items' turn ids, read
          // before the seal so the index re-sync below can name its turns.
          const liveTurns = db
            .prepare(
              `SELECT DISTINCT turn_id FROM items
                WHERE thread_id = ? AND status = 'in-progress'`,
            )
            .all(event.threadId) as Array<{ turn_id: string }>;
          db.prepare(
            `UPDATE blocks SET state = 'failed', ended_at = ?
             WHERE thread_id = ? AND role = 'assistant' AND state = 'running'`,
          ).run(event.at, event.threadId);
          // The sealed turns never complete, so they never pass through the
          // settle re-sync — index their final text here, bounded to the
          // turns that were actually live.
          for (const turn of liveTurns) {
            indexTurnRows(db, event.threadId, turn.turn_id);
          }
          break;
        }
        case "thread.state.changed": {
          // A settled context compaction does two things: it invalidates the
          // stored window fill (the pre-compaction number describes a
          // transcript that no longer exists), and it records the boundary
          // itself so the timeline can show when/where the context was
          // compacted. The fill restarts at the reported post-compaction
          // count; unknown stays NULL — "Compacted" with no counts reads
          // differently from "→ 0", and the meter must not claim a fresh
          // window it cannot see. The cumulative `tokens` rollup is spend,
          // not window fill, so it stays either way.
          if (event.state !== "compacted") break;
          const record = decodeCompactionRecord(
            event.threadId,
            event.at,
            event.beforeTokens,
            event.afterTokens,
          );
          withTransaction(db, () => {
            this.invalidateUsageSnapshot(db, record.threadId, record.afterTokens);
            this.recordCompaction(db, record);
          });
          this.deps.touch(db, event.threadId, event.at);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("[conversation-store] applyEvent failed:", err);
    }
  }

  /** Invalidate the stored window fill after a settled compaction: the meter
   *  restarts at the reported post-compaction count, or NULL when the
   *  provider reported none — unknown, not zero. */
  private invalidateUsageSnapshot(
    db: DatabaseSync,
    threadId: string,
    afterTokens: number | null,
  ): void {
    this.dbh.prepare(db, `UPDATE threads SET context_used = ? WHERE thread_id = ?`).run(
      afterTokens === null ? null : Math.max(0, afterTokens),
      threadId,
    );
  }

  /** Journal one settled-compaction boundary for the timeline's when/where
   *  markers. Counts keep NULLs as unknown. */
  private recordCompaction(db: DatabaseSync, record: CompactionRecord): void {
    this.dbh.prepare(
      db,
      `INSERT INTO compactions (thread_id, at, before_tokens, after_tokens)
       VALUES (?, ?, ?, ?)`,
    ).run(record.threadId, record.at, record.beforeTokens, record.afterTokens);
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

  /** Snapshot the project's branch + working-tree diffstat onto the thread.
   *  Called (best-effort, off an async git read) when a turn settles, so the
   *  row reflects the repo state the session left behind. */
  recordRepoStats(input: {
    threadId: string;
    branch?: string | null;
    added?: number;
    removed?: number;
  }): void {
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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

  /** Every settled compaction boundary on a thread, oldest first — what the
   *  timeline renders its "when/where" markers from. Compactions are few (one
   *  per event, manual or automatic), so this is always the full list, never
   *  a page. */
  listCompactions(threadId: string): CompactionRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the selected columns are exactly the compactions table shape.
      const rows = db
        .prepare(
          `SELECT thread_id, at, before_tokens, after_tokens FROM compactions
           WHERE thread_id = ?
           ORDER BY at ASC, seq ASC`,
        )
        .all(threadId) as Array<{
        thread_id: string;
        at: number;
        before_tokens: number | null;
        after_tokens: number | null;
      }>;
      return rows.map((row) => {
        const record: CompactionRecord = {
          threadId: row.thread_id,
          at: row.at,
          beforeTokens: row.before_tokens,
          afterTokens: row.after_tokens,
        };
        return record;
      });
    } catch (err) {
      console.error("[conversation-store] listCompactions failed:", err);
      return [];
    }
  }

  /** The thread id a caller's idempotency key was already used for, if any.
   *  A replayed requestId must land on the same thread — a different threadId
   *  with the same key is an idempotency conflict. */
  threadIdForRequestId(requestId: string): string | null {
    const db = this.dbh.handle();
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

  /** Drop cached conversation ids for deleted threads so a reused id re-reads. */
  forgetConversationIds(ids: readonly string[]): void {
    for (const id of ids) this.knownConversationIds.delete(id);
  }
}
