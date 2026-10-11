import { senderRelationshipLabel } from "@kone/protocol/message-sender";
import type { IrcDeliveryClaim, IrcMailbox, IrcMessageRecord } from "./gateway/tools/irc.js";
import { withDrift } from "./messageAbout.js";
import type { ThreadDispatcher } from "./dispatch.js";
import { formatSince, type RecipientState, type ThreadRuntime } from "./recipientState.js";
import { renderCourierMessage, renderKoneNotice, renderSenderHeader, renderUserHeader } from "./senderHeader.js";
import type { MessageSender, RuntimeEvent, SendTurnInput } from "./types.js";

// The ringer: one place that decides whether, when and how a message waiting
// in an agent's inbox is handed over.
//
// Everything waits in the inbox. What rings — a question, an answer, a report,
// a notice kone marks — is handed over by the turn slot: when the recipient's
// running turn ends, or at once when it is idle, the next turn carries every
// waiting message in front of whatever starts it (the user's queued message
// last). What does not ring — a note, an unmarked notice — never starts a turn;
// it rides in front of the next one, whatever starts it. Only an urgent
// message goes into a running turn.
//
// A job — work handed over with agent_followup or app_send_to_thread — is a
// turn of its own, never folded into someone else's and never batched with
// another job. The user's queued messages go first; then each job, oldest
// first, with whatever else waits riding in front of it.
//
// What the recipient is doing is read when it rings, not when the message was
// sent: a thread parked on the user holds everything until the user answers; a
// thread starting or compacting takes its messages as soon as it can; a closed
// one is brought back up for a message that rings, and for nothing else.

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
 *  batch waits in the inbox until something else rings. */
export const IRC_DELIVERY_RETRY_MS: readonly number[] = [1_000, 5_000, 15_000, 60_000];

/** Arm a callback, and hand back the way to call it off. Injectable so tests
 *  fire the debounce deliberately instead of sleeping on real time. */
export type ScheduleDelivery = (fn: () => void, ms: number) => () => void;

/** The service's side of the turn slot: what is waiting is folded into the
 *  next turn to start, and settled with that turn once the provider takes it. */
export interface TurnInbox {
  /**
   * Claim what is waiting for a turn starting now on `threadId` and fold it in
   * front of `turn`. With `turn` null there is nothing else to run, so this
   * claims only when something rings, and the turn it returns carries nothing
   * but the inbox. Null when nothing is carried.
   *
   * `ownBlockId` is the transcript block of the turn's own words, when it has
   * one: the user's own words are headed as theirs and go last.
   */
  carry(threadId: string, turn: SendTurnInput | null, ownBlockId?: string): CarriedTurn | null;
  /** An urgent job waits: the next turn is its own, ahead of the user's
   *  queued messages, as it would have gone into the running turn on a
   *  provider that takes one there. */
  cutsIn?(threadId: string): boolean;
}

/** A turn with the inbox folded in, and how to settle what it carries. */
export interface CarriedTurn {
  input: SendTurnInput;
  /** The turn is going to the provider now. */
  sending(): void;
  /** The provider took the turn: what it carries is seen, with that turn. */
  settle(turnId: string): void;
  /** It did not: what it carried waits again, its blocks kept. */
  release(): void;
}

export interface InboxDeliveryDeps {
  mailbox: IrcMailbox;
  service: {
    threadRuntime(threadId: string): ThreadRuntime;
    /** Let the turn slot run: it starts a turn for what rings when the thread
     *  is free, and does nothing when it is not. */
    kickTurnSlot(threadId: string): void;
    /** kone steer: end the running turn once its current tool call is done
     *  — held while parked on the user — so the turn slot carries what is
     *  urgent next. */
    interruptAfterStep(threadId: string, from: "agent"): void;
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
  };
  dispatcher: Pick<ThreadDispatcher, "steerThreadTurn" | "ensureThreadSession" | "takeReplayPreamble">;
  /** Put one message on the recipient's transcript under its sender, and hand
   *  back the block it was written as (null when nothing was written).
   *  `beforeBlockId` is the turn's own block, which it reads above. */
  journal: (threadId: string, message: IrcMessageRecord, beforeBlockId?: string) => string | null;
  /** Who wrote a block on the thread's transcript; null when unknown. */
  blockSender?: (threadId: string, blockId: string) => MessageSender | null;
  /** Put a block after everything on the transcript: the turn's own words,
   *  once what it carries is written above them. */
  placeLast?: (threadId: string, blockId: string) => void;
  schedule?: ScheduleDelivery;
}

export interface InboxDelivery extends TurnInbox {
  /** Unsubscribe and drop every armed ring. */
  stop(): void;
}

/** Start the ringer. Hand its `carry` to the service as the turn slot's
 *  inbox, and `stop` it on teardown. */
export function startInboxDelivery(deps: InboxDeliveryDeps): InboxDelivery {
  const schedule: ScheduleDelivery =
    deps.schedule ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const { mailbox } = deps;
  const armed = new Map<string, () => void>();
  /** Failed urgent steers in a row, per thread. */
  const failures = new Map<string, number>();
  /** Threads being brought back up for a message that rings. */
  const restarting = new Set<string>();

  function arm(threadId: string, ms = IRC_DELIVERY_DEBOUNCE_MS): void {
    armed.get(threadId)?.();
    armed.set(threadId, schedule(() => ring(threadId), ms));
  }

  /** Decide, from what the thread is doing now, what a ring does. */
  function ring(threadId: string): void {
    armed.delete(threadId);
    if (mailbox.ringingCount(threadId) === 0) return;
    const rt = deps.service.threadRuntime(threadId);
    // Nothing reaches a thread parked on the user, urgent included: the user
    // answering is what rings again.
    if (rt.parked) return;
    // It takes messages shortly: the session coming up, or the compaction
    // ending, lets the turn slot run.
    if (rt.starting || rt.compacting) return;
    if (!rt.live) {
      restart(threadId);
      return;
    }
    if (rt.busy) {
      // Only urgent goes into a running turn; the rest is next, when the turn
      // ends and the turn slot carries it.
      if (mailbox.urgentCount(threadId) > 0) urgentInto(threadId, rt);
      return;
    }
    deps.service.kickTurnSlot(threadId);
  }

  /** Bring a closed session back up. Its start lets the turn slot run, which
   *  carries what rang. */
  function restart(threadId: string): void {
    if (restarting.has(threadId)) return;
    restarting.add(threadId);
    void deps.dispatcher
      .ensureThreadSession(threadId, { resume: true })
      .catch((err) => {
        console.warn(`[agent] could not bring ${threadId} back up for its inbox:`, err);
        restarting.delete(threadId);
        retry(threadId);
      })
      .finally(() => restarting.delete(threadId));
  }

  /** Urgent mail for a busy thread. It is settled only with a turn the
   *  provider really started, so a job's id always comes to stand for one:
   *  into the running turn when the provider takes it there and that turn has
   *  announced itself. On a provider that cannot, kone steer ends the running
   *  turn after its current step, and the turn slot carries the mail next,
   *  its rows unseen until then. A provider that would lose that step's work
   *  is never interrupted: the mail goes when the turn ends. */
  function urgentInto(threadId: string, rt: ThreadRuntime): void {
    if (rt.turnStartedAt === null) return; // turn.started rings again
    const lands = rt.urgent ?? (rt.steers ? "steer" : "turn-end");
    if (lands === "steer") steerUrgent(threadId);
    else if (lands === "after-step") deps.service.interruptAfterStep(threadId, "agent");
  }

  /** Put the urgent messages, and at most one urgent job, into the running
   *  turn. */
  function steerUrgent(threadId: string): void {
    const handOver = joinClaims(mailbox, [
      mailbox.claimUrgent(threadId, IRC_DELIVERY_BATCH_MAX),
      mailbox.claimJob(threadId, true),
    ]);
    if (!handOver) return;
    const { messages, job } = splitJob(handOver.messages);
    const blockIds = journalAll(threadId, job ? [...messages, job] : messages);
    const input: SendTurnInput = {
      threadId,
      input: renderHandOver(messages, job, mailbox.urgentCount(threadId)),
    };
    nameBlocks(input, blockIds);
    // Live only: a turn that ended while this was on its way leaves the
    // steer refused rather than queued, so the hand-over is settled with a
    // turn the provider took, never with a queue row's id.
    let accepted = false;
    const settle = (turnId: string): void => {
      accepted = true;
      handOver.settle(turnId);
      failures.delete(threadId);
    };
    void (async () => {
      try {
        await deps.dispatcher.steerThreadTurn(input, {
          silent: true,
          liveOnly: true,
          onAccepted: settle,
          onSending: () => handOver.sending(),
        });
      } catch (err) {
        console.warn(`[agent] urgent delivery to ${threadId} failed:`, err);
        if (accepted) return;
        handOver.release();
        retry(threadId);
        return;
      }
      if (mailbox.urgentCount(threadId) > 0) arm(threadId);
    })();
  }

  /** Arm the retry for mail whose hand-over failed — a steer, a turn of its
   *  own, a session that would not come back up — later each time, and give
   *  up after the last delay until something else rings. */
  function retry(threadId: string): void {
    const attempt = failures.get(threadId) ?? 0;
    const ms = IRC_DELIVERY_RETRY_MS[attempt];
    if (ms === undefined) {
      failures.delete(threadId);
      return;
    }
    failures.set(threadId, attempt + 1);
    if (!armed.has(threadId)) arm(threadId, ms);
  }

  /** Write each message to the transcript once, and return the blocks. */
  function journalAll(threadId: string, messages: IrcMessageRecord[], beforeBlockId?: string): string[] {
    for (const message of messages) {
      if (message.blockId || !message.sender) continue;
      const blockId = deps.journal(threadId, message, beforeBlockId);
      if (!blockId) continue;
      message.blockId = blockId;
      mailbox.setBlockId(message.id, blockId);
    }
    return messages.flatMap((m) => (m.blockId ? [m.blockId] : []));
  }

  function carry(threadId: string, turn: SendTurnInput | null, ownBlockId?: string): CarriedTurn | null {
    if (turn === null) return carryOwnTurn(threadId);
    // Jobs wait for a turn of their own; everything else rides this one.
    const claim = mailbox.claimForTurn(threadId, IRC_DELIVERY_BATCH_MAX);
    if (!claim) return null;
    const carried = journalAll(threadId, claim.messages, ownBlockId);
    // Read in the order the turn says it: what waited above, the turn's own
    // words below.
    if (ownBlockId && carried.length > 0) deps.placeLast?.(threadId, ownBlockId);
    const inbox = renderInboxTurn(claim.messages, messagesLeft(threadId));
    const own = ownBlockId ? (deps.blockSender?.(threadId, ownBlockId) ?? null) : null;
    // The user's words come last, headed as the user's, so the agent can
    // tell where the messages end and the person it works for begins.
    const words = own?.kind === "user" ? `${renderUserHeader()}\n\n${turn.input}` : turn.input;
    const input: SendTurnInput = { ...turn, input: `${inbox}\n\n${words}` };
    nameBlocks(input, [...carried, ...(turn.userBlockIds ?? (ownBlockId ? [ownBlockId] : []))]);
    return carriedTurn(input, joinClaims(mailbox, [claim])!);
  }

  /** A turn with nothing else to run: the oldest job, with what else waits
   *  in front of it, or — with no job — what rings. Null when nothing is owed
   *  a turn. */
  function carryOwnTurn(threadId: string): CarriedTurn | null {
    const job = mailbox.claimJob(threadId, true) ?? mailbox.claimJob(threadId);
    if (!job && mailbox.ringingCount(threadId) === 0) return null;
    const handOver = joinClaims(mailbox, [mailbox.claimForTurn(threadId, IRC_DELIVERY_BATCH_MAX), job]);
    if (!handOver) return null;
    const split = splitJob(handOver.messages);
    // The job is the turn's own words: written last, under what rode with it.
    const blockIds = journalAll(threadId, split.job ? [...split.messages, split.job] : split.messages);
    // A session that came up blank gets its transcript back first, as any
    // turn would.
    const replay = deps.dispatcher.takeReplayPreamble(threadId);
    const body = renderHandOver(split.messages, split.job, messagesLeft(threadId));
    const input: SendTurnInput = { threadId, input: replay ? `${replay}\n\n${body}` : body };
    nameBlocks(input, blockIds);
    // Nothing else is owed this turn: when the provider refuses it, the ringer
    // tries again on its backoff.
    return {
      input,
      sending: () => handOver.sending(),
      settle: (turnId) => {
        failures.delete(threadId);
        handOver.settle(turnId);
      },
      release: () => {
        handOver.release();
        retry(threadId);
      },
    };
  }

  /** Messages still waiting once this hand-over is out, jobs aside. */
  function messagesLeft(threadId: string): number {
    return mailbox.getUnreadCount(threadId) - mailbox.jobCount(threadId);
  }

  const unsubscribeMail = mailbox.onMessageDelivered((threadId) => arm(threadId));
  // A release the store wrote late puts mail back with nothing else to ring it.
  const unsubscribeReleased = mailbox.onDeliveryReleased((threadId) => {
    if (!armed.has(threadId)) arm(threadId);
  });
  const unsubscribeEvents = deps.service.onEvent((event) => {
    switch (event.type) {
      // The user answered: whatever was held for them rings again.
      case "approval.resolved":
      case "user-input.resolved":
      // A session came up: anything urgent that waited for it rings now.
      case "session.started":
        if (mailbox.ringingCount(event.threadId) > 0) arm(event.threadId);
        return;
      // A turn announced itself: urgent mail that waited for it goes in now.
      case "turn.started":
        if (mailbox.urgentCount(event.threadId) > 0) arm(event.threadId);
        return;
      default:
        return;
    }
  });

  return {
    carry,
    cutsIn: (threadId) => mailbox.unseenJobs(threadId, true) > 0,
    stop() {
      unsubscribeMail();
      unsubscribeReleased();
      unsubscribeEvents();
      for (const cancel of armed.values()) cancel();
      armed.clear();
      failures.clear();
    },
  };
}

/** Name the blocks a turn carries: a steer moves only the blocks it names to
 *  where it landed. */
function nameBlocks(input: SendTurnInput, blockIds: readonly string[]): void {
  if (blockIds.length === 0) return;
  input.userBlockId = blockIds[blockIds.length - 1];
  if (blockIds.length > 1) input.userBlockIds = [...blockIds];
}

interface HandOver {
  messages: IrcMessageRecord[];
  sending(): void;
  settle(turnId: string): void;
  release(): void;
}

/** One hand-over that took more than one claim: what it carries, settled or
 *  released together. Null when every claim came back empty. */
function joinClaims(
  mailbox: IrcMailbox,
  claims: readonly (IrcDeliveryClaim | null)[],
): HandOver | null {
  const taken = claims.filter((c): c is IrcDeliveryClaim => c !== null);
  if (taken.length === 0) return null;
  return {
    messages: taken.flatMap((c) => c.messages),
    sending: () => {
      for (const c of taken) mailbox.sendingDelivery(c.deliveryId);
    },
    settle: (turnId) => {
      for (const c of taken) mailbox.settleDelivery(c.deliveryId, turnId);
    },
    release: () => {
      for (const c of taken) mailbox.releaseDelivery(c.deliveryId);
    },
  };
}

function carriedTurn(input: SendTurnInput, handOver: HandOver): CarriedTurn {
  return {
    input,
    sending: () => handOver.sending(),
    settle: (turnId) => handOver.settle(turnId),
    release: () => handOver.release(),
  };
}

/** A hand-over's job, if it carries one, apart from the rest. */
function splitJob(all: IrcMessageRecord[]) {
  const job = all.find((m) => m.kind === "job") ?? null;
  return { messages: all.filter((m) => m !== job), job };
}

/** What waited, then the job — which reads as its sender's words, the way a
 *  turn someone sent does. */
function renderHandOver(messages: IrcMessageRecord[], job: IrcMessageRecord | null, remaining: number): string {
  const parts: string[] = [];
  if (messages.length > 0 || (!job && remaining > 0)) parts.push(renderInboxTurn(messages, remaining));
  if (job) {
    const header = job.sender ? renderSenderHeader(job.sender) : null;
    parts.push(header ? `${header}\n\n${job.message}` : job.message);
  }
  return parts.join("\n\n");
}

/**
 * How a batch handed over from the inbox reads to the agent receiving it.
 *
 * kone's own words — a notice, or the courier carrying another agent's work —
 * are each framed as kone's. What other agents sent is one tagged block with
 * one header per sender, so a burst from one agent reads as that agent
 * speaking, not as several strangers. It says plainly when nobody is waiting
 * on a reply, which is what keeps two agents from thanking each other.
 */
export function renderInboxTurn(messages: IrcMessageRecord[], remaining = 0): string {
  const kone: string[] = [];
  const fromAgents: IrcMessageRecord[] = [];
  for (const m of messages) {
    if (m.sender?.kind === "courier") kone.push(renderCourierMessage(m.sender, m.message));
    else if (m.sender?.kind === "system") kone.push(renderKoneNotice(m.message));
    else fromAgents.push(m);
  }
  const overflow =
    remaining > 0 ? `${remaining} more ${remaining === 1 ? "message is" : "messages are"} still in your inbox.` : "";
  if (fromAgents.length === 0) return [...kone, overflow].filter(Boolean).join("\n\n");
  return [...kone, renderAgentSections(fromAgents, overflow)].join("\n\n");
}

/** Other agents' messages, grouped under one header per sender. */
function renderAgentSections(messages: IrcMessageRecord[], overflow: string): string {
  const bySender = new Map<string, IrcMessageRecord[]>();
  for (const m of messages) {
    const list = bySender.get(m.from) ?? [];
    list.push(m);
    bySender.set(m.from, list);
  }
  const sections = [...bySender.values()].map((list) => {
    const first = list[0]!;
    const who = (first.sender?.kind === "agent" ? first.sender.name : undefined) ?? first.from;
    const relation = first.sender?.kind === "agent" ? ` (${senderRelationshipLabel(first.sender.relationship)})` : "";
    const lines = list.map((m) => {
      const kind = m.kind && m.kind !== "note" ? ` ${m.kind}` : "";
      const urgent = m.urgent ? ", urgent" : "";
      const replyTo = m.replyTo ? `, replying to ${m.replyTo}` : "";
      return `[${m.id}]${kind}${urgent}${replyTo}:\n${withDrift(m)}`;
    });
    return [`From \`${who}\`${relation}:`, ...lines].join("\n\n");
  });
  const header =
    messages.length === 1
      ? "A message from another agent is waiting for you:"
      : `${messages.length} messages from other agents are waiting for you:`;
  const asked = messages.some((m) => m.kind === "question" || m.kind === "pushback");
  const closing = asked
    ? "The user did not say this — other agents did. A question or pushback is waiting on you: answer it with agent_message (kind \"answer\", replyTo its id) from what you know of the user's intent, asking the user only what you cannot answer. Anything else here needs no reply."
    : "The user did not say this — other agents did, and nobody is waiting on a reply. Fold anything useful into what you are doing; a bare acknowledgement costs the sender a turn and tells them nothing.";
  return [
    "<agent_messages>",
    header + (overflow ? `\n\n${overflow}` : ""),
    "",
    sections.join("\n\n"),
    "",
    closing,
    "</agent_messages>",
  ].join("\n");
}

// ── what a send reports ─────────────────────────────────────────────────────

/** What happened to a message, as its sender is told. */
export type DeliveryOutcome =
  /** Into the running turn. */
  | "delivered"
  /** Its provider cannot take it mid-turn, and no tool call is running: kone
   *  steer interrupts the running turn and it lands as the next one. */
  | "interrupts"
  /** kone steer waits for the tool call the recipient is in, then
   *  interrupts its turn, and it lands as the next one. */
  | "after-step"
  /** Next, when the running turn ends. */
  | "next"
  /** The recipient was idle: it is taking it now. */
  | "waking"
  /** In the inbox, for the recipient's next turn; it starts none. */
  | "inbox"
  /** Held: the recipient is waiting on the user. */
  | "held"
  /** Starting or compacting: it takes it as soon as it can. */
  | "soon"
  /** Its session was closed and is being brought back up for it. */
  | "restarting"
  /** The recipient was parked waiting on exactly this answer. */
  | "returned";

export interface DeliveryReceipt {
  outcome: DeliveryOutcome;
  text: string;
}

export interface DeliveryReceiptInput {
  /** The recipient as the sender knows it. */
  name: string;
  state: RecipientState;
  /** It rings (handed over on its own) rather than waiting for a turn. */
  rings: boolean;
  urgent: boolean;
  /** An answer the recipient is parked waiting on. */
  returned: boolean;
  /** Delivery as the ringer does it; false describes the older routing, where
   *  every message is steered into a running turn or wakes an idle one. */
  now: number;
}

/**
 * What a send reports, read from the recipient's state at the moment it was
 * sent. State can change before the message lands; the ringer reads it again
 * when it rings.
 */
export function deliveryReceipt(input: DeliveryReceiptInput): DeliveryReceipt {
  const { name, state } = input;
  if (input.returned) return { outcome: "returned", text: `Returned to ${name}, who was waiting on this answer.` };
  if (state.state === "waiting-on-user") {
    return {
      outcome: "held",
      text: `Held: ${name} is ${state.activity ?? "waiting on the user"}. Nothing reaches ${name} until the user answers — ask the user if you need this sooner.`,
    };
  }
  const notLive = state.state === "closed" || state.state === "ended";
  if (!input.rings) {
    if (notLive) {
      return { outcome: "inbox", text: `In ${name}'s inbox. ${name}'s session is closed, so it waits until ${name} runs again.` };
    }
    if (state.state === "idle") {
      return { outcome: "inbox", text: `In ${name}'s inbox. ${name} is idle, so it waits until something else starts a turn there.` };
    }
    return { outcome: "inbox", text: `In ${name}'s inbox. It reaches ${name} at the start of the next turn ${name} runs.` };
  }
  if (state.state === "starting" || state.state === "compacting") {
    return { outcome: "soon", text: `In ${name}'s inbox: ${name} is ${state.state} and takes it as soon as it can.` };
  }
  if (notLive) {
    return {
      outcome: "restarting",
      text: `${name}'s session was closed; kone is bringing it back up, and ${name} takes it then.`,
    };
  }
  if (state.state === "idle") return { outcome: "waking", text: `Delivered: ${name} was idle and is taking it now.` };
  // Working, or waiting on another agent inside a running turn.
  if (input.urgent) {
    const lands = state.urgent ?? (state.steers === false ? "turn-end" : "steer");
    if (lands === "after-step" && state.inTool) {
      return {
        outcome: "after-step",
        text: `Waiting for ${name} to finish the current step${state.activity ? ` (${state.activity})` : ""}; it lands right after, as ${name}'s next turn.`,
      };
    }
    if (lands === "after-step") {
      return {
        outcome: "interrupts",
        text: `${name}'s provider cannot take a message mid-turn, so kone interrupts ${name}'s turn between steps and this lands as the next one.`,
      };
    }
    if (lands === "turn-end") {
      const since = formatSince(state.since, input.now);
      return {
        outcome: "next",
        text: `Next for ${name}: ${name}'s provider loses work if interrupted mid-turn, so this lands when ${name}'s turn ends${since ? ` (running ${since})` : ""}.`,
      };
    }
    return { outcome: "delivered", text: `Delivered into ${name}'s running turn.` };
  }
  const doing = state.activity ? `is ${state.state === "working" ? `on ${state.activity}` : state.activity}` : "is working";
  const since = formatSince(state.since, input.now);
  return {
    outcome: "next",
    text: `Next for ${name}: ${name} ${doing}${since ? ` (${since})` : ""} and takes it when that turn ends.`,
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
    return `[${m.id}] From \`${who}\`${relation}${kind}${replyTo}:\n${withDrift(m)}`;
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
