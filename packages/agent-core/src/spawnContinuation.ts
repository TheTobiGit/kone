import type { AgentSender } from "@kone/protocol/message-sender";
import { agentSenderFor } from "./senderHeader.js";
import type { ThreadDispatcher } from "./dispatch.js";
import type {
  ContinueThreadRequest,
  ContinueThreadResult,
  SpawnCaller,
  SpawnEngineProviders,
  SpawnEngineStore,
  SpawnJobs,
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
  /** Take a child from before a restart back on; null when it is no
   *  spawned child. */
  adopt?: (threadId: string, parentTurnId: string, hasLiveSession: boolean) => TrackedChild | null;
  isInSubtree: (rootThreadId: string, threadId: string) => boolean;
  /** Up the thread's chain, or granted follow-up on it. */
  canFollowUp: (callerThreadId: string, threadId: string) => boolean;
  /** Where a follow-up goes: a job in the child's inbox. */
  jobs: SpawnJobs;
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
    if (!this.deps.canFollowUp(caller.threadId, request.threadId)) {
      throw new SpawnError(
        "not_found",
        `Thread "${request.threadId}" is not in this conversation's subtree — you can only continue a thread you (or a descendant of yours) spawned, or one you were granted follow-up on.`,
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
    let tracked = this.deps.tracked.get(request.threadId);
    const live = tracked ? tracked.hasLiveSession : this.deps.providers.hasLiveSession(request.threadId);
    // A child from before a restart is followed again from this follow-up on,
    // so its turns report to the parent and a wait reads them live. If the
    // follow-up never goes out, it is let go again.
    const adopted = tracked ? null : (this.deps.adopt?.(request.threadId, caller.turnId, live) ?? null);
    if (adopted) tracked = adopted;
    const letGo = (): void => {
      if (adopted && this.deps.tracked.get(request.threadId) === adopted) {
        this.deps.tracked.delete(request.threadId);
        this.deps.liveChildren.delete(request.threadId);
      }
    };
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
        letGo();
        const detail = err instanceof Error ? err.message : String(err);
        throw new SpawnError(
          "provider_unavailable",
          `The child thread could not be brought back up on ${meta.provider}: ${detail}. Its transcript is intact — retry the follow-up once the provider is healthy.`,
          { threadId: request.threadId },
        );
      }
      if (tracked) this.deps.recompute(tracked);
    }

    const finish = (turnId: string, job = false): ContinueThreadResult => {
      const result: ContinueThreadResult = { threadId: request.threadId, parentThreadId: caller.threadId, turnId, resumed };
      if (job) result.job = true;
      return result;
    };

    try {
      // Whoever above the child asks, the ask arrives as that agent's words —
      // never the user's — under the relationship the hand-off was made with,
      // or as from up the chain when an ancestor past the parent asks. A peer
      // holding a follow-up grant asks as the peer it is.
      const relationship = !this.deps.isInSubtree(caller.threadId, request.threadId)
        ? "peer"
        : lineage.parentThreadId !== caller.threadId
          ? "upstream"
          : meta.contract
            ? "contracting"
            : lineage.relationshipToParent === "delegation"
              ? "delegator"
              : "parent";
      const sender = agentSenderFor(this.deps.store, caller.threadId, relationship, "followup");
      const jobId = this.postJob(this.deps.jobs, caller, request, message, meta, sender);
      // The job is in the child's inbox — durably accepted. More work on a
      // closed contract reopens it here, not before the ask is out: a
      // failure on the way (a provider that cannot come back up, a job that
      // could not be posted) leaves the contract closed, as it was.
      if (meta.contractClosed) this.deps.store.setContractClosed?.(request.threadId, null);
      const result = finish(jobId, true);
      if (tracked) {
        this.deps.liveChildren.add(request.threadId);
      }
      if (request.requestId !== undefined) {
        this.deps.store.setGatewayOpResult({
          threadId: caller.threadId,
          turnId: caller.turnId,
          requestId: request.requestId,
          resultJson: JSON.stringify(result),
        });
      }
      return result;
    } catch (err) {
      letGo();
      const detail = err instanceof Error ? err.message : String(err);
      throw new SpawnError(
        "provider_unavailable",
        `The follow-up turn could not be dispatched to ${request.threadId}: ${detail}.`,
        { threadId: request.threadId },
      );
    }
  }

  /** Leave the follow-up in the child's inbox as a job, and hand back its id.
   *  The ringer gives it a turn of its own — now, when the child is idle, or
   *  when its running turn ends. A retry under the same request id finds the
   *  job already there and gets the same id. */
  private postJob(
    jobs: SpawnJobs,
    caller: SpawnCaller,
    request: ContinueThreadRequest,
    message: string,
    meta: StoredThreadMeta,
    sender: AgentSender,
  ): string {
    // The child's events are stamped with the turn that asked, as a send
    // carrying it would stamp them.
    this.deps.dispatcher.noteSpawnParentTurn(request.threadId, caller.turnId);
    const job: Parameters<SpawnJobs["postJob"]>[0] = { to: request.threadId, projectPath: meta.projectPath, message, sender };
    if (request.requestId !== undefined) {
      job.dedupeKey = `job:${caller.threadId}:${caller.turnId}:${request.requestId}`;
    }
    const turnId = jobs.postJob(job).messageId;
    // A granted peer asked: this turn's result is that peer's news, not the
    // parent's. Bound to the job's id here, in the same synchronous block the
    // job is posted in — before it can be taken or settled — so however many
    // follow-ups race, each turn reports to whoever asked for it. An
    // up-chain ask reports to the parent, as it always did.
    if (!this.deps.isInSubtree(caller.threadId, request.threadId)) {
      const tracked = this.deps.tracked.get(request.threadId);
      if (tracked) (tracked.reportees ??= new Map()).set(turnId, caller.threadId);
    }
    return turnId;
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
