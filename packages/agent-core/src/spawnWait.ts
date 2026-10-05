import type { SpawnEngineStore, TrackedChild } from "./threadSpawn.js";
import { SPAWN_WAIT_DEFAULT_MS, SPAWN_WAIT_MAX_MS, SpawnError } from "./threadSpawn.js";
import type { JobTurn } from "./gateway/tools/irc.js";
import type { SpawnedThread } from "./types.js";
import { projectSpawnedThread, type SpawnProjectionTurn } from "./spawnProjection.js";

/** The rejection a cancelled wait settles with — named AbortError so the
 *  gateway transport can tell a client-cancelled call from a tool failure. */
export function abortWaitError(): Error {
  return Object.assign(new Error("The wait was cancelled."), { name: "AbortError" });
}

export type WaiterResult = {
  threads: SpawnedThread[];
  allTerminal: boolean;
  timedOut: boolean;
  turnIds: (string | null)[];
};

export type Waiter = {
  ids: string[];
  /** Positionally paired with `ids`; undefined = wait on the child's latest. */
  turnIds?: (string | undefined)[];
  scopeThreadId: string;
  /** When the wait began. */
  since: number;
  resolve: (out: WaiterResult) => void;
  timeout?: NodeJS.Timeout;
};

export interface SpawnWaitDeps {
  tracked: Map<string, TrackedChild>;
  store: SpawnEngineStore;
  snapshot: (threadId: string) => SpawnedThread | null;
  /** The child as the store has it, for a turn the live record does not hold. */
  storedSnapshot?: (threadId: string, turnId?: string) => SpawnedThread | null;
  isInSubtree: (rootThreadId: string, threadId: string) => boolean;
  /** A wait returned a settled turn to the agent that waited — that agent has
   *  the result, so nothing else need tell it. */
  onCollected?: (scopeThreadId: string, threadId: string, turnId: string) => void;
  /** A parked wait was cancelled before it returned anything. */
  onAbandoned?: (scopeThreadId: string, threadIds: readonly string[]) => void;
  /** Where a job in a child's inbox stands, for a wait pinned to the job's
   *  id: the turn that carried it once it was handed over. Null when the id
   *  names no job. */
  jobTurn: (inboxId: string) => JobTurn | null;
}

/** What a wait is pinned to: a turn, or a job still waiting for its turn —
 *  or one kone was handing over when it restarted, which will never come. */
type Pin = { turnId: string | undefined; pending: boolean; uncertain?: true };

/**
 * Coordinates async waits on spawned child threads, handling turn-pinning,
 * timeouts, abort signal cancellation, and gating detection (approvals / user questions).
 */
export class SpawnWaitCoordinator {
  private readonly waiters: Waiter[] = [];

  constructor(private readonly deps: SpawnWaitDeps) {}

  async waitFor(input: {
    threadIds: string[];
    turnIds?: (string | undefined)[];
    timeoutMs?: number;
    scopeThreadId: string;
    signal?: AbortSignal;
  }): Promise<WaiterResult> {
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? SPAWN_WAIT_DEFAULT_MS, 0),
      SPAWN_WAIT_MAX_MS,
    );
    if (input.turnIds && input.turnIds.length !== input.threadIds.length) {
      throw new SpawnError(
        "invalid_input",
        "turnIds must be positionally paired with threadIds — one turn id per thread, in the same order.",
      );
    }
    for (const id of input.threadIds) {
      if (!this.deps.isInSubtree(input.scopeThreadId, id)) {
        throw new SpawnError(
          "not_found",
          `Thread "${id}" is not in this conversation's subtree — a parent may only wait on its own spawned children.`,
          { threadId: id },
        );
      }
    }
    if (input.signal?.aborted) {
      throw abortWaitError();
    }
    const { promise, resolve, reject } = Promise.withResolvers<WaiterResult>();
    const waiter: Waiter = {
      ids: [...input.threadIds],
      turnIds: input.turnIds ? [...input.turnIds] : undefined,
      scopeThreadId: input.scopeThreadId,
      since: Date.now(),
      resolve,
    };
    waiter.timeout = setTimeout(() => this.finishWaiter(waiter, true), timeoutMs);
    this.waiters.push(waiter);
    this.checkWaiter(waiter);
    const signal = input.signal;
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          reject(abortWaitError());
          this.deps.onAbandoned?.(waiter.scopeThreadId, waiter.ids);
        },
        { once: true },
      );
    }
    return promise;
  }

  /** Is `scopeThreadId` parked in a wait that will return this turn of
   *  `threadId` — on that turn by id, or on whatever the child's latest is? */
  isCollecting(scopeThreadId: string, threadId: string, turnId: string): boolean {
    return this.waiters.some(
      (waiter) =>
        waiter.scopeThreadId === scopeThreadId &&
        waiter.ids.some((id, i) => id === threadId && (this.pinOf(id, waiter.turnIds?.[i]).turnId ?? turnId) === turnId),
    );
  }

  /** A pin names a turn, or a job's inbox id — which stands for the turn
   *  that carried the job once it was handed over, and for a turn still to
   *  come until then. */
  private pinOf(threadId: string, requested: string | undefined): Pin {
    if (requested === undefined) return { turnId: undefined, pending: false };
    const job = this.deps.jobTurn(requested);
    if (!job || job.recipient !== threadId) return { turnId: requested, pending: false };
    if (job.uncertain) return { turnId: requested, pending: false, uncertain: true };
    if (job.turnId) return { turnId: job.turnId, pending: false };
    return { turnId: requested, pending: !job.handedOver };
  }

  /** The threads `scopeThreadId` is parked waiting on, and since when; null
   *  when it is not waiting. */
  waitingOn(scopeThreadId: string): { threadIds: string[]; since: number } | null {
    const mine = this.waiters.filter((w) => w.scopeThreadId === scopeThreadId);
    if (mine.length === 0) return null;
    return {
      threadIds: [...new Set(mine.flatMap((w) => w.ids))],
      since: Math.min(...mine.map((w) => w.since)),
    };
  }

  checkWaiters(): void {
    for (const waiter of Array.from(this.waiters)) this.checkWaiter(waiter);
  }

  private checkWaiter(waiter: Waiter): void {
    const threads = waiter.ids.map((id, i) => this.snapshotForWait(id, waiter.turnIds?.[i]));
    const anyGated = threads.some(
      (t) => t.status === "waiting-for-approval" || t.status === "waiting-for-user-input",
    );
    const allTerminal = threads.every((t) => t.terminal);
    if (anyGated || allTerminal) this.finishWaiter(waiter, false);
  }

  private finishWaiter(waiter: Waiter, timedOut: boolean): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    const threads = waiter.ids.map((id, i) => this.snapshotForWait(id, waiter.turnIds?.[i]));
    const turnIds = this.resolvedTurnIds(waiter);
    waiter.resolve({
      threads,
      allTerminal: threads.every((t) => t.terminal),
      timedOut,
      turnIds,
    });
    // A timed-out wait still hands back every child that had settled by then.
    waiter.ids.forEach((id, i) => {
      const turnId = turnIds[i];
      if (threads[i]!.terminal && turnId) this.deps.onCollected?.(waiter.scopeThreadId, id, turnId);
    });
  }

  private resolvedTurnIds(waiter: Waiter): (string | null)[] {
    return waiter.ids.map((id, i) => {
      const requested = this.pinOf(id, waiter.turnIds?.[i]).turnId;
      if (requested !== undefined) return requested;
      const tracked = this.deps.tracked.get(id);
      if (tracked && tracked.turns.length > 0) {
        return tracked.turns[tracked.turns.length - 1]!.turnId;
      }
      return null;
    });
  }

  snapshotForWait(threadId: string, requested?: string): SpawnedThread {
    const pin = this.pinOf(threadId, requested);
    const snap = this.snapshotPinned(threadId, pin.turnId);
    // Settled, with nothing to collect: the job may never have arrived, and
    // the sender is the one who can send it again.
    if (pin.uncertain) {
      return {
        ...snap,
        status: "uncertain",
        terminal: true,
        handedOver: false,
        detail:
          "kone restarted while handing this job over, and nothing says whether it arrived. " +
          "If it still matters, send agent_followup again with a new requestId.",
      };
    }
    // A job still in the child's inbox is a turn to come: nothing to collect
    // yet, unless the child is parked on the user, which holds the job too.
    if (pin.pending && snap.status !== "waiting-for-approval" && snap.status !== "waiting-for-user-input") {
      return { ...snap, status: "starting", terminal: false };
    }
    return snap;
  }

  private snapshotPinned(threadId: string, turnId: string | undefined): SpawnedThread {
    const tracked = this.deps.tracked.get(threadId);
    if (tracked && turnId) {
      const pin = tracked.turns.find((t) => t.turnId === turnId);
      // A child taken back on after a restart holds only its turns since; a
      // turn from before is read from the store — that turn, not the newest.
      if (!pin && tracked.adopted && tracked.awaitingTurn?.turnId !== turnId) {
        const stored = this.deps.storedSnapshot?.(threadId, turnId);
        if (stored) return stored;
      }
      // The provider took the turn; its events have yet to say so.
      const awaiting = tracked.awaitingTurn?.turnId === turnId ? tracked.awaitingTurn : undefined;
      const pinnedTurns: SpawnProjectionTurn[] = pin ? [pin] : awaiting ? [{ turnId, state: "running", at: awaiting.at }] : [];
      return projectSpawnedThread({
        thread: {
          threadId: tracked.threadId,
          parentThreadId: tracked.parentThreadId,
          title: tracked.title,
          provider: tracked.provider,
          model: tracked.model,
          effort: tracked.effort,
          createdAt: tracked.createdAt,
          updatedAt: tracked.updatedAt,
        },
        turns: pinnedTurns,
        // A pinned turn reports ITS OWN reply, never the thread's newest —
        // the same rule as the store path. A turn that said nothing carries
        // no summary.
        latestAssistantText: this.deps.store.turnAssistantText(tracked.threadId, turnId),
        gate: tracked.gate,
        hasLiveSession: tracked.hasLiveSession || pinnedTurns.length === 0,
        tokens: tracked.tokens,
        now: Date.now(),
      });
    }
    // Not followed here: the store has the turn the wait asked for.
    const stored = turnId ? this.deps.storedSnapshot?.(threadId, turnId) : null;
    if (stored) return stored;
    const snap = this.deps.snapshot(threadId);
    if (snap) return snap;
    const meta = this.deps.store.threadMeta(threadId);
    return {
      threadId,
      parentThreadId: threadId,
      title: meta?.title ?? "",
      provider: meta?.provider ?? "opencode",
      status: "idle",
      terminal: true,
      createdAt: meta?.createdAt ?? 0,
      updatedAt: meta?.updatedAt ?? 0,
    };
  }

  dispose(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      const threads = waiter.ids.map((id, i) => this.snapshotForWait(id, waiter.turnIds?.[i]));
      waiter.resolve({
        threads,
        allTerminal: threads.every((t) => t.terminal),
        timedOut: true,
        turnIds: this.resolvedTurnIds(waiter),
      });
    }
    this.waiters.length = 0;
  }
}
