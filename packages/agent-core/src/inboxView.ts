import type { InboxKind, InboxRow, InboxSeenVia, InboxSender, InboxState } from "./store/agentInbox.js";

// The inbox as the app shows it: one agent's messages, without the hand-over
// bookkeeping (delivery ids, dedupe keys, blocks) that only delivery reads.

/** How long a quoted question gets before it is cut. Enough to recognise it
 *  in one line; the question itself is in the asker's own inbox. */
const QUOTE_MAX = 160;

/** The message an answer replies to, quoted. */
export interface InboxQuote {
  inboxId: string;
  kind: InboxKind;
  sender: InboxSender | null;
  excerpt: string;
}

export interface InboxEntry {
  inboxId: string;
  kind: InboxKind;
  urgent: boolean;
  /** False for a message held for the recipient's next turn. */
  rings: boolean;
  state: InboxState;
  /** Set while the message is uncertain: kone was handing it over when it
   *  restarted, so it may not have arrived. */
  uncertain?: true;
  sender: InboxSender | null;
  body: string;
  replyTo: string | null;
  /** What `replyTo` names, when that message is still stored. */
  answers: InboxQuote | null;
  createdAt: number;
  seenAt: number | null;
  seenVia: InboxSeenVia | null;
  turnId: string | null;
}

/** The store reads the views need. */
export interface InboxViewSource {
  listWaitingInbox(recipientThreadId: string): InboxRow[];
  inboxHistory(recipientThreadId: string, limit: number): InboxRow[];
  inboxMessage(inboxId: string): InboxRow | null;
}

/** The default and the ceiling for one history read. */
export const INBOX_HISTORY_DEFAULT = 20;
const INBOX_HISTORY_MAX = 200;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1).trimEnd()}…` : flat;
}

export function inboxEntryOf(row: InboxRow, lookup: (inboxId: string) => InboxRow | null): InboxEntry {
  const quoted = row.replyTo ? lookup(row.replyTo) : null;
  const entry: InboxEntry = {
    inboxId: row.inboxId,
    kind: row.kind,
    urgent: row.urgent,
    rings: row.rings,
    state: row.state,
    sender: row.sender,
    body: row.body,
    replyTo: row.replyTo,
    answers: quoted
      ? { inboxId: quoted.inboxId, kind: quoted.kind, sender: quoted.sender, excerpt: excerpt(quoted.body) }
      : null,
    createdAt: row.createdAt,
    seenAt: row.seenAt,
    seenVia: row.seenVia,
    turnId: row.turnId,
  };
  if (row.state === "uncertain") entry.uncertain = true;
  return entry;
}

/** What waits for a thread, oldest first: unseen, being handed over, and
 *  uncertain — a message nobody can say arrived still waits on someone. */
export function waitingInbox(source: InboxViewSource, threadId: string): InboxEntry[] {
  const lookup = (id: string) => source.inboxMessage(id);
  return source.listWaitingInbox(threadId).map((row) => inboxEntryOf(row, lookup));
}

/** What a thread has seen, newest first. A limit that is not a positive
 *  whole number reads as the default. */
export function inboxHistoryView(source: InboxViewSource, threadId: string, limit?: number): InboxEntry[] {
  const n =
    limit !== undefined && Number.isInteger(limit) && limit > 0
      ? Math.min(limit, INBOX_HISTORY_MAX)
      : INBOX_HISTORY_DEFAULT;
  const lookup = (id: string) => source.inboxMessage(id);
  return source.inboxHistory(threadId, n).map((row) => inboxEntryOf(row, lookup));
}
