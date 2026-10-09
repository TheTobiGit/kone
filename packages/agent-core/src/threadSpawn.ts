import { randomUUID } from "node:crypto";

import type { ModelCandidate } from "./agentModel.js";
import type { AgentSender } from "@kone/protocol/message-sender";
import type { ContractClosedReason } from "@kone/protocol/contract";
import { grantCovers, type AgentGrant, type GrantAccess } from "./agentAccess.js";
import type { ThreadDispatcher } from "./dispatch.js";
import type { ThreadAgentBinding } from "./rosterRecord.js";
import { checkSpawn, type SpawnRefusalDetails } from "./spawnGuards.js";
import {
  projectSpawnedThread,
  type SpawnGate,
  type SpawnProjectionTurn,
} from "./spawnProjection.js";
import { SpawnWaitCoordinator, type SpawnWaitDeps, type WaiterResult } from "./spawnWait.js";
import { ThreadContinuationManager, type SpawnContinuationDeps } from "./spawnContinuation.js";
import {
  ThreadControlManager,
  type AnswerChildInputRequest,
  type AnswerChildInputResult,
  type CancelChildResult,
  type DeclineChildGateRequest,
  type DeclineChildGateResult,
} from "./spawnControl.js";
import { SpawnFailoverRunner, type FallbackAdmissionCounts } from "./spawnFailover.js";
import { buildPromptThreadTitleFallback } from "./threadTitle.js";
import { getHandOffLifecycle } from "./handOffLifecycle.js";
import type { DeliverySettled, JobTurn } from "./gateway/tools/irc.js";
import type { SettledTurnReport, SettleReportSink, StillOut } from "./settleReports.js";
import {
  isSpawnedRelationship,
  MAX_LIVE_CHILDREN_PER_PARENT,
  MAX_LIVE_SPAWNED_THREADS,
  MAX_DELEGATION_DEPTH,
} from "./types.js";
import type {
  AgentPersona,
  ContractTerms,
  HandOffKind,
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
  UserInputAnswers,
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
    contract?: ContractTerms;
  }): boolean;
  threadLineage(threadId: string): ThreadLineage | null;
  /** What one agent was granted on another, beyond the chain. */
  agentGrant?(granteeThreadId: string, targetThreadId: string): AgentGrant | null;
  /** Reopen (null) or close a contractor's contract. A follow-up on a closed
   *  one reopens it: there is more to the job. */
  setContractClosed?(threadId: string, closed: { at: number; reason: ContractClosedReason } | null): boolean;
  /** Bind a delegated child to the agent it runs as, before its first turn
   *  dispatches, so the thread's transcript names who answered. Returns what
   *  the thread is bound to now, or null when the write didn't land — the
   *  answer the engine announces to the renderer. */
  bindThreadAgent(threadId: string, agentId: string): ThreadAgentBinding | null;
  /** Persist the provider/model a child actually started on, after a spawn-time
   *  failover moved it off the primary. The row is written before dispatch, so
   *  a retry that lands on a later candidate has to rewrite the stored target
   *  or the sidebar would keep showing the model that couldn't start. */
  retargetSpawnedThread(threadId: string, provider: ProviderKind, model?: string): void;
  spawnedChildren(parentThreadId: string): StoredThreadMeta[];
  spawnDepth(threadId: string): number;
  liveSpawnedThreadIds(): string[];
  latestAssistantText(threadId: string): string | null;
  /** One turn's OWN final reply — the text a wait pinned to that turn reports
   *  as its summary. Null when the turn said nothing after its last step. */
  turnAssistantText(threadId: string, turnId: string): string | null;
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
  /** Keep how a session's end settled a turn, so a late settle for it,
   *  before or after a restart, cannot rewrite it. False when it could not
   *  be written. */
  sealTurn?(threadId: string, turnId: string, seal: { state: "failed" | "interrupted"; error: string; at: number }): boolean;
  /** The same readout for one turn of the thread; null when the store has
   *  no record of it. */
  turnSpan?(threadId: string, turnId: string): {
    startedAt: number;
    endedAt: number | null;
    runningTurns: number;
    lastState: "running" | "interrupted" | "failed" | "completed" | null;
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
  /** Did somebody ask to end the thread's work (an interrupt or a stop) since
   *  its last send or session start? Read when a session's end seals a turn:
   *  a seal says how the turn ended, not who wanted it ended. */
  endWasAsked?(threadId: string): boolean;
  /** Answer a parked approval on a child thread with a rejection — the ONLY
   *  decision the spawn engine ever sends: decline the proposed action so the
   *  child tries an alternative (reject-once), or decline and stop its turn
   *  (reject-and-stop). The engine never approves. */
  respondToRequest(
    threadId: string,
    requestId: string,
    decision: "reject-once" | "reject-and-stop",
  ): Promise<void>;
  /** Supply domain answers to a child's parked question, unparking its turn to
   *  carry on. */
  respondToUserInput(
    threadId: string,
    requestId: string,
    answers: UserInputAnswers,
  ): Promise<{ owned: boolean }>;
}

export interface SpawnEngineDeps {
  store: SpawnEngineStore;
  providers: SpawnEngineProviders;
  dispatcher: ThreadDispatcher;
  /** Push a runtime event to renderers. The caller wires this so spawn events
   *  are NEVER journaled. */
  emit: (event: RuntimeEvent) => void;
  onEvents: (listener: (event: RuntimeEvent) => void) => () => void;
  /** Where a settled turn nobody collected is sent, so the agent that handed
   *  the work off hears it finished. Absent, results are only ever collected
   *  through waitFor. */
  reports?: SettleReportSink;
  /** Where follow-ups go: a job in the child's inbox, handed over as a turn
   *  of its own, whose id `agent_wait` resolves to that turn. */
  jobs: SpawnJobs;
}

/** The inbox's side of a follow-up sent as a job. */
export interface SpawnJobs {
  postJob(input: {
    to: string;
    projectPath: string;
    message: string;
    sender: AgentSender;
    dedupeKey?: string;
  }): { messageId: string; duplicate: boolean };
  jobTurn(inboxId: string): JobTurn | null;
  /** Hear when a hand-over is settled with its turn. */
  onDeliverySettled(listener: (settled: DeliverySettled) => void): () => void;
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
   *  on the child's session so the model works as that agent. Meaningful
   *  alongside `delegateToAgentId` or `contract`; ignored otherwise. */
  persona?: AgentPersona;
  /** When this spawn is a contract: the terms the calling agent wrote for an
   *  agent it made up on the spot. The child is an agent (a `"delegation"`
   *  edge, counted against the delegation depth) whose identity is kept on its
   *  own thread instead of being bound to a roster row. Never alongside
   *  `delegateToAgentId`. */
  contract?: ContractTerms;
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
  /** The preset sub-agents `worker_start` can invoke by name, in the
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
  /** The teammates `agent_delegate` can hand work to on the caller's
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
  /** The kinds of work the user set a model for, in their order — what a start
   *  or delegation names as `kind`. Dormant kinds (no model) are left out. Same
   *  provenance as `presets`. */
  modelPreferences?: Array<{
    kind: string;
    label: string;
    hint?: string;
    model: { provider: ProviderKind; model: string };
    effort?: string;
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
   *  agent_wait to this exact turn. A follow-up sent as a job has no turn
   *  yet: this is the job's inbox id, which agent_wait resolves to the turn
   *  that carries it. */
  turnId: string;
  /** Sent as a job: waiting in the child's inbox for a turn of its own. */
  job?: boolean;
  /** True when the child's provider session had settled and this follow-up
   *  brought it back up before dispatching. */
  resumed: boolean;
};

/** Decline a parked approval gate on a spawned child of the caller's subtree.
 *  The child stays running and tries an alternative. */
export type { DeclineChildGateRequest, DeclineChildGateResult, CancelChildResult };

/** Answer a parked user-input gate on a spawned child of the caller's
 *  subtree. */
export type { AnswerChildInputRequest, AnswerChildInputResult };

export interface SpawnEngine {
  spawn(caller: SpawnCaller, request: SpawnRequest): Promise<SpawnThreadResult>;
  /** Post a follow-up turn into an existing spawned child of the caller's
   *  subtree, continuing that thread's conversation in place — no new row, no
   *  new sidebar tab. */
  continueThread(caller: SpawnCaller, request: ContinueThreadRequest): Promise<ContinueThreadResult>;
  /** Stop a spawned child of the caller's subtree in place — seal its live
   *  turn, release its provider session, leave its transcript and store row
   *  intact. Never approves or answers anything parked on the child. */
  cancelChild(caller: SpawnCaller, threadId: string): Promise<CancelChildResult>;
  /** Decline a parked approval gate on a spawned child of the caller's
   *  subtree — reject the proposed action so the child unparks and tries an
   *  alternative. Never approves. */
  declineChildGate(
    caller: SpawnCaller,
    request: DeclineChildGateRequest,
  ): Promise<DeclineChildGateResult>;
  /** Answer a parked user-input gate on a spawned child of the caller's
   *  subtree with domain clarification. Never grants a capability. */
  answerChildInput(
    caller: SpawnCaller,
    request: AnswerChildInputRequest,
  ): Promise<AnswerChildInputResult>;
  targets(caller: SpawnCaller): Promise<SpawnTargetsReport>;
  /** Live snapshots of a parent's direct children, oldest first. */
  children(parentThreadId: string): SpawnedThread[];
  snapshot(threadId: string): SpawnedThread | null;
  /** True when `threadId` is `rootThreadId` itself or any spawned descendant. */
  isInSubtree(rootThreadId: string, threadId: string): boolean;
  /** Whether `callerThreadId` may act on `threadId` at `need`: it is up the
   *  thread's chain, or holds a grant that covers it. */
  canReach(callerThreadId: string, threadId: string, need: GrantAccess): boolean;
  /** The agent that handed `threadId` its work stopped or withdrew it: what
   *  its current turn comes to is no news to that agent, so it is not
   *  reported. A follow-up from up the chain lifts it. */
  muteReports(threadId: string): void;
  /** The children `threadId` is parked in agent_wait on, and since when. */
  waitingOn(threadId: string): { threadIds: string[]; since: number } | null;
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
  /** A peer with a follow-up grant asked for the turn under way: its result
   *  goes to that peer, not the parent. Cleared once reported or collected. */
  reportTo?: string;
  /** Worker, delegation or contract — what the UI files the child under. */
  handOff?: HandOffKind;
  /** The name a delegate or contractor runs under. */
  agentName?: string;
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
  /** Taken back on after a restart, by a follow-up: its turns from before are
   *  not in `turns`, only in the store. */
  adopted?: true;
  /** A follow-up the provider took whose turn has not started yet, as far as
   *  the events have said. Cleared by an event for that turn, or by the
   *  session ending or failing. */
  awaitingTurn?: { turnId: string; at: number };
  /** How and when the child's session last ended or failed, by its event. */
  sessionEnd?: SessionEnd;
  /** Turns a session's end settled, running or not yet started. That
   *  settlement is what the parent was told, so a late event for one of
   *  them changes nothing. */
  sealed?: Set<string>;
  /** Interrupted turns a session's end cut off that nobody asked to end, with
   *  what ended it — taken at the seal, so a report sent later still knows. */
  cutOff?: Map<string, string>;
};

/** Does `event` end the wait for the turn the provider took? An event for
 *  that turn does, and so does the session ending or failing under it; an
 *  event for another turn says nothing about this one. */
function endsAwaiting(event: RuntimeEvent, turnId: string): boolean {
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
      return event.turnId === turnId;
    default:
      return endsSession(event);
  }
}

/** How a child's session ended: when, why, how a turn it took but never
 *  started settles, and how a turn it was running settles. */
type SessionEnd = {
  at: number;
  state: "failed" | "interrupted";
  running: "failed" | "interrupted";
  error: string;
};

/** Does `event` say the child's session ended or failed? */
function endsSession(event: RuntimeEvent): boolean {
  if (event.type === "session.exited") return true;
  return event.type === "session.state.changed" && (event.state === "error" || event.state === "stopped");
}

/** What has become of each settled turn's report, for one child. */
type ChildReports = {
  /** Turns a wait already handed to the parent. */
  collected: Set<string>;
  /** Turns settled while the parent was parked in a wait that will return
   *  them — reported only if that wait is abandoned. */
  held: Set<string>;
  /** Turns already reported, with the message that carried each (null when
   *  none went out). */
  reported: Map<string, string | null>;
  muted: boolean;
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
  private readonly reports = new Map<string, ChildReports>();
  private readonly reportSink: SettleReportSink | undefined;
  private readonly unsubscribeEvents: () => void;
  private readonly unsubscribeJobs: (() => void) | null;

  private readonly waitCoordinator: SpawnWaitCoordinator;
  private readonly continuation: ThreadContinuationManager;
  private readonly controls: ThreadControlManager;
  private readonly failoverRunner: SpawnFailoverRunner;

  constructor(deps: SpawnEngineDeps) {
    this.store = deps.store;
    this.providers = deps.providers;
    this.dispatcher = deps.dispatcher;
    this.emit = deps.emit;
    this.reportSink = deps.reports;
    this.unsubscribeEvents = deps.onEvents((event) => this.onEvent(event));

    const jobs = deps.jobs;
    const waitDeps: SpawnWaitDeps = {
      tracked: this.tracked,
      store: this.store,
      snapshot: (threadId) => this.snapshot(threadId),
      storedSnapshot: (threadId, turnId) => this.storedSnapshot(threadId, turnId),
      isInSubtree: (rootThreadId, threadId) => this.canReach(rootThreadId, threadId, "followup"),
      onCollected: (scopeThreadId, threadId, turnId) => this.onCollected(scopeThreadId, threadId, turnId),
      onAbandoned: (scopeThreadId, threadIds) => this.onAbandoned(scopeThreadId, threadIds),
      jobTurn: (inboxId) => jobs.jobTurn(inboxId),
    };
    this.waitCoordinator = new SpawnWaitCoordinator(waitDeps);
    // A job handed over turns a wait pinned to its id into a wait on a turn,
    // which may already have settled.
    // A turn that took a hand-over is under way from that moment, though its
    // turn.started may still be on its way.
    this.unsubscribeJobs = jobs.onDeliverySettled(({ recipient, claimedAt, turnId }) => {
      const child = recipient ? this.tracked.get(recipient) : undefined;
      if (child && turnId) this.markAwaitingTurn(child, turnId, claimedAt ?? Date.now());
      this.waitCoordinator.checkWaiters();
    });

    const continuationDeps: SpawnContinuationDeps = {
      store: this.store,
      providers: this.providers,
      dispatcher: this.dispatcher,
      tracked: this.tracked,
      liveChildren: this.liveChildren,
      recompute: (child) => this.recompute(child),
      adopt: (threadId, parentTurnId, hasLiveSession) => this.adopt(threadId, parentTurnId, hasLiveSession),
      isInSubtree: (rootThreadId, threadId) => this.isInSubtree(rootThreadId, threadId),
      canFollowUp: (callerThreadId, threadId) => this.canReach(callerThreadId, threadId, "followup"),
      jobs,
    };
    this.continuation = new ThreadContinuationManager(continuationDeps);

    this.controls = new ThreadControlManager({
      providers: this.providers,
      tracked: this.tracked,
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
    // A decision turn is for deciding what happens to work already handed
    // off, after a stop: starting more in it would undo the stop.
    if (getHandOffLifecycle()?.isDeciding(caller.threadId)) {
      throw new SpawnError(
        "capability_denied",
        "You were just stopped: decide what happens to the agents working for you with agent_keep_or_stop, and start nothing new in this turn.",
      );
    }

    const fingerprint = fingerprintOf([
      "spawn.thread",
      request.prompt,
      request.target.provider,
      request.target.model,
      // Inherit and provider-default are different requests, so they must not
      // share a fingerprint.
      request.target.effort === null ? "\u0000default" : request.target.effort,
      request.mode,
      request.title,
      request.delegateToAgentId,
      request.contract ? JSON.stringify(request.contract) : undefined,
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
    // A worker is a thread started as one — the "subagent" edge — and starts
    // nothing; only a delegation (or contract) lengthens the agent chain.
    const parentRole = parent.lineage?.relationshipToParent === "subagent" ? "worker" : "agent";
    const childIsAgent = Boolean(request.delegateToAgentId || request.contract);
    const childKind = childIsAgent ? "agent" : "worker";

    const check = checkSpawn({
      prompt: request.prompt,
      target: request.target,
      requestedMode: request.mode,
      parentMode,
      parentEffort,
      parentDepth,
      parentRole,
      childKind,
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
      relationshipToParent: childIsAgent ? "delegation" : "subagent",
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
        contract: request.contract,
      })
    ) {
      throw new SpawnError("internal", "Failed to persist the spawned thread row.");
    }

    if (request.delegateToAgentId) {
      const binding = this.store.bindThreadAgent(threadId, request.delegateToAgentId);
      // Ahead of thread.spawned: a renderer that has not heard the binding
      // shows the child under a name rolled from its id instead of the
      // teammate's, and nothing it does itself would teach it otherwise.
      if (binding) {
        this.emit({
          type: "thread.agent-bound",
          threadId,
          provider: request.target.provider,
          at: now,
          source: "kone.store",
          parentTurnId: caller.turnId,
          binding,
        });
      }
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
      handOff: request.contract ? "contract" : request.delegateToAgentId ? "delegation" : "worker",
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
    const agentName = request.contract?.name ?? request.persona?.name;
    if (agentName && child.handOff !== "worker") child.agentName = agentName;
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
      parentRole,
      childKind,
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

  async continueThread(caller: SpawnCaller, request: ContinueThreadRequest): Promise<ContinueThreadResult> {
    // Asked again: what the child does next is news once more.
    const upChain = this.isInSubtree(caller.threadId, request.threadId);
    if (upChain) this.reportsOf(request.threadId).muted = false;
    const result = await this.continuation.continueThread(caller, request);
    // A granted peer asked: the turn's result is its news, not the parent's.
    const child = this.tracked.get(request.threadId);
    if (child) {
      if (upChain) delete child.reportTo;
      else child.reportTo = caller.threadId;
    }
    return result;
  }

  cancelChild(caller: SpawnCaller, threadId: string): Promise<CancelChildResult> {
    // Before the stop, whose recompute is what settles the child.
    if (this.isInSubtree(caller.threadId, threadId)) this.muteReports(threadId);
    return this.controls.cancelChild(caller, threadId);
  }

  muteReports(threadId: string): void {
    this.reportsOf(threadId).muted = true;
  }

  declineChildGate(
    caller: SpawnCaller,
    request: DeclineChildGateRequest,
  ): Promise<DeclineChildGateResult> {
    return this.controls.declineChildGate(caller, request);
  }

  answerChildInput(
    caller: SpawnCaller,
    request: AnswerChildInputRequest,
  ): Promise<AnswerChildInputResult> {
    return this.controls.answerChildInput(caller, request);
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
        maxDepth: MAX_DELEGATION_DEPTH,
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

  waitingOn(threadId: string): { threadIds: string[]; since: number } | null {
    return this.waitCoordinator.waitingOn(threadId);
  }

  snapshot(threadId: string): SpawnedThread | null {
    const tracked = this.tracked.get(threadId);
    if (tracked) return this.project(tracked, Date.now());
    return this.storedSnapshot(threadId);
  }

  /** Take a spawned child this process did not spawn — one from before a
   *  restart — back on, so its turns from here on are followed live: a wait
   *  reads them as they run, and each settled one is reported to the parent.
   *  It starts with no turns, reading "starting" until the follow-up's turn
   *  begins. Null when the thread is not a spawned child. */
  private adopt(threadId: string, parentTurnId: string, hasLiveSession: boolean): TrackedChild | null {
    const meta = this.store.threadMeta(threadId);
    const lineage = meta ? this.store.threadLineage(threadId) : null;
    if (!meta || !lineage?.parentThreadId || !isSpawnedRelationship(lineage.relationshipToParent)) return null;
    const handOff: HandOffKind =
      lineage.relationshipToParent !== "delegation" ? "worker" : meta.contract ? "contract" : "delegation";
    const boundAgentId = handOff === "delegation" ? this.store.getThreadAgent?.(threadId)?.agentId : undefined;
    const agentName =
      meta.contract?.name ?? (boundAgentId ? this.store.getAgent?.(boundAgentId)?.name ?? undefined : undefined);
    const child: TrackedChild = {
      threadId,
      parentThreadId: lineage.parentThreadId,
      handOff,
      parentTurnId,
      title: meta.title ?? "",
      provider: meta.provider,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      turns: [],
      gate: null,
      hasLiveSession,
      sessionStopped: false,
      lastProjection: null,
      adopted: true,
    };
    if (meta.model) child.model = meta.model;
    if (agentName) child.agentName = agentName;
    if (meta.tokens !== undefined && meta.tokens !== null) child.tokens = meta.tokens;
    child.lastProjection = this.project(child, Date.now());
    this.tracked.set(threadId, child);
    return child;
  }

  /** A spawned child as the store has it, for one this process is not
   *  following: its newest turn recovered from the transcript, or with
   *  `turnId` that turn. A turn the store has no record of is not read as
   *  any other: the snapshot says kone cannot tell how it went. */
  private storedSnapshot(threadId: string, turnId?: string): SpawnedThread | null {
    const meta = this.store.threadMeta(threadId);
    const lineage = meta ? this.store.threadLineage(threadId) : null;
    if (!meta || !lineage || !isSpawnedRelationship(lineage.relationshipToParent)) return null;
    const span = turnId === undefined ? this.store.threadTurnSpan(threadId) : (this.store.turnSpan?.(threadId, turnId) ?? null);
    const turns: SpawnProjectionTurn[] = [];
    if (span) {
      if (span.runningTurns > 0) {
        turns.push({ turnId: turnId ?? "<recovered>", state: "running", at: span.startedAt });
      } else if (span.endedAt !== null) {
        const state: SpawnProjectionTurn["state"] =
          span.lastState === "interrupted" || span.lastState === "failed"
            ? span.lastState
            : "completed";
        const recoveredTurn: SpawnProjectionTurn = {
          turnId: turnId ?? "<recovered>",
          state,
          at: span.startedAt,
          endedAt: span.endedAt,
        };
        if (span.lastError) recoveredTurn.error = span.lastError;
        turns.push(recoveredTurn);
      }
    }
    // Recovered from the store: the edge says worker versus agent, and a
    // contract on the row says which kind of agent.
    const handOff: HandOffKind =
      lineage.relationshipToParent !== "delegation" ? "worker" : meta.contract ? "contract" : "delegation";
    const boundAgentId = handOff === "delegation" ? this.store.getThreadAgent?.(threadId)?.agentId : undefined;
    const agentName =
      meta.contract?.name ?? (boundAgentId ? this.store.getAgent?.(boundAgentId)?.name ?? undefined : undefined);
    const unknownTurn = turnId !== undefined && turns.length === 0;
    const snap = projectSpawnedThread({
      thread: {
        threadId,
        parentThreadId: lineage.parentThreadId ?? threadId,
        handOff,
        agentName,
        title: meta.title ?? "",
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      },
      turns,
      // A pinned turn reports ITS OWN reply; unpinned reports the newest. A
      // turn with no reply is left unsaid, never borrowed from the newest.
      latestAssistantText: unknownTurn
        ? null
        : turnId === undefined
          ? this.store.latestAssistantText(threadId)
          : this.store.turnAssistantText(threadId, turnId),
      gate: null,
      hasLiveSession: false,
      tokens: meta.tokens,
      now: Date.now(),
    });
    if (!unknownTurn) return snap;
    return {
      ...snap,
      status: "uncertain",
      terminal: true,
      detail:
        `kone has no record of how turn ${turnId} on this thread went, so it cannot say. ` +
        "Read the thread with agent_read to see what it did.",
    };
  }

  canReach(callerThreadId: string, threadId: string, need: GrantAccess): boolean {
    if (this.isInSubtree(callerThreadId, threadId)) return true;
    return grantCovers(this.store.agentGrant?.(callerThreadId, threadId)?.access, need);
  }

  /** Who hears how the child's turn went: a granted peer that asked for it,
   *  otherwise its parent. */
  private reportTarget(child: TrackedChild): string {
    return child.reportTo ?? child.parentThreadId;
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
    this.unsubscribeJobs?.();
    this.waitCoordinator.dispose();
    this.tracked.clear();
    this.liveChildren.clear();
    this.reports.clear();
  }

  private onEvent(event: RuntimeEvent): void {
    const child = this.tracked.get(event.threadId);
    if (!child) return;
    const awaiting = child.awaitingTurn;
    if (awaiting && endsAwaiting(event, awaiting.turnId)) delete child.awaitingTurn;
    switch (event.type) {
      case "turn.started":
        // An old start can arrive after the session ended. Only the turn
        // accepted since that end can establish new life without a start
        // announcement for the session itself.
        if (child.sessionEnd && awaiting?.turnId !== event.turnId) return;
        if (child.turns.some((turn) => turn.turnId === event.turnId)) return;
        this.reviveSession(child);
        child.turns.push({ turnId: event.turnId, state: "running", at: event.at });
        child.gate = null;
        break;
      case "turn.completed":
        if (this.ignoresLateSettle(child, event)) return;
        this.settleTurn(child, event.turnId, "completed", event.at);
        break;
      case "turn.aborted":
        if (this.ignoresLateSettle(child, event)) return;
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
          requestId: event.requestId,
          questions: event.questions,
        };
        break;
      case "approval.resolved":
      case "user-input.resolved":
        // A late word on an ask that already left takes nothing down with it.
        if (child.gate?.requestId === event.requestId) child.gate = null;
        break;
      case "session.started":
        this.reviveSession(child);
        break;
      case "session.state.changed":
        if (!endsSession(event)) break;
        this.endSession(child, awaiting, {
          at: event.at,
          state: event.state === "error" ? "failed" : "interrupted",
          running: event.state === "error" ? "failed" : "interrupted",
          error: event.message ?? (event.state === "error" ? "The child's session failed." : "The child's session was stopped."),
        });
        break;
      case "session.exited":
        this.endSession(child, awaiting, {
          at: event.at,
          state: "failed",
          running: "interrupted",
          error: "The child's session exited.",
        });
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

  /** The provider took `turnId`, sent at `since`: until an event for it
   *  comes through, the child reads as running it. Nothing to mark when its
   *  events are already in, or when the session ended or failed since it was
   *  sent — those events came before the mark and will not come again. */
  private markAwaitingTurn(child: TrackedChild, turnId: string, since: number): void {
    if (child.turns.some((t) => t.turnId === turnId)) return;
    const end = child.sessionEnd;
    if (end && end.at >= since) {
      // The session went before the turn could start: the turn ends with it,
      // and is reported like any other.
      this.sealTurn(child, turnId, end.state, end.at, `${end.error} Its turn never started.`);
      this.recompute(child);
      this.scheduleReport(child);
      return;
    }
    child.awaitingTurn = { turnId, at: Date.now() };
    this.recompute(child);
  }

  /** The child's session is up again: an end it reported before no longer
   *  stands, so a turn sent since is not failed for it. */
  private reviveSession(child: TrackedChild): void {
    child.hasLiveSession = true;
    delete child.sessionEnd;
  }

  /** The child's session ended or failed. A turn the provider took that had
   *  not started yet ends with it — failed, or interrupted for a stop — and
   *  is reported like any other; a child that never turned at all ends on a
   *  placeholder, as a spawn that never got going. */
  private endSession(child: TrackedChild, awaiting: TrackedChild["awaitingTurn"], end: SessionEnd): void {
    child.hasLiveSession = false;
    child.sessionEnd = end;
    const unasked = !(this.providers.endWasAsked?.(child.threadId) ?? false);
    const cutOff = (turnId: string, state: "failed" | "interrupted", error: string): void => {
      if (state === "interrupted" && unasked) (child.cutOff ??= new Map()).set(turnId, error);
    };
    // A turn the session was running ends with it, for good: a later session
    // starts turns of its own and never brings this one back.
    for (const turn of child.turns) {
      if (turn.state !== "running") continue;
      this.sealTurn(child, turn.turnId, end.running, end.at, end.error);
      cutOff(turn.turnId, end.running, end.error);
    }
    if (awaiting && !child.turns.some((t) => t.turnId === awaiting.turnId)) {
      this.sealTurn(child, awaiting.turnId, end.state, end.at, `${end.error} Its turn never started.`);
      cutOff(awaiting.turnId, end.state, `${end.error} Its turn never started.`);
    } else if (child.turns.length === 0) {
      this.settleTurn(child, "<session-exited>", end.state, end.at, `${end.error} Its first turn never started.`);
    }
  }

  /** Settle a turn as its session's end decided, here and in the store, for
   *  good: that is what the parent will be told. */
  private sealTurn(child: TrackedChild, turnId: string, state: "failed" | "interrupted", at: number, error: string): void {
    this.settleTurn(child, turnId, state, at, error);
    (child.sealed ??= new Set()).add(turnId);
    if (this.store.sealTurn?.(child.threadId, turnId, { state, error, at }) === false) {
      console.error(`[spawn] could not store the seal of turn ${turnId} on ${child.threadId}; after a restart a late settle can rewrite it`);
    }
  }

  /** Is `event` a late settle for a turn its session's end sealed? */
  private ignoresLateSettle(child: TrackedChild, event: Extract<RuntimeEvent, { type: "turn.completed" | "turn.aborted" }>): boolean {
    if (!child.sealed?.has(event.turnId)) return false;
    const turn = child.turns.find((t) => t.turnId === event.turnId);
    console.warn(
      `[spawn] ignored a late ${event.type} for turn ${event.turnId} on ${child.threadId}: its session's end settled it ${turn?.state ?? "already"}`,
    );
    return true;
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
    // The moment the child stops moving — a turn settled, or the session under
    // a running turn went away. A parked gate is not it: that projection is
    // not terminal.
    const settled = spawned.terminal && child.lastProjection !== null && !child.lastProjection.terminal;
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
    // Waiters first, so a parent parked on this child has collected it before
    // anything decides whether to tell it.
    this.waitCoordinator.checkWaiters();
    if (settled) this.scheduleReport(child);
  }

  private reportsOf(threadId: string): ChildReports {
    let state = this.reports.get(threadId);
    if (!state) {
      state = { collected: new Set(), held: new Set(), reported: new Map(), muted: false };
      this.reports.set(threadId, state);
    }
    return state;
  }

  /** Report the child's newest turn, a moment from now: the event that settled
   *  it is still on its way to the store's other listeners, and the reply text
   *  is read from the transcript they write. Only a real provider turn is
   *  reported — a placeholder for a child that never got one going is a spawn
   *  failure, which the spawn call itself answers. */
  private scheduleReport(child: TrackedChild): void {
    if (!this.reportSink) return;
    const turnId = child.turns[child.turns.length - 1]?.turnId;
    if (!turnId || turnId.startsWith("<")) return;
    queueMicrotask(() => this.report(child, turnId));
  }

  private report(child: TrackedChild, turnId: string): void {
    const sink = this.reportSink;
    if (!sink || this.tracked.get(child.threadId) !== child) return;
    const state = this.reportsOf(child.threadId);
    if (state.reported.has(turnId) || state.collected.has(turnId)) return;
    if (state.muted) {
      state.reported.set(turnId, null);
      return;
    }
    const target = this.reportTarget(child);
    if (this.waitCoordinator.isCollecting(target, child.threadId, turnId)) {
      state.held.add(turnId);
      return;
    }
    state.held.delete(turnId);
    const turn = this.waitCoordinator.snapshotForWait(child.threadId, turnId);
    if (!turn.terminal) return;
    delete child.reportTo;
    const report: SettledTurnReport = {
      childThreadId: child.threadId,
      parentThreadId: target,
      turnId,
      handOff: child.handOff ?? "worker",
      status: turn.status,
    };
    if (turn.summary) report.summary = turn.summary;
    if (turn.detail) report.detail = turn.detail;
    // Only a seal nobody asked for says the session's end cut the turn off:
    // the abort of an interrupt somebody asked for can carry a message too,
    // and a stop can arrive as a bare exit.
    const cutOff = turn.status === "interrupted" ? child.cutOff?.get(turnId) : undefined;
    if (cutOff) report.cutOff = cutOff;
    const stillOut = this.stillOut(child.parentThreadId, child.threadId);
    if (stillOut) report.stillOut = stillOut;
    state.reported.set(turnId, sink.deliver(report));
  }

  /** The parent's other hand-offs still at work — running, starting, or
   *  parked on a question — apart from the one reporting. Null when none. */
  private stillOut(parentThreadId: string, exceptThreadId: string): StillOut | null {
    const out: StillOut = { agents: [], workers: 0 };
    const now = Date.now();
    for (const other of this.tracked.values()) {
      if (other.parentThreadId !== parentThreadId || other.threadId === exceptThreadId) continue;
      if (this.project(other, now).terminal) continue;
      if ((other.handOff ?? "worker") === "worker") out.workers += 1;
      else out.agents.push({ name: other.agentName ?? other.title, title: other.title });
    }
    return out.agents.length > 0 || out.workers > 0 ? out : null;
  }

  /** Only the parent's own wait counts: a wait further up the chain tells that
   *  agent, not the one the child works for. */
  private onCollected(scopeThreadId: string, threadId: string, turnId: string): void {
    const child = this.tracked.get(threadId);
    if (!child || this.reportTarget(child) !== scopeThreadId) return;
    const state = this.reportsOf(threadId);
    state.collected.add(turnId);
    state.held.delete(turnId);
    const messageId = state.reported.get(turnId);
    if (messageId) this.reportSink?.retract(scopeThreadId, messageId);
  }

  private onAbandoned(scopeThreadId: string, threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      const child = this.tracked.get(threadId);
      if (!child || this.reportTarget(child) !== scopeThreadId) continue;
      for (const turnId of this.reportsOf(threadId).held) {
        queueMicrotask(() => this.report(child, turnId));
      }
    }
  }

  private project(child: TrackedChild, now: number): SpawnedThread {
    return projectSpawnedThread({
      thread: {
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        handOff: child.handOff,
        agentName: child.agentName,
        title: child.title,
        provider: child.provider,
        model: child.model,
        effort: child.effort,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      },
      // A follow-up on its way reads as a turn under way; its "<" id is never
      // reported or collected.
      turns: child.awaitingTurn
        ? [...child.turns, { turnId: "<follow-up>", state: "running", at: child.awaitingTurn.at }]
        : child.turns,
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
