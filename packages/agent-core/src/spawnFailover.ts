import { isQuotaOrRateLimitError } from "./adapters/errors.js";
import type { ModelCandidate } from "./agentModel.js";
import type { ThreadDispatcher } from "./dispatch.js";
import { checkSpawn } from "./spawnGuards.js";
import type {
  SpawnAttempt,
  SpawnCaller,
  SpawnEngineProviders,
  SpawnEngineStore,
  SpawnRequest,
  TrackedChild,
} from "./threadSpawn.js";
import { catalogOf, providerStatusOf, SpawnError } from "./threadSpawn.js";
import type {
  InteractionMode,
  SendTurnInput,
  SessionStartInput,
  SpawnTarget,
  SpawnThreadResult,
} from "./types.js";

export interface SpawnFailoverDeps {
  store: SpawnEngineStore;
  providers: SpawnEngineProviders;
  dispatcher: ThreadDispatcher;
  recompute: (child: TrackedChild) => void;
}

export interface FallbackAdmissionCounts {
  prompt: string;
  requestedMode: InteractionMode | undefined;
  parentMode: InteractionMode;
  parentEffort: string | undefined;
  parentDepth: number;
  liveChildrenOfParent: number;
  liveSpawnedTotal: number;
}

/**
 * Manages model candidate fallback admission and execution retry loop for spawned threads.
 */
export class SpawnFailoverRunner {
  constructor(private readonly deps: SpawnFailoverDeps) {}

  /**
   * Take the next candidate off a fallback chain that the spawn guards will
   * admit, resolving its model and effort the same way the primary target's
   * were. Consumes the chain as it goes.
   */
  admitFallback(
    chain: ModelCandidate[],
    counts: FallbackAdmissionCounts,
  ): SpawnAttempt | null {
    const surface = this.deps.providers.cachedSurface();
    while (chain.length > 0) {
      const candidate = chain.shift();
      if (!candidate) continue;
      const target: SpawnTarget = { provider: candidate.provider };
      if (candidate.model) target.model = candidate.model;
      const check = checkSpawn({
        prompt: counts.prompt,
        target,
        requestedMode: counts.requestedMode,
        parentMode: counts.parentMode,
        parentEffort: counts.parentEffort,
        parentDepth: counts.parentDepth,
        liveChildrenOfParent: counts.liveChildrenOfParent,
        liveSpawnedTotal: counts.liveSpawnedTotal,
        providerStatus: providerStatusOf(surface.statuses, candidate.provider),
        catalog: catalogOf(surface.models, candidate.provider),
        antigravityAcpAvailable: this.deps.providers.isAntigravityAcpAvailable?.() ?? false,
      });
      if (!check.ok) continue;
      const next: SpawnAttempt = { provider: candidate.provider };
      if (check.model) next.model = check.model;
      if (check.effort) next.effort = check.effort;
      return next;
    }
    return null;
  }

  /**
   * Dispatches the child's session and opening turn, failing over down the
   * candidate chain if the model encounters rate-limit / quota errors on start.
   */
  async executeSpawnWithFailover(input: {
    caller: SpawnCaller;
    request: SpawnRequest;
    child: TrackedChild;
    result: SpawnThreadResult;
    initialAttempt: SpawnAttempt;
    chain: ModelCandidate[];
    mode: InteractionMode;
    title: string;
    admissionCounts: FallbackAdmissionCounts;
  }): Promise<SpawnThreadResult> {
    const { caller, request, child, result, chain, mode, title, admissionCounts } = input;
    const threadId = child.threadId;
    let attempt: SpawnAttempt = input.initialAttempt;

    for (;;) {
      const failover = chain.length > 0 ? chain.map((c) => ({ ...c })) : undefined;
      try {
        const startInput: SessionStartInput = {
          threadId,
          provider: attempt.provider,
          cwd: caller.cwd,
          model: attempt.model,
          effort: attempt.effort,
          mode,
          agent: request.persona,
        };
        if (failover) startInput.fallbacks = failover;
        await this.deps.dispatcher.startThread(
          startInput,
          { parentTurnId: caller.turnId },
        );
        this.deps.store.markGatewayOpDispatched({
          threadId: caller.threadId,
          turnId: caller.turnId,
          requestId: request.requestId,
        });
        const turnInput: SendTurnInput = { threadId, input: request.prompt };
        if (failover) turnInput.fallbacks = failover;
        const turnStart = await this.deps.dispatcher.sendThreadTurn(
          turnInput,
          { title, generateTitle: false, parentTurnId: caller.turnId },
        );
        result.firstTurnId = turnStart.turnId;
        this.deps.store.setGatewayOpResult({
          threadId: caller.threadId,
          turnId: caller.turnId,
          requestId: request.requestId,
          resultJson: JSON.stringify(result),
        });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const nextTarget = isQuotaOrRateLimitError(err)
          ? this.admitFallback(chain, admissionCounts)
          : null;

        if (nextTarget) {
          await this.deps.providers.stopSession(threadId).catch(() => {});
          child.turns = child.turns.filter((turn) => turn.state !== "running");
          child.hasLiveSession = false;
          child.gate = null;
          if (!result.failedOverFrom) {
            result.failedOverFrom = { provider: attempt.provider, reason: message };
            if (attempt.model) result.failedOverFrom.model = attempt.model;
          }
          attempt = nextTarget;
          child.provider = attempt.provider;
          child.model = attempt.model;
          child.effort = attempt.effort;
          result.provider = attempt.provider;
          result.model = attempt.model;
          result.effort = attempt.effort;
          this.deps.store.retargetSpawnedThread(threadId, attempt.provider, attempt.model);
          this.deps.recompute(child);
          continue;
        }

        const at = Date.now();
        let settledRunning = false;
        for (const turn of child.turns) {
          if (turn.state !== "running") continue;
          settledRunning = true;
          turn.state = "failed";
          turn.endedAt = at;
          turn.error = message;
        }
        if (!child.sessionStopped) {
          child.sessionStopped = true;
          void this.deps.providers.stopSession(child.threadId).catch(() => {});
        }
        child.hasLiveSession = false;
        child.gate = null;
        if (!settledRunning) {
          child.turns.push({
            turnId: "<dispatch>",
            state: "failed",
            at,
            endedAt: at,
            error: message,
          });
        }
        this.deps.recompute(child);
        throw new SpawnError(
          "provider_unavailable",
          `The child thread could not be started on ${attempt.provider}: ${message}. The child remains visible in a failed state — retry with a fresh requestId once the provider is healthy.`,
        );
      }
    }

    return result;
  }
}
