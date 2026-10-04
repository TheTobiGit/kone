// How an agent's inbox reads in the app: what each kind of message is called,
// where it stands, and which of them still wait.

import type { InboxEntry, InboxKind } from "~/types/desktop";

const KIND_LABEL = {
  note: "Note",
  question: "Question",
  pushback: "Pushback",
  answer: "Answer",
  report: "Report",
  notice: "Notice",
  job: "Job",
} satisfies Record<InboxKind, string>;

export function inboxKindLabel(kind: InboxKind): string {
  return KIND_LABEL[kind];
}

/** Where one message stands, in a few words. A waiting message says whether
 *  it will be handed over on its own or rides in with the next turn; a seen
 *  one says how it got seen, and still says it may not have arrived when kone
 *  lost track of its hand-over: reading it later does not settle that. */
export function inboxStateLabel(
  entry: Pick<InboxEntry, "state" | "rings" | "seenVia"> & Partial<Pick<InboxEntry, "uncertainAt">>,
): string {
  const seen = seenLabel(entry);
  if (entry.state === "seen" && entry.uncertainAt != null) return `${seen} · may not have arrived`;
  return seen;
}

function seenLabel(entry: Pick<InboxEntry, "state" | "rings" | "seenVia">): string {
  switch (entry.state) {
    case "unseen":
      return entry.rings ? "Waiting" : "Next turn";
    case "handing":
      return "Handing over";
    case "retracted":
      return "Taken back";
    case "uncertain":
      return "May not have arrived";
    case "seen":
      switch (entry.seenVia) {
        case "inbox":
          return "Read";
        case "wait":
          return "Answered a wait";
        default:
          return "Seen";
      }
  }
}

/** When the line's time stamp counts from: arrival while it waits, the
 *  moment it was seen once it was. */
export function inboxStampAt(entry: Pick<InboxEntry, "createdAt" | "seenAt">): number {
  return entry.seenAt ?? entry.createdAt;
}
