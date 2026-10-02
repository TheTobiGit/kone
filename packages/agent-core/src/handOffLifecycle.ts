// What happens to the work an agent handed off when that agent is stopped,
// withdraws a hand-off, or is spoken to over its head (docs/agent-roles-design.md
// §6–§7).
//
// Two kinds of hand-off, two rules. A worker has no say: it is part of the
// agent that started it, so stopping the agent stops its workers outright. A
// delegate or contractor is a co-worker: it is never stopped from under itself
// without being told, and whether it keeps going when its delegator is stopped
// is the delegator's call — made in a short decision turn kone gives it —
// not something kone decides on its behalf. A delegate that is stopped gets the
// same decision for the agents working for it, so a stop travels down the
// chain one link at a time, each agent deciding for the ones it brought in.
//
// Everything said to an agent here is said as kone (the `system` sender): it
// describes what happened, it is not an instruction from the user.

import { getSpawnEngine, SpawnError } from "./threadSpawn.js";
import { threadAgentName } from "./senderHeader.js";
import type { ThreadDispatcher } from "./dispatch.js";
import type {
  MessageSender,
  RuntimeEvent,
  SendTurnInput,
  StoredThreadMeta,
  ThreadLineage,
  TurnStartResult,
} from "./types.js";

/** Structural — the real ConversationStore satisfies it. */
export interface HandOffLifecycleStore {
  threadMeta(threadId: string): StoredThreadMeta | null;
  threadLineage(threadId: string): ThreadLineage | null;
  spawnedChildren(parentThreadId: string): StoredThreadMeta[];
  getThreadAgent?(threadId: string): { agentId: string | null } | null;
  getAgent?(agentId: string): { name: string | null } | null;
}

/** Structural — the real AgentService satisfies it. */
export interface HandOffLifecycleService {
  isThreadBusy(threadId: string): boolean;
  hasLiveSession(threadId: string): boolean;
  interruptTurn(threadId: string): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  /** Drop the thread's queued follow-ups, leaving its session up. */
  cancelQueuedTurns(threadId: string): Promise<void>;
}

export interface HandOffLifecycleDeps {
  store: HandOffLifecycleStore;
  service: HandOffLifecycleService;
  dispatcher: Pick<ThreadDispatcher, "sendThreadTurn" | "steerThreadTurn" | "queueNotice" | "ensureThreadSession">;
}

/** What a stopped agent decides for one agent working because of it. */
export type HandOffDecision = "continue" | "stop" | "ask_user";

export type HandOffDecisionOutcome = {
  threadId: string;
  name: string;
  decision: HandOffDecision;
};

const SYSTEM: MessageSender = { kind: "system" };

/** Where an agent's decision turn is. The send that carries it may land as a
 *  live turn or, when the interrupted turn has not finished aborting yet, as a
 *  queued follow-up that becomes a turn of its own later — so the id the send
 *  answered with may be a queue id, swapped for the real turn id on promotion.
 *  Events can outrun the send's answer (a promotion, even a settlement, may be
 *  heard before the queue id is), so what happened meanwhile is remembered. */
type DecisionTurn = {
  /** The id the decision is known by: the turn id, or the queue id until promoted. */
  id: string | null;
  /** Promoted without a turn id and none running yet: the next turn to start is it. */
  awaitingStart: boolean;
  /** The turn running now, if one started since the decision was sent. */
  live: string | null;
  /** Turns that settled since the decision was sent. */
  settled: Set<string>;
  /** Queue ids promoted since the decision was sent, with the turn each became. */
  promoted: Map<string, string | null>;
};

export class HandOffLifecycle {
  /** Agents in a decision turn: they may decide, not start anything new. */
  private readonly deciding = new Map<string, DecisionTurn>();

  constructor(private readonly deps: HandOffLifecycleDeps) {}

  isDeciding(threadId: string): boolean {
    return this.deciding.has(threadId);
  }

  /** Follow the decision turns through the runtime event stream: promotion out
   *  of the queue, settlement, a cancelled queue row, a session going away. */
  onEvent(event: RuntimeEvent): void {
    const decision = this.deciding.get(event.threadId);
    if (!decision) return;
    switch (event.type) {
      case "turn.started":
        decision.live = event.turnId;
        if (decision.awaitingStart) {
          decision.id = event.turnId;
          decision.awaitingStart = false;
        }
        return;
      case "turn.promoted": {
        // The promoted turn has usually started by now (the drain announces
        // the promotion after the adapter took it); one live turn per thread,
        // so a running one is it.
        const turnId = event.turnId ?? decision.live;
        if (decision.id === null) decision.promoted.set(event.queueId, turnId);
        else if (decision.id === event.queueId) this.adopt(event.threadId, decision, turnId);
        return;
      }
      case "turn.completed":
      case "turn.aborted":
        if (decision.live === event.turnId) decision.live = null;
        this.onTurnSettled(event.threadId, event.turnId);
        return;
      case "turn.queued-cancelled":
        // The decision never ran and never will.
        if (decision.id === event.queueId) this.deciding.delete(event.threadId);
        return;
      case "session.exited":
        this.deciding.delete(event.threadId);
        return;
      case "session.state.changed":
        if (event.state === "stopped" || event.state === "error") this.deciding.delete(event.threadId);
        return;
      default:
        return;
    }
  }

  /** The decision turn is over once the turn that carried it settles — that
   *  turn, not the interrupted one whose abort may land a moment later. */
  onTurnSettled(threadId: string, turnId: string): void {
    const decision = this.deciding.get(threadId);
    if (!decision) return;
    if (decision.id === turnId) this.deciding.delete(threadId);
    else decision.settled.add(turnId);
  }

  /**
   * The user pressed Stop on `threadId`: interrupt it, then settle the work it
   * handed off. A Stop during its decision turn ends that decision rather than
   * asking it again — the agent goes idle, and its delegates carry on as they
   * were last told. Only the interrupt can fail this; settling is best-effort.
   */
  async userStops(threadId: string): Promise<void> {
    const decision = this.deciding.get(threadId);
    if (decision) {
      this.deciding.delete(threadId);
      // A decision still waiting in the queue would be promoted by this very
      // interrupt's abort, and run as if nothing had been said.
      if (decision.id === null || decision.id !== decision.live) await this.deps.service.cancelQueuedTurns(threadId);
      await this.deps.service.interruptTurn(threadId);
      return;
    }
    // Nothing the user lined up starts on its own once they pressed Stop: the
    // interrupt's abort would otherwise promote the next queued follow-up.
    // The rows are cancelled with reason "stop", which hands their words back
    // to the composer rather than discarding them.
    await this.deps.service.cancelQueuedTurns(threadId);
    await this.deps.service.interruptTurn(threadId);
    try {
      await this.onUserStopped(threadId);
    } catch (err) {
      console.warn("[agent] could not settle the hand-offs of a stopped thread:", err);
    }
  }

  /**
   * The user stopped `threadId`. Its workers stop with it; its delegates and
   * contractors that are still working are told, and it gets a decision turn
   * for them. With none working it is a plain stop — nothing to decide.
   */
  async onUserStopped(threadId: string): Promise<{ decisionTurn: boolean }> {
    return this.onStopped(threadId, "the user");
  }

  /** Stop everything under `threadId`, and it, with no decisions asked. */
  async stopEverything(threadId: string): Promise<string[]> {
    const stopped: string[] = [];
    const walk = async (id: string): Promise<void> => {
      for (const child of this.deps.store.spawnedChildren(id)) await walk(child.threadId);
      unreported(id);
      if (this.deps.service.hasLiveSession(id)) {
        await this.deps.service.stopSession(id);
        stopped.push(id);
      }
    };
    for (const child of this.deps.store.spawnedChildren(threadId)) await walk(child.threadId);
    // The thread keeps its session, but nothing it had lined up runs: an
    // interrupted turn's abort promotes the next queued follow-up, and that
    // would start new work the moment everything was stopped.
    await this.deps.service.cancelQueuedTurns(threadId);
    if (this.deps.service.isThreadBusy(threadId)) {
      await this.deps.service.interruptTurn(threadId);
      stopped.push(threadId);
    }
    return stopped;
  }

  /**
   * Apply a decision turn's choices. Every thread named must be a delegate or
   * contractor of the caller's; a worker is not the caller's to decide about
   * here, it stopped with the caller.
   */
  async decide(
    callerThreadId: string,
    decisions: ReadonlyArray<{ threadId: string; decision: HandOffDecision }>,
  ): Promise<HandOffDecisionOutcome[]> {
    const callerName = this.nameOf(callerThreadId);
    const outcomes: HandOffDecisionOutcome[] = [];
    for (const { threadId, decision } of decisions) {
      const lineage = this.deps.store.threadLineage(threadId);
      if (lineage?.parentThreadId !== callerThreadId || lineage.relationshipToParent !== "delegation") {
        throw new SpawnError(
          "not_found",
          `"${threadId}" is not an agent you delegated to or contracted — decide only for those.`,
          { threadId },
        );
      }
      const name = this.nameOf(threadId);
      if (decision === "continue") {
        await this.tell(
          threadId,
          `${callerName} was stopped by the user and decided you should carry on. Keep working; your report goes to ${callerName} when you are done.`,
          { wake: false },
        );
      } else if (decision === "stop") {
        await this.stopDelegate(threadId, callerName);
      }
      // ask_user: nothing to tell the delegate yet — it keeps working until
      // the user answers and the decision is made again.
      outcomes.push({ threadId, name, decision });
    }
    return outcomes;
  }

  /**
   * An agent takes back work it handed off. A worker simply stops. A delegate
   * or contractor is told, and wraps up: it stops, leaves a short note of what
   * it did, and starts nothing new.
   */
  async withdraw(callerThreadId: string, threadId: string): Promise<"stopped" | "told"> {
    // The caller has moved on: neither the stop nor the wrap-up note is worth
    // waking it for. Both stay where agent_wait and agent_read find them.
    unreported(threadId);
    const lineage = this.deps.store.threadLineage(threadId);
    if (lineage?.relationshipToParent !== "delegation") {
      await this.deps.service.stopSession(threadId);
      return "stopped";
    }
    const callerName = this.nameOf(callerThreadId);
    await this.tell(
      threadId,
      `${callerName} withdrew this task. Stop here: start nothing new, stop any workers you started, and reply with a short note of what you did and what is left.`,
      { wake: true },
    );
    return "told";
  }

  /** Send words the user typed into a thread, as a turn. */
  async userSends(input: SendTurnInput): Promise<TurnStartResult> {
    return this.userSpeaks(input, (typed) => this.deps.dispatcher.sendThreadTurn(typed));
  }

  /** Steer words the user typed into a thread's running turn (or its queue). */
  async userSteers(input: SendTurnInput): Promise<TurnStartResult> {
    return this.userSpeaks(input, (typed) => this.deps.dispatcher.steerThreadTurn(typed));
  }

  /**
   * The user typed into a delegate's or contractor's thread directly. Its
   * delegator is told — quietly, on its next turn, unless it is running now —
   * so it does not keep coordinating on plans the user just changed.
   */
  async onUserSpokeTo(threadId: string, text: string): Promise<void> {
    const lineage = this.deps.store.threadLineage(threadId);
    const delegator = lineage?.parentThreadId;
    if (!delegator || lineage.relationshipToParent !== "delegation") return;
    const said = text.trim().replace(/\s+/g, " ");
    const quote = said.length > 280 ? `${said.slice(0, 279)}…` : said;
    await this.tell(
      delegator,
      `The user spoke to ${this.nameOf(threadId)} directly: "${quote}". What it was asked may have changed; check in with it (agent_message) if that matters to what you are coordinating.`,
      { wake: false },
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Whatever the user typed is always the user's: a sender is only ever set
   *  for words an agent or kone itself wrote, so one arriving here is dropped.
   *  Once the words are accepted, the delegator (if any) hears the user went
   *  over its head — best-effort, since the words already landed. */
  private async userSpeaks(
    input: SendTurnInput,
    dispatch: (typed: SendTurnInput) => Promise<TurnStartResult>,
  ): Promise<TurnStartResult> {
    const { sender: _sender, ...typed } = input;
    const result = await dispatch(typed);
    try {
      await this.onUserSpokeTo(typed.threadId, typed.input);
    } catch (err) {
      console.warn("[agent] could not tell the delegator the user spoke directly:", err);
    }
    return result;
  }

  private async onStopped(threadId: string, by: string): Promise<{ decisionTurn: boolean }> {
    // Already deciding for these same agents: a second decision turn would
    // only ask the question again.
    if (this.deciding.has(threadId)) return { decisionTurn: true };
    const children = this.deps.store.spawnedChildren(threadId);
    // Workers are part of the agent: they stop with it, no questions asked.
    for (const child of children) {
      if (child.lineage?.relationshipToParent !== "subagent") continue;
      unreported(child.threadId);
      if (this.deps.service.hasLiveSession(child.threadId)) await this.deps.service.stopSession(child.threadId);
    }
    const working = children.filter(
      (child) =>
        child.lineage?.relationshipToParent === "delegation" && this.deps.service.isThreadBusy(child.threadId),
    );
    if (working.length === 0) return { decisionTurn: false };

    const name = this.nameOf(threadId);
    for (const child of working) {
      await this.tell(
        child.threadId,
        `${name}, who handed you this work, was stopped by ${by}. Keep working for now: ${name} is deciding whether you carry on, and you will be told if you should stop.`,
        { wake: false },
      );
    }

    const list = working
      .map((child) => `- ${this.nameOf(child.threadId)} (${child.threadId}): ${child.title ?? "untitled"}, still working`)
      .join("\n");
    const decision: DecisionTurn = { id: null, awaitingStart: false, live: null, settled: new Set(), promoted: new Map() };
    this.deciding.set(threadId, decision);
    let turn: { turnId: string };
    try {
      await this.deps.dispatcher.ensureThreadSession(threadId, { resume: true });
      turn = await this.deps.dispatcher.sendThreadTurn(
        {
          threadId,
          sender: SYSTEM,
          input: [
            `You were stopped by ${by}. These agents are still working because of you:`,
            list,
            "",
            `For each one, decide with agent_keep_or_stop: continue (it is still worth finishing), stop (the work is no longer wanted), or ask_user (you cannot tell — then ask the user in your reply). Do not start anything new in this turn; ${by === "the user" ? "the user stopped you for a reason" : "you were stopped for a reason"}.`,
          ].join("\n"),
        },
        { generateTitle: false },
      );
    } catch (err) {
      // No decision turn is coming, so nothing should be refused on its account.
      if (this.deciding.get(threadId) === decision) this.deciding.delete(threadId);
      throw err;
    }
    if (this.deciding.get(threadId) !== decision) return { decisionTurn: true };
    decision.id = turn.turnId;
    // Queued, and promoted while the send was still answering.
    if (decision.promoted.has(turn.turnId)) this.adopt(threadId, decision, decision.promoted.get(turn.turnId) ?? null);
    else if (decision.settled.has(turn.turnId)) this.deciding.delete(threadId);
    return { decisionTurn: true };
  }

  /** The queued decision became a real turn: know it by that turn's id from
   *  here on, or by the next one to start when the promotion did not name it. */
  private adopt(threadId: string, decision: DecisionTurn, turnId: string | null): void {
    decision.promoted.clear();
    decision.id = turnId;
    decision.awaitingStart = turnId === null;
    if (turnId !== null && decision.settled.has(turnId)) this.deciding.delete(threadId);
  }

  private async stopDelegate(threadId: string, delegatorName: string): Promise<void> {
    unreported(threadId);
    // Nothing it had lined up runs: the interrupt's abort would otherwise
    // promote its next queued follow-up and it would carry on working.
    await this.deps.service.cancelQueuedTurns(threadId);
    if (this.deps.service.isThreadBusy(threadId)) await this.deps.service.interruptTurn(threadId);
    // It hears why before anything else, then decides for its own delegates.
    this.deps.dispatcher.queueNotice(
      threadId,
      `${delegatorName} stopped this task after the user stopped ${delegatorName}. Start nothing new.`,
    );
    await this.onStopped(threadId, delegatorName);
  }

  /** Say something to an agent as kone: into its running turn if it has one,
   *  otherwise as a turn of its own when it should act now, otherwise queued
   *  for whenever it next runs. */
  private async tell(threadId: string, text: string, options: { wake: boolean }): Promise<void> {
    if (this.deps.service.isThreadBusy(threadId)) {
      await this.deps.dispatcher.steerThreadTurn({ threadId, input: text, sender: SYSTEM });
      return;
    }
    if (options.wake) {
      await this.deps.dispatcher.ensureThreadSession(threadId, { resume: true });
      await this.deps.dispatcher.sendThreadTurn({ threadId, input: text, sender: SYSTEM }, { generateTitle: false });
      return;
    }
    this.deps.dispatcher.queueNotice(threadId, text);
  }

  /** What an agent is called — the same name every other surface uses. */
  private nameOf(threadId: string): string {
    return threadAgentName(this.deps.store, threadId);
  }
}

/** A thread stopped here was stopped by the agent it works for (or with it),
 *  so how its turn ends is no news to that agent: the spawn engine is told not
 *  to report it. */
function unreported(threadId: string): void {
  getSpawnEngine()?.muteReports(threadId);
}

let lifecycle: HandOffLifecycle | null = null;

/** Build the lifecycle the app runs on. Called once from the IPC wiring. */
export function initHandOffLifecycle(deps: HandOffLifecycleDeps): HandOffLifecycle {
  lifecycle = new HandOffLifecycle(deps);
  return lifecycle;
}

/** The live lifecycle, or null until something initializes it. Resolved at
 *  call time by the gateway tools and the spawn engine. */
export function getHandOffLifecycle(): HandOffLifecycle | null {
  return lifecycle;
}
