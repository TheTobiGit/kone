// Who said a message, written and read in one place.
//
// Under the hood every turn a provider session receives looks like the user
// typing. It isn't: a delegate's brief was written by the agent that delegated
// it, a follow-up by the agent that asked, a wake report by kone itself. The
// transcript keeps that difference as a sender on the block, the prompt says it
// out loud in a header, and the renderer puts the message on the right side of
// the conversation. Both halves read this module, so a new relationship lands
// on both at once.
//
// Absent means the user. Every block written before senders existed was typed
// by a person, and that stays the default so nothing old changes meaning.

import { z } from "zod";

/** How the sending agent relates to the thread that RECEIVES the message —
 *  always from the receiver's side, because that is whose conduct it shapes.
 *
 *  - `delegator`: handed this thread's agent its work (a teammate delegation).
 *  - `contracting`: contracted this thread's agent for a job.
 *  - `parent`: started this thread as a worker.
 *  - `upstream`: further up the chain than whoever handed this thread its
 *    work — the delegator's delegator, say — reaching down to it directly.
 *  - `delegate` / `contractor` / `child`: the reverse edges, for a message
 *    coming back up.
 *  - `peer`: an agent on the project with no hand-off between them. */
export const SENDER_RELATIONSHIPS = [
  "delegator",
  "contracting",
  "parent",
  "upstream",
  "delegate",
  "contractor",
  "child",
  "peer",
] as const;

export type SenderRelationship = (typeof SENDER_RELATIONSHIPS)[number];

/** What an agent-sent message is for. `brief` opens a hand-off, `followup` is a
 *  further tracked turn on one; the rest are agent_message kinds. */
export const MESSAGE_KINDS = [
  "brief",
  "followup",
  "note",
  "question",
  "pushback",
  "report",
  "answer",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const AgentSenderSchema = z.object({
  kind: z.literal("agent"),
  /** The sending agent's thread. */
  threadId: z.string().min(1),
  /** The name it answered under when it sent this — a snapshot for the prompt
   *  and for a sender whose thread is gone. The renderer prefers the live
   *  roster name via `agentId`. */
  name: z.string().min(1).optional(),
  /** Its roster id, when it runs as a saved agent. */
  agentId: z.string().min(1).optional(),
  relationship: z.enum(SENDER_RELATIONSHIPS),
  messageKind: z.enum(MESSAGE_KINDS).optional(),
});

const MessageSenderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  AgentSenderSchema,
  z.object({ kind: z.literal("system") }),
]);

export type AgentSender = z.infer<typeof AgentSenderSchema>;
export type MessageSender = z.infer<typeof MessageSenderSchema>;

/** The sender a stored block holds, or undefined for the user. A malformed or
 *  unknown value reads as the user too: showing a message on the user's side
 *  is the old behaviour, never a new wrong claim about who spoke. */
export function parseMessageSender(json: string | null | undefined): MessageSender | undefined {
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = MessageSenderSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind === "user") return undefined;
  return parsed.data;
}

/** The column value for a sender. The user is stored as NULL, so an ordinary
 *  prompt writes exactly what it always did. */
export function encodeMessageSender(sender: MessageSender | undefined): string | null {
  if (!sender || sender.kind === "user") return null;
  return JSON.stringify(sender);
}

/** How a relationship reads as a short label, from the receiver's side:
 *  "your delegator", "your worker". */
export function senderRelationshipLabel(relationship: SenderRelationship): string {
  switch (relationship) {
    case "delegator":
      return "your delegator";
    case "contracting":
      return "contracted you";
    case "parent":
      return "started you";
    case "upstream":
      return "up your chain";
    case "delegate":
      return "your delegate";
    case "contractor":
      return "your contractor";
    case "child":
      return "your worker";
    case "peer":
      return "teammate";
  }
}
