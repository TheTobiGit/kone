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

import { SpawnError } from "./threadSpawn.js";
import type { ThreadDispatcher } from "./dispatch.js";
import type { MessageSender, StoredThreadMeta, ThreadLineage } from "./types.js";

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

export class HandOffLifecycle {
  /** Agents in a decision turn, with that turn's id once it is known: they may
   *  decide, not start anything new. */
  private readonly deciding = new Map<string, string | null>();

  constructor(private readonly deps: HandOffLifecycleDeps) {}

  isDeciding(threadId: string): boolean {
    return this.deciding.has(threadId);
  }

  /** The decision turn is over once the turn that carried it settles — that
   *  turn, not the interrupted one whose abort may land a moment later. */
  onTurnSettled(threadId: string, turnId: string): void {
    if (this.deciding.get(threadId) === turnId) this.deciding.delete(threadId);
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
      if (this.deps.service.hasLiveSession(id)) {
        await this.deps.service.stopSession(id);
        stopped.push(id);
      }
    };
    for (const child of this.deps.store.spawnedChildren(threadId)) await walk(child.threadId);
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

  private async onStopped(threadId: string, by: string): Promise<{ decisionTurn: boolean }> {
    const children = this.deps.store.spawnedChildren(threadId);
    // Workers are part of the agent: they stop with it, no questions asked.
    for (const child of children) {
      if (child.lineage?.relationshipToParent !== "subagent") continue;
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
    this.deciding.set(threadId, null);
    await this.deps.dispatcher.ensureThreadSession(threadId, { resume: true });
    const turn = await this.deps.dispatcher.sendThreadTurn(
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
    this.deciding.set(threadId, turn.turnId);
    return { decisionTurn: true };
  }

  private async stopDelegate(threadId: string, delegatorName: string): Promise<void> {
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

  /** What an agent is called: its contract name, its roster name, or its
   *  thread's title. */
  private nameOf(threadId: string): string {
    const meta = this.deps.store.threadMeta(threadId);
    if (meta?.contract) return meta.contract.name;
    const agentId = this.deps.store.getThreadAgent?.(threadId)?.agentId;
    const rosterName = agentId ? this.deps.store.getAgent?.(agentId)?.name?.trim() : undefined;
    return rosterName || meta?.title || "an agent";
  }
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
