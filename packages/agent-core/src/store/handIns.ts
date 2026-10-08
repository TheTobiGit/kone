import { z } from "zod";

import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import type { HandInRecord, ProviderKind } from "../types.js";
import { withTransaction } from "../conversationMigrations.js";

/** One stored hand-in row, as the table spells it. */
export type HandInRow = {
  thread_id: string;
  from_provider: string;
  from_model: string | null;
  to_provider: string;
  to_model: string | null;
  at: number;
  omitted_block_ids_json: string | null;
  omitted_item_ids_json: string | null;
};

const OmittedIdArrayWire = z.array(z.string().min(1));

/** Decode a JSON array of ids, tolerating a missing or malformed value by
 *  answering "nothing recorded" rather than throwing on a hand-edited row. */
function parseIdArray(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = OmittedIdArrayWire.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A stored hand-in row as the record the timeline reads. Blank models are
 *  dropped rather than carried as empty strings — nothing recorded is not the
 *  same as a model with no name. */
export function handInRecordFromRow(row: HandInRow): HandInRecord {
  // SAFETY: from_provider is only ever written from a ProviderKind-typed
  // input in writeHandIn.
  const fromProvider = row.from_provider as ProviderKind;
  // SAFETY: to_provider is only ever written from a ProviderKind-typed input
  // in writeHandIn.
  const toProvider = row.to_provider as ProviderKind;
  const record: HandInRecord = {
    threadId: row.thread_id,
    fromProvider,
    toProvider,
    at: row.at,
  };
  if (row.from_model) record.fromModel = row.from_model;
  if (row.to_model) record.toModel = row.to_model;
  const omittedBlockIds = parseIdArray(row.omitted_block_ids_json);
  const omittedItemIds = parseIdArray(row.omitted_item_ids_json);
  if (omittedBlockIds) record.omittedBlockIds = omittedBlockIds;
  if (omittedItemIds) record.omittedItemIds = omittedItemIds;
  return record;
}

export class HandInsRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Record that a thread changed hands and point its row at the new owner,
   *  in one transaction: the history row and the thread's current provider
   *  are two halves of the same fact, and a database that carries one without
   *  the other can neither draw the timeline nor route the next turn.
   *
   *  The provider-native session ids (`conversation_id`, `resume_session_at`)
   *  are cleared with it. They name a conversation inside the old provider;
   *  handing them to the new one would ask it to resume a conversation it has
   *  never had. The thread's own blocks are untouched — they are what the new
   *  session gets bootstrapped with.
   *
   *  Returns the stored record, or null when there is no such thread or the
   *  write failed. */
  writeHandIn(input: {
    threadId: string;
    fromProvider: ProviderKind;
    fromModel?: string;
    toProvider: ProviderKind;
    toModel?: string;
    at: number;
  }): HandInRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      const exists = db.prepare(`SELECT 1 FROM threads WHERE thread_id = ?`).get(input.threadId);
      if (!exists) return null;
      this.dbh.durably(db, () => {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO thread_hand_ins
               (thread_id, from_provider, from_model, to_provider, to_model, at,
                omitted_block_ids_json, omitted_item_ids_json)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
          ).run(
            input.threadId,
            input.fromProvider,
            input.fromModel ?? null,
            input.toProvider,
            input.toModel ?? null,
            input.at,
          );
          db.prepare(
            `UPDATE threads
                SET provider = ?, model = ?, conversation_id = NULL,
                    resume_session_at = NULL, last_activity_at = ?
              WHERE thread_id = ?`,
          ).run(input.toProvider, input.toModel ?? null, input.at, input.threadId);
        });
      });
      return handInRecordFromRow({
        thread_id: input.threadId,
        from_provider: input.fromProvider,
        from_model: input.fromModel ?? null,
        to_provider: input.toProvider,
        to_model: input.toModel ?? null,
        at: input.at,
        omitted_block_ids_json: null,
        omitted_item_ids_json: null,
      });
    } catch (err) {
      console.error("[conversation-store] writeHandIn failed:", err);
      return null;
    }
  }

  /** The hand-in this thread is still waiting to bootstrap, if any — the
   *  newest row whose one-shot replay has not been consumed. Null for a
   *  thread that never changed hands, and for one whose new session has
   *  already been handed the prior transcript. */
  pendingHandIn(threadId: string): HandInRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names exactly the columns migration 13
      // creates on thread_hand_ins, plus migration 29's omitted-id columns.
      const row = db
        .prepare(
          `SELECT thread_id, from_provider, from_model, to_provider, to_model, at,
                  omitted_block_ids_json, omitted_item_ids_json
             FROM thread_hand_ins
            WHERE thread_id = ? AND bootstrap_status = 'pending'
            ORDER BY at DESC, hand_in_id DESC LIMIT 1`,
        )
        .get(threadId) as HandInRow | undefined;
      return row ? handInRecordFromRow(row) : null;
    } catch (err) {
      console.error("[conversation-store] pendingHandIn failed:", err);
      return null;
    }
  }

  /** Record the block/item ids a hand-in's one-shot replay could not fit, on
   *  the still-pending row. Written when the bootstrap is built, before the
   *  turn runs, so the note survives even if the turn fails. No-op when
   *  nothing was omitted or no hand-in is pending. */
  recordHandInOmittedHistory(
    threadId: string,
    omittedBlockIds: readonly string[],
    omittedItemIds: readonly string[],
  ): void {
    if (omittedBlockIds.length === 0 && omittedItemIds.length === 0) return;
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () =>
        db
          .prepare(
            `UPDATE thread_hand_ins
                SET omitted_block_ids_json = ?, omitted_item_ids_json = ?
              WHERE thread_id = ? AND bootstrap_status = 'pending'`,
          )
          .run(
            omittedBlockIds.length > 0 ? JSON.stringify(omittedBlockIds) : null,
            omittedItemIds.length > 0 ? JSON.stringify(omittedItemIds) : null,
            threadId,
          ),
      );
    } catch (err) {
      console.error("[conversation-store] recordHandInOmittedHistory failed:", err);
    }
  }

  /** Flip every pending hand-in of a thread to "completed" — called when a
   *  turn settles, so the prior-transcript replay never runs twice. Plural
   *  because two swaps before a single turn share one replay: the transcript
   *  the turn carried already covered both. No-op when nothing is pending. */
  completeHandInBootstrap(db: DatabaseSync, threadId: string): void {
    try {
      db.prepare(
        `UPDATE thread_hand_ins SET bootstrap_status = 'completed'
          WHERE thread_id = ? AND bootstrap_status = 'pending'`,
      ).run(threadId);
    } catch (err) {
      console.error("[conversation-store] completeHandInBootstrap failed:", err);
    }
  }

  /** Every time this thread changed hands, oldest first — the timeline's
   *  "changed hands" markers, the same shape of history read as
   *  continuationsFromSource. Empty for a thread that has only ever had one
   *  owner. */
  handInsForThread(threadId: string): HandInRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection names exactly the columns migration 13
      // creates on thread_hand_ins, plus migration 29's omitted-id columns.
      const rows = db
        .prepare(
          `SELECT thread_id, from_provider, from_model, to_provider, to_model, at,
                  omitted_block_ids_json, omitted_item_ids_json
             FROM thread_hand_ins WHERE thread_id = ? ORDER BY at ASC, hand_in_id ASC`,
        )
        .all(threadId) as HandInRow[];
      return rows.map(handInRecordFromRow);
    } catch (err) {
      console.error("[conversation-store] handInsForThread failed:", err);
      return [];
    }
  }
}
