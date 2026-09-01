import { randomUUID } from "node:crypto";

import { isQuotaOrRateLimitError } from "./adapters/errors.js";
import type { ModelCandidate } from "./agentModel.js";
import type { ThreadDispatcher } from "./dispatch.js";
import { checkSpawn, type SpawnRefusalDetails } from "./spawnGuards.js";
import {
  projectSpawnedThread,
  type SpawnGate,
  type SpawnProjectionTurn,
} from "./spawnProjection.js";
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
  SendTurnInput,
  Session,
  SessionStartInput,
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

/** The rejection a cancelled wait settles with — named AbortError so the
 *  gateway transport can tell a client-cancelled call from a tool failure. */
function abortWaitError(): Error {
  return Object.assign(new Error("The wait was cancelled."), { name: "AbortError" });
}

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
  }): Promise<{
    threads: SpawnedThread[];
    allTerminal: boolean;
    timedOut: boolean;
    /** The turnId each wait was pinned to (requested, else the child's latest
     *  turn at resolution, else null) — echo back to keep waiting on the same
     *  turn. */
    turnIds: (string | null)[];
  }>;
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
function fingerprintOf(parts: Array<string | number | undefined>): string {
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
function providerStatusOf(
  statuses: ProviderStatus[],
  provider: ProviderKind,
): { available: boolean; error?: string } | undefined {
  const status = statuses.find((s) => s.provider === provider);
  return status ? { available: status.available, error: status.message } : undefined;
}

/** The target provider's discovered catalog, or undefined when absent or empty
 *  — same cold-cache fallback: an unknown catalog never refuses a model. */
function catalogOf(
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
type SpawnAttempt = {
  provider: ProviderKind;
  model?: string;
  effort?: string;
};

type TrackedChild = {
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

type Waiter = {
  ids: string[];
  /** Positionally paired with `ids`; undefined = wait on the child's latest. */
  turnIds?: (string | undefined)[];
  scopeThreadId: string;
  resolve: (out: {
    threads: SpawnedThread[];
    allTerminal: boolean;
    timedOut: boolean;
    turnIds: (string | null)[];
  }) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

class SpawnEngineImpl implements SpawnEngine {
  private readonly store: SpawnEngineStore;
  private readonly providers: SpawnEngineProviders;
  private readonly dispatcher: ThreadDispatcher;
  private readonly emit: (event: RuntimeEvent) => void;

  // Children this process has spawned. A child leaves `liveChildren` (the
  // breadth-cap count) when its projection goes terminal, but stays tracked so
  // its projection never drifts from the live view.
  private readonly tracked = new Map<string, TrackedChild>();
  private readonly liveChildren = new Set<string>();
  private readonly waiters: Waiter[] = [];
  private readonly unsubscribeEvents: () => void;

  constructor(deps: SpawnEngineDeps) {
    this.store = deps.store;
    this.providers = deps.providers;
    this.dispatcher = deps.dispatcher;
    this.emit = deps.emit;
    this.unsubscribeEvents = deps.onEvents((event) => this.onEvent(event));
  }

  async spawn(caller: SpawnCaller, request: SpawnRequest): Promise<SpawnThreadResult> {
    // 1. The parent must exist — parentage is credential-derived, so a missing
    //    row means the caller's session is gone, not a bad request.
    const parent = this.store.threadMeta(caller.threadId);
    if (!parent) {
      throw new SpawnError("not_found", `No thread ${caller.threadId} to spawn from.`);
    }

    // 2. Reserve idempotency FIRST — before any guard — so a genuine retry
    //    returns the original child even if a breadth cap has since filled. A
    //    reserved row with no stored result is treated as never-completed by
    //    the store, so refusing after a reserve is safe.
    const fingerprint = fingerprintOf([
      "spawn.thread",
      request.prompt,
      request.target.provider,
      request.target.model,
      request.target.effort,
      request.mode,
      request.title,
      // A delegation and a plain spawn with the same prompt are different ops —
      // fold the bound agent in so a retry only replays the same kind.
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
      // SAFETY: result_json was written by this engine's own completion path
      // (setGatewayOpResult(JSON.stringify(result))) under an identical
      // kind+fingerprint, so the parsed replay is a SpawnThreadResult.
      const stored = reserve.result as SpawnThreadResult;
      return { ...stored, status: "replayed" };
    }
    if (reserve.kind === "conflict") {
      throw new SpawnError(
        "idempotency_conflict",
        `requestId "${request.requestId}" was already used for a different spawn in this turn — use a new requestId, or resend the exact original request to replay it.`,
      );
    }

    // 3. The parent's approval mode is the child's ceiling. Resolved from the
    //    live session list — never guessed upward: no live session reads as
    //    the most restrictive rung. The parent's effort rides along so a child
    //    that doesn't name one inherits its parent's reasoning strength instead
    //    of silently falling to the provider's default.
    const parentMode = await this.resolveParentMode(caller.threadId);
    const parentEffort = await this.resolveParentEffort(caller.threadId);

    // 4. The breadth caps count every live child — the store's running-block
    //    rows UNION the engine's in-memory set: a child dispatched moments ago
    //    has no running block row yet, and without the union a burst of spawns
    //    inside one turn walks straight through the cap.
    const surface = this.providers.cachedSurface();
    const { liveChildrenOfParent, liveSpawnedTotal } = this.liveCounts(caller.threadId);
    const parentDepth = this.store.spawnDepth(caller.threadId);

    // 5. Admission — every rule lives in checkSpawn (spawnGuards.ts); this
    //    engine only feeds it resolved values and surfaces its verdict.
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
    });
    if (!check.ok) {
      throw new SpawnError(check.code, check.message, check.details);
    }
    const { model, effort, mode, adjustments } = check;

    // 6–7. Agents never choose ids — kone mints them. The title is the
    //    parent's when given, else the same word-cap fallback the renderer
    //    path uses; no second title algorithm.
    const threadId = randomUUID();
    const title = request.title ?? buildPromptThreadTitleFallback(request.prompt);
    const now = Date.now();

    // 8. Persist the child row — the anchor every child event hangs off. The
    //    root id is stamped from the parent's own lineage (falling back to the
    //    parent), so every descendant of one root shares it and subtree checks
    //    are a single lookup.
    const lineage: ThreadLineage = {
      parentThreadId: caller.threadId,
      // A delegation is a spawned child like any other, but its lineage records
      // that the work went to a named agent rather than an anonymous worker.
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

    // Bind the child to the agent it was delegated to BEFORE its first turn
    // dispatches, so every event the thread emits names the agent it ran as
    // from the very first action. The persona (below) carries its instructions
    // into the session; the binding is what makes the transcript read as theirs.
    if (request.delegateToAgentId) {
      this.store.bindThreadAgent(threadId, request.delegateToAgentId);
    }

    // 9. Record the result BEFORE dispatching — a crash mid-dispatch must not
    //    let a retry spawn a second thread.
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

    // Track the child + count it live BEFORE dispatch — the write →
    // turn.started gap is exactly when a burst of spawns would otherwise walk
    // through the cap.
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

    // 10. Announce the child with its first projection — the honest "fresh
    //     child" read before anything has started; updates stream as it lives.
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

    // 11. Dispatch without blocking the caller — spawn() resolves as soon as
    //     the child's first turn is ACCEPTED, never when it completes. The
    //     title + generateTitle: false options keep the title the parent chose
    //     and skip the background naming round-trip.
    //
    //     A target with a fallback chain behind it gets more than one go. When
    //     the start fails specifically because the model is rate limited or its
    //     quota is spent, the engine walks down the chain and restarts the child
    //     on the next candidate the guards admit, rather than handing the parent
    //     a dead child it would only have to respawn by hand. Every other
    //     failure — a crashed CLI, a bad cwd, a refused prompt — goes straight
    //     through: those do not get better on a different model.
    let attempt: SpawnAttempt = { provider: request.target.provider, model, effort };
    const chain: ModelCandidate[] = [...(request.fallbacks ?? [])];

    for (;;) {
      // The rest of the chain rides along to the session and the first turn, so
      // a 429 that lands mid-turn — after the child started cleanly — fails the
      // child over again inside the runtime instead of surfacing as a dead turn.
      const failover = chain.length > 0 ? chain.map((c) => ({ ...c })) : undefined;
      try {
        const startInput: SessionStartInput = {
          threadId,
          provider: attempt.provider,
          cwd: caller.cwd,
          model: attempt.model,
          effort: attempt.effort,
          mode,
          // A delegated child runs as its agent: the persona reaches the session
          // so the model works under that name and its standing instructions.
          // Absent for an anonymous sub-agent spawn, which stays a guest.
          agent: request.persona,
        };
        if (failover) startInput.fallbacks = failover;
        await this.dispatcher.startThread(
          startInput,
          // The child's events carry the spawning turn's id (F10), so a consumer
          // can correlate the child's whole traffic to the parent turn without
          // walking the store.
          { parentTurnId: caller.turnId },
        );
        // The child is now genuinely dispatched: mark the ledger bit AFTER
        // startThread returns (F8), so a crash between the store write and here
        // leaves a reserved-but-undispatched op — which boot-time recovery seals
        // as a failed child instead of leaving it projecting idle forever.
        this.store.markGatewayOpDispatched({
          threadId: caller.threadId,
          turnId: caller.turnId,
          requestId: request.requestId,
        });
        const turnInput: SendTurnInput = { threadId, input: request.prompt };
        if (failover) turnInput.fallbacks = failover;
        const turnStart = await this.dispatcher.sendThreadTurn(
          turnInput,
          { title, generateTitle: false, parentTurnId: caller.turnId },
        );
        // The parent pins kone_wait_for_responses to the child's FIRST turn so a
        // newer turn can't swap the outcome mid-wait (F7). Persist it on the
        // stored result too, so a replay returns the same pin for free.
        result.firstTurnId = turnStart.turnId;
        this.store.setGatewayOpResult({
          threadId: caller.threadId,
          turnId: caller.turnId,
          requestId: request.requestId,
          resultJson: JSON.stringify(result),
        });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Only a rate limit or a spent quota is worth another model, and only
        // while the chain still has one to offer. The next candidate goes
        // through the same guards the primary did — the counts are the ones
        // taken before this child was tracked, so re-admitting it can't trip its
        // own breadth cap.
        const nextTarget = isQuotaOrRateLimitError(err)
          ? this.admitFallback(chain, {
              prompt: request.prompt,
              requestedMode: request.mode,
              parentMode,
              parentEffort,
              parentDepth,
              liveChildrenOfParent,
              liveSpawnedTotal,
            })
          : null;

        if (nextTarget) {
          // Release the half-started session before moving providers, and drop
          // the turns it never really ran: the child is being restarted, not
          // failed, and a settled-failed turn here would make it project as
          // dead for the rest of its life.
          await this.providers.stopSession(threadId).catch(() => {});
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
          this.store.retargetSpawnedThread(threadId, attempt.provider, attempt.model);
          this.recompute(child);
          continue;
        }

        // The row stays — a failed child is visible, not silently erased. The
        // failure can hit sendThreadTurn after startThread succeeded, by which
        // point the live stream has set hasLiveSession and may have pushed a
        // running turn — whose "running" state outranks any failed turn, so the
        // child would read "working" forever. Settle every running turn as
        // failed first, then the projection reads failed + terminal
        // unconditionally.
        const at = Date.now();
        let settledRunning = false;
        for (const turn of child.turns) {
          if (turn.state !== "running") continue;
          settledRunning = true;
          turn.state = "failed";
          turn.endedAt = at;
          turn.error = message;
        }
        // Release any provider session startThread already started before
        // sendThreadTurn failed, so the child process is not leaked in the background.
        if (!child.sessionStopped) {
          child.sessionStopped = true;
          void this.providers.stopSession(child.threadId).catch(() => {});
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
        this.recompute(child);
        throw new SpawnError(
          "provider_unavailable",
          `The child thread could not be started on ${attempt.provider}: ${message}. The child remains visible in a failed state — retry with a fresh requestId once the provider is healthy.`,
        );
      }
    }

    return result;
  }

  /** Take the next candidate off a fallback chain that the spawn guards will
   *  admit, resolving its model and effort the same way the primary target's
   *  were. Consumes the chain as it goes, so a candidate that is refused is
   *  never offered twice, and returns null once nothing is left to try.
   *
   *  `counts` are the caller's own pre-admission numbers: this child is already
   *  tracked as live by the time a fallback is needed, and counting it against
   *  itself would refuse the retry on a breadth cap it has already passed. */
  private admitFallback(
    chain: ModelCandidate[],
    counts: {
      prompt: string;
      requestedMode: InteractionMode | undefined;
      parentMode: InteractionMode;
      parentEffort: string | undefined;
      parentDepth: number;
      liveChildrenOfParent: number;
      liveSpawnedTotal: number;
    },
  ): SpawnAttempt | null {
    const surface = this.providers.cachedSurface();
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
   * Post a follow-up turn into a child thread the caller's subtree already
   * spawned — the second question to a worker, the changed brief to a
   * teammate — continuing that thread's conversation in place.
   *
   * The child keeps its row, its title and its transcript; only a turn is
   * added. A child that is mid-turn gets its follow-up queued behind the live
   * one (the service's durable queue), and a child whose session settled —
   * the engine releases a terminal child's provider process — gets its session
   * brought back up first, resuming the stored provider conversation so the
   * follow-up lands with the child's full context. The dispatch is journaled
   * like the opening brief is: the parent agent said it, and the child's
   * transcript should show what it was actually asked.
   */
  async continueThread(
    caller: SpawnCaller,
    request: ContinueThreadRequest,
  ): Promise<ContinueThreadResult> {
    const message = request.message.trim();
    if (!message) {
      throw new SpawnError("invalid_input", "The follow-up message cannot be empty.");
    }
    // Continuing your own thread is what speaking already does — the only
    // sensible targets are the children the subtree spawned.
    if (request.threadId === caller.threadId) {
      throw new SpawnError(
        "invalid_input",
        "That is your own thread — write your reply instead of continuing it.",
      );
    }
    if (!this.isInSubtree(caller.threadId, request.threadId)) {
      throw new SpawnError(
        "not_found",
        `Thread "${request.threadId}" is not in this conversation's subtree — you can only continue a thread you (or a descendant of yours) spawned.`,
        { threadId: request.threadId },
      );
    }
    return this.dispatchFollowUp(caller, request, message);
  }

  /** The dispatch half of continueThread: idempotency, target resolution,
   *  session wake, and the turn itself. Split out so the refusal checks above
   *  read before anything stateful happens. */
  private async dispatchFollowUp(
    caller: SpawnCaller,
    request: ContinueThreadRequest,
    message: string,
  ): Promise<ContinueThreadResult> {
    // Retry safety. The dispatch bills the child a turn whether or not the
    // caller hears back, so an ambiguous failure retried without a key would
    // run the child twice on the same ask. Same ledger, same semantics as a
    // spawn: same key + same fingerprint replays the stored result.
    if (request.requestId !== undefined) {
      const reserved = this.store.reserveGatewayOp({
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
        // SAFETY: the engine only ever stores JSON.stringify of a
        // ContinueThreadResult under this op kind (below), so a completed row
        // parses back into exactly that shape.
        return reserved.result as ContinueThreadResult;
      }
      if (reserved.kind === "conflict") {
        throw new SpawnError(
          "idempotency_conflict",
          `Request id "${request.requestId}" was already used in this turn with a different follow-up — pass a fresh requestId to send a different message.`,
        );
      }
    }

    const meta = this.store.threadMeta(request.threadId);
    const lineage = meta ? this.store.threadLineage(request.threadId) : null;
    // The subtree check passed, so this row exists and is spawned — its absence
    // here means it was deleted between the two reads. Refuse rather than
    // dispatch a turn into a thread with no row to hang it on.
    if (!meta || !lineage || !isSpawnedRelationship(lineage.relationshipToParent)) {
      throw new SpawnError(
        "not_found",
        `Thread "${request.threadId}" is not a spawned child — nothing to continue.`,
        { threadId: request.threadId },
      );
    }
    return this.wakeAndSend(caller, request, message, meta, lineage);
  }

  /** Session wake (when the child's process had been released) plus the
   *  follow-up dispatch itself. */
  private async wakeAndSend(
    caller: SpawnCaller,
    request: ContinueThreadRequest,
    message: string,
    meta: StoredThreadMeta,
    lineage: ThreadLineage,
  ): Promise<ContinueThreadResult> {
    const tracked = this.tracked.get(request.threadId);
    const live = tracked ? tracked.hasLiveSession : this.providers.hasLiveSession(request.threadId);
    let resumed = false;
    if (!live) {
      resumed = true;
      // Restart exactly what the child ran as: its own provider, model, mode
      // and effort are persisted on the row (the spawn stamped them), and a
      // delegation wakes as its agent again. Resuming the stored provider
      // conversation is what makes this a continuation rather than a stranger
      // reading the transcript cold — and when a provider refuses the resume,
      // the adapter falls back to a fresh conversation and the dispatch path
      // replays the transcript, so the follow-up still lands with context.
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
        // Before startThread, not after: the session.started event that turns
        // these back on the honest way races the recompute that must not read
        // the child as still-stopped.
        tracked.sessionStopped = false;
        tracked.hasLiveSession = true;
      }
      try {
        await this.dispatcher.startThread(startInput, { parentTurnId: caller.turnId });
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
      if (tracked) this.recompute(tracked);
    }

    const finish = (turnId: string): ContinueThreadResult => ({
      threadId: request.threadId,
      parentThreadId: caller.threadId,
      turnId,
      resumed,
    });

    try {
      // A live turn on the child is not an obstacle: the service durably
      // queues this behind it, so a follow-up sent mid-run lands in order.
      // generateTitle stays off — the thread already has its name; a fresh
      // one would erase what the parent (or user) chose.
      const turn = await this.dispatcher.sendThreadTurn(
        { threadId: request.threadId, input: message },
        { generateTitle: false, parentTurnId: caller.turnId },
      );
      if (tracked) {
        // The breadth caps count live children; a child that settled left the
        // live set, and this turn puts it back in before any event does.
        this.liveChildren.add(request.threadId);
      }
      if (request.requestId !== undefined) {
        this.store.setGatewayOpResult({
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

  /** The persona a restarted delegation runs as, read from the thread's agent
   *  binding — the same identity the original session carried. Absent for an
   *  anonymous worker, and absent when the store cannot answer: a follow-up
   *  that wakes a guest is better than one that wakes nobody. */
  private personaFor(threadId: string, lineage: ThreadLineage): AgentPersona | undefined {
    if (lineage.relationshipToParent !== "delegation") return undefined;
    const binding = this.store.getThreadAgent?.(threadId);
    const agentId = binding?.agentId;
    if (!agentId) return undefined;
    const record = this.store.getAgent?.(agentId);
    // A nameless agent has no identity to wake as — a guest that still reads
    // the transcript beats a persona made of nothing.
    if (!record?.name) return undefined;
    const persona: AgentPersona = { name: record.name };
    if (record.instructions) persona.instructions = record.instructions;
    return persona;
  }

  async targets(caller: SpawnCaller): Promise<SpawnTargetsReport> {
    // Never spawn a CLI for this — the cache's last known surface is the
    // truth a model plans against.
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

    // Boot fallback: the engine has no memory of children from previous runs —
    // read what the store knows and project with honest inputs. A row that
    // says running but that nothing is driving must read as interrupted, not
    // working — feed hasLiveSession: false and the projection does the rest.
    const meta = this.store.threadMeta(threadId);
    const lineage = meta ? this.store.threadLineage(threadId) : null;
    if (!meta || !lineage || !isSpawnedRelationship(lineage.relationshipToParent)) return null;
    const span = this.store.threadTurnSpan(threadId);
    const turns: SpawnProjectionTurn[] = [];
    if (span) {
      if (span.runningTurns > 0) {
        // A block the store still marks running — nothing drives it, so the
        // projection reads it interrupted (hasLiveSession: false).
        turns.push({ turnId: "<recovered>", state: "running", at: span.startedAt });
      } else if (span.endedAt !== null) {
        // Settled — read the newest block's own state rather than assuming a
        // completed turn. A turn a previous process left mid-flight was sealed
        // 'interrupted' at boot; reading it as completed would hand the parent
        // a truncated stream as the child's answer. Unknown/null falls back to
        // completed, exactly as before.
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
    // Walk the parent pointers upward. rootThreadId equality would answer "do
    // these share a root", not "is this my descendant" — and a mid-tree
    // orchestrator (A → B → C, a legal depth-2 tree) must be able to wait on
    // and read the child IT spawned, whose row carries the same root as every
    // other descendant. Capped and cycle-guarded like ConversationStore.
    // spawnDepth: a corrupted pointer loop must return false, never hang the
    // main process.
    const visited = new Set<string>([threadId]);
    let current = threadId;
    for (let hops = 0; hops < 64; hops++) {
      const lineage = this.store.threadLineage(current);
      // A side chat carries lineage too and is NOT a spawned descendant — the
      // discriminator gates it out before we step anywhere. A delegation IS a
      // spawned descendant, so it stays in the subtree the parent can reach.
      if (!lineage || !isSpawnedRelationship(lineage.relationshipToParent)) return false;
      const parent = lineage.parentThreadId;
      if (parent === rootThreadId) return true;
      if (!parent || visited.has(parent)) return false;
      visited.add(parent);
      current = parent;
    }
    return false;
  }

  async waitFor(input: {
    threadIds: string[];
    turnIds?: (string | undefined)[];
    timeoutMs?: number;
    scopeThreadId: string;
    signal?: AbortSignal;
  }): Promise<{
    threads: SpawnedThread[];
    allTerminal: boolean;
    timedOut: boolean;
    turnIds: (string | null)[];
  }> {
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
    // A parent may only wait on its own subtree — anything else is a forgery
    // or a bug, and the refusal names the offending id.
    for (const id of input.threadIds) {
      if (!this.isInSubtree(input.scopeThreadId, id)) {
        throw new SpawnError(
          "not_found",
          `Thread "${id}" is not in this conversation's subtree — a parent may only wait on its own spawned children.`,
          { threadId: id },
        );
      }
    }
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        // Cancelled before we even parked — no waiter, no timer, so nothing is
        // left behind to settle this promise later.
        reject(abortWaitError());
        return;
      }
      const waiter: Waiter = {
        ids: [...input.threadIds],
        turnIds: input.turnIds ? [...input.turnIds] : undefined,
        scopeThreadId: input.scopeThreadId,
        resolve,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => this.finishWaiter(waiter, true), timeoutMs);
      this.waiters.push(waiter);
      this.checkWaiter(waiter);
      const signal = input.signal;
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            // The waiter may already have finished (resolved or timed out) —
            // then there is nothing to tear down and this is a no-op.
            const index = this.waiters.indexOf(waiter);
            if (index === -1) return;
            this.waiters.splice(index, 1);
            if (waiter.timeout) clearTimeout(waiter.timeout);
            reject(abortWaitError());
          },
          { once: true },
        );
      }
    });
  }

  dispose(): void {
    this.unsubscribeEvents();
    // Resolve every waiter with whatever state the store knows rather than
    // leaving a parent agent hanging on a promise that will never settle.
    for (const waiter of this.waiters) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      const threads = waiter.ids.map((id, i) => this.snapshotForWait(id, waiter.turnIds?.[i]));
      waiter.resolve({
        threads,
        allTerminal: threads.every((t) => t.terminal),
        timedOut: true,
        turnIds: this.resolvedTurnIds(waiter),
      });
    }
    this.waiters.length = 0;
    this.tracked.clear();
    this.liveChildren.clear();
  }

  // ── live tracking ──────────────────────────────────────────────────────────
  // The engine subscribes to the merged runtime event stream once and folds
  // every event for a tracked child into its projection inputs; every fold
  // recomputes and emits only when the projection actually changed.

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
        // A session that died before its first turn (a provider that crashed
        // on startup, no turn ever started) must not read "starting" forever —
        // seal it failed so the child settles (F8).
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
        // item.*, title updates, other threads' spawn events — none of them
        // move a child's rolled-up state.
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
    // Any turn settling clears the gate — a parked child that answered its own
    // question (or got interrupted) must not keep reading "waiting".
    child.gate = null;
  }

  private recompute(child: TrackedChild): void {
    const spawned = this.project(child, Date.now());
    if (spawned.terminal) this.liveChildren.delete(child.threadId);
    else this.liveChildren.add(child.threadId);
    // Release the child's provider session the moment it settles (F6): each
    // spawned child owns a dedicated provider process, and nothing else ever
    // stops it — children are never in the renderer registry, so the
    // agent:stop-session IPC and quit-time stopAll are the only other callers.
    // The release is not a close: a follow-up turn brings the session back up
    // and resumes the stored conversation. Keep the store row and transcript;
    // only the process goes. One-shot, and idempotent downstream
    // (AgentService.stopSession no-ops for an unknown thread).
    if (spawned.terminal && child.hasLiveSession && !child.sessionStopped) {
      child.sessionStopped = true;
      void this.providers.stopSession(child.threadId).catch(() => {
        // Best-effort: a dead process is already gone; the next session event
        // clears hasLiveSession regardless.
      });
    }
    // A recompute that changes nothing emits nothing — a busy child produces
    // zero events, a child that changes state produces exactly one.
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
    this.checkWaiters();
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
      // A TRACKED child is being driven by this process, so a no-turns child
      // reads "starting" (the spawn is in flight), never "stillborn" — stillborn
      // is the boot-fallback's read for a child nothing is driving. A session
      // that dies before its first turn is sealed failed by onEvent
      // (session.exited), so no live child can strand as "starting" forever.
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

  // ── waiters ────────────────────────────────────────────────────────────────
  // waitFor parks on a promise and resolves as soon as every named thread is
  // terminal — OR any named thread parks on a question/approval, because
  // nothing moves until a human answers and making the parent wait for the
  // full window is pure waste. Timers and listeners are cleared on every exit
  // path; resolution is idempotent (the waiter is removed from the list
  // first).

  private checkWaiter(waiter: Waiter): void {
    const threads = waiter.ids.map((id, i) => this.snapshotForWait(id, waiter.turnIds?.[i]));
    const anyGated = threads.some(
      (t) => t.status === "waiting-for-approval" || t.status === "waiting-for-user-input",
    );
    const allTerminal = threads.every((t) => t.terminal);
    if (anyGated || allTerminal) this.finishWaiter(waiter, false);
  }

  private checkWaiters(): void {
    // Snapshot: checkWaiter can splice entries out of this.waiters, and live
    // array iteration would skip the element shifting into the removed slot.
    for (const waiter of Array.from(this.waiters)) this.checkWaiter(waiter);
  }

  private finishWaiter(waiter: Waiter, timedOut: boolean): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    const threads = waiter.ids.map((id, i) => this.snapshotForWait(id, waiter.turnIds?.[i]));
    waiter.resolve({
      threads,
      allTerminal: threads.every((t) => t.terminal),
      timedOut,
      turnIds: this.resolvedTurnIds(waiter),
    });
  }

  /** The turnId each named wait resolved to — the requested pin, else the child's
   *  latest turn at resolution, else null. Echoed in the wait result so a parent
   *  can keep waiting on the same turn. */
  private resolvedTurnIds(waiter: Waiter): (string | null)[] {
    return waiter.ids.map((id, i) => {
      const requested = waiter.turnIds?.[i];
      if (requested !== undefined) return requested;
      const tracked = this.tracked.get(id);
      if (tracked && tracked.turns.length > 0) {
        return tracked.turns[tracked.turns.length - 1]!.turnId;
      }
      return null;
    });
  }

  /** snapshot, pinned to one turn when a turnId is given, with the one subtree
   *  member that has no spawned-child projection — the scope thread itself —
   *  read as trivially settled (nothing the engine drives is pending on it). */
  private snapshotForWait(threadId: string, turnId?: string): SpawnedThread {
    const tracked = this.tracked.get(threadId);
    if (tracked && turnId) {
      // Pin the wait to this exact turn: a human typing into the child must
      // not swap which turn's outcome the parent collects. A pin whose turn
      // hasn't started yet reads starting (non-terminal), so the wait keeps
      // going.
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
        latestAssistantText: this.store.latestAssistantText(tracked.threadId),
        gate: tracked.gate,
        // Same rule as project(): a tracked child with no pinned turn reads
        // starting, never stillborn.
        hasLiveSession: tracked.hasLiveSession || pinnedTurns.length === 0,
        tokens: tracked.tokens,
        now: Date.now(),
      });
    }
    const snap = this.snapshot(threadId);
    if (snap) return snap;
    const meta = this.store.threadMeta(threadId);
    return {
      threadId,
      parentThreadId: threadId,
      title: meta?.title ?? "",
      // A placeholder provider; only reachable for a scope thread whose row
      // was deleted mid-wait, which is pathological.
      provider: meta?.provider ?? "opencode",
      status: "idle",
      terminal: true,
      createdAt: meta?.createdAt ?? 0,
      updatedAt: meta?.updatedAt ?? 0,
    };
  }
}
