import type { IrcMailbox, IrcMessageRecord } from "./gateway/tools/irc.js";
import { senderRelationshipLabel } from "@kone/protocol/message-sender";
import type { ThreadDispatcher } from "./dispatch.js";
import type { SendTurnInput } from "./types.js";
import { renderCourierMessage, renderKoneNotice } from "./senderHeader.js";

// Delivery: the half that turns a mailbox into messaging.
//
// The tools could always put a message in a thread's inbox. Nothing ever took
// it out. A recipient learned it had mail only if its agent happened to call
// the inbox tool on a turn it was already running — so in practice every inbox
// read came back empty, and an agent that reached for one found nothing and
// concluded messaging did not work.
//
// A thread is not a person idling in a channel. It is either mid-turn or it is
// nothing, so "delivery" here means one of exactly two things:
//
//   · mid-turn  → steer the running turn, so the message lands in the work
//                 already happening rather than queueing behind it;
//   · idle      → wake it with a turn of its own.
//
// Either way the batch is claimed from the inbox before it goes and settled
// once the provider takes the turn, so the agent reads it once and the inbox
// tool stays what it is: a way to catch up on what arrived while nobody could
// reach you.
//
// Both are silent turns. Nobody said them, so no user block is journaled — the
// transcript shows an agent being interrupted by a peer, which is what happened.

/** How long a delivery waits for more messages to the same recipient.
 *
 *  A wake costs the recipient a full turn, so two messages arriving together
 *  should cost one turn, not two. Short enough that a lone message is not left
 *  sitting; long enough to catch a burst from one sender, or a broadcast
 *  fanning out across a fleet. */
export const IRC_DELIVERY_DEBOUNCE_MS = 400;

/** How many messages ride one delivery. Past this the rest wait for the next
 *  round — a wake carrying forty messages is not a wake, it is a context
 *  dump. */
export const IRC_DELIVERY_BATCH_MAX = 8;

/** How long a released batch waits before it is tried again, by attempt.
 *
 *  A send that throws — a session reaped under it, a provider refusing the
 *  steer — may be over in a second or may not be over at all, and nothing else
 *  is coming to try again: the senders' events have fired. So each failure
 *  arms its own retry, a little later each time, and after the last one the
 *  batch waits in the inbox for the next message or the thread coming back. */
export const IRC_DELIVERY_RETRY_MS: readonly number[] = [1_000, 5_000, 15_000, 60_000];

/** The two turn entry points delivery needs. Narrower than the whole dispatcher
 *  on purpose: everything else it owns — thread lifecycle, titles, repo stats —
 *  is nothing a delivered message may reach. */
export type IrcTurnDispatcher = Pick<ThreadDispatcher, "sendThreadTurn" | "steerThreadTurn">;

/** Arm a callback, and hand back the way to call it off. Injectable so tests
 *  fire the debounce deliberately instead of sleeping on real time. */
export type ScheduleDelivery = (fn: () => void, ms: number) => () => void;

export interface IrcDeliveryDeps {
  mailbox: IrcMailbox;
  dispatcher: IrcTurnDispatcher;
  /** Does this thread have a live provider session? Only a live thread can be
   *  woken; anything else keeps its mail until it comes back. */
  isLive: (threadId: string) => boolean;
  /** Is it mid-turn right now? Decides steer versus wake. */
  isBusy: (threadId: string) => boolean;
  /** A thread just came back — subscribe, and hand back the unsubscribe.
   *
   *  Delivery is otherwise driven only by a message being sent, so mail that
   *  arrived for a thread while it was away is mail nothing ever runs for again:
   *  the sender's event has already fired and passed. This is the other edge
   *  that has to arm a delivery. Optional so a caller with no session lifecycle
   *  to hand over (tests) is not made to invent one. */
  onThreadLive?: (listener: (threadId: string) => void) => () => void;
  /** Put one message on the recipient's transcript as its sender's words, so
   *  the thread shows who said what rather than a turn nobody started, and
   *  hand back the block it was written as (null when nothing was written).
   *  The model still reads the batch as one delivery. Optional: without it
   *  messages reach the agent and leave no mark, as before senders existed. */
  journal?: (threadId: string, message: IrcMessageRecord) => string | null;
  schedule?: ScheduleDelivery;
}

/**
 * Start delivering IRC messages to their recipients.
 *
 * Returns the teardown: it unsubscribes from the bus and drops every armed
 * delivery, so a stopped app leaves no timer holding the process open.
 */
export function startIrcDelivery(deps: IrcDeliveryDeps): () => void {
  const schedule: ScheduleDelivery =
    deps.schedule ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const armed = new Map<string, () => void>();
  /** Failed sends in a row, per thread; cleared by the next one that lands. */
  const failures = new Map<string, number>();

  function arm(threadId: string, ms = IRC_DELIVERY_DEBOUNCE_MS): void {
    armed.get(threadId)?.();
    armed.set(threadId, schedule(() => deliver(threadId), ms));
  }

  /** Arm the retry for a batch that was just released, or give up for now. */
  function retry(threadId: string): void {
    const attempt = failures.get(threadId) ?? 0;
    const ms = IRC_DELIVERY_RETRY_MS[attempt];
    if (ms === undefined) {
      failures.delete(threadId);
      return;
    }
    failures.set(threadId, attempt + 1);
    // A message arriving meanwhile re-arms on the short debounce, which is
    // fine: it is one more attempt, and the count carries over.
    if (!armed.has(threadId)) arm(threadId, ms);
  }

  function deliver(threadId: string): void {
    armed.delete(threadId);
    // Not live: the thread was closed or its session reaped between the send
    // and this firing. The messages stay unread in the inbox, which is exactly
    // where a thread that comes back later should find them — and coming back
    // is what re-arms this.
    if (!deps.isLive(threadId)) return;
    // Claimed, not drained. The claim takes the batch away from every other
    // hand-over, inbox read and waiting sender, but only settles once the turn
    // is accepted: a send that throws — a reaped session, a provider that
    // refused the steer — releases it to unseen, where the next delivery finds
    // it. A crash in between leaves it claimed, and the store's first open puts
    // it back.
    const claim = deps.mailbox.claimDelivery(threadId, IRC_DELIVERY_BATCH_MAX);
    if (!claim) return;
    const { deliveryId, messages } = claim;
    // Only what rings is left over: held messages ride in front of the turn
    // this sends, so they are not waiting on another round.
    const remaining = deps.mailbox.ringingCount(threadId);

    // Journaled before the turn goes out, so the messages sit above the reply
    // they prompt. Once each: the block is stored with the message the moment
    // it is written, so a delivery retried after a failed send — or after a
    // restart — finds it already on the transcript and names the same block.
    for (const message of messages) {
      if (message.blockId || !message.sender || !deps.journal) continue;
      const blockId = deps.journal(threadId, message);
      if (!blockId) continue;
      message.blockId = blockId;
      deps.mailbox.setBlockId(message.id, blockId);
    }

    // The turn names the blocks it carries. A steer lands mid-reply, and only
    // the blocks it names move to where it landed: unnamed, they stay at the
    // tail, under everything the agent goes on to write in answer to them.
    const blockIds = messages.flatMap((m) => (m.blockId ? [m.blockId] : []));
    const input: SendTurnInput = { threadId, input: renderIncoming(messages, remaining) };
    if (blockIds.length > 0) input.userBlockId = blockIds[blockIds.length - 1];
    if (blockIds.length > 1) input.userBlockIds = blockIds;
    // A running turn is steered rather than interrupted: the agent is working,
    // and a peer's message is context for that work, not a new assignment. An
    // idle one has no turn to steer, so it gets one.
    // Delivered the moment the provider takes the turn — before the
    // checkpoint after it, so a crash there cannot hand the batch over again.
    // Settle exactly what was claimed, so a message that arrived while the
    // turn was starting is still unseen and still gets its own delivery.
    let settled = false;
    const settle = (turnId: string): void => {
      settled = true;
      failures.delete(threadId);
      deps.mailbox.settleDelivery(deliveryId, turnId);
    };
    void (async () => {
      try {
        const options = {
          silent: true,
          onAccepted: settle,
          onSending: () => deps.mailbox.sendingDelivery(deliveryId),
        };
        const result = await (deps.isBusy(threadId)
          ? deps.dispatcher.steerThreadTurn(input, options)
          : deps.dispatcher.sendThreadTurn(input, options));
        // Queued behind a busy turn: the row carries the batch from here.
        if (!settled) settle(result.turnId);
      } catch (err) {
        console.warn(`[agent] irc delivery to ${threadId} failed:`, err);
        if (settled) return;
        // Back to unseen on purpose: the batch never reached the agent, so the
        // next delivery — or the agent's own inbox read — should still find it.
        deps.mailbox.releaseDelivery(deliveryId);
        retry(threadId);
        return;
      }
      // Past the batch cap the rest stayed behind. Nothing else is going to
      // come along for them — the senders' events have already fired — so the
      // overflow arms its own round rather than waiting for a message that may
      // never be sent.
      if (deps.mailbox.ringingCount(threadId) > 0) arm(threadId);
    })();
  }

  const unsubscribe = deps.mailbox.onMessageDelivered((threadId) => arm(threadId));
  // A thread that was away while mail arrived has an inbox nothing is scheduled
  // to read. Coming back is the second thing that arms a delivery.
  const unsubscribeLive = deps.onThreadLive?.((threadId) => {
    if (deps.mailbox.ringingCount(threadId) > 0) arm(threadId);
  });

  return () => {
    unsubscribe();
    unsubscribeLive?.();
    for (const cancel of armed.values()) cancel();
    armed.clear();
    failures.clear();
  };
}

/**
 * How a delivered batch reads to the agent receiving it.
 *
 * Tagged, so an agent can tell another agent's words from its own user's —
 * they arrive on the same channel and nothing else distinguishes them — and
 * each one says who sent it, how that agent relates to this one, and what the
 * message is for: a question from a delegate wants an answer, a note from a
 * peer wants nothing. It says plainly when no reply is owed, because the
 * default failure of agent messaging is two of them being polite at each other
 * until somebody runs out of money.
 *
 * What the courier carries, and kone's own notices, are kone speaking, not
 * another agent, so each is framed as kone's on its own rather than counted
 * among the agents' messages.
 */
export function renderIncoming(messages: IrcMessageRecord[], remaining = 0): string {
  const carried: string[] = [];
  const fromAgents: IrcMessageRecord[] = [];
  for (const m of messages) {
    if (m.sender?.kind === "courier") carried.push(renderCourierMessage(m.sender, m.message));
    else if (m.sender?.kind === "system") carried.push(renderKoneNotice(m.message));
    else fromAgents.push(m);
  }
  // Said rather than left implicit: past the batch cap the rest are still in the
  // inbox, and an agent told "3 messages arrived" while forty wait is being
  // given a wrong number to reason about.
  const overflow =
    remaining > 0
      ? `${remaining} more ${remaining === 1 ? "message is" : "messages are"} still in your inbox.`
      : "";
  if (fromAgents.length === 0) return [...carried, overflow].filter(Boolean).join("\n\n");
  return [...carried, renderAgentMessages(fromAgents, overflow)].join("\n\n");
}

/** Messages other agents sent, as one tagged block. */
function renderAgentMessages(messages: IrcMessageRecord[], overflow: string): string {
  const lines = messages.map((m) => {
    const who = (m.sender?.kind === "agent" ? m.sender.name : undefined) ?? m.from;
    const relation = m.sender?.kind === "agent" ? ` (${senderRelationshipLabel(m.sender.relationship)})` : "";
    const kind = m.kind && m.kind !== "note" ? `, ${m.kind}` : "";
    const replyTo = m.replyTo ? `, replying to ${m.replyTo}` : "";
    return `[${m.id}] From \`${who}\`${relation}${kind}${replyTo}:\n${m.message}`;
  });
  const header =
    messages.length === 1
      ? "A message from another agent arrived while you were working:"
      : `${messages.length} messages from other agents arrived while you were working:`;
  const asked = messages.some((m) => m.kind === "question" || m.kind === "pushback");
  const closing = asked
    ? "The user did not say this — other agents did. A question or pushback is waiting on you: answer it with agent_message (kind \"answer\", replyTo its id) from what you know of the user's intent, asking the user only what you cannot answer. Anything else here needs no reply."
    : "The user did not say this — other agents did, and nobody is waiting on a reply. Fold anything useful into what you are already doing; a bare acknowledgement costs the sender a whole turn and tells them nothing.";
  return [
    "<agent_messages>",
    header + (overflow ? `\n\n${overflow}` : ""),
    "",
    lines.join("\n\n"),
    "",
    closing,
    "</agent_messages>",
  ].join("\n");
}
