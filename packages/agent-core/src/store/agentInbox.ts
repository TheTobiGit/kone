import { randomUUID } from "node:crypto";

import { AgentSenderSchema, CourierSenderSchema, type AgentSender, type CourierSender } from "@kone/protocol/message-sender";
import type { ConversationDb } from "./ConversationDb.js";
import type { DatabaseSync } from "../sqlite.js";

// The agent inbox: every message one agent or kone sends another lands here
// first, and stays until it is seen — handed over in a turn, read with the
// inbox tool, or returned to a sender parked on it — then stays as history.
//
// A hand-over is two-phase so a crash neither loses a message nor repeats
// one. `claimInbox` flips a batch unseen → handing under one fresh delivery
// id, in one statement, so two racing hand-overs can never both take a row.
// The provider accepting the turn settles the batch (seen, with the turn);
// a send that throws releases it (unseen again). The transcript block a
// message was written as survives the release, so the retry names the same
// block instead of writing a second one. Settle and release both match on the
// delivery id AND the handing state: a delivery that lost its rows (the boot
// reset, a reply taken by a waiting sender) changes nothing.

export const INBOX_KINDS = ["note", "question", "pushback", "answer", "report", "notice", "job"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxState = "unseen" | "handing" | "seen" | "retracted";
export type InboxSeenVia = "turn" | "inbox" | "wait";
export type InboxSender = AgentSender | CourierSender;

export interface InboxRow {
  inboxId: string;
  recipientThreadId: string;
  /** Null for kone's own messages (the courier, notices). */
  senderThreadId: string | null;
  /** Null when nobody could say who sent it. */
  sender: InboxSender | null;
  kind: InboxKind;
  urgent: boolean;
  replyTo: string | null;
  body: string;
  state: InboxState;
  deliveryId: string | null;
  blockId: string | null;
  turnId: string | null;
  seenVia: InboxSeenVia | null;
  dedupeKey: string | null;
  projectPath: string;
  createdAt: number;
  seenAt: number | null;
}

export interface InboxInsert {
  inboxId: string;
  recipientThreadId: string;
  senderThreadId: string | null;
  sender: InboxSender | null;
  kind: InboxKind;
  urgent?: boolean;
  replyTo?: string | null;
  body: string;
  dedupeKey?: string | null;
  projectPath: string;
  createdAt?: number;
}

/** What an insert came to. `duplicate` is a replayed write its dedupe key
 *  caught; `failed` means nothing was stored (no database, a missing thread). */
export type InboxInsertResult = "inserted" | "duplicate" | "failed";

/** One hand-over's batch, claimed under `deliveryId`, oldest first. */
export interface InboxClaim {
  deliveryId: string;
  rows: InboxRow[];
}

/** The inbox as the mailbox and delivery use it — the store's methods, or an
 *  in-memory stand-in with the same rules where there is no store. */
export interface AgentInboxStore {
  insertInboxMessage(input: InboxInsert): InboxInsertResult;
  /** Take up to `limit` unseen messages for one hand-over; null when there
   *  are none. */
  claimInbox(recipientThreadId: string, limit: number): InboxClaim | null;
  /** The provider took the turn: the batch is seen, carried by `turnId`.
   *  Returns how many rows it settled. */
  settleInboxDelivery(deliveryId: string, turnId: string | null): number;
  /** The send failed: the batch is unseen again, block ids kept. Returns how
   *  many rows it released. */
  releaseInboxDelivery(deliveryId: string): number;
  setInboxBlockId(inboxId: string, blockId: string): void;
  /** Mark these unseen messages seen, and return the ids that actually were
   *  unseen — a message already claimed or seen is left as it is. */
  markInboxSeen(inboxIds: readonly string[], via: InboxSeenVia): string[];
  /** Take back an unseen message. False once it was claimed or seen. */
  retractInboxMessage(inboxId: string): boolean;
  listUnseenInbox(recipientThreadId: string, limit?: number): InboxRow[];
  /** Seen messages, newest first. */
  inboxHistory(recipientThreadId: string, limit: number): InboxRow[];
  unseenInboxCount(recipientThreadId: string): number;
}

const INBOX_COLUMNS = `inbox_id, recipient_thread_id, sender_thread_id, sender_json, kind,
                       urgent, reply_to, body, state, delivery_id, block_id, turn_id,
                       seen_via, dedupe_key, project_path, created_at, seen_at`;

/** Arrival order. rowid settles two messages written in the same millisecond,
 *  which a broadcast does routinely. */
const INBOX_ORDER = `created_at ASC, rowid ASC`;

/** A type alias, not an interface: only an alias carries the implicit index
 *  signature a driver's row record converts to. */
type InboxDbRow = {
  inbox_id: string;
  recipient_thread_id: string;
  sender_thread_id: string | null;
  sender_json: string;
  kind: InboxKind;
  urgent: number;
  reply_to: string | null;
  body: string;
  state: InboxState;
  delivery_id: string | null;
  block_id: string | null;
  turn_id: string | null;
  seen_via: InboxSeenVia | null;
  dedupe_key: string | null;
  project_path: string;
  created_at: number;
  seen_at: number | null;
  /** Present on RETURNING rows, which come back in no promised order. */
  row_seq?: number;
};

/** The stored sender, or null when it is the JSON null or no longer parses. */
function parseInboxSender(json: string): InboxSender | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const agent = AgentSenderSchema.safeParse(value);
  if (agent.success) return agent.data;
  const courier = CourierSenderSchema.safeParse(value);
  return courier.success ? courier.data : null;
}

function rowToInbox(row: InboxDbRow): InboxRow {
  return {
    inboxId: row.inbox_id,
    recipientThreadId: row.recipient_thread_id,
    senderThreadId: row.sender_thread_id,
    sender: parseInboxSender(row.sender_json),
    kind: row.kind,
    urgent: row.urgent !== 0,
    replyTo: row.reply_to,
    body: row.body,
    state: row.state,
    deliveryId: row.delivery_id,
    blockId: row.block_id,
    turnId: row.turn_id,
    seenVia: row.seen_via,
    dedupeKey: row.dedupe_key,
    projectPath: row.project_path,
    createdAt: row.created_at,
    seenAt: row.seen_at,
  };
}

/** Put every message a dead process was handing over back to unseen. Safe
 *  only at the first open of a fresh process, when no hand-over is live. */
export function releaseOrphanedInboxClaims(db: DatabaseSync): void {
  try {
    db.prepare(`UPDATE agent_inbox SET state = 'unseen', delivery_id = NULL WHERE state = 'handing'`).run();
  } catch (err) {
    console.error("[conversation-store] could not release orphaned inbox claims:", err);
  }
}

export class AgentInboxRepo implements AgentInboxStore {
  constructor(private readonly dbh: ConversationDb) {}

  insertInboxMessage(input: InboxInsert): InboxInsertResult {
    const db = this.dbh.handle();
    if (!db) return "failed";
    let result: InboxInsertResult = "failed";
    try {
      this.dbh.durably(db, () => {
        const run = db
          .prepare(
            `INSERT INTO agent_inbox (inbox_id, recipient_thread_id, sender_thread_id, sender_json,
                                      kind, urgent, reply_to, body, state, dedupe_key,
                                      project_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unseen', ?, ?, ?)
             ON CONFLICT (dedupe_key) DO NOTHING`,
          )
          .run(
            input.inboxId,
            input.recipientThreadId,
            input.senderThreadId,
            JSON.stringify(input.sender),
            input.kind,
            input.urgent ? 1 : 0,
            input.replyTo ?? null,
            input.body,
            input.dedupeKey ?? null,
            input.projectPath,
            input.createdAt ?? Date.now(),
          );
        result = Number(run.changes) > 0 ? "inserted" : "duplicate";
      });
    } catch (err) {
      console.error("[conversation-store] insertInboxMessage failed:", err);
      return "failed";
    }
    return result;
  }

  claimInbox(recipientThreadId: string, limit: number): InboxClaim | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const deliveryId = `dlv_${randomUUID()}`;
    try {
      // SAFETY: RETURNING the INBOX_COLUMNS projection plus rowid, exactly
      // the shape InboxDbRow declares.
      const rows = db
        .prepare(
          `UPDATE agent_inbox SET state = 'handing', delivery_id = ?
            WHERE inbox_id IN (
              SELECT inbox_id FROM agent_inbox
               WHERE recipient_thread_id = ? AND state = 'unseen'
               ORDER BY ${INBOX_ORDER}
               LIMIT ?)
            RETURNING ${INBOX_COLUMNS}, rowid AS row_seq`,
        )
        .all(deliveryId, recipientThreadId, Math.max(1, limit)) as InboxDbRow[];
      if (rows.length === 0) return null;
      rows.sort((a, b) => a.created_at - b.created_at || (a.row_seq ?? 0) - (b.row_seq ?? 0));
      return { deliveryId, rows: rows.map(rowToInbox) };
    } catch (err) {
      console.error("[conversation-store] claimInbox failed:", err);
      return null;
    }
  }

  settleInboxDelivery(deliveryId: string, turnId: string | null): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    let settled = 0;
    try {
      this.dbh.durably(db, () => {
        const run = db
          .prepare(
            `UPDATE agent_inbox SET state = 'seen', seen_via = 'turn', turn_id = ?, seen_at = ?
              WHERE delivery_id = ? AND state = 'handing'`,
          )
          .run(turnId, Date.now(), deliveryId);
        settled = Number(run.changes);
      });
    } catch (err) {
      console.error("[conversation-store] settleInboxDelivery failed:", err);
    }
    return settled;
  }

  releaseInboxDelivery(deliveryId: string): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      const run = db
        .prepare(
          `UPDATE agent_inbox SET state = 'unseen', delivery_id = NULL
            WHERE delivery_id = ? AND state = 'handing'`,
        )
        .run(deliveryId);
      return Number(run.changes);
    } catch (err) {
      console.error("[conversation-store] releaseInboxDelivery failed:", err);
      return 0;
    }
  }

  setInboxBlockId(inboxId: string, blockId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE agent_inbox SET block_id = ? WHERE inbox_id = ?`).run(blockId, inboxId);
    } catch (err) {
      console.error("[conversation-store] setInboxBlockId failed:", err);
    }
  }

  markInboxSeen(inboxIds: readonly string[], via: InboxSeenVia): string[] {
    const db = this.dbh.handle();
    if (!db || inboxIds.length === 0) return [];
    try {
      const placeholders = inboxIds.map(() => "?").join(", ");
      // SAFETY: RETURNING one TEXT column.
      const rows = db
        .prepare(
          `UPDATE agent_inbox SET state = 'seen', seen_via = ?, seen_at = ?
            WHERE inbox_id IN (${placeholders}) AND state = 'unseen'
            RETURNING inbox_id`,
        )
        .all(via, Date.now(), ...inboxIds) as Array<{ inbox_id: string }>;
      const flipped = new Set(rows.map((r) => r.inbox_id));
      return inboxIds.filter((id) => flipped.has(id));
    } catch (err) {
      console.error("[conversation-store] markInboxSeen failed:", err);
      return [];
    }
  }

  retractInboxMessage(inboxId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const run = db
        .prepare(`UPDATE agent_inbox SET state = 'retracted' WHERE inbox_id = ? AND state = 'unseen'`)
        .run(inboxId);
      return Number(run.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] retractInboxMessage failed:", err);
      return false;
    }
  }

  listUnseenInbox(recipientThreadId: string, limit?: number): InboxRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list InboxDbRow is declared from.
      const rows = db
        .prepare(
          `SELECT ${INBOX_COLUMNS} FROM agent_inbox
            WHERE recipient_thread_id = ? AND state = 'unseen'
            ORDER BY ${INBOX_ORDER}
            LIMIT ?`,
        )
        .all(recipientThreadId, limit && limit > 0 ? limit : -1) as InboxDbRow[];
      return rows.map(rowToInbox);
    } catch (err) {
      console.error("[conversation-store] listUnseenInbox failed:", err);
      return [];
    }
  }

  inboxHistory(recipientThreadId: string, limit: number): InboxRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list InboxDbRow is declared from.
      const rows = db
        .prepare(
          `SELECT ${INBOX_COLUMNS} FROM agent_inbox
            WHERE recipient_thread_id = ? AND state = 'seen'
            ORDER BY seen_at DESC, rowid DESC
            LIMIT ?`,
        )
        .all(recipientThreadId, Math.max(1, limit)) as InboxDbRow[];
      return rows.map(rowToInbox);
    } catch (err) {
      console.error("[conversation-store] inboxHistory failed:", err);
      return [];
    }
  }

  unseenInboxCount(recipientThreadId: string): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      // SAFETY: an aggregate COUNT answers one row with one integer column.
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM agent_inbox WHERE recipient_thread_id = ? AND state = 'unseen'`)
        .get(recipientThreadId) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      console.error("[conversation-store] unseenInboxCount failed:", err);
      return 0;
    }
  }

  /** Put every message still being handed over back to unseen, block ids
   *  kept. What the first open of a process does; exposed for tests. */
  resetHandingAtBoot(): void {
    const db = this.dbh.handle();
    if (db) releaseOrphanedInboxClaims(db);
  }
}

/** The inbox with the same rules and no database: what the mailbox runs on
 *  until the app hands it the store, and in tests that need no disk. Nothing
 *  here survives the process. */
export class MemoryAgentInbox implements AgentInboxStore {
  private readonly rows: InboxRow[] = [];

  insertInboxMessage(input: InboxInsert): InboxInsertResult {
    if (input.dedupeKey && this.rows.some((r) => r.dedupeKey === input.dedupeKey)) return "duplicate";
    this.rows.push({
      inboxId: input.inboxId,
      recipientThreadId: input.recipientThreadId,
      senderThreadId: input.senderThreadId,
      sender: input.sender,
      kind: input.kind,
      urgent: input.urgent ?? false,
      replyTo: input.replyTo ?? null,
      body: input.body,
      state: "unseen",
      deliveryId: null,
      blockId: null,
      turnId: null,
      seenVia: null,
      dedupeKey: input.dedupeKey ?? null,
      projectPath: input.projectPath,
      createdAt: input.createdAt ?? Date.now(),
      seenAt: null,
    });
    return "inserted";
  }

  claimInbox(recipientThreadId: string, limit: number): InboxClaim | null {
    const batch = this.unseen(recipientThreadId).slice(0, Math.max(1, limit));
    if (batch.length === 0) return null;
    const deliveryId = `dlv_${randomUUID()}`;
    for (const row of batch) {
      row.state = "handing";
      row.deliveryId = deliveryId;
    }
    return { deliveryId, rows: batch.map((r) => ({ ...r })) };
  }

  settleInboxDelivery(deliveryId: string, turnId: string | null): number {
    const now = Date.now();
    return this.handing(deliveryId).map((row) => {
      row.state = "seen";
      row.seenVia = "turn";
      row.turnId = turnId;
      row.seenAt = now;
      return row;
    }).length;
  }

  releaseInboxDelivery(deliveryId: string): number {
    return this.handing(deliveryId).map((row) => {
      row.state = "unseen";
      row.deliveryId = null;
      return row;
    }).length;
  }

  setInboxBlockId(inboxId: string, blockId: string): void {
    const row = this.rows.find((r) => r.inboxId === inboxId);
    if (row) row.blockId = blockId;
  }

  markInboxSeen(inboxIds: readonly string[], via: InboxSeenVia): string[] {
    const now = Date.now();
    return inboxIds.filter((id) => {
      const row = this.rows.find((r) => r.inboxId === id);
      if (row?.state !== "unseen") return false;
      row.state = "seen";
      row.seenVia = via;
      row.seenAt = now;
      return true;
    });
  }

  retractInboxMessage(inboxId: string): boolean {
    const row = this.rows.find((r) => r.inboxId === inboxId);
    if (row?.state !== "unseen") return false;
    row.state = "retracted";
    return true;
  }

  listUnseenInbox(recipientThreadId: string, limit?: number): InboxRow[] {
    const unseen = this.unseen(recipientThreadId);
    return (limit && limit > 0 ? unseen.slice(0, limit) : unseen).map((r) => ({ ...r }));
  }

  inboxHistory(recipientThreadId: string, limit: number): InboxRow[] {
    return this.rows
      .filter((r) => r.recipientThreadId === recipientThreadId && r.state === "seen")
      .reverse()
      .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
      .slice(0, Math.max(1, limit))
      .map((r) => ({ ...r }));
  }

  unseenInboxCount(recipientThreadId: string): number {
    return this.unseen(recipientThreadId).length;
  }

  /** Forget one thread's messages, or all of them — the stand-in for a
   *  thread's rows going with it. */
  clear(recipientThreadId?: string): void {
    if (recipientThreadId === undefined) {
      this.rows.length = 0;
      return;
    }
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.recipientThreadId === recipientThreadId) this.rows.splice(i, 1);
    }
  }

  /** Rows are pushed in arrival order, so insertion order is arrival order. */
  private unseen(recipientThreadId: string): InboxRow[] {
    return this.rows.filter((r) => r.recipientThreadId === recipientThreadId && r.state === "unseen");
  }

  private handing(deliveryId: string): InboxRow[] {
    return this.rows.filter((r) => r.deliveryId === deliveryId && r.state === "handing");
  }
}
