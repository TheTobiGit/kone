// Who is talking, on a message the user did not write.
//
// Two speakers take the agent's side of a conversation: another agent, in its
// own words, and the courier — kone's own agent, carrying words an agent did
// not carry itself. They read alike on purpose (a face, a name, a tag saying
// who they are to this thread), but the courier is never the author: it speaks
// as kone, and the agent whose work it carries rides along as `about`, which
// is also where the message points you to follow it up.

import { senderRelationshipLabel, type AgentSender, type CourierSender, type MessageKind } from "@kone/protocol/message-sender";
import { agentIdentity } from "~/utils/agentIdentity";
import { agentOrDeparted, courierAgent, type Agent } from "~/utils/agents";

/** A sender that speaks from the agent's side of a thread. */
export type SpeakingSender = AgentSender | CourierSender;

/** An agent a message is from or about, as the reader sees them. */
export interface SpeakerRef {
  name: string;
  /** Their roster entry, while the roster has them; else the face is derived
   *  from `threadId`. */
  agent: Agent | undefined;
  threadId: string;
}

export interface MessageSpeaker {
  name: string;
  /** The roster entry to draw the face from, when there is one. */
  agent: Agent | undefined;
  /** The thread a derived face is drawn from when there is no roster entry. */
  seed: string;
  /** The thread the speaker's name opens, or null when there is none to open. */
  opens: string | null;
  /** Who the speaker is to this thread: "your delegate", or for the courier
   *  whose work it carries — "your delegate Maya". */
  relation: string;
  /** What the message is for, when that changes how to read it. */
  purpose: MessageKind | null;
  /** The agent whose work the courier carries. Absent on an agent's own words. */
  about?: SpeakerRef;
}

/** An agent named on a message, read the way the roster reads them. */
function speakerRef(threadId: string, agentId: string | undefined, name: string | undefined): SpeakerRef {
  const agent = agentOrDeparted(agentId);
  return { name: agent?.name ?? name ?? agentIdentity(threadId).name, agent, threadId };
}

/** A follow-up is part of a hand-off rather than a purpose of its own; a note
 *  is the default. Neither is worth a tag. */
function purposeOf(kind: MessageKind | undefined): MessageKind | null {
  return kind === undefined || kind === "note" || kind === "followup" ? null : kind;
}

export function messageSpeaker(sender: SpeakingSender): MessageSpeaker {
  if (sender.kind === "agent") {
    const from = speakerRef(sender.threadId, sender.agentId, sender.name);
    return {
      name: from.name,
      agent: from.agent,
      seed: sender.threadId,
      opens: sender.threadId,
      relation: senderRelationshipLabel(sender.relationship),
      purpose: purposeOf(sender.messageKind),
    };
  }
  const courier = courierAgent();
  const about = sender.about
    ? speakerRef(sender.about.threadId, sender.about.agentId, sender.about.name)
    : undefined;
  const speaker: MessageSpeaker = {
    name: courier.name,
    agent: courier,
    seed: courier.id,
    opens: about?.threadId ?? null,
    relation: about && sender.about
      ? `${senderRelationshipLabel(sender.about.relationship)} ${about.name}`
      : "kone",
    purpose: purposeOf(sender.messageKind),
  };
  if (about) speaker.about = about;
  return speaker;
}

/** Whether a user-role block's sender speaks from the agent's side. */
export function isSpeakingSender(sender: { kind: string } | undefined | null): sender is SpeakingSender {
  return sender?.kind === "agent" || sender?.kind === "courier";
}
