import type { ThreadDispatcher } from "./dispatch.js";
import type {
  ContinueThreadRequest,
  ContinueThreadResult,
  SpawnCaller,
  SpawnEngineProviders,
  SpawnEngineStore,
  TrackedChild,
} from "./threadSpawn.js";
import { CONTINUE_THREAD_OP_KIND, fingerprintOf, SpawnError } from "./threadSpawn.js";
import {
  isSpawnedRelationship,
  type AgentPersona,
  type SessionStartInput,
  type StoredThreadMeta,
  type ThreadLineage,
} from "./types.js";

export interface SpawnContinuationDeps {
  store: SpawnEngineStore;
  providers: SpawnEngineProviders;
  dispatcher: ThreadDispatcher;
  tracked: Map<string, TrackedChild>;
  liveChildren: Set<string>;
  recompute: (child: TrackedChild) => void;
  isInSubtree: (rootThreadId: string, threadId: string) => boolean;
}
/**
 * Handles follow-up turns dispatched to already-spawned child threads,
 * waking dormant sessions when necessary and maintaining durable op idempotency.
 */
export class ThreadContinuationManager {
  constructor(private readonly deps: SpawnContinuationDeps) {}

  async continueThread(
    caller: SpawnCaller,
    request: ContinueThreadRequest,
  ): Promise<ContinueThreadResult> {
    const message = request.message.trim();
    if (!message) {
      throw new SpawnError("invalid_input", "The follow-up message cannot be empty.");
    }
    if (request.threadId === caller.threadId) {
      throw new SpawnError(
        "invalid_input",
        "That is your own thread — write your reply instead of continuing it.",
      );
    }
    if (!this.deps.isInSubtree(caller.threadId, request.threadId)) {
      throw new SpawnError(
        "not_found",
        `Thread "${request.threadId}" is not in this conversation's subtree — you can only continue a thread you (or a descendant of yours) spawned.`,
        { threadId: request.threadId },
      );
    }
    return this.dispatchFollowUp(caller, request, message);
  }

  private async dispatchFollowUp(
    caller: SpawnCaller,
    request: ContinueThreadRequest,
    message: string,
  ): Promise<ContinueThreadResult> {
    if (request.requestId !== undefined) {
      const reserved = this.deps.store.reserveGatewayOp({
        threadId: caller.threadId,
        turnId: caller.turnId,
        requestId: request.requestId,
        kind: CONTINUE_THREAD_OP_KIND,
        fingerprint: fingerprintOf([request.threadId, message]),
      });
      if (reserved === null) {
        throw new SpawnError("internal", "Failed to reserve the follow-up operation.");
      }
      if (reserved.kind === "replay") {
        // SAFETY: result_json was stored as JSON.stringify of a ContinueThreadResult
        // under CONTINUE_THREAD_OP_KIND, so a replay row deserializes to ContinueThreadResult.
        return reserved.result as ContinueThreadResult;
      }
      if (reserved.kind === "conflict") {
        throw new SpawnError(
          "idempotency_conflict",
          `Request id "${request.requestId}" was already used in this turn with a different follow-up — pass a fresh requestId to send a different message.`,
        );
      }
    }

    const meta = this.deps.store.threadMeta(request.threadId);
    const lineage = meta ? this.deps.store.threadLineage(request.threadId) : null;
    if (!meta || !lineage || !isSpawnedRelationship(lineage.relationshipToParent)) {
      throw new SpawnError(
        "not_found",
        `Thread "${request.threadId}" is not a spawned child — nothing to continue.`,
        { threadId: request.threadId },
      );
    }
    return this.wakeAndSend(caller, request, message, meta, lineage);
  }

  private async wakeAndSend(
    caller: SpawnCaller,
    request: ContinueThreadRequest,
    message: string,
    meta: StoredThreadMeta,
    lineage: ThreadLineage,
  ): Promise<ContinueThreadResult> {
    const tracked = this.deps.tracked.get(request.threadId);
    const live = tracked ? tracked.hasLiveSession : this.deps.providers.hasLiveSession(request.threadId);
    let resumed = false;
    if (!live) {
      resumed = true;
      const startInput: SessionStartInput = {
        threadId: request.threadId,
        provider: meta.provider,
        cwd: meta.projectPath,
        model: meta.model,
        mode: meta.selection?.mode,
        effort: meta.selection?.effort,
        resume: meta.conversationId,
        resumeSessionAt: meta.resumeSessionAt,
        agent: this.personaFor(request.threadId, lineage),
      };
      if (tracked) {
        tracked.sessionStopped = false;
        tracked.hasLiveSession = true;
      }
      try {
        await this.deps.dispatcher.startThread(startInput, { parentTurnId: caller.turnId });
      } catch (err) {
        if (tracked) {
          tracked.hasLiveSession = false;
          tracked.sessionStopped = true;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new SpawnError(
          "provider_unavailable",
          `The child thread could not be brought back up on ${meta.provider}: ${detail}. Its transcript is intact — retry the follow-up once the provider is healthy.`,
          { threadId: request.threadId },
        );
      }
      if (tracked) this.deps.recompute(tracked);
    }

    const finish = (turnId: string): ContinueThreadResult => ({
      threadId: request.threadId,
      parentThreadId: caller.threadId,
      turnId,
      resumed,
    });

    try {
      const turn = await this.deps.dispatcher.sendThreadTurn(
        { threadId: request.threadId, input: message },
        { generateTitle: false, parentTurnId: caller.turnId },
      );
      if (tracked) {
        this.deps.liveChildren.add(request.threadId);
      }
      if (request.requestId !== undefined) {
        this.deps.store.setGatewayOpResult({
          threadId: caller.threadId,
          turnId: caller.turnId,
          requestId: request.requestId,
          resultJson: JSON.stringify(finish(turn.turnId)),
        });
      }
      return finish(turn.turnId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SpawnError(
        "provider_unavailable",
        `The follow-up turn could not be dispatched to ${request.threadId}: ${detail}.`,
        { threadId: request.threadId },
      );
    }
  }

  private personaFor(threadId: string, lineage: ThreadLineage): AgentPersona | undefined {
    if (lineage.relationshipToParent !== "delegation") return undefined;
    const binding = this.deps.store.getThreadAgent?.(threadId);
    const agentId = binding?.agentId;
    if (!agentId) return undefined;
    const record = this.deps.store.getAgent?.(agentId);
    if (!record?.name) return undefined;
    const persona: AgentPersona = { name: record.name };
    if (record.instructions) persona.instructions = record.instructions;
    return persona;
  }
}
