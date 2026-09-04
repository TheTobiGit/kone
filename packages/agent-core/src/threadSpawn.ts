import { randomUUID } from "node:crypto";

import type { ModelCandidate } from "./agentModel.js";
import type { ThreadDispatcher } from "./dispatch.js";
import { checkSpawn, type SpawnRefusalDetails } from "./spawnGuards.js";
import {
  projectSpawnedThread,
  type SpawnGate,
  type SpawnProjectionTurn,
} from "./spawnProjection.js";
import { SpawnWaitCoordinator, type WaiterResult } from "./spawnWait.js";
import { ThreadContinuationManager } from "./spawnContinuation.js";
import { SpawnFailoverRunner, type FallbackAdmissionCounts } from "./spawnFailover.js";
import { buildPromptThreadTitleFallback } from "./threadTitle.js";
import {
  isSpawnedRelationship,
  MAX_LIVE_CHILDREN_PER_PARENT,
  MAX_LIVE_SPAWNED_THREADS,
  MAX_SPAWN_DEPTH,
} from "./types.js";
import type {
  AgentPersona,
  InteractionMode,
  ModelDescriptor,
  ProviderKind,
  ProviderStatus,
  RuntimeEvent,
  Session,
  SpawnedThread,
  SpawnThreadResult,
  SpawnTarget,
  StoredThreadMeta,
  ThreadLineage,
} from "./types.js";

// ── thread spawning engine (docs/thread-spawning-design.md §6 Wave 2) ────────
// The stateful engine that makes an agent-requested child thread real: admit
// it through the guards, persist it, drive it headlessly through the
// ThreadDispatcher (dispatch.ts) and keep a live rolled-up view of every child
// so a parent can wait on them. It is the ONLY place a spawned child's status
// is derived — the projection (spawnProjection.ts) is the single shape the
// wait tool and the UI both consume. It knows nothing about MCP: the gateway
// tool layer calls into it.

/** Structural — the real ConversationStore satisfies it; tests fake it. */
export interface SpawnEngineStore {
  threadMeta(threadId: string): StoredThreadMeta | null;
  writeSpawnedThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
    createdAt: number;
    title: string;
    lineage: ThreadLineage;
  }): boolean;
  threadLineage(threadId: string): ThreadLineage | null;
  /** Bind a delegated child to the agent it runs as, before its first turn
   *  dispatches. The return value is ignored — the engine only needs the write
   *  to land so the thread's transcript names who answered. */
  bindThreadAgent(threadId: string, agentId: string): void;
  /** Persist the provider/model a child actually started on, after a spawn-time
   *  failover moved it off the primary. The row is written before dispatch, so
   *  a retry that lands on a later candidate has to rewrite the stored target
   *  or the sidebar would keep showing the model that couldn't start. */
  retargetSpawnedThread(threadId: string, provider: ProviderKind, model?: string): void;
  spawnedChildren(parentThreadId: string): StoredThreadMeta[];
  spawnDepth(threadId: string): number;
  liveSpawnedThreadIds(): string[];
  latestAssistantText(threadId: string): string | null;
  threadTurnSpan(threadId: string): {
    startedAt: number;
    endedAt: number | null;
    runningTurns: number;
    /** The state of the NEWEST assistant block by `at` — lets the boot
     *  fallback tell a turn sealed 'interrupted' by a crash from one that
     *  genuinely settled, instead of reading every settled span as success. */
    lastState: "running" | "interrupted" | "failed" | "completed" | null;
    /** The NEWEST assistant block's error, when it has one. */
    lastError?: string;
  } | null;
  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null;
  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void;
  /** Mark a reserved op as dispatched — for spawn.thread, AFTER startThread
   *  returned. A row reserved but never marked is the durable trace of a
   *  half-created child (F8); boot-time sealUndispatchedSpawns turns those
   *  into failed threads. */
  markGatewayOpDispatched(input: {
    threadId: string;
    turnId: string;
    requestId: string;
  }): void;
  /** The agent a delegated thread runs as, when it has one. Optional because
   *  only a session restart of a delegation needs it: the binding is already
   *  on the thread for every turn the original session drove. */
  getThreadAgent?(threadId: string): { agentId: string | null } | null;
  /** One agent by id — the name and standing instructions a restarted
   *  delegation needs to wake up as itself. */
  getAgent?(agentId: string): { name: string | null; instructions?: string | null } | null;
}

/** Structural — the real AgentService satisfies it. */
export interface SpawnEngineProviders {
  cachedSurface(): {
    statuses: ProviderStatus[];
    models: Partial<Record<ProviderKind, ModelDescriptor[]>>;
  };
  listSessions(): Promise<Session[]>;
  /** Tear down one thread's provider session. The engine calls it the moment a
   *  spawned child goes terminal so the child's dedicated provider process (an
   *  OpenCode `serve`, a Cursor `acp`, …) is released instead of being held
   *  until app quit. The store row and transcript stay. */
  stopSession(threadId: string): Promise<void>;
  /** Whether the thread has a live provider session right now. A follow-up to
   *  a settled child must bring its session back up before dispatching; one to
   *  a child that never stopped goes straight to the turn. */
  hasLiveSession(threadId: string): boolean;
  /** True when the Antigravity ACP server resolves on this machine, so the
   *  spawn guard's print-mode floor doesn't refuse below-full-access
   *  Antigravity children an ACP transport could serve. Optional — absentees
   *  keep the conservative floor. */
  isAntigravityAcpAvailable?(): boolean;
}

export interface SpawnEngineDeps {
  store: SpawnEngineStore;
  providers: SpawnEngineProviders;
  dispatcher: ThreadDispatcher;
  /** Push a runtime event to renderers. The caller wires this so spawn events
   *  are NEVER journaled. */
  emit: (event: RuntimeEvent) => void;
  onEvents: (listener: (event: RuntimeEvent) => void) => () => void;
}

/** The parent session asking to spawn. Every field is server-derived from the
 *  caller's own credential — never agent-supplied, so parentage cannot be
 *  forged. */
export interface SpawnCaller {
  threadId: string;
  turnId: string;
  provider: ProviderKind;
  model?: string;
  cwd: string;
}

export type SpawnRequest = {
  requestId: string;
  prompt: string;
  title?: string;
  target: SpawnTarget;
  mode?: InteractionMode;
  /** When this spawn is a delegation to a persistent project-team agent: the
   *  agent to bind the child to, so it runs AS that agent. The engine stamps
   *  the child's lineage `"delegation"` (not `"subagent"`), binds the thread to
   *  this agent before dispatch (so the transcript carries its identity), and
   *  delivers `persona` to the session (so its instructions reach the
   *  model). Absent for an anonymous sub-agent spawn. */
  delegateToAgentId?: string;
  /** The delegated agent's identity — its name and standing instructions — set
   *  on the child's session so the model works as that agent. Only meaningful
   *  alongside `delegateToAgentId`; ignored otherwise. */
  persona?: AgentPersona;
  /** What is left of the target's fallback chain, in the order to try it. Used
   *  twice, at two different moments: the engine walks it here if the child
   *  cannot even be STARTED on `target` because that model is rate-limited or
   *  spent, and it rides along to the session and the first turn so the runtime
   *  can fail the child over again if a 429 lands mid-turn. Absent for a target
   *  with no chain behind it — the overwhelming majority of spawns. */
  fallbacks?: readonly ModelCandidate[];
};

export type SpawnErrorCode =
  | "invalid_input"
  | "capability_denied"
  | "provider_unavailable"
  | "not_found"
  | "permission_denied"
  | "idempotency_conflict"
  | "internal";

/** Detail payloads a SpawnError carries: the admission guards' refusal details
 *  plus the engine's own `{ threadId }` lookups — all kone-owned data the
 *  gateway tool layer forwards into structuredContent verbatim. */
export type SpawnErrorDetails = SpawnRefusalDetails | { threadId: string };

export class SpawnError extends Error {
  readonly code: SpawnErrorCode;
  readonly details?: SpawnErrorDetails;
  constructor(code: SpawnErrorCode, message: string, details?: SpawnErrorDetails) {
    super(message);
    this.name = "SpawnError";
    this.code = code;
    this.details = details;
  }
}

export type SpawnTargetsReport = {
  providers: Array<{
    provider: ProviderKind;
    label: string;
    available: boolean;
    /** ProviderStatus.message — the human hint for a provider that is not
     *  ready. */
    hint?: string;
    models: Array<{ id: string; label: string; efforts?: string[]; defaultEffort?: string }>;
  }>;
  caller: { provider: ProviderKind; model?: string; mode: InteractionMode };
  limits: {
    depth: number;
    maxDepth: number;
    remainingChildren: number;
    remainingAppWide: number;
  };
  /** The preset sub-agents `kone_spawn_worker_preset` can invoke by name, in the
   *  order the user keeps them. Filled by the gateway tool, not the engine —
   *  presets live outside the engine's store — so it is optional: absent means
   *  the report was built without them (the engine's own `targets`), and `[]`
   *  means the user has saved none. */
  presets?: Array<{
    name: string;
    /** A one-line gist of the preset's instructions, for choosing between them. */
    summary?: string;
    /** The model the preset runs on, or absent when it names none and the
     *  runtime picks. */
    model?: { provider: ProviderKind; model: string };
  }>;
  /** The teammates `kone_delegate_to_teammate` can hand work to on the caller's
   *  own project, in roster order. Same provenance as `presets`. A nameless agent
   *  is left out — delegation resolves by name, so one with no name cannot be
   *  reached. */
  teammates?: Array<{
    id: string;
    name: string;
    role?: string;
    /** A one-line gist of the teammate's standing instructions. */
    summary?: string;
  }>;
};

export const SPAWN_WAIT_DEFAULT_MS = 30_000;
export const SPAWN_WAIT_MAX_MS = 60_000;

/** The gateway-op ledger kind a follow-up reserves under. Deliberately NOT
 *  "spawn.thread": boot recovery seals undispatched spawn.thread rows as dead
 *  children because a spawn creates a thread row before dispatching — a
 *  follow-up creates nothing, so an undispatched one only needs to error to
 *  the caller, and a kind of its own keeps the sweeper from ever seeing it. */
export const CONTINUE_THREAD_OP_KIND = "spawn.follow-up";

/** A follow-up turn an orchestrator posts into a child thread it (or a
 *  descendant of it) already spawned. */
export type ContinueThreadRequest = {
  /** The child thread to dispatch into. */
  threadId: string;
  /** The follow-up itself — a new standing ask, not a steer of work in flight. */
  message: string;
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn).
   *  Optional: a dispatch that creates no row still bills a turn, so a retry
   *  without a key would run the child twice. */
  requestId?: string;
};

export type ContinueThreadResult = {
  threadId: string;
  parentThreadId: string;
  /** The follow-up turn's id — pass it back as turnIds to pin
   *  kone_wait_for_responses to this exact turn. */
  turnId: string;
  /** True when the child's provider session had settled and this follow-up
   *  brought it back up before dispatching. */
  resumed: boolean;
};

export interface SpawnEngine {
  spawn(caller: SpawnCaller, request: SpawnRequest): Promise<SpawnThreadResult>;
  /** Post a follow-up turn into an existing spawned child of the caller's
   *  subtree, continuing that thread's conversation in place — no new row, no
   *  new sidebar tab. */
  continueThread(caller: SpawnCaller, request: ContinueThreadRequest): Promise<ContinueThreadResult>;
  targets(caller: SpawnCaller): Promise<SpawnTargetsReport>;
  /** Live snapshots of a parent's direct children, oldest first. */
  children(parentThreadId: string): SpawnedThread[];
  snapshot(threadId: string): SpawnedThread | null;
  /** True when `threadId` is `rootThreadId` itself or any spawned descendant. */
  isInSubtree(rootThreadId: string, threadId: string): boolean;
  waitFor(input: {
    threadIds: string[];
    /** Positionally paired with `threadIds`: pin each wait to that exact turn
     *  of the child, so a newer turn can't swap the outcome mid-wait. Omit to
     *  wait on the child's latest turn. */
    turnIds?: (string | undefined)[];
    timeoutMs?: number;
    scopeThreadId: string;
    /** The caller's cancellation signal — aborting it tears down the parked
     *  waiter and rejects the wait instead of holding to the timeout. */
    signal?: AbortSignal;
  }): Promise<WaiterResult>;
  dispose(): void;
}

/** The live engine, or null before boot. Gateway tools resolve it lazily, so
 *  module import order can't matter. */
let engine: SpawnEngine | null = null;

/** Build the engine the app runs on. Called once from the gateway wiring. */
export function initSpawnEngine(deps: SpawnEngineDeps): SpawnEngine {
  engine = new SpawnEngineImpl(deps);
  return engine;
}

/** The live engine, or null until something initializes it. */
export function getSpawnEngine(): SpawnEngine | null {
  return engine;
}

/** Stable FNV-1a hex over the canonicalized spawn request — the idempotency
 *  fingerprint, not a security boundary. */
export function fingerprintOf(parts: Array<string | number | undefined>): string {
  let hash = 0x811c9dc5;
  const canonical = parts.map((part) => (part === undefined ? "" : String(part))).join("\u0001");
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** The target provider's last known health, or undefined when kone has never
 *  probed it — an absent status is NOT a refusal (a cold cache must not refuse
 *  a real model), which is exactly the permissive fallback checkSpawn expects. */
export function providerStatusOf(
  statuses: ProviderStatus[],
  provider: ProviderKind,
): { available: boolean; error?: string } | undefined {
  const status = statuses.find((s) => s.provider === provider);
  return status ? { available: status.available, error: status.message } : undefined;
}

/** The target provider's discovered catalog, or undefined when absent or empty
 *  — same cold-cache fallback: an unknown catalog never refuses a model. */
export function catalogOf(
  models: Partial<Record<ProviderKind, ModelDescriptor[]>>,
  provider: ProviderKind,
): ModelDescriptor[] | undefined {
  const catalog = models[provider];
  return catalog && catalog.length > 0 ? catalog : undefined;
}

// One child this process spawned. Everything the live projection needs that
// the store hasn't persisted yet — running turns, the session's liveness, the
// gate — lives here, so a projection can be recomputed on every event without
// re-reading the DB. `lastProjection` is what the diff-guard compares against
// before emitting thread.spawn-updated: a recompute that changes nothing emits
// nothing — the difference between a calm stream and a firehose.
/** The provider, model and effort one dispatch attempt runs on — the primary
 *  target first, then whichever rung of the fallback chain replaced it. */
export type SpawnAttempt = {
  provider: ProviderKind;
  model?: string;
  effort?: string;
};

export type TrackedChild = {
  threadId: string;
  parentThreadId: string;
  /** The parent's turn that spawned this child — stamped on every child event
   *  (F10), including the engine's own thread.spawned / thread.spawn-updated
   *  announces (the dispatcher map that stamps the session events is only
   *  registered at startThread, which runs AFTER the first announce). */
  parentTurnId: string;
  title: string;
  provider: ProviderKind;
  model?: string;
  effort?: string;
  createdAt: number;
  updatedAt: number;
  turns: SpawnProjectionTurn[];
  gate: SpawnGate | null;
  hasLiveSession: boolean;
  /** True once the child's provider session has been released (F6) — the
   *  one-shot guard so a terminal child's process is stopped exactly once. */
  sessionStopped: boolean;
  tokens?: number;
  lastProjection: SpawnedThread | null;
};

/** Live spawned-thread counts: how many live threads belong to a given parent
 *  and how many are live overall. */
type LiveSpawnCounts = {
  liveChildrenOfParent: number;
  liveSpawnedTotal: number;
};

class SpawnEngineImpl implements SpawnEngine {
  private readonly store: SpawnEngineStore;
  private readonly providers: SpawnEngineProviders;
  private readonly dispatcher: ThreadDispatcher;
  private readonly emit: (event: RuntimeEvent) => void;

  private readonly tracked = new Map<string, TrackedChild>();
  private readonly liveChildren = new Set<string>();
  private readonly unsubscribeEvents: () => void;

  private readonly waitCoordinator: SpawnWaitCoordinator;
  private readonly continuation: ThreadContinuationManager;
  private readonly failoverRunner: SpawnFailoverRunner;

  constructor(deps: SpawnEngineDeps) {
    this.store = deps.store;
    this.providers = deps.providers;
    this.dispatcher = deps.dispatcher;
    this.emit = deps.emit;
    this.unsubscribeEvents = deps.onEvents((event) => this.onEvent(event));

    this.waitCoordinator = new SpawnWaitCoordinator({
      tracked: this.tracked,
      store: this.store,
      snapshot: (threadId) => this.snapshot(threadId),
      isInSubtree: (rootThreadId, threadId) => this.isInSubtree(rootThreadId, threadId),
    });

    this.continuation = new ThreadContinuationManager({
      store: this.store,
      providers: this.providers,
      dispatcher: this.dispatcher,
      tracked: this.tracked,
      liveChildren: this.liveChildren,
      recompute: (child) => this.recompute(child),
      isInSubtree: (rootThreadId, threadId) => this.isInSubtree(rootThreadId, threadId),
    });

    this.failoverRunner = new SpawnFailoverRunner({
      store: this.store,
      providers: this.providers,
      dispatcher: this.dispatcher,
      recompute: (child) => this.recompute(child),
    });
  }

  async spawn(caller: SpawnCaller, request: SpawnRequest): Promise<SpawnThreadResult> {
    const parent = this.store.threadMeta(caller.threadId);
    if (!parent) {
      throw new SpawnError("not_found", `No thread ${caller.threadId} to spawn from.`);
    }

    const fingerprint = fingerprintOf([
      "spawn.thread",
      request.prompt,
      request.target.provider,
      request.target.model,
      request.target.effort,
      request.mode,
      request.title,
      request.delegateToAgentId,
    ]);
    const reserve = this.store.reserveGatewayOp({
      threadId: caller.threadId,
      turnId: caller.turnId,
      requestId: request.requestId,
      kind: "spawn.thread",
      fingerprint,
    });
    if (reserve === null) {
      throw new SpawnError("internal", "Idempotency reserve failed — the op table is unavailable.");
    }
    if (reserve.kind === "replay") {
      // SAFETY: result_json was written by this engine's completion path as JSON.stringify
      // under spawn.thread, so a stored replay deserializes to SpawnThreadResult.
      const stored = reserve.result as SpawnThreadResult;
      return { ...stored, status: "replayed" };
    }
    if (reserve.kind === "conflict") {
      throw new SpawnError(
        "idempotency_conflict",
        `requestId "${request.requestId}" was already used for a different spawn in this turn — use a new requestId, or resend the exact original request to replay it.`,
      );
    }

    const parentMode = await this.resolveParentMode(caller.threadId);
    const parentEffort = await this.resolveParentEffort(caller.threadId);
    const surface = this.providers.cachedSurface();
    const { liveChildrenOfParent, liveSpawnedTotal } = this.liveCounts(caller.threadId);
    const parentDepth = this.store.spawnDepth(caller.threadId);

    const check = checkSpawn({
      prompt: request.prompt,
      target: request.target,
      requestedMode: request.mode,
      parentMode,
      parentEffort,
      parentDepth,
      liveChildrenOfParent,
      liveSpawnedTotal,
      providerStatus: providerStatusOf(surface.statuses, request.target.provider),
      catalog: catalogOf(surface.models, request.target.provider),
      antigravityAcpAvailable: this.providers.isAntigravityAcpAvailable?.() ?? false,
    });
    if (!check.ok) {
      throw new SpawnError(check.code, check.message, check.details);
    }
    const { model, effort, mode, adjustments } = check;

    const threadId = randomUUID();
    const title = request.title ?? buildPromptThreadTitleFallback(request.prompt);
    const now = Date.now();

    const lineage: ThreadLineage = {
      parentThreadId: caller.threadId,
      relationshipToParent: request.delegateToAgentId ? "delegation" : "subagent",
      rootThreadId: parent.lineage?.rootThreadId ?? caller.threadId,
    };
    if (
      !this.store.writeSpawnedThread({
        threadId,
        projectPath: caller.cwd,
        provider: request.target.provider,
        model,
        createdAt: now,
        title,
        lineage,
      })
    ) {
      throw new SpawnError("internal", "Failed to persist the spawned thread row.");
    }

    if (request.delegateToAgentId) {
      this.store.bindThreadAgent(threadId, request.delegateToAgentId);
    }

    const result: SpawnThreadResult = {
      requestId: request.requestId,
      threadId,
      parentThreadId: caller.threadId,
      title,
      provider: request.target.provider,
      model,
      effort,
      mode,
      status: "dispatched",
    };
    if (adjustments.length > 0) result.adjustments = adjustments;
    this.store.setGatewayOpResult({
      threadId: caller.threadId,
      turnId: caller.turnId,
      requestId: request.requestId,
      resultJson: JSON.stringify(result),
    });

    const child: TrackedChild = {
      threadId,
      parentThreadId: caller.threadId,
      parentTurnId: caller.turnId,
      title,
      provider: request.target.provider,
      model,
      effort,
      createdAt: now,
      updatedAt: now,
      turns: [],
      gate: null,
      hasLiveSession: false,
      sessionStopped: false,
      lastProjection: null,
    };
    this.tracked.set(threadId, child);
    this.liveChildren.add(threadId);

    const firstProjection = this.project(child, now);
    child.lastProjection = firstProjection;
    this.emit({
      type: "thread.spawned",
      threadId,
      provider: request.target.provider,
      at: now,
      source: "kone.store",
      parentTurnId: caller.turnId,
      spawned: firstProjection,
    });

    const initialAttempt: SpawnAttempt = { provider: request.target.provider, model, effort };
    const chain: ModelCandidate[] = [...(request.fallbacks ?? [])];
    const admissionCounts: FallbackAdmissionCounts = {
      prompt: request.prompt,
      requestedMode: request.mode,
      parentMode,
      parentEffort,
      parentDepth,
      liveChildrenOfParent,
      liveSpawnedTotal,
    };

    return this.failoverRunner.executeSpawnWithFailover({
      caller,
      request,
      child,
      result,
      initialAttempt,
      chain,
      mode,
      title,
      admissionCounts,
    });
  }

  continueThread(caller: SpawnCaller, request: ContinueThreadRequest): Promise<ContinueThreadResult> {
    return this.continuation.continueThread(caller, request);
  }

  async targets(caller: SpawnCaller): Promise<SpawnTargetsReport> {
    const surface = this.providers.cachedSurface();
    const { liveChildrenOfParent, liveSpawnedTotal } = this.liveCounts(caller.threadId);
    const providers = surface.statuses.map((s) => {
      const entry: SpawnTargetsReport["providers"][number] = {
        provider: s.provider,
        label: s.label,
        available: s.available,
        models: (surface.models[s.provider] ?? []).map((m) => {
          const modelEntry: SpawnTargetsReport["providers"][number]["models"][number] = {
            id: m.id,
            label: m.label,
          };
          if (m.reasoningEfforts && m.reasoningEfforts.length > 0) {
            modelEntry.efforts = m.reasoningEfforts;
          }
          if (m.defaultReasoningEffort) modelEntry.defaultEffort = m.defaultReasoningEffort;
          return modelEntry;
        }),
      };
      if (s.message) entry.hint = s.message;
      return entry;
    });
    const callerEntry: SpawnTargetsReport["caller"] = {
      provider: caller.provider,
      mode: await this.resolveParentMode(caller.threadId),
    };
    if (caller.model) callerEntry.model = caller.model;
    return {
      providers,
      caller: callerEntry,
      limits: {
        depth: this.store.spawnDepth(caller.threadId),
        maxDepth: MAX_SPAWN_DEPTH,
        remainingChildren: Math.max(MAX_LIVE_CHILDREN_PER_PARENT - liveChildrenOfParent, 0),
        remainingAppWide: Math.max(MAX_LIVE_SPAWNED_THREADS - liveSpawnedTotal, 0),
      },
    };
  }

  children(parentThreadId: string): SpawnedThread[] {
    return this.store
      .spawnedChildren(parentThreadId)
      .map((meta) => this.snapshot(meta.threadId))
      .filter((t): t is SpawnedThread => t !== null);
  }

  snapshot(threadId: string): SpawnedThread | null {
    const tracked = this.tracked.get(threadId);
    if (tracked) return this.project(tracked, Date.now());

    const meta = this.store.threadMeta(threadId);
    const lineage = meta ? this.store.threadLineage(threadId) : null;
    if (!meta || !lineage || !isSpawnedRelationship(lineage.relationshipToParent)) return null;
    const span = this.store.threadTurnSpan(threadId);
    const turns: SpawnProjectionTurn[] = [];
    if (span) {
      if (span.runningTurns > 0) {
        turns.push({ turnId: "<recovered>", state: "running", at: span.startedAt });
      } else if (span.endedAt !== null) {
        const state: SpawnProjectionTurn["state"] =
          span.lastState === "interrupted" || span.lastState === "failed"
            ? span.lastState
            : "completed";
        const recoveredTurn: SpawnProjectionTurn = {
          turnId: "<recovered>",
          state,
          at: span.startedAt,
          endedAt: span.endedAt,
        };
        if (span.lastError) recoveredTurn.error = span.lastError;
        turns.push(recoveredTurn);
      }
    }
    return projectSpawnedThread({
      thread: {
        threadId,
        parentThreadId: lineage.parentThreadId ?? threadId,
        title: meta.title ?? "",
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      },
      turns,
      latestAssistantText: this.store.latestAssistantText(threadId),
      gate: null,
      hasLiveSession: false,
      tokens: meta.tokens,
      now: Date.now(),
    });
  }

  isInSubtree(rootThreadId: string, threadId: string): boolean {
    if (threadId === rootThreadId) return true;
    const visited = new Set<string>([threadId]);
    let current = threadId;
    for (let hops = 0; hops < 64; hops++) {
      const lineage = this.store.threadLineage(current);
      if (!lineage || !isSpawnedRelationship(lineage.relationshipToParent)) return false;
      const parent = lineage.parentThreadId;
      if (parent === rootThreadId) return true;
      if (!parent || visited.has(parent)) return false;
      visited.add(parent);
      current = parent;
    }
    return false;
  }

  waitFor(input: {
    threadIds: string[];
    turnIds?: (string | undefined)[];
    timeoutMs?: number;
    scopeThreadId: string;
    signal?: AbortSignal;
  }): Promise<WaiterResult> {
    return this.waitCoordinator.waitFor(input);
  }

  dispose(): void {
    this.unsubscribeEvents();
    this.waitCoordinator.dispose();
    this.tracked.clear();
    this.liveChildren.clear();
  }

  private onEvent(event: RuntimeEvent): void {
    const child = this.tracked.get(event.threadId);
    if (!child) return;
    switch (event.type) {
      case "turn.started":
        child.turns.push({ turnId: event.turnId, state: "running", at: event.at });
        child.gate = null;
        break;
      case "turn.completed":
        this.settleTurn(child, event.turnId, "completed", event.at);
        break;
      case "turn.aborted":
        this.settleTurn(child, event.turnId, event.reason, event.at, event.message);
        break;
      case "approval.requested":
        child.gate = {
          kind: "approval",
          detail: event.approval.title,
          requestId: event.requestId,
          approval: event.approval,
        };
        break;
      case "user-input.requested":
        child.gate = {
          kind: "user-input",
          detail: event.questions[0]?.question ?? "The agent asked the user a question.",
        };
        break;
      case "approval.resolved":
      case "user-input.resolved":
        child.gate = null;
        break;
      case "session.started":
      case "session.state.changed":
        child.hasLiveSession = true;
        break;
      case "session.exited":
        child.hasLiveSession = false;
        if (child.turns.length === 0) {
          child.turns.push({
            turnId: "<session-exited>",
            state: "failed",
            at: event.at,
            endedAt: event.at,
            error: "The child's session exited before its first turn started.",
          });
        }
        break;
      case "thread.token-usage.updated":
        if (event.usage.total !== undefined) child.tokens = event.usage.total;
        break;
      default:
        return;
    }
    child.updatedAt = Math.max(child.updatedAt, event.at);
    this.recompute(child);
  }

  private settleTurn(
    child: TrackedChild,
    turnId: string,
    state: SpawnProjectionTurn["state"],
    endedAt: number,
    error?: string,
  ): void {
    const turn = child.turns.find((t) => t.turnId === turnId);
    if (turn) {
      turn.state = state;
      turn.endedAt = endedAt;
      if (error !== undefined) turn.error = error;
    } else {
      const settledTurn: SpawnProjectionTurn = { turnId, state, at: endedAt, endedAt };
      if (error !== undefined) settledTurn.error = error;
      child.turns.push(settledTurn);
    }
    child.gate = null;
  }

  private recompute(child: TrackedChild): void {
    const spawned = this.project(child, Date.now());
    if (spawned.terminal) this.liveChildren.delete(child.threadId);
    else this.liveChildren.add(child.threadId);

    if (spawned.terminal && child.hasLiveSession && !child.sessionStopped) {
      child.sessionStopped = true;
      void this.providers.stopSession(child.threadId).catch(() => {});
    }

    if (
      child.lastProjection &&
      JSON.stringify(child.lastProjection) === JSON.stringify(spawned)
    ) {
      return;
    }
    child.lastProjection = spawned;
    this.emit({
      type: "thread.spawn-updated",
      threadId: child.threadId,
      provider: child.provider,
      at: Date.now(),
      source: "kone.store",
      parentTurnId: child.parentTurnId,
      spawned,
    });
    this.waitCoordinator.checkWaiters();
  }

  private project(child: TrackedChild, now: number): SpawnedThread {
    return projectSpawnedThread({
      thread: {
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        title: child.title,
        provider: child.provider,
        model: child.model,
        effort: child.effort,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      },
      turns: child.turns,
      latestAssistantText: this.store.latestAssistantText(child.threadId),
      gate: child.gate,
      hasLiveSession: child.hasLiveSession || child.turns.length === 0,
      tokens: child.tokens,
      now,
    });
  }

  private liveCounts(parentThreadId: string): LiveSpawnCounts {
    const liveUnion = new Set([...this.store.liveSpawnedThreadIds(), ...this.liveChildren]);
    const childrenOfParent = new Set(this.store.spawnedChildren(parentThreadId).map((t) => t.threadId));
    let liveChildrenOfParent = 0;
    for (const id of liveUnion) {
      if (childrenOfParent.has(id)) liveChildrenOfParent++;
    }
    return { liveChildrenOfParent, liveSpawnedTotal: liveUnion.size };
  }

  private async resolveParentMode(threadId: string): Promise<InteractionMode> {
    const sessions = await this.providers.listSessions();
    return sessions.find((s) => s.threadId === threadId)?.mode ?? "ask";
  }

  private async resolveParentEffort(threadId: string): Promise<string | undefined> {
    const sessions = await this.providers.listSessions();
    return sessions.find((s) => s.threadId === threadId)?.effort;
  }
}
