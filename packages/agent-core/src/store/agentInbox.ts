import { randomUUID } from "node:crypto";

import { AgentSenderSchema, CourierSenderSchema, type AgentSender, type CourierSender } from "@kone/protocol/message-sender";
import { z } from "zod";
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
//
// A row either rings or is held. A ringing row is the reason for a hand-over
// of its own; a held one never is: it waits, and the next turn the recipient
// runs — whatever starts it — claims it and carries it in front.

export const INBOX_KINDS = ["note", "question", "pushback", "answer", "report", "notice", "job"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
/** `uncertain`: a hand-over went to the provider and the process died with
 *  nothing on record to say whether it took it. Never handed over again on its
 *  own; read from the inbox. */
export type InboxState = "unseen" | "handing" | "seen" | "retracted" | "uncertain";
export type InboxSeenVia = "turn" | "inbox" | "wait";
/** kone itself, writing a notice of its own. */
export type SystemSender = { kind: "system" };
export type InboxSender = AgentSender | CourierSender | SystemSender;
/** Which unseen rows a hand-over takes: the ones that ring, handed over on
 *  their own; the held ones, which ride in front of the recipient's next turn
 *  whatever starts it; all of them; only the urgent ones, for a running turn;
 *  every message but the jobs, which ride in front of a turn; or the jobs,
 *  each a turn of its own — `urgent-` narrowing either to what is urgent. */
export type InboxRing =
  | "ringing"
  | "held"
  | "all"
  | "urgent"
  | "messages"
  | "urgent-messages"
  | "job"
  | "urgent-job";

export interface InboxRow {
  inboxId: string;
  recipientThreadId: string;
  /** Null for kone's own messages (the courier, notices). */
  senderThreadId: string | null;
  /** Null when nobody could say who sent it. */
  sender: InboxSender | null;
  kind: InboxKind;
  urgent: boolean;
  /** False for a held row, which waits for the recipient's next turn. */
  rings: boolean;
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
  /** When the hand-over carrying it went to the provider. Set only while it
   *  is being handed over: a crash after this may have delivered it. */
  sentAt: number | null;
  /** When a restart left it uncertain: handed to the provider with nothing
   *  on record to say whether it arrived. Stays once the row is read. */
  uncertainAt: number | null;
}

export interface InboxInsert {
  inboxId: string;
  recipientThreadId: string;
  senderThreadId: string | null;
  sender: InboxSender | null;
  kind: InboxKind;
  urgent?: boolean;
  /** Default true. False holds it for the recipient's next turn. */
  rings?: boolean;
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
  /** Take up to `limit` unseen messages of one sort for one hand-over,
   *  answers first and then oldest; null when there are none. */
  claimInbox(recipientThreadId: string, limit: number, which: InboxRing): InboxClaim | null;
  /** The provider took the turn: the batch is seen, carried by `turnId`.
   *  Returns how many rows it settled — 0 when the delivery has none left —
   *  or null when the store could not write it. */
  settleInboxDelivery(deliveryId: string, turnId: string | null): number | null;
  /** The send failed: the batch is unseen again, block ids kept. Returns how
   *  many rows it released, or null when the store could not write it. */
  releaseInboxDelivery(deliveryId: string): number | null;
  /** The batch is going to the provider now: from here a crash leaves it
   *  uncertain rather than unsent. False when the store could not write it. */
  markInboxSending(deliveryId: string): boolean;
  setInboxBlockId(inboxId: string, blockId: string): void;
  /** Mark these unseen messages seen, and return the ids that actually were
   *  unseen — a message already claimed or seen is left as it is. A read of
   *  the inbox (`via` "inbox") takes an uncertain one too. */
  markInboxSeen(inboxIds: readonly string[], via: InboxSeenVia): string[];
  /** Messages a dead process left uncertain, oldest first. */
  listUncertainInbox(recipientThreadId: string): InboxRow[];
  /** The provider took the turn carrying this hand-over: link each message's
   *  transcript block to that turn — the record recovery settles it by, written
   *  apart from the settle so that a settle the store loses can still be.
   *  False when the store could not write it. */
  linkInboxDelivery(deliveryId: string, turnId: string): boolean;
  /** Take back an unseen message. False once it was claimed or seen. */
  retractInboxMessage(inboxId: string): boolean;
  listUnseenInbox(recipientThreadId: string, limit?: number): InboxRow[];
  /** Seen messages, newest first. */
  inboxHistory(recipientThreadId: string, limit: number): InboxRow[];
  /** Unseen messages, of one sort or (without `which`) all of them. */
  unseenInboxCount(recipientThreadId: string, which?: InboxRing): number;
  /** One message, whatever its state; null when there is none. */
  inboxMessage(inboxId: string): InboxRow | null;
}

const INBOX_COLUMNS = `inbox_id, recipient_thread_id, sender_thread_id, sender_json, kind,
                       urgent, rings, reply_to, body, state, delivery_id, block_id, turn_id,
                       seen_via, dedupe_key, project_path, created_at, seen_at, sent_at, uncertain_at`;

/** Arrival order. rowid settles two messages written in the same millisecond,
 *  which a broadcast does routinely. */
const INBOX_ORDER = `created_at ASC, rowid ASC`;

/** Hand-over order: answers first, since their askers may be parked on them,
 *  then arrival. */
const HANDOVER_ORDER = `(kind = 'answer') DESC, ${INBOX_ORDER}`;

/** The SQL filter for one selection. */
function selectClause(which: InboxRing | undefined): string {
  switch (which) {
    case "ringing":
      return " AND rings = 1";
    case "held":
      return " AND rings = 0";
    case "urgent":
      return " AND urgent = 1";
    case "messages":
      return " AND kind <> 'job'";
    case "urgent-messages":
      return " AND urgent = 1 AND kind <> 'job'";
    case "job":
      return " AND kind = 'job'";
    case "urgent-job":
      return " AND urgent = 1 AND kind = 'job'";
    default:
      return "";
  }
}

/** The same filter, for rows in memory. */
function selects(row: InboxRow, which: InboxRing | undefined): boolean {
  switch (which) {
    case "ringing":
      return row.rings;
    case "held":
      return !row.rings;
    case "urgent":
      return row.urgent;
    case "messages":
      return row.kind !== "job";
    case "urgent-messages":
      return row.urgent && row.kind !== "job";
    case "job":
      return row.kind === "job";
    case "urgent-job":
      return row.urgent && row.kind === "job";
    default:
      return true;
  }
}

/** A type alias, not an interface: only an alias carries the implicit index
 *  signature a driver's row record converts to. */
type InboxDbRow = {
  inbox_id: string;
  recipient_thread_id: string;
  sender_thread_id: string | null;
  sender_json: string;
  kind: InboxKind;
  urgent: number;
  rings: number;
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
  sent_at: number | null;
  uncertain_at: number | null;
  /** Present on RETURNING rows, which come back in no promised order. */
  row_seq?: number;
};

const SystemSenderSchema = z.object({ kind: z.literal("system") });

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
  if (courier.success) return courier.data;
  return SystemSenderSchema.safeParse(value).success ? { kind: "system" } : null;
}

function rowToInbox(row: InboxDbRow): InboxRow {
  return {
    inboxId: row.inbox_id,
    recipientThreadId: row.recipient_thread_id,
    senderThreadId: row.sender_thread_id,
    sender: parseInboxSender(row.sender_json),
    kind: row.kind,
    urgent: row.urgent !== 0,
    rings: row.rings !== 0,
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
    sentAt: row.sent_at,
    uncertainAt: row.uncertain_at,
  };
}

/** Settle what a dead process was handing over. Safe only at the first open
 *  of a fresh process, when no hand-over is live.
 *
 *  A row never marked sent never reached a provider: it goes back to unseen,
 *  keeping its block, and is handed over again. A row marked sent may have
 *  been delivered, so it is never simply resent. It is seen with a turn only
 *  on an explicit record that the turn took it — its block linked to that
 *  turn when the provider accepted it, or steered into it — never on when
 *  some turn happened to start. Anything else is uncertain: delivery skips
 *  it, its recipient and its sender are each told once, and the recipient's
 *  inbox read shows it. One transaction, so a crash part-way leaves the rows
 *  handing for the next open, and the notices' dedupe keys keep a rerun from
 *  telling anyone twice. */
export function releaseOrphanedInboxClaims(db: DatabaseSync): void {
  try {
    db.exec("BEGIN");
    try {
      reconcileOrphanedInboxClaims(db, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.error("[conversation-store] could not release orphaned inbox claims:", err);
  }
}

/** A row a dead process left uncertain, with what its notices are made of. */
type UncertainRow = {
  inbox_id: string;
  recipient_thread_id: string;
  sender_thread_id: string | null;
  sender_json: string;
  kind: InboxKind;
  project_path: string;
  recipient_title: string | null;
};

function reconcileOrphanedInboxClaims(db: DatabaseSync, now: number): void {
  db.prepare(
    `UPDATE agent_inbox SET state = 'unseen', delivery_id = NULL
      WHERE state = 'handing' AND sent_at IS NULL`,
  ).run();
  const linked = `(SELECT b.turn_id FROM blocks b
                    WHERE b.block_id = agent_inbox.block_id AND b.role = 'user' AND b.turn_id IS NOT NULL)`;
  db.prepare(
    `UPDATE agent_inbox
        SET state = 'seen', seen_via = 'turn', seen_at = ?, delivery_id = NULL, turn_id = ${linked}
      WHERE state = 'handing' AND ${linked} IS NOT NULL`,
  ).run(now);
  // SAFETY: RETURNING names exactly UncertainRow's columns.
  const uncertain = db
    .prepare(
      `UPDATE agent_inbox SET state = 'uncertain', uncertain_at = ?, delivery_id = NULL
        WHERE state = 'handing'
        RETURNING inbox_id, recipient_thread_id, sender_thread_id, sender_json, kind, project_path,
                  (SELECT title FROM threads WHERE thread_id = agent_inbox.recipient_thread_id) AS recipient_title`,
    )
    .all(now) as UncertainRow[];
  if (uncertain.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO agent_inbox (inbox_id, recipient_thread_id, sender_thread_id, sender_json, kind, urgent, rings,
                              body, state, dedupe_key, project_path, created_at)
     VALUES (?, ?, NULL, '{"kind":"system"}', 'notice', 0, 0, ?, 'unseen', ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
  );
  const exists = db.prepare(`SELECT 1 FROM threads WHERE thread_id = ?`);
  const tell = (to: string, body: string, key: string, projectPath: string): void => {
    if (!exists.get(to)) return;
    insert.run(`msg_${randomUUID()}`, to, body, key, projectPath, now);
  };
  for (const [recipient, rows] of groupBy(uncertain, (r) => r.recipient_thread_id)) {
    tell(recipient, uncertainRecipientNotice(rows), uncertainKey("recipient", recipient, rows), rows[0]!.project_path);
  }
  const fromAgents = uncertain.filter((r) => r.sender_thread_id !== null);
  for (const [sender, rows] of groupBy(fromAgents, (r) => r.sender_thread_id!)) {
    tell(sender, uncertainSenderNotice(rows), uncertainKey("sender", sender, rows), rows[0]!.project_path);
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

/** One key per reader and set of rows: a row turns uncertain once, so a later
 *  open never makes the same notice again, and a rerun of this one finds its
 *  own. */
function uncertainKey(reader: "recipient" | "sender", threadId: string, rows: readonly UncertainRow[]): string {
  const ids = rows.map((r) => r.inbox_id).sort().join(",");
  return `uncertain:${reader}:${threadId}:${ids}`;
}

/** Who a message was from, by name, for a notice that carries no bodies. */
function senderName(senderJson: string): string {
  const sender = parseInboxSender(senderJson);
  return (sender?.kind === "agent" ? sender.name : undefined) ?? "kone";
}

/** What the recipient is told: which messages, from whom, and where they
 *  are — never what they said, which may already be in its context. */
function uncertainRecipientNotice(rows: readonly UncertainRow[]): string {
  const one = rows.length === 1;
  const list = rows.map((r) => `${r.kind} ${r.inbox_id} from ${senderName(r.sender_json)}`).join("; ");
  return (
    `kone restarted while handing you ${one ? "a message" : `${rows.length} messages`} (${list}). ` +
    `${one ? "It" : "They"} may already be in your context, or may never have reached you. ` +
    `agent_inbox lists ${one ? "it" : "them"}, marked uncertain; reading ${one ? "it" : "them"} there marks ${one ? "it" : "them"} seen.`
  );
}

/** What the sender is told: what may not have arrived, and how to send it
 *  again — a job by a fresh agent_followup, since its old requestId would
 *  only replay the job that may be lost. */
function uncertainSenderNotice(rows: readonly UncertainRow[]): string {
  const lines = rows.map((r) => {
    const to = r.recipient_title?.trim() || r.recipient_thread_id;
    const again =
      r.kind === "job"
        ? "If it still matters, send agent_followup again with a new requestId."
        : "If it still matters, send it again.";
    return `Your ${r.kind} ${r.inbox_id} to "${to}" may not have arrived: kone restarted while handing it over. ${again}`;
  });
  return lines.join("\n");
}

/** Told which recipients' inboxes just moved: a row written, claimed,
 *  settled, released, marked seen or retracted. */
export type InboxChangeListener = (recipientThreadIds: readonly string[]) => void;

export class AgentInboxRepo implements AgentInboxStore {
  private readonly listeners = new Set<InboxChangeListener>();

  constructor(private readonly dbh: ConversationDb) {}

  /** Hear about every change to anyone's inbox. Returns the unsubscribe. */
  onChanged(listener: InboxChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** After the write, never inside it: a listener that throws or reads the
   *  inbox back must not touch the statement that changed it. */
  private changed(recipientThreadIds: readonly string[]): void {
    if (recipientThreadIds.length === 0 || this.listeners.size === 0) return;
    const unique = [...new Set(recipientThreadIds)];
    for (const listener of this.listeners) {
      try {
        listener(unique);
      } catch (err) {
        console.error("[conversation-store] inbox change listener failed:", err);
      }
    }
  }

  insertInboxMessage(input: InboxInsert): InboxInsertResult {
    const db = this.dbh.handle();
    if (!db) return "failed";
    let result: InboxInsertResult = "failed";
    let inserted = false;
    try {
      this.dbh.durably(db, () => {
        const run = db
          .prepare(
            `INSERT INTO agent_inbox (inbox_id, recipient_thread_id, sender_thread_id, sender_json,
                                      kind, urgent, rings, reply_to, body, state, dedupe_key,
                                      project_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unseen', ?, ?, ?)
             ON CONFLICT (dedupe_key) DO NOTHING`,
          )
          .run(
            input.inboxId,
            input.recipientThreadId,
            input.senderThreadId,
            JSON.stringify(input.sender),
            input.kind,
            input.urgent ? 1 : 0,
            input.rings === false ? 0 : 1,
            input.replyTo ?? null,
            input.body,
            input.dedupeKey ?? null,
            input.projectPath,
            input.createdAt ?? Date.now(),
          );
        inserted = Number(run.changes) > 0;
        result = inserted ? "inserted" : "duplicate";
      });
    } catch (err) {
      console.error("[conversation-store] insertInboxMessage failed:", err);
      return "failed";
    }
    if (inserted) this.changed([input.recipientThreadId]);
    return result;
  }

  claimInbox(recipientThreadId: string, limit: number, which: InboxRing): InboxClaim | null {
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
               WHERE recipient_thread_id = ? AND state = 'unseen'${selectClause(which)}
               ORDER BY ${HANDOVER_ORDER}
               LIMIT ?)
            RETURNING ${INBOX_COLUMNS}, rowid AS row_seq`,
        )
        .all(deliveryId, recipientThreadId, Math.max(1, limit)) as InboxDbRow[];
      if (rows.length === 0) return null;
      rows.sort(
        (a, b) =>
          Number(b.kind === "answer") - Number(a.kind === "answer") ||
          a.created_at - b.created_at ||
          (a.row_seq ?? 0) - (b.row_seq ?? 0),
      );
      this.changed(rows.map((r) => r.recipient_thread_id));
      return { deliveryId, rows: rows.map(rowToInbox) };
    } catch (err) {
      console.error("[conversation-store] claimInbox failed:", err);
      return null;
    }
  }

  settleInboxDelivery(deliveryId: string, turnId: string | null): number | null {
    const db = this.dbh.handle();
    if (!db) return null;
    let settled: string[] = [];
    try {
      this.dbh.durably(db, () => {
        // SAFETY: RETURNING one TEXT column.
        const rows = db
          .prepare(
            `UPDATE agent_inbox SET state = 'seen', seen_via = 'turn', turn_id = ?, seen_at = ?
              WHERE delivery_id = ? AND state = 'handing'
              RETURNING recipient_thread_id`,
          )
          .all(turnId, Date.now(), deliveryId) as Array<{ recipient_thread_id: string }>;
        settled = rows.map((r) => r.recipient_thread_id);
      });
    } catch (err) {
      console.error("[conversation-store] settleInboxDelivery failed:", err);
      return null;
    }
    this.changed(settled);
    return settled.length;
  }

  releaseInboxDelivery(deliveryId: string): number | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: RETURNING one TEXT column.
      const rows = db
        .prepare(
          `UPDATE agent_inbox SET state = 'unseen', delivery_id = NULL, sent_at = NULL
            WHERE delivery_id = ? AND state = 'handing'
            RETURNING recipient_thread_id`,
        )
        .all(deliveryId) as Array<{ recipient_thread_id: string }>;
      this.changed(rows.map((r) => r.recipient_thread_id));
      return rows.length;
    } catch (err) {
      console.error("[conversation-store] releaseInboxDelivery failed:", err);
      return null;
    }
  }

  markInboxSending(deliveryId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      this.dbh.durably(db, () => {
        db.prepare(`UPDATE agent_inbox SET sent_at = ? WHERE delivery_id = ? AND state = 'handing'`).run(
          Date.now(),
          deliveryId,
        );
      });
      return true;
    } catch (err) {
      console.error("[conversation-store] markInboxSending failed:", err);
      return false;
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
      // SAFETY: RETURNING two TEXT columns.
      const rows = db
        .prepare(
          `UPDATE agent_inbox SET state = 'seen', seen_via = ?, seen_at = ?
            WHERE inbox_id IN (${placeholders})
              AND (state = 'unseen' OR (state = 'uncertain' AND ? = 'inbox'))
            RETURNING inbox_id, recipient_thread_id`,
        )
        .all(via, Date.now(), ...inboxIds, via) as Array<{ inbox_id: string; recipient_thread_id: string }>;
      this.changed(rows.map((r) => r.recipient_thread_id));
      const flipped = new Set(rows.map((r) => r.inbox_id));
      return inboxIds.filter((id) => flipped.has(id));
    } catch (err) {
      console.error("[conversation-store] markInboxSeen failed:", err);
      return [];
    }
  }

  listUncertainInbox(recipientThreadId: string): InboxRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list InboxDbRow is declared from.
      const rows = db
        .prepare(
          `SELECT ${INBOX_COLUMNS} FROM agent_inbox
            WHERE recipient_thread_id = ? AND state = 'uncertain'
            ORDER BY ${INBOX_ORDER}`,
        )
        .all(recipientThreadId) as InboxDbRow[];
      return rows.map(rowToInbox);
    } catch (err) {
      console.error("[conversation-store] listUncertainInbox failed:", err);
      return [];
    }
  }

  linkInboxDelivery(deliveryId: string, turnId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `UPDATE blocks SET turn_id = ?
            WHERE role = 'user' AND turn_id IS NULL
              AND block_id IN (SELECT block_id FROM agent_inbox
                                WHERE delivery_id = ? AND state = 'handing' AND block_id IS NOT NULL)`,
        ).run(turnId, deliveryId);
      });
      return true;
    } catch (err) {
      console.error("[conversation-store] linkInboxDelivery failed:", err);
      return false;
    }
  }

  retractInboxMessage(inboxId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      // SAFETY: RETURNING one TEXT column.
      const rows = db
        .prepare(
          `UPDATE agent_inbox SET state = 'retracted' WHERE inbox_id = ? AND state = 'unseen'
            RETURNING recipient_thread_id`,
        )
        .all(inboxId) as Array<{ recipient_thread_id: string }>;
      this.changed(rows.map((r) => r.recipient_thread_id));
      return rows.length > 0;
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

  /** What still waits for a thread: unseen, being handed over right now, and
   *  uncertain, oldest first. */
  listWaitingInbox(recipientThreadId: string): InboxRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list InboxDbRow is declared from.
      const rows = db
        .prepare(
          `SELECT ${INBOX_COLUMNS} FROM agent_inbox
            WHERE recipient_thread_id = ? AND state IN ('unseen', 'handing', 'uncertain')
            ORDER BY ${INBOX_ORDER}`,
        )
        .all(recipientThreadId) as InboxDbRow[];
      return rows.map(rowToInbox);
    } catch (err) {
      console.error("[conversation-store] listWaitingInbox failed:", err);
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

  unseenInboxCount(recipientThreadId: string, which?: InboxRing): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      // SAFETY: an aggregate COUNT answers one row with one integer column.
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_inbox WHERE recipient_thread_id = ? AND state = 'unseen'${selectClause(which)}`,
        )
        .get(recipientThreadId) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      console.error("[conversation-store] unseenInboxCount failed:", err);
      return 0;
    }
  }

  inboxMessage(inboxId: string): InboxRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection is the column list InboxDbRow is declared from.
      const row = db.prepare(`SELECT ${INBOX_COLUMNS} FROM agent_inbox WHERE inbox_id = ?`).get(inboxId) as
        | InboxDbRow
        | undefined;
      return row ? rowToInbox(row) : null;
    } catch (err) {
      console.error("[conversation-store] inboxMessage failed:", err);
      return null;
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
      rings: input.rings !== false,
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
      sentAt: null,
      uncertainAt: null,
    });
    return "inserted";
  }

  claimInbox(recipientThreadId: string, limit: number, which: InboxRing): InboxClaim | null {
    const unseen = this.unseen(recipientThreadId, which);
    const batch = [...unseen.filter((r) => r.kind === "answer"), ...unseen.filter((r) => r.kind !== "answer")].slice(
      0,
      Math.max(1, limit),
    );
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
      row.sentAt = null;
      return row;
    }).length;
  }

  markInboxSending(deliveryId: string): boolean {
    const now = Date.now();
    for (const row of this.handing(deliveryId)) row.sentAt = now;
    return true;
  }

  setInboxBlockId(inboxId: string, blockId: string): void {
    const row = this.rows.find((r) => r.inboxId === inboxId);
    if (row) row.blockId = blockId;
  }

  markInboxSeen(inboxIds: readonly string[], via: InboxSeenVia): string[] {
    const now = Date.now();
    return inboxIds.filter((id) => {
      const row = this.rows.find((r) => r.inboxId === id);
      if (!row || !(row.state === "unseen" || (row.state === "uncertain" && via === "inbox"))) return false;
      row.state = "seen";
      row.seenVia = via;
      row.seenAt = now;
      return true;
    });
  }

  listUncertainInbox(recipientThreadId: string): InboxRow[] {
    return this.rows
      .filter((r) => r.recipientThreadId === recipientThreadId && r.state === "uncertain")
      .map((r) => ({ ...r }));
  }

  /** No transcript here to link: a process with no store has nothing to
   *  recover after it. */
  linkInboxDelivery(): boolean {
    return true;
  }

  /** Leave what a dead process was handing over as the store's boot would:
   *  never sent goes back to unseen, sent turns uncertain. For tests. */
  recoverAsAfterRestart(): void {
    for (const row of this.rows) {
      if (row.state !== "handing") continue;
      row.state = row.sentAt === null ? "unseen" : "uncertain";
      if (row.state === "uncertain") row.uncertainAt = Date.now();
      row.deliveryId = null;
    }
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

  unseenInboxCount(recipientThreadId: string, which?: InboxRing): number {
    return this.unseen(recipientThreadId, which).length;
  }

  inboxMessage(inboxId: string): InboxRow | null {
    const row = this.rows.find((r) => r.inboxId === inboxId);
    return row ? { ...row } : null;
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
  private unseen(recipientThreadId: string, which?: InboxRing): InboxRow[] {
    return this.rows.filter(
      (r) =>
        r.recipientThreadId === recipientThreadId &&
        r.state === "unseen" &&
        selects(r, which),
    );
  }

  private handing(deliveryId: string): InboxRow[] {
    return this.rows.filter((r) => r.deliveryId === deliveryId && r.state === "handing");
  }
}
