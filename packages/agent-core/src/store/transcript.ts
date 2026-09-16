import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import type { StoredThread } from "../types.js";
import { PAGE_DEFAULT_USER_BLOCKS, PAGE_RAW_FANOUT, assembleBlocks, decodeThreadPageCursor, encodeThreadPageCursor, rowToMeta, type BlockRow, type ItemRow, type StoredThreadPage, type SubagentRow, type ThreadRow, type TurnPartRows, type TurnSpan, type TurnUsageRecord } from "../conversationStoreTypes.js";
import { WITHOUT_ACTIVE_QUEUE } from "./sql.js";

export class TranscriptRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Reconstruct one thread by id: its metadata plus every block in arrival
   *  order, each assistant turn carrying its ordered items. */
  loadThread(threadId: string): StoredThread | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
      const threadRow = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(threadId) as ThreadRow | undefined;
      if (!threadRow) return null;

      // SAFETY: `SELECT *` of blocks in seq order is exactly BlockRow. A
      // prompt behind the running turn stays out until its queue row settles
      // (see WITHOUT_ACTIVE_QUEUE).
      const blockRows = db
        .prepare(
          `SELECT * FROM blocks WHERE thread_id = ? AND ${WITHOUT_ACTIVE_QUEUE} ORDER BY seq`,
        )
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
    const db = this.dbh.handle();
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
        ? (this.dbh.prepare(
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
      // Prompts behind the running turn are excluded before the walk, so they
      // neither appear nor consume the user-anchored window (see
      // WITHOUT_ACTIVE_QUEUE).
      const candidates = (
        boundarySeq !== null
          ? db
              .prepare(
                `SELECT * FROM blocks
                  WHERE thread_id = ? AND seq < ? AND ${WITHOUT_ACTIVE_QUEUE}
                  ORDER BY seq DESC
                  LIMIT ?`,
              )
              .all(threadId, boundarySeq, maxRaw)
          : boundary
            ? db
                .prepare(
                  `SELECT * FROM blocks
                    WHERE thread_id = ? AND at < ? AND ${WITHOUT_ACTIVE_QUEUE}
                    ORDER BY seq DESC
                    LIMIT ?`,
                )
                .all(threadId, boundary.beforeAnchorAt, maxRaw)
            : db
                .prepare(
                  `SELECT * FROM blocks WHERE thread_id = ? AND ${WITHOUT_ACTIVE_QUEUE} ORDER BY seq DESC LIMIT ?`,
                )
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
            `SELECT 1 FROM blocks WHERE thread_id = ? AND seq < ? AND ${WITHOUT_ACTIVE_QUEUE} LIMIT 1`,
          )
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

  /** Every per-turn token audit row on a thread, oldest first. Rows are few
   *  (one per turn that reported usage), so this is always the full list,
   *  never a page — the thread export's per-turn usage section reads here. */
  listTurnUsage(threadId: string): TurnUsageRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection names exactly the turn_usage columns this
      // schema creates, aliased to the record's camelCase fields.
      const rows = db
        .prepare(
          `SELECT turn_id AS turnId,
                  input_tokens AS inputTokens,
                  output_tokens AS outputTokens,
                  total_tokens AS totalTokens,
                  cache_read_tokens AS cacheReadTokens,
                  cache_creation_tokens AS cacheCreationTokens,
                  reasoning_tokens AS reasoningTokens,
                  at
             FROM turn_usage
            WHERE thread_id = ?
            ORDER BY at ASC, turn_id ASC`,
        )
        .all(threadId) as TurnUsageRecord[];
      return rows;
    } catch (err) {
      console.error("[conversation-store] listTurnUsage failed:", err);
      return [];
    }
  }

  /** Whether the thread has a live (native) assistant turn yet. Fork-imported
   *  assistant blocks are the source's history, not the side chat's own
   *  activity — only a native assistant block means the child has actually
   *  answered. This is the one-shot gate for the `<sidechat_context>` bootstrap
 */
  hasNativeAssistantTurn(threadId: string): boolean {
    const db = this.dbh.handle();
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

  /** The most recent assistant block's narrative text — its `assistant_text`
   *  items concatenated in arrival order, trimmed. This is what becomes the
   *  child's summary, so it is the narrative only: reasoning, plan and tool
   *  calls are excluded (they stay in the child's transcript, readable on
   *  demand via kone_read_response). Null when the thread has never produced
   *  assistant text. */
  latestAssistantText(threadId: string): string | null {
    const db = this.dbh.handle();
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
    const db = this.dbh.handle();
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

  /** Batch version of threadTurnSpan: the same per-thread readout for many
   *  threads in one aggregate query, so a twenty-row list costs one round
   *  trip instead of twenty. Threads with no assistant blocks are absent
   *  from the map — callers read a miss as null, the same answer the
   *  single-thread read gives. Empty input answers empty without touching
   *  the database, because an empty IN list is a syntax error, not a query. */
  threadTurnSpans(threadIds: readonly string[]): Map<string, TurnSpan> {
    const spans = new Map<string, TurnSpan>();
    if (threadIds.length === 0) return spans;
    const db = this.dbh.handle();
    if (!db) return spans;
    try {
      const placeholders = threadIds.map(() => "?").join(",");
      // SAFETY: every selected value is an aliased aggregate grouped by
      // thread_id, plus the newest row's settle columns: MAX(seq) over the
      // same assistant-only filter names the newest block once per thread,
      // and the PK join reads its state and error together — one aggregate
      // pass instead of two per-group sorts for the same block.
      const rows = db
        .prepare(
          `SELECT agg.thread_id,
                  agg.started_at,
                  agg.ended_at,
                  agg.running,
                  newest.state AS last_state,
                  newest.error AS last_error
             FROM (SELECT thread_id,
                          MIN(at) AS started_at,
                          MAX(ended_at) AS ended_at,
                          COUNT(CASE WHEN state = 'running' THEN 1 END) AS running,
                          MAX(seq) AS newest_seq
                     FROM blocks
                    WHERE thread_id IN (${placeholders}) AND role = 'assistant'
                    GROUP BY thread_id) AS agg
             LEFT JOIN blocks AS newest ON newest.seq = agg.newest_seq`,
        )
        .all(...threadIds) as Array<{
        thread_id: string;
        started_at: number | null;
        ended_at: number | null;
        running: number;
        last_state: "running" | "interrupted" | "failed" | "completed" | null;
        last_error: string | null;
      }>;
      for (const row of rows) {
        if (row.started_at === null) continue;
        const span: TurnSpan = {
          startedAt: row.started_at,
          endedAt: row.running > 0 ? null : row.ended_at,
          runningTurns: row.running,
          lastState: row.last_state,
        };
        if (row.last_error) span.lastError = row.last_error;
        spans.set(row.thread_id, span);
      }
      return spans;
    } catch (err) {
      console.error("[conversation-store] threadTurnSpans failed:", err);
      return spans;
    }
  }
}
