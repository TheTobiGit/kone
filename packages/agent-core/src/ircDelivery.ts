import type { IrcMailbox, IrcMessageRecord } from "./gateway/tools/irc.js";
import type { ThreadDispatcher } from "./dispatch.js";

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
// Either way the message is drained from the inbox as it goes, so the agent
// reads it once and the inbox tool stays what it is: a way to catch up on what
// arrived while nobody could reach you.
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

/** How many messages ride one delivery. Past this the rest stay in the inbox
 *  for the recipient to drain deliberately — a wake carrying forty messages is
 *  not a wake, it is a context dump. */
export const IRC_DELIVERY_BATCH_MAX = 8;

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

  function arm(threadId: string): void {
    armed.get(threadId)?.();
    armed.set(threadId, schedule(() => deliver(threadId), IRC_DELIVERY_DEBOUNCE_MS));
  }

  function deliver(threadId: string): void {
    armed.delete(threadId);
    // Not live: the thread was closed or its session reaped between the send
    // and this firing. The messages stay unread in the inbox, which is exactly
    // where a thread that comes back later should find them — and coming back
    // is what re-arms this.
    if (!deps.isLive(threadId)) return;
    // Peeked, not drained. Reading a batch out of the inbox is the only record
    // that it existed, so taking it before the turn is accepted means a send
    // that throws — a reaped session, a provider that refused the steer — has
    // silently eaten the messages: gone from the inbox, never seen by the
    // agent, and nothing left anywhere to notice. The drain happens below,
    // after the turn is on its way.
    const { messages, unreadCount } = deps.mailbox.getInbox(threadId, {
      peek: true,
      limit: IRC_DELIVERY_BATCH_MAX,
    });
    if (messages.length === 0) return;
    // A peek reports the whole unread pile, not what is left after the batch —
    // it took nothing, so nothing is left over yet. The overflow is the
    // difference.
    const remaining = Math.max(0, unreadCount - messages.length);

    const input = { threadId, input: renderIncoming(messages, remaining) };
    // A running turn is steered rather than interrupted: the agent is working,
    // and a peer's message is context for that work, not a new assignment. An
    // idle one has no turn to steer, so it gets one.
    const send = deps.isBusy(threadId)
      ? deps.dispatcher.steerThreadTurn(input, { silent: true })
      : deps.dispatcher.sendThreadTurn(input, { silent: true });
    void (async () => {
      try {
        await send;
      } catch (err) {
        // Left unread on purpose: the batch never reached the agent, so the
        // next delivery — or the agent's own inbox read — should still find it.
        console.warn(`[agent] irc delivery to ${threadId} failed:`, err);
        return;
      }
      // Delivered. Drain exactly what was handed over, so a message that
      // arrived while the turn was starting is still unread and still gets its
      // own delivery.
      deps.mailbox.getInbox(threadId, { limit: messages.length });
      // Past the batch cap the rest stayed behind. Nothing else is going to
      // come along for them — the senders' events have already fired — so the
      // overflow arms its own round rather than waiting for a message that may
      // never be sent.
      if (deps.mailbox.getUnreadCount(threadId) > 0) arm(threadId);
    })();
  }

  const unsubscribe = deps.mailbox.onMessageDelivered((threadId) => arm(threadId));
  // A thread that was away while mail arrived has an inbox nothing is scheduled
  // to read. Coming back is the second thing that arms a delivery.
  const unsubscribeLive = deps.onThreadLive?.((threadId) => {
    if (deps.mailbox.getUnreadCount(threadId) > 0) arm(threadId);
  });

  return () => {
    unsubscribe();
    unsubscribeLive?.();
    for (const cancel of armed.values()) cancel();
    armed.clear();
  };
}

/**
 * How a delivered batch reads to the agent receiving it.
 *
 * Tagged, so an agent can tell a peer's words from its own user's — they arrive
 * on the same channel and nothing else distinguishes them. It also says plainly
 * that no reply is owed, because the default failure of agent messaging is two
 * of them being polite at each other until somebody runs out of money.
 */
export function renderIncoming(messages: IrcMessageRecord[], remaining = 0): string {
  const lines = messages.map((m) => {
    const replyTo = m.replyTo ? ` (replying to ${m.replyTo})` : "";
    return `From \`${m.from}\`${replyTo}:\n${m.message}`;
  });
  const header =
    messages.length === 1
      ? "A message from another agent arrived while you were working:"
      : `${messages.length} messages from other agents arrived while you were working:`;
  // Said rather than left implicit: past the batch cap the rest are still in the
  // inbox, and an agent told "3 messages arrived" while forty wait is being
  // given a wrong number to reason about.
  const overflow =
    remaining > 0
      ? `\n\n${remaining} more ${remaining === 1 ? "message is" : "messages are"} still in your inbox.`
      : "";
  return [
    "<irc>",
    header + overflow,
    "",
    lines.join("\n\n"),
    "",
    "The user did not say this — another agent did, and it is waiting on nothing. Fold anything useful into what you are already doing. Reply with the irc tool only if the sender asked you something they cannot proceed without; a bare acknowledgement costs them a whole turn and tells them nothing.",
    "</irc>",
  ].join("\n");
}
