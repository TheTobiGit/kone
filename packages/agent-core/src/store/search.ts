import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import type {
  ConversationSearchHit,
  ConversationSearchOptions,
} from "../conversationStoreTypes.js";

/** Full-text search over stored conversation text, plus the writers that keep
 *  its index in step with the transcript.
 *
 *  The index is one FTS5 table (`conversation_fts`, created by the migration):
 *  a row per user block and a row per turn item, carrying the thread, the
 *  containing block, the turn/item identity and the text. Ranking and excerpts
 *  come from FTS5 itself (`bm25()` / `snippet()`), never from hand-rolled
 *  scoring, so relevance follows the tokenizer rather than this file.
 *
 *  Write discipline matters more than read here. `item.updated` fires once per
 *  streamed text delta — thousands of times a turn — so nothing on that path
 *  touches this table. Items land in the index when they settle
 *  (`item.completed`) and whole turns are re-synced when they settle
 *  (`turn.completed` / `turn.aborted`), which also backfills anything that
 *  never emitted a completion. User blocks are written once per turn, so they
 *  index at write time. Every writer here is idempotent (delete-then-insert
 *  per entry), so re-syncing a turn never duplicates rows. */

export const CONVERSATION_FTS_TABLE = "conversation_fts";

/** Rows per backfill pass when re-syncing a whole turn or thread: bounded so
 *  a long history never holds one giant statement. */
export const SEARCH_INDEX_BATCH_SIZE = 500;

/** Default / maximum hits per search call. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

/** Join an item's searchable fields into the single text its FTS row carries:
 *  the streamed body, the tool name, and the tool payload. All three are
 *  searched together because a hit only needs one of them to match — the
 *  snippet then shows which. */
export function combineItemText(
  text: string | null,
  name: string | null,
  detail: string | null,
): string {
  const parts: string[] = [];
  if (text) parts.push(text);
  if (name) parts.push(name);
  if (detail) parts.push(detail);
  return parts.join("\n");
}

/** Whether the FTS table exists yet. Migrations run at open before any repo
 *  writes, so this is normally true; the check keeps every writer a no-op
 *  instead of a throw on a database that stopped mid-ladder. */
export function ftsReady(db: DatabaseSync): boolean {
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(CONVERSATION_FTS_TABLE) != null
    );
  } catch {
    return false;
  }
}

export type FtsBlockInput = {
  threadId: string;
  blockId: string;
  turnId: string | null;
  at: number;
  text: string;
};

export type FtsItemInput = {
  threadId: string;
  turnId: string;
  itemId: string;
  /** The assistant block carrying the turn, when one exists — resolved by the
   *  caller so hits can jump straight to it. */
  blockId: string | null;
  at: number;
  text: string | null;
  name: string | null;
  detail: string | null;
};

/** Index (or re-index) one user block. Empty text indexes nothing — the stale
 *  row, if any, is still removed so an edit that blanks a block unlists it. */
export function indexBlockRow(db: DatabaseSync, input: FtsBlockInput): void {
  if (!ftsReady(db)) return;
  try {
    db.prepare(
      `DELETE FROM conversation_fts WHERE entry_kind = 'block' AND block_id = ?`,
    ).run(input.blockId);
    if (!input.text || input.text.trim().length === 0) return;
    db.prepare(
      `INSERT INTO conversation_fts
         (thread_id, entry_kind, block_id, turn_id, item_id, at, text)
       VALUES (?, 'block', ?, ?, NULL, ?, ?)`,
    ).run(input.threadId, input.blockId, input.turnId, input.at, input.text);
  } catch (err) {
    console.error("[conversation-store] indexBlockRow failed:", err);
  }
}

/** Index (or re-index) one turn item. Combines body + tool name + payload
 *  into the row's text; an item with nothing searchable still clears its
 *  stale row. */
export function indexItemRow(db: DatabaseSync, input: FtsItemInput): void {
  if (!ftsReady(db)) return;
  try {
    db.prepare(
      `DELETE FROM conversation_fts
        WHERE entry_kind = 'item' AND thread_id = ? AND turn_id = ? AND item_id = ?`,
    ).run(input.threadId, input.turnId, input.itemId);
    const text = combineItemText(input.text, input.name, input.detail);
    if (text.trim().length === 0) return;
    db.prepare(
      `INSERT INTO conversation_fts
         (thread_id, entry_kind, block_id, turn_id, item_id, at, text)
       VALUES (?, 'item', ?, ?, ?, ?, ?)`,
    ).run(input.threadId, input.blockId, input.turnId, input.itemId, input.at, text);
  } catch (err) {
    console.error("[conversation-store] indexItemRow failed:", err);
  }
}

/** The assistant block carrying a turn, or null when the turn has none yet —
 *  what item hits jump to. Resolved per turn rather than per item so a turn
 *  re-sync costs one lookup, not one per item. */
export function parentBlockIdForTurn(
  db: DatabaseSync,
  threadId: string,
  turnId: string,
): string | null {
  try {
    // SAFETY: the projection names only blocks.block_id (NOT NULL TEXT).
    const row = db
      .prepare(
        `SELECT block_id FROM blocks
          WHERE thread_id = ? AND turn_id = ? AND role = 'assistant'
          LIMIT 1`,
      )
      .get(threadId, turnId) as { block_id: string } | undefined;
    return row?.block_id ?? null;
  } catch {
    return null;
  }
}

type ItemIndexRow = {
  item_id: string;
  turn_id: string;
  text: string | null;
  name: string | null;
  detail: string | null;
  at: number;
};

/** Re-sync every item of one turn from the items table: the backfill half of
 *  the completion hook. Removes the turn's item rows first, then re-inserts
 *  from the current row contents in bounded batches, so settling a turn
 *  indexes even the items that never emitted their own completion. */
export function indexTurnRows(db: DatabaseSync, threadId: string, turnId: string): void {
  if (!ftsReady(db)) return;
  try {
    db.prepare(
      `DELETE FROM conversation_fts
        WHERE entry_kind = 'item' AND thread_id = ? AND turn_id = ?`,
    ).run(threadId, turnId);
    const blockId = parentBlockIdForTurn(db, threadId, turnId);
    let offset = 0;
    for (;;) {
      // SAFETY: the projection names exactly the item columns read below.
      const rows = db
        .prepare(
          `SELECT item_id, turn_id, text, name, detail, at FROM items
            WHERE thread_id = ? AND turn_id = ?
            ORDER BY seq ASC
            LIMIT ? OFFSET ?`,
        )
        .all(threadId, turnId, SEARCH_INDEX_BATCH_SIZE, offset) as ItemIndexRow[];
      if (rows.length === 0) break;
      const insert = db.prepare(
        `INSERT INTO conversation_fts
           (thread_id, entry_kind, block_id, turn_id, item_id, at, text)
         VALUES (?, 'item', ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const text = combineItemText(row.text, row.name, row.detail);
        if (text.trim().length === 0) continue;
        insert.run(threadId, blockId, row.turn_id, row.item_id, row.at, text);
      }
      if (rows.length < SEARCH_INDEX_BATCH_SIZE) break;
      offset += rows.length;
    }
  } catch (err) {
    console.error("[conversation-store] indexTurnRows failed:", err);
  }
}

type BlockIndexRow = {
  block_id: string;
  turn_id: string | null;
  text: string | null;
  at: number;
};

/** Re-sync a whole thread (every block row, every item row) in bounded
 *  batches. Used for recovery paths that settle text outside the normal
 *  completion flow, where per-turn re-syncs cannot enumerate what changed. */
export function indexThreadRows(db: DatabaseSync, threadId: string): void {
  if (!ftsReady(db)) return;
  try {
    db.prepare(`DELETE FROM conversation_fts WHERE thread_id = ?`).run(threadId);
    let offset = 0;
    for (;;) {
      // SAFETY: the projection names exactly the block columns read below.
      const blocks = db
        .prepare(
          `SELECT block_id, turn_id, text, at FROM blocks
            WHERE thread_id = ?
            ORDER BY seq ASC
            LIMIT ? OFFSET ?`,
        )
        .all(threadId, SEARCH_INDEX_BATCH_SIZE, offset) as BlockIndexRow[];
      if (blocks.length === 0) break;
      const insertBlock = db.prepare(
        `INSERT INTO conversation_fts
           (thread_id, entry_kind, block_id, turn_id, item_id, at, text)
         VALUES (?, 'block', ?, ?, NULL, ?, ?)`,
      );
      for (const block of blocks) {
        if (!block.text || block.text.trim().length === 0) continue;
        insertBlock.run(threadId, block.block_id, block.turn_id, block.at, block.text);
      }
      if (blocks.length < SEARCH_INDEX_BATCH_SIZE) break;
      offset += blocks.length;
    }
    // SAFETY: the projection names exactly the item columns read below.
    const turns = db
      .prepare(`SELECT DISTINCT turn_id FROM items WHERE thread_id = ?`)
      .all(threadId) as Array<{ turn_id: string }>;
    for (const turn of turns) {
      indexTurnRows(db, threadId, turn.turn_id);
    }
  } catch (err) {
    console.error("[conversation-store] indexThreadRows failed:", err);
  }
}

/** Drop every index row for the given threads. Called on delete, where the
 *  transcript rows cascade away and the index must follow them. */
export function removeThreadRows(db: DatabaseSync, threadIds: readonly string[]): void {
  if (threadIds.length === 0 || !ftsReady(db)) return;
  try {
    const placeholders = threadIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM conversation_fts WHERE thread_id IN (${placeholders})`).run(
      ...threadIds,
    );
  } catch (err) {
    console.error("[conversation-store] removeThreadRows failed:", err);
  }
}

/** Turn free user input into a safe FTS5 MATCH expression. Every term is
 *  double-quoted (embedded quotes doubled), so input that looks like FTS5
 *  syntax — `OR`, `NEAR(`, `*`, unbalanced quotes, column filters — can only
 *  ever match literally, never throw. Double-quoted spans in the input stay
 *  phrases; everything else is ANDed terms. Null when the input carries no
 *  searchable token at all, which the search answers as empty. */
export function toFtsQuery(rawQuery: string): string | null {
  const quoted = (token: string): string => `"${token.replace(/"/g, `""`)}"`;
  const clauses: string[] = [];
  const phrasePattern = /"([^"]*)"/g;
  const phrases: string[] = [];
  let match: RegExpExecArray | null;
  // Collect the user's own quoted spans as phrases first, then strip them so
  // their words are not also indexed as loose terms.
  for (;;) {
    match = phrasePattern.exec(rawQuery);
    if (!match) break;
    const words = match[1] ?? "";
    if (words.trim().length > 0) phrases.push(words);
  }
  const withoutPhrases = rawQuery.replace(/"[^"]*"/g, " ");
  const terms = withoutPhrases.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const phrase of phrases) {
    clauses.push(quoted(phrase));
  }
  for (const term of terms) {
    clauses.push(quoted(term));
  }
  if (clauses.length === 0) return null;
  return clauses.join(" AND ");
}

export class SearchRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Search stored conversation text — user blocks and turn items together —
   *  across all threads, or scoped to one with `options.threadId`. Ranked by
   *  FTS5 `bm25` (best first); each hit carries an FTS `snippet()` excerpt
   *  with `<mark>` around the matched span plus the ids the renderer needs
   *  to jump to it. Hostile or empty input answers empty, never throws. */
  searchConversations(query: string, options?: ConversationSearchOptions): ConversationSearchHit[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      const ftsQuery = toFtsQuery(query);
      if (!ftsQuery || !ftsReady(db)) return [];
      const limit = clampLimit(options?.limit);
      const scoped = options?.threadId;
      type FtsHitRow = {
        thread_id: string;
        entry_kind: string;
        block_id: string | null;
        turn_id: string | null;
        item_id: string | null;
        at: number;
        snippet: string;
        rank: number;
      };
      // Column 6 of the FTS table is the indexed text — the only column the
      // excerpt is ever drawn from. bm25 orders best-first (most negative).
      const sql = scoped
        ? `SELECT thread_id, entry_kind, block_id, turn_id, item_id, at,
                  snippet(conversation_fts, 6, '<mark>', '</mark>', '…', 24) AS snippet,
                  bm25(conversation_fts) AS rank
             FROM conversation_fts
            WHERE conversation_fts MATCH ? AND thread_id = ?
            ORDER BY rank LIMIT ?`
        : `SELECT thread_id, entry_kind, block_id, turn_id, item_id, at,
                  snippet(conversation_fts, 6, '<mark>', '</mark>', '…', 24) AS snippet,
                  bm25(conversation_fts) AS rank
             FROM conversation_fts
            WHERE conversation_fts MATCH ?
            ORDER BY rank LIMIT ?`;
      // SAFETY: the projection names exactly the FTS columns plus the two
      // aliased FTS5 auxiliary outputs read below.
      const rows = (
        scoped
          ? db.prepare(sql).all(ftsQuery, scoped, limit)
          : db.prepare(sql).all(ftsQuery, limit)
      ) as FtsHitRow[];
      const hits: ConversationSearchHit[] = [];
      for (const row of rows) {
        // SAFETY: entry_kind is only ever written as 'block' or 'item' above.
        const entryKind = row.entry_kind as ConversationSearchHit["entryKind"];
        if (entryKind !== "block" && entryKind !== "item") continue;
        hits.push({
          threadId: row.thread_id,
          entryKind,
          blockId: row.block_id,
          turnId: row.turn_id,
          itemId: row.item_id,
          at: row.at,
          snippet: row.snippet,
          rank: row.rank,
        });
      }
      return hits;
    } catch (err) {
      console.error("[conversation-store] searchConversations failed:", err);
      return [];
    }
  }
}

/** Clamp the caller's limit into the supported window: a positive integer,
 *  defaulting when absent or unusable, capped so one query cannot page the
 *  whole index. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return SEARCH_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}
