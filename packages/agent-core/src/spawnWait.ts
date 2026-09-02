import type { SpawnEngineStore, TrackedChild } from "./threadSpawn.js";
import { SPAWN_WAIT_DEFAULT_MS, SPAWN_WAIT_MAX_MS, SpawnError } from "./threadSpawn.js";
import type { SpawnedThread } from "./types.js";
import { projectSpawnedThread } from "./spawnProjection.js";

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
  resolve: (out: WaiterResult) => void;
  timeout?: NodeJS.Timeout;
};

export interface SpawnWaitDeps {
  tracked: Map<string, TrackedChild>;
  store: SpawnEngineStore;
  snapshot: (threadId: string) => SpawnedThread | null;
  isInSubtree: (rootThreadId: string, threadId: string) => boolean;
}

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
        },
        { once: true },
      );
    }
    return promise;
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
    waiter.resolve({
      threads,
      allTerminal: threads.every((t) => t.terminal),
      timedOut,
      turnIds: this.resolvedTurnIds(waiter),
    });
  }

  private resolvedTurnIds(waiter: Waiter): (string | null)[] {
    return waiter.ids.map((id, i) => {
      const requested = waiter.turnIds?.[i];
      if (requested !== undefined) return requested;
      const tracked = this.deps.tracked.get(id);
      if (tracked && tracked.turns.length > 0) {
        return tracked.turns[tracked.turns.length - 1]!.turnId;
      }
      return null;
    });
  }

  snapshotForWait(threadId: string, turnId?: string): SpawnedThread {
    const tracked = this.deps.tracked.get(threadId);
    if (tracked && turnId) {
      const pin = tracked.turns.find((t) => t.turnId === turnId);
      const pinnedTurns = pin ? [pin] : [];
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
        latestAssistantText: this.deps.store.latestAssistantText(tracked.threadId),
        gate: tracked.gate,
        hasLiveSession: tracked.hasLiveSession || pinnedTurns.length === 0,
        tokens: tracked.tokens,
        now: Date.now(),
      });
    }
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
