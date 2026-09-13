import type {
  SpawnCaller,
  SpawnEngineProviders,
  TrackedChild,
} from "./threadSpawn.js";
import { SpawnError } from "./threadSpawn.js";
import type { UserInputAnswers } from "./types.js";

/** Decline a parked approval gate on a spawned child of the caller's subtree.
 *  The child stays running and tries an alternative. */
export type DeclineChildGateRequest = {
  threadId: string;
  requestId: string;
};

export type DeclineChildGateResult = {
  threadId: string;
  requestId: string;
  resolved: boolean;
};

export type CancelChildResult = {
  threadId: string;
  parentThreadId: string;
  cancelled: boolean;
};

/** Answer a parked user-input gate on a spawned child of the caller's
 *  subtree. */
export type AnswerChildInputRequest = {
  threadId: string;
  requestId: string;
  answers: UserInputAnswers;
};

export type AnswerChildInputResult = {
  threadId: string;
  requestId: string;
  owned: boolean;
  followUp?: string;
};

export interface SpawnControlDeps {
  providers: Pick<SpawnEngineProviders, "stopSession" | "respondToRequest" | "respondToUserInput">;
  tracked: Map<string, TrackedChild>;
  recompute: (child: TrackedChild) => void;
  isInSubtree: (rootThreadId: string, threadId: string) => boolean;
}

/**
 * Handles cancel/decline/answer controls on already-spawned child threads,
 * enforcing subtree scope before touching the provider session.
 */
export class ThreadControlManager {
  constructor(private readonly deps: SpawnControlDeps) {}

  async cancelChild(caller: SpawnCaller, threadId: string): Promise<CancelChildResult> {
    this.assertChildInSubtree(caller, threadId, "cancel");
    // The single choke point: only the checked thread is ever stopped, and the
    // stop itself seals the live turn and revokes the thread's gateway
    // credential, so no interrupt fallback is needed.
    await this.deps.providers.stopSession(threadId);
    const tracked = this.deps.tracked.get(threadId);
    if (tracked) {
      tracked.hasLiveSession = false;
      tracked.sessionStopped = true;
      tracked.gate = null;
      this.deps.recompute(tracked);
    }
    return { threadId, parentThreadId: caller.threadId, cancelled: true };
  }

  async declineChildGate(
    caller: SpawnCaller,
    request: DeclineChildGateRequest,
  ): Promise<DeclineChildGateResult> {
    this.assertChildInSubtree(caller, request.threadId, "decline a gate on");
    // Decline-only: the decision is always a reject variant, never an allow —
    // a parent cannot grant its child a capability through this path.
    await this.deps.providers.respondToRequest(request.threadId, request.requestId, "reject-once");
    return { threadId: request.threadId, requestId: request.requestId, resolved: true };
  }

  async answerChildInput(
    caller: SpawnCaller,
    request: AnswerChildInputRequest,
  ): Promise<AnswerChildInputResult> {
    this.assertChildInSubtree(caller, request.threadId, "answer a question on");
    const outcome = await this.deps.providers.respondToUserInput(
      request.threadId,
      request.requestId,
      request.answers,
    );
    const result: AnswerChildInputResult = {
      threadId: request.threadId,
      requestId: request.requestId,
      owned: outcome.owned,
    };
    if (outcome.followUp !== undefined) result.followUp = outcome.followUp;
    return result;
  }

  private assertChildInSubtree(
    caller: SpawnCaller,
    threadId: string,
    verb: "cancel" | "decline a gate on" | "answer a question on",
  ): void {
    if (threadId === caller.threadId || !this.deps.isInSubtree(caller.threadId, threadId)) {
      throw new SpawnError(
        "not_found",
        `Thread "${threadId}" is not in this conversation's subtree — you can only ${verb} a worker you (or a descendant of yours) spawned.`,
        { threadId },
      );
    }
  }
}
