import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getAttachmentStore } from "./AttachmentStore.js";
import { isQuotaOrRateLimitError } from "./adapters/errors.js";
import {
  resolveModelWithFallback,
  type ModelCandidate,
  type ProviderAvailability,
} from "./agentModel.js";
import {
  DONE_CLEARED,
  type CheckpointStore,
  type QueuedTurnEnqueueInput,
  type TurnCheckpointRecord,
} from "./conversationStoreTypes.js";
import {
  checkpointExists,
  createCheckpoint,
  dropCheckpoint,
  previewCheckpointRestore,
  restoreCheckpoint,
} from "@kone/git-core/checkpoint.js";
import { threadWorkingDir } from "./threadWorkspace.js";
import { copyTurnStamp, isCompactionSupported } from "./types.js";
import type { ThreadRuntime } from "./recipientState.js";
import type { CarriedTurn, TurnInbox } from "./inboxDelivery.js";
import { onceEvent, withTimeout, type EventWait } from "./eventWait.js";
import { AntigravityAdapter } from "./adapters/AntigravityAdapter.js";
import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { CursorAdapter } from "./adapters/CursorAdapter.js";
import { ClineAdapter } from "./adapters/ClineAdapter.js";
import { DroidAdapter } from "./adapters/DroidAdapter.js";
import { OpenCodeAdapter } from "./adapters/OpenCodeAdapter.js";
import {
  getConversationStore,
  type ConversationStore,
} from "./ConversationStore.js";
import { buildAgentEnv } from "./processEnv.js";
import {
  cacheModels,
  cacheStatuses,
  readProviderCache,
  type ProviderSurfaceSnapshot,
} from "./providerCache.js";
import {
  disabledProviderStatus,
  providerStatusesEqual,
  stabilizeProviderStatuses,
  statusEnabled,
} from "./providerHealth.js";
import { resolveProviderMaintenance, runProviderUpdate } from "./providerMaintenance.js";
import {
  assertProviderEnabled,
  isProviderEnabled,
  readProviderSettings,
  writeProviderSettings,
} from "./providerSettings.js";
import { sidechatBootstrapForTurn } from "./sidechat.js";
import { forkThreadForEdit } from "./editFork.js";
import { subagentWakePrompt } from "./subagentWake.js";
// Resolved at call time, not imported as a value binding: the dispatcher is
// built after the service (it takes one), so at module load there is nothing to
// bind to. Same lazy-lookup contract the gateway tools use.
import { getThreadDispatcher } from "./dispatch.js";
import { steeredBlockIds } from "@kone/protocol/steer-split";
import type { GatewayHandle } from "./gateway/index.js";
import { withViewBlock } from "./gateway/viewPreamble.js";
import type {
  ApprovalDecision,
  InteractionMode,
  CompactThreadResult,
  EmitEvent,
  ForkThreadAtBlockInput,
  ForkThreadAtBlockResult,
  ModelDescriptor,
  ProviderAdapter,
  ProviderConfig,
  ProviderKind,
  ProviderMaintenance,
  ProviderSettingsMap,
  ProviderStatus,
  ProviderUpdateResult,
  QueuedTurnRow,
  QueuedTurnStore,
  RuntimeEvent,
  Session,
  SendTurnInput,
  SessionStartInput,
  ThreadArchiveResult,
  ThreadCompactionCapability,
  TurnSendOptions,
  TurnStartResult,
  UserInputAnswers,
  UserInputRespondResult,
} from "./types.js";

/** How often the wedge watchdog sweeps live sessions (module constants so the
 *  tuning lives with the mechanism it tunes). */
const WEDGE_SWEEP_MS = 60_000;
/** A live turn that has emitted NO event for this long is presumed wedged —
 *  the provider process is alive but the turn will never advance on its own
 *  (a JSON-RPC call already timed out and rejected, but nothing killed the
 *  child or sealed the turn). The cost of a false positive is a reset instead
 *  of a finish, so this deliberately errs long enough that a genuinely
 *  streaming turn — token-usage events fire continuously while a provider
 *  works — is never mistaken for a dead one. */
const WEDGE_SILENCE_MS = 5 * 60_000;
/** A thread with an in-progress item (a tool call whose result hasn't landed,
 *  or a text block still streaming) is legitimately busy, not silent — a
 *  single long-running tool call can go quiet for many minutes with zero
 *  intermediate events while the provider works exactly as asked. The sweep
 *  uses this much longer threshold whenever a thread has an open item, and
 *  falls back to the short one only once every item has settled. */
const WEDGE_ITEM_SILENCE_MS = 30 * 60_000;

/** How often the idle session reaper sweeps inactive sessions (module constants
 *  so the tuning lives with the mechanism it tunes). */
const IDLE_SWEEP_MS = 5 * 60_000;
/** Inactive session threshold: a session with no active turn and no activity
 *  for this long is cleanly stopped to reclaim child CLI processes and system
 *  resources. Subsequent turns rehydrate/resume on demand. */
const IDLE_THRESHOLD_MS = 30 * 60_000;

/** The thread-retention sweep puts away conversations nobody has touched in a
 *  week — an archive stamp, reversible from the archived view, never a delete.
 *  A shorter pass runs ahead of it: three days of silence marks a thread done,
 *  which stops it asking without hiding it anywhere. Module constants so the
 *  tuning lives with the mechanism it tunes. */
const RETENTION_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_DONE_MS = 3 * 24 * 60 * 60 * 1000;
/** First sweep runs a few minutes after boot rather than instantly — the app
 *  is busy opening projects and rehydrating sessions then, and an archive
 *  stamp landing in the middle of that is pure noise. */
const RETENTION_INITIAL_DELAY_MS = 5 * 60_000;
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

/** How many wakes in a row a thread may be given for its own background
 *  subagents settling.
 *
 *  A wake is a turn; a turn can spawn more background subagents; those settle
 *  and wake it again. Nothing in that loop needs a human, which is what makes it
 *  worth bounding — it is the same shape whether the agent is converging on
 *  something or circling. The count resets the moment a turn arrives that this
 *  did not cause, so the ceiling only ever applies to an unbroken chain. */
const SUBAGENT_WAKE_MAX = 5;
/** Stale threads are archived in small batches with a breath between them, so
 *  a first-run backlog (hundreds of rows) costs a few seconds of idle work
 *  instead of one long blocking loop. */
const RETENTION_BATCH_SIZE = 25;
const RETENTION_BATCH_PAUSE_MS = 50;

/** A native compaction call gets this long before the service calls it failed
 *  — server-side compaction on a large thread takes minutes, not seconds. */
const NATIVE_COMPACT_TIMEOUT_MS = 10 * 60_000;
/** A `/compact` command turn (the fallback for providers without a native
 *  call) is an ordinary turn, but it still must settle eventually — this long. */
const FALLBACK_COMPACT_TIMEOUT_MS = 10 * 60_000;

/** How long a queued follow-up that failed to start waits before each retry.
 *  One delay per retry, so a row gets the first try plus this many more; when
 *  they run out the row is held for the user rather than retried forever. */
const QUEUE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

/** The permission modes a stored queue row's `mode` column can name; anything
 *  else runs in the session's own mode. */
const QUEUED_MODES: readonly InteractionMode[] = ["ask", "accept-edits", "full-access"];


/** How many pre-turn checkpoint refs a thread keeps. Each ref pins one commit
 *  object plus the blobs unique to that snapshot, so an unbounded per-thread
 *  list grows the repo's ref scan and object store a little with every turn —
 *  twenty turns back is far more undo depth than a revert picker can usefully
 *  show, while costing a bounded handful of small commits. Older refs and
 *  their rows are freed together once a newer capture lands past this cap. */
const MAX_TURN_CHECKPOINTS_PER_THREAD = 20;

/** What a command-turn compaction wait observed: the provider's announced
 *  boundary wins; otherwise the turn's own settlement decides — a completed
 *  turn compacted silently, an aborted one compacted nothing — and the
 *  service's fallback budget bounds the wait. */
type CompactionBoundaryOutcome =
  | { outcome: "compacted" }
  | { outcome: "turn-completed" }
  | { outcome: "turn-aborted" }
  | { outcome: "timeout" };

/** A parked provider ask (tool approval / user-input question) that a renderer
 *  reload would otherwise lose: approvals and user-input questions are live
 *  round-trips and are deliberately never journaled, so a re-subscribing
 *  renderer can only re-present them from this snapshot. */
export type PendingInteraction = {
  threadId: string;
  requestId: string;
  kind: "approval" | "user-input";
  /** The exact `approval.requested` / `user-input.requested` event to re-emit. */
  event: RuntimeEvent;
};

/** Constructor tuning for the wedge watchdog and idle session reaper — defaults
 *  to the module constants above; tests shrink them to exercise the sweep
 *  without waiting. */
export type AgentServiceOptions = {
  wedgeSweepMs?: number;
  wedgeSilenceMs?: number;
  wedgeItemSilenceMs?: number;
  idleSweepMs?: number;
  idleThresholdMs?: number;
  /** Thread-retention tuning (see RETENTION_* above). `retentionSweepMs: 0`
   *  disables the sweep entirely — tests and embedders that never want the
   *  archive touched from the background. `retentionDoneMs: 0` disables just
   *  the mark-done pass, keeping the archive pass. */
  retentionSweepMs?: number;
  retentionUnusedMs?: number;
  retentionDoneMs?: number;
  retentionInitialDelayMs?: number;
  /** Context-compaction tuning (see NATIVE/FALLBACK_COMPACT_TIMEOUT_MS above).
   *  Tests shrink these to exercise the orchestration without waiting minutes. */
  compactNativeTimeoutMs?: number;
  compactFallbackTimeoutMs?: number;
  /** Queued-turn retry backoff (see QUEUE_RETRY_DELAYS_MS). Tests shrink it. */
  queueRetryDelaysMs?: readonly number[];
  /** The conversation store's queue surface, injected by tests. Defaults to
   *  the app-wide store (getConversationStore) when absent. */
  store?: QueuedTurnStore;
  /** The conversation store's history slice the archive/retention paths need,
   *  injected by tests. Defaults to the app-wide store when absent. */
  historyStore?: Pick<
    ConversationStore,
    "setArchived" | "setDone" | "threadMeta" | "staleThreadIds"
  >;
  /** The conversation store's turn-checkpoint slice the pre-turn snapshot
   *  path needs, injected by tests. Defaults to the app-wide store when
   *  absent; pass null to disable checkpoints. Which queue slice was injected
   *  never affects this — the two slices are independent options. */
  checkpointStore?: CheckpointStore | null;
  /** Adapters to register instead of the five real ones, handed the service's
   *  emit closure exactly like the real construction path. Injected by tests
   *  so no CLI is ever spawned. */
  adapters?: (emit: EmitEvent) => ProviderAdapter[];
};

/** What restoring a turn's snapshot would change, without changing anything.
 *  `wouldWrite` names checkpoint files whose worktree content differs (the
 *  uncommitted work a restore would overwrite); `wouldDelete` names worktree
 *  files the snapshot does not contain (a hard restore removes them). */
export type PreviewTurnCheckpointResult =
  | { ok: true; wouldWrite: string[]; wouldDelete: string[] }
  | {
      ok: false;
      reason: "missing" | "no-workdir" | "checkpoint-gone" | "failed";
      detail?: string;
    };

/** Outcome of reverting a thread's working tree to a turn's pre-turn
 *  snapshot. `missing` means the turn has no recorded checkpoint, `no-workdir`
 *  means the thread's directory cannot be resolved or is gone from disk
 *  (unknown thread, a worktree that was never materialized, or one that moved
 *  — `detail` names the directory that was expected), `busy` means a turn is
 *  live on the thread and restoring under it would corrupt the running turn,
 *  `checkpoint-gone` means the row survived but the git object behind its ref
 *  did not (garbage-collected, or the repo was re-cloned — `detail` names the
 *  ref), `dirty` means the restore would overwrite uncommitted work and the
 *  caller did not pass `force` (`wouldWrite`/`wouldDelete` name exactly what
 *  would change, so the confirmation step can show it), and `failed` means the
 *  git restore itself refused or left the tree only partly reconciled
 *  (`detail` carries git's own message — nothing fails silently). */
export type RevertTurnCheckpointResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "no-workdir" | "busy" | "checkpoint-gone" | "failed";
      detail?: string;
    }
  | { ok: false; reason: "dirty"; wouldWrite: string[]; wouldDelete: string[] };

/** The failure both checkpoint answers share. Factored so every catch in the
 *  preview/revert paths formats a thrown value or a leftover-files report the
 *  same way, instead of each repeating the coercion. */
type FailedCheckpoint = { ok: false; reason: "failed"; detail?: string };

function failedCheckpoint(cause: unknown): FailedCheckpoint {
  if (cause instanceof Error) return { ok: false, reason: "failed", detail: cause.message };
  return { ok: false, reason: "failed", detail: String(cause) };
}

// The cross-provider facade that lives in the Electron main process. It owns
// the adapter registry, routes thread-scoped calls to the adapter that owns the
// thread, and fans every
// adapter's events out to a single set of listeners (the IPC layer subscribes
// one listener that forwards to the renderer).
//
// Kept plain-TS and framework-free to match kone's git/fs modules — no Effect,
// no DI container. One instance per app, created in main.ts.

export class AgentService {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>();
  /** threadId → provider, so thread-scoped calls find the right adapter. */
  private readonly routing = new Map<string, ProviderKind>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  /** Last known catalog per provider — seeded from disk at construction, so a
   *  cold launch can validate a model id without spawning a probe CLI. */
  private readonly catalogs = new Map<ProviderKind, ModelDescriptor[]>();
  /** The MCP gateway (docs/mcp-gateway-design.md), attached after boot. When
   *  live, each startSession mints a per-session bearer token and stopSession
   *  revokes it — agents reach kone tools over loopback. */
  private gateway: GatewayHandle | null = null;
  /** What waits in each thread's inbox, carried by the next turn to start. */
  private turnInbox: TurnInbox | null = null;
  private warming: Promise<void> | null = null;
  /** The discovery round in flight, so concurrent callers share one set of CLI
   *  spawns instead of racing their own. */
  private discovering: Promise<ProviderStatus[]> | null = null;
  /** Told whenever the provider surface actually changes — the desktop layer
   *  forwards this to every renderer, so a status corrected in the background
   *  reaches the UI without anyone asking for it. */
  private readonly providerListeners = new Set<(statuses: ProviderStatus[]) => void>();
  /** Parked asks per thread (requestId → ask). Approvals/user-inputs are live
   *  round-trips and are never journaled, so this map is the only record a
   *  re-subscribing renderer can be replayed from (reload recovery), and the
   *  precise "waiting on the human" signal the wedge watchdog must respect. */
  private readonly parkedByThread = new Map<string, Map<string, PendingInteraction>>();
  /** Last event arrival per thread — the wedge watchdog's heartbeat and idle reaper clock. */
  private readonly lastActivity = new Map<string, number>();
  /** Turns currently live per thread (turnId) — the wedge watchdog's scope. */
  private readonly activeTurns = new Map<string, string>();
  /** Consecutive subagent wakes per thread — see SUBAGENT_WAKE_MAX. */
  private readonly subagentWakes = new Map<string, number>();
  /** Threads whose next `turn.started` is a wake this service asked for. Held
   *  so the counter can tell its own chain apart from a turn that came from
   *  anywhere else, which is the thing that resets it. */
  private readonly pendingSubagentWakes = new Set<string>();
  /** Threads whose sendTurn is in flight at an adapter but whose turn.started
   *  hasn't landed yet. `activeTurns` alone can't close that window — adapters
   *  emit turn.started from INSIDE sendTurn, after their own awaits — so
   *  without this a burst of sends walks straight past the busy-intercept and
   *  starts concurrent turns on one session. See `isBusy`. */
  private readonly dispatchingTurns = new Set<string>();
  /** Threads with a manual context compaction in flight. One at a time per
   *  thread (the check-then-add in compactThread is synchronous, so two
   *  callers can't both claim it), and no turn may start while one runs — a
   *  turn racing the compaction would read a half-compacted context. Cleared
   *  when the compaction settles or the session goes away. */
  private readonly compactingThreads = new Set<string>();
  /** itemIds currently in-progress per thread (item.started without a matching
   *  item.completed yet) — the wedge sweep's "is this thread legitimately busy"
   *  signal. */
  private readonly openItems = new Map<string, Set<string>>();
  /** When each live turn started — how long a thread has been working. */
  private readonly turnStartedAt = new Map<string, number>();
  /** The tool call each thread is in the middle of, if any — what it is
   *  working on, for a sender deciding whether to disturb it. */
  private readonly activeTool = new Map<string, { itemId: string; name: string; text: string; startedAt: number }>();
  /** Threads whose session is being started right now. */
  private readonly startingSessions = new Set<string>();
  /** Per-thread tail of queued-row deliveries — the drain and Send now share
   *  it, so one row at a time is handed to the provider (withQueueDelivery). */
  private readonly queueDeliveries = new Map<string, Promise<void>>();
  /** Threads with a drain already waiting in their delivery chain. */
  private readonly drainWaiting = new Set<string>();
  /** In-memory mirror of how many rows are queued per thread — the fallback
   *  for `turn.queued` positions when the store read fails. Drift from the
   *  store (crash recovery) self-corrects on the next successful read. */
  private readonly queuedByThread = new Map<string, number>();
  /** The pending retry of a queued follow-up that failed to start, per thread.
   *  One at a time: the drain sends at most one row, so there is at most one
   *  row waiting out its backoff. While one is pending, automatic drains wait
   *  for its timer — a provider that reports the failed turn as aborted
   *  before rejecting the send would otherwise kick an immediate re-drain. */
  private readonly queueRetries = new Map<string, { queueId: string; timer: ReturnType<typeof setTimeout> }>();
  /** Bumped every time a thread's session starts or stops, so a delivery that
   *  outlived its session can tell the session it is looking at is not the
   *  one it delivered into. */
  private readonly sessionGenerations = new Map<string, number>();
  /** Per-thread tail of the checkpoint-revert chain. Restoring a snapshot
   *  rewrites the working tree, so two reverts for one thread must run one
   *  after the other — never interleaved — and the chain entry itself never
   *  rejects, or every later revert would inherit the failure. */
  private readonly revertChains = new Map<string, Promise<void>>();
  /** threadId -> SessionStartInput, remembered so a fallback provider switch can start a session. */
  private readonly sessionInputs = new Map<string, SessionStartInput>();
  /** threadId -> configured fallback chain for the thread. */
  private readonly threadFallbacks = new Map<string, ModelCandidate[]>();
  /** The wedge sweep timer — lazily started on first session, cleared on stopAll. */
  private wedgeTimer: ReturnType<typeof setInterval> | null = null;
  /** The idle session sweep timer — lazily started on first session, cleared on stopAll. */
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** The thread-retention sweep timer — started at construction (retention is
   *  about stored rows, not live sessions, so waiting for a first session
   *  would leave a quiet app un-swept forever), cleared on stopAll. The first
   *  sweep runs off a one-shot delay, the rest on the daily interval. */
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private retentionStartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AgentServiceOptions = {}) {
    const emit: EmitEvent = (event) => this.dispatch(event);
    // Recovery bookkeeping listener: watches the merged stream to keep the
    // parked-ask snapshot, per-thread heartbeat, and live-turn map current.
    // Registered before any adapter, so nothing a provider emits escapes it.
    this.listeners.add((event) => this.trackEvent(event));
    if (options.adapters) {
      for (const adapter of options.adapters(emit)) this.register(adapter);
    } else {
      this.register(new CodexAdapter(emit));
      this.register(new ClaudeAdapter(emit));
      this.register(new OpenCodeAdapter(emit));
      this.register(new CursorAdapter(emit));
      this.register(new DroidAdapter(emit));
      this.register(new ClineAdapter(emit));
      // Antigravity's plugin MCP path needs one-shot gateway bootstraps (its
      // plugin config must stay secret-free on disk) — minted from the session
      // credential through the gateway handle once it's attached.
      this.register(
        new AntigravityAdapter(emit, (sessionToken) =>
          this.gateway?.issueBootstrapToken(sessionToken) ?? null,
        ),
      );
    }
    // Point each adapter at the user's persisted install settings (custom binary
    // path, …) before anything probes or spawns. Unset providers keep their
    // built-in default, so a fresh install behaves exactly as before.
    const settings = readProviderSettings();
    for (const [provider, adapter] of this.adapters) {
      adapter.setConfig?.(settings[provider] ?? {});
    }
    for (const [provider, models] of Object.entries(readProviderCache().models)) {
      if (models?.length) {
        // SAFETY: the provider cache is keyed by ProviderKind at write time.
        this.catalogs.set(provider as ProviderKind, models);
      }
    }
    this.ensureRetentionSweep();
  }

  private register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  private adapter(provider: ProviderKind): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Unsupported agent provider: ${provider}`);
    return adapter;
  }

  private adapterForThread(threadId: string): ProviderAdapter {
    const provider = this.routing.get(threadId);
    if (!provider) throw new Error(`No agent session for thread ${threadId}`);
    return this.adapter(provider);
  }

  /** The conversation store's queue surface: the injected one (tests), else
   *  the app-wide store. */
  private get queueStore(): QueuedTurnStore {
    return this.options.store ?? getConversationStore();
  }

  /** Subscribe to the merged runtime event stream. Returns an unsubscribe fn. */
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The conversation store's history slice (archive stamps, thread metadata,
   *  retention candidates) — the injected test double when present, else the
   *  app-wide singleton. */
  private get historyStore(): AgentServiceOptions["historyStore"] | null {
    if (this.options.historyStore) return this.options.historyStore;
    // getConversationStore lazily opens the real store; when the queue slice
    // was injected for tests but no history store was, archive paths have no
    // real store to touch and must degrade to a no-op rather than open one.
    if (this.options.store) return null;
    return getConversationStore();
  }

  /** The conversation store's checkpoint slice (pre-turn snapshots) — the
   *  injected test double when present, explicitly null when checkpoints are
   *  disabled, else the app-wide singleton. Every checkpoint path degrades to
   *  doing nothing on null instead of crashing the turn it was meant to
   *  protect. */
  private get checkpointStore(): CheckpointStore | null {
    if (this.options.checkpointStore !== undefined) return this.options.checkpointStore;
    return getConversationStore();
  }

  /** Wire the MCP gateway in (boot): session lifecycle starts minting and
   *  revoking gateway credentials, and the gateway watches the turn stream
   *  for its authority boundary. */
  attachGateway(gateway: GatewayHandle): void {
    this.gateway = gateway;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /** The last known provider surface, straight off the disk cache — no CLI is
   *  spawned, so this answers in microseconds. The renderer hydrates its picker
   *  from this at app open and refreshes in the background, which is what makes
   *  a cold launch present a provider list that's actually usable rather than
   *  one that only *looks* populated. Empty on a first-ever run. */
  cachedSurface(): ProviderSurfaceSnapshot {
    const surface = readProviderCache();
    const settings = readProviderSettings();
    // Manual-compaction support derives at read time from the live adapter
    // union — the disk snapshot carries no copy (see providerCache.ts), so a
    // stale flag can never linger past the adapter that owns it.
    const statuses = surface.statuses.map((status) => {
      const supportsThreadCompaction = isCompactionSupported(
        this.adapters.get(status.provider)?.capabilities.compaction,
      );
      return isProviderEnabled(status.provider, settings)
        ? { ...status, enabled: statusEnabled(status), supportsThreadCompaction }
        : { ...disabledProviderStatus(status.provider, status.label), supportsThreadCompaction };
    });
    return { ...surface, statuses };
  }

  /** Probe every provider on the user's machine — what's installed + logged in.
   *
   *  Folded over the previous round before it is published or persisted: a probe
   *  that timed out reports no verdict, and letting one slow CLI overwrite a
   *  known-good row would put that wrong answer on disk, where the next cold
   *  launch hydrates it as fact. */
  async discover(): Promise<ProviderStatus[]> {
    // Single-flight: discovery spawns a CLI per provider, and two surfaces
    // asking at once (the picker opening while warmup is still running) would
    // otherwise pay for that twice and race each other to the disk snapshot.
    this.discovering ??= (async () => {
      try {
        const settings = readProviderSettings();
        const cached = readProviderCache().statuses;
        const probed = await Promise.all(
          [...this.adapters.values()].map(async (a) => {
            // Manual-compaction support is adapter code truth — derived from
            // the adapter's compaction union here, never probed or persisted.
            const supportsThreadCompaction = isCompactionSupported(a.capabilities.compaction);
            if (!isProviderEnabled(a.provider, settings)) {
              const prev = cached.find((s) => s.provider === a.provider);
              return {
                ...disabledProviderStatus(a.provider, prev?.label ?? a.provider),
                supportsThreadCompaction,
              };
            }
            const status = await a.discover();
            return {
              ...status,
              enabled: statusEnabled(status),
              supportsThreadCompaction,
            };
          }),
        );
        const statuses = stabilizeProviderStatuses(cached, probed);
        this.publishStatuses(statuses);
        return statuses;
      } finally {
        this.discovering = null;
      }
    })();
    return this.discovering;
  }

  /** Subscribe to provider-surface changes. Returns an unsubscribe fn. */
  onProvidersChanged(listener: (statuses: ProviderStatus[]) => void): () => void {
    this.providerListeners.add(listener);
    return () => this.providerListeners.delete(listener);
  }

  /** Persist a discovery round and announce it — but only when something the
   *  user could see actually moved. Every probe writes a `checkedAt`-free row,
   *  so an unchanged surface compares equal and stays silent rather than waking
   *  every renderer on a timer. */
  private publishStatuses(statuses: ProviderStatus[]): void {
    const changed = !providerStatusesEqual(readProviderCache().statuses, statuses);
    cacheStatuses(statuses);
    if (!changed) return;
    for (const listener of this.providerListeners) {
      try {
        listener(statuses);
      } catch (error) {
        // One bad subscriber must not strand the others or the probe round.
        console.error("[agent] provider status listener failed:", error);
      }
    }
  }

  async listModels(provider: ProviderKind): Promise<ModelDescriptor[]> {
    const models = await this.adapter(provider).listModels();
    if (models.length) {
      this.catalogs.set(provider, models);
      cacheModels(provider, models);
    }
    return models;
  }

  /** Refresh the whole surface in the background at app open: discover, then
   *  pull each installed provider's catalog, writing both through to disk. The
   *  point is that by the time the user sends anything, `catalogFor` is warm —
   *  validation on the send path must never be the thing that spawns a CLI.
   *  Deduped, and never rejects: a missing or broken CLI just leaves the
   *  previous snapshot in place. */
  warm(): Promise<void> {
    this.warming ??= (async () => {
      try {
        const found = await this.discover();
        await Promise.all(
          found
            .filter((s) => s.available)
            .map((s) => this.listModels(s.provider).catch(() => [])),
        );
      } catch {
        // Warming is opportunistic — the cached snapshot stays valid.
      } finally {
        this.warming = null;
      }
    })();
    return this.warming;
  }

  /** The catalog we already know for `provider`, or undefined if we've never
   *  successfully read one. Deliberately non-spawning: the validators below run
   *  on the send path, and `listModels()` there would stall the user's turn
   *  behind a fresh `codex app-server` handshake. Unknown catalog → no
   *  validation, which is the same permissive behaviour as a failed probe. */
  private catalogFor(provider: ProviderKind): ModelDescriptor[] | undefined {
    const known = this.catalogs.get(provider);
    if (known?.length) return known;
    // Nothing in memory yet — kick off a refresh so the *next* turn is guarded,
    // but don't make this one wait for it.
    void this.listModels(provider).catch(() => []);
    return undefined;
  }

  // ── install settings ────────────────────────────────────────────────────────

  /** The user's persisted per-provider install settings (binary paths, …). */
  getProviderSettings(): ProviderSettingsMap {
    return readProviderSettings();
  }

  /** Persist one provider's install settings and apply them to its live adapter
   *  so the next discover / session picks up the change without a restart.
   *  Returns the full updated map. */
  setProviderSettings(provider: ProviderKind, config: ProviderConfig): ProviderSettingsMap {
    const prevSettings = readProviderSettings();
    const wasEnabled = isProviderEnabled(provider, prevSettings);
    const next = writeProviderSettings(provider, config);
    this.adapters.get(provider)?.setConfig?.(next[provider] ?? {});
    if (wasEnabled !== isProviderEnabled(provider, next)) {
      void this.discover();
    }
    return next;
  }

  // ── install maintenance ─────────────────────────────────────────────────────

  /** The version discovery last read for `provider`. Taken from the disk
   *  snapshot rather than a fresh probe: maintenance is about the install, and
   *  re-spawning five `--version` handshakes to decorate a settings pane is
   *  exactly the kind of thing kone keeps off the interactive path. */
  private knownVersion(provider: ProviderKind): string | null {
    const status = readProviderCache().statuses.find((s) => s.provider === provider);
    return status?.version ?? null;
  }

  /** Where each provider's CLI came from, and whether it's behind. `checkLatest`
   *  is what makes this a network call, so callers that only want the local
   *  facts (install channel, resolved path, update command) can leave it off. */
  async providerMaintenance(options?: {
    checkLatest?: boolean;
    force?: boolean;
  }): Promise<ProviderMaintenance[]> {
    const env = await buildAgentEnv();
    const settings = readProviderSettings();
    return Promise.all(
      [...this.adapters.keys()].map((provider) => {
        const input: Parameters<typeof resolveProviderMaintenance>[0] = {
          provider,
          currentVersion: this.knownVersion(provider),
          env,
          checkLatest: options?.checkLatest ?? true,
          force: options?.force ?? false,
        };
        const binaryPath = settings[provider]?.binaryPath;
        if (binaryPath) input.binaryOverride = binaryPath;
        return resolveProviderMaintenance(input);
      }),
    );
  }

  /** Update one provider's CLI through the channel that installed it, then
   *  re-probe so the caller sees the version that actually landed. A run that
   *  succeeded without moving the version reports `unchanged` — "already up to
   *  date" is a real outcome, and calling it success invites the user to wonder
   *  why nothing happened. */
  async updateProvider(provider: ProviderKind): Promise<ProviderUpdateResult> {
    const env = await buildAgentEnv();
    const settings = readProviderSettings();
    const override = settings[provider]?.binaryPath;
    const before = this.knownVersion(provider);

    const updateInput: Parameters<typeof runProviderUpdate>[0] = {
      provider,
      env,
    };
    if (override) updateInput.binaryOverride = override;
    const run = await runProviderUpdate(updateInput);

    if (run.outcome === "unsupported") {
      const maintenanceInput: Parameters<typeof resolveProviderMaintenance>[0] = {
        provider,
        currentVersion: before,
        env,
        checkLatest: false,
      };
      if (override) maintenanceInput.binaryOverride = override;
      return {
        provider,
        outcome: run.outcome,
        message: run.message,
        output: run.output,
        maintenance: await resolveProviderMaintenance(maintenanceInput),
        statuses: readProviderCache().statuses,
      };
    }

    // The install moved (or tried to), so everything downstream of it is stale:
    // re-probe every provider and refresh the model catalog, since a new CLI can
    // ship new models.
    const statuses = await this.discover();
    const after = statuses.find((s) => s.provider === provider)?.version ?? null;
    void this.listModels(provider).catch(() => []);

    const maintenanceInput: Parameters<typeof resolveProviderMaintenance>[0] = {
      provider,
      currentVersion: after,
      env,
      checkLatest: true,
      force: true,
    };
    if (override) maintenanceInput.binaryOverride = override;
    const maintenance = await resolveProviderMaintenance(maintenanceInput);

    const outcome =
      run.outcome === "succeeded" && before && after && before === after ? "unchanged" : run.outcome;
    return { provider, outcome, message: run.message, output: run.output, maintenance, statuses };
  }

  // ── lifecycle (routed) ──────────────────────────────────────────────────────

  /** Drop a model id that doesn't belong to `provider`, so a renderer-side
   *  provider/model desync can't reach the CLI verbatim and come back as an
   *  opaque upstream 400 (a Cursor `composer-*` id sent to Codex draws
   *  "The 'composer-2.5' model is not supported when using Codex with a ChatGPT
   *  account."). Returning undefined lets the provider pick its own default — a
   *  working turn on the default model beats a dead thread. Only acts when the
   *  catalog is non-empty, so a failed probe never strips a legitimate model. */
  private validModelFor(provider: ProviderKind, model: string | undefined): string | undefined {
    if (!model) return model;
    const catalog = this.catalogFor(provider);
    if (!catalog) return model;
    if (catalog.some((m) => m.id === model)) return model;
    console.warn(
      `[agent] dropping model "${model}" — not in ${provider}'s catalog; using provider default`,
    );
    return undefined;
  }

  /** Same desync story as `validModelFor`, one axis over. `"base"` is a
   *  renderer-internal sentinel from modelCatalog meaning "this model has no
   *  reasoning-effort axis" — it is not a provider value and must never cross
   *  the IPC boundary, or Codex answers with
   *  "[reasoning.effort] Invalid value: 'base'". Beyond that, an effort the
   *  chosen model doesn't list (a tier carried over from another provider's
   *  ladder) is dropped so the provider applies its own default. */
  private validEffortFor(
    provider: ProviderKind,
    model: string | undefined,
    effort: string | undefined,
  ): string | undefined {
    if (!effort || effort === "base") return undefined;
    if (!model) return effort;
    const catalog = this.catalogFor(provider);
    if (!catalog) return effort;
    const efforts = catalog.find((m) => m.id === model)?.reasoningEfforts;
    if (!efforts || efforts.length === 0 || efforts.includes(effort)) return effort;
    console.warn(
      `[agent] dropping effort "${effort}" — not supported by ${provider}/${model}; using provider default`,
    );
    return undefined;
  }

  async startSession(input: SessionStartInput): Promise<Session> {
    this.startingSessions.add(input.threadId);
    try {
      return await this.startSessionNow(input);
    } finally {
      this.startingSessions.delete(input.threadId);
    }
  }

  private async startSessionNow(input: SessionStartInput): Promise<Session> {
    this.bumpSessionGeneration(input.threadId);
    assertProviderEnabled(readProviderSettings(), input.provider);
    this.sessionInputs.set(input.threadId, input);
    if (input.fallbacks && input.fallbacks.length > 0) {
      this.threadFallbacks.set(input.threadId, input.fallbacks);
    }
    const model = this.validModelFor(input.provider, input.model);
    const effort = this.validEffortFor(input.provider, model, input.effort);
    // Mint the gateway credential first so the adapter can inject it into the
    // provider session's mcpServers config. Restarting a thread revokes the
    // prior token (GatewayCredentials.issueSessionToken). The endpoint port
    // resolves a beat after boot; awaiting `ready` guarantees the URL is real
    // before a provider process tries to reach it.
    const gatewayConnection = this.gateway
      ? (await this.gateway.ready, this.gateway.connectionForThread(input.threadId, input.provider, model))
      : undefined;
    const session = await this.adapter(input.provider).startSession({
      ...input,
      model,
      effort,
      gatewayConnection,
    });
    this.lastActivity.set(input.threadId, Date.now());
    this.routing.set(input.threadId, input.provider);
    this.ensureWedgeWatchdog();
    this.ensureIdleReaper();
    // Crash-recovery drain: queued rows survive a quit, so when the thread
    // reopens and a session comes up, any rows still waiting are promoted
    // into it (boot itself has no sessions, so there is nothing to drain
    // until a session actually exists for the thread).
    this.promoteQueuedTurns(input.threadId);
    return session;
  }

  async sendTurn(input: SendTurnInput, options?: TurnSendOptions): Promise<TurnStartResult> {
    this.lastActivity.set(input.threadId, Date.now());
    // SendTurnInput.model overrides the session model per turn (CodexAdapter
    // sets `session.model = input.model`), so guarding startSession alone left
    // the desync fully live — every turn re-supplied the foreign id.
    const provider = this.routing.get(input.threadId);
    if (provider) assertProviderEnabled(readProviderSettings(), provider);
    // A fork's FIRST turn carries the one-shot context bootstrap
    // (sidechat.ts): the imported transcript, the boundary instruction, and
    // the user's message wrapped in `<latest_user_message>`. Null for every
    // other turn/thread. Overlong turns (imported context + message > send
    // cap) reject here, up front.
    const sidechatInput = sidechatBootstrapForTurn(input.threadId, input.input);
    // dispatchMode is the service's own routing hint — strip it before
    // anything reaches an adapter (adapters don't know the queue exists).
    const { dispatchMode, ...base } = input;
    const next = sidechatInput ? { ...base, input: sidechatInput } : base;
    if (!provider) return this.adapterForThread(input.threadId).sendTurn(this.withViewBlock(next));
    const model = this.validModelFor(provider, next.model);
    const effort = this.validEffortFor(provider, model, next.effort);
    const routed = { ...next, model, effort };
    // A compaction in flight owns the session until its boundary lands — but
    // the user's words still belong in the transcript's future, not in an
    // error. Queue behind it exactly like a busy send: the row promotes when
    // the compaction settles (see compactThread) and runs against the
    // compacted context.
    if (this.isCompacting(input.threadId)) {
      return this.enqueueTurn(routed, dispatchMode ?? "queue", provider);
    }
    // Busy-intercept: a live turn means this follow-up is durably enqueued
    // rather than racing the live turn (sending straight to the adapter would
    // start a second concurrent turn on the same session). `steer` requests
    // that reach sendTurn go through the same queue — steers claim first.
    //
    // `dispatchingTurns` is the second half of "busy": `activeTurns` is fed by
    // the turn.started EVENT, which adapters emit partway through their own
    // sendTurn (ClaudeAdapter awaits the attachment read and the live-settings
    // apply first). Two sends landing in the same tick therefore both saw an
    // empty activeTurns and both reached the adapter — the second overwriting
    // the session's activeTurnId and resetting its scopes. The marker is set
    // before the first await below, so the second call's synchronous prologue
    // sees it and queues instead.
    if (this.isBusy(input.threadId)) {
      return this.enqueueTurn(routed, dispatchMode ?? "queue", provider);
    }
    return this.dispatchToAdapter(input.threadId, routed, input.userBlockId, undefined, options);
  }

  /** Is this thread already running (or about to run) a turn? True while a
   *  turn.started has landed without its settlement, AND across the window
   *  where a sendTurn has been handed to an adapter but the adapter hasn't
   *  announced the turn yet. */
  private isBusy(threadId: string): boolean {
    return this.activeTurns.has(threadId) || this.dispatchingTurns.has(threadId);
  }

  /** Whether this thread has a live provider session — the only threads a wake
   *  or a steer can reach. A thread with none is not broken, just away: whatever
   *  was addressed to it keeps until it comes back. */
  hasLiveSession(threadId: string): boolean {
    return this.routing.has(threadId);
  }

  /** The public read of `isBusy`, for callers deciding whether to steer a
   *  running turn or start one. */
  isThreadBusy(threadId: string): boolean {
    return this.isBusy(threadId);
  }

  /** Whether `provider` can take a message into a running turn. One that
   *  cannot gets it as the next turn instead. */
  providerSteers(provider: ProviderKind): boolean {
    return this.adapters.get(provider)?.steerTurn !== undefined;
  }

  /** Whether `provider` still holds a finished tool call's result after its
   *  turn is cancelled — what kone steer needs before it may interrupt a
   *  provider that cannot steer. False for an unknown provider. */
  providerCancelKeepsCompletedTools(provider: ProviderKind): boolean {
    return this.adapters.get(provider)?.capabilities.cancelKeepsCompletedTools === true;
  }

  /** What one thread is doing right now, read-only: what a sender looks at
   *  before deciding whether a message is worth disturbing it. */
  threadRuntime(threadId: string): ThreadRuntime {
    const provider = this.routing.get(threadId) ?? null;
    const parked = this.parkedByThread.get(threadId);
    let gate: ThreadRuntime["parked"] = null;
    let parkedSince: number | null = null;
    for (const ask of parked?.values() ?? []) {
      if (gate !== "approval") gate = ask.kind;
      parkedSince = Math.min(parkedSince ?? ask.event.at, ask.event.at);
    }
    const tool = this.activeTool.get(threadId);
    return {
      live: provider !== null,
      starting: this.startingSessions.has(threadId),
      busy: this.isBusy(threadId),
      turnStartedAt: this.turnStartedAt.get(threadId) ?? null,
      parked: gate,
      parkedSince,
      compacting: this.isCompacting(threadId),
      steers: provider ? this.providerSteers(provider) : null,
      activeTool: tool ? { name: tool.name, text: tool.text, startedAt: tool.startedAt } : null,
      lastActivityAt: this.lastActivity.get(threadId) ?? null,
    };
  }

  /** Every thread with a turn live right now: the announced turn id, or null
   *  while a send is still on its way to the adapter and no turn has been
   *  announced yet. The quit-resume record snapshots this — those are the
   *  threads a quit would otherwise strand mid-turn. */
  inFlightTurns(): Array<{ threadId: string; turnId: string | null }> {
    const flights: Array<{ threadId: string; turnId: string | null }> = [];
    for (const [threadId, turnId] of this.activeTurns) flights.push({ threadId, turnId });
    for (const threadId of this.dispatchingTurns) {
      if (!this.activeTurns.has(threadId)) flights.push({ threadId, turnId: null });
    }
    return flights;
  }

  /** Whether the Antigravity ACP server resolves on this machine — the spawn
   *  guard's mode-floor input (an ACP-served child may run below full-access;
   *  a print-served one may not). False for test doubles and non-facade
   *  registrations. */
  isAntigravityAcpAvailable(): boolean {
    const adapter = this.adapters.get("antigravity");
    return adapter instanceof AntigravityAdapter && adapter.acpAvailable();
  }

  /** Hand one turn to the thread's adapter, holding the in-flight marker for
   *  the duration so a concurrent send queues behind it instead of starting a
   *  second turn on the same session. The marker is released on settle: by
   *  then the adapter has emitted turn.started, so `activeTurns` carries the
   *  busy signal on. */
  /** Snapshot of current provider and model availability across installed adapters. */
  buildAvailabilitySnapshot(): ProviderAvailability[] {
    const cached = this.cachedSurface();
    const providers = new Set<ProviderKind>([
      ...this.adapters.keys(),
      ...cached.statuses.map((s) => s.provider),
    ]);
    const result: ProviderAvailability[] = [];
    for (const provider of providers) {
      const status = cached.statuses.find((s) => s.provider === provider);
      const catalog = this.catalogs.get(provider) ?? cached.models[provider] ?? [];
      result.push({
        provider,
        available: status ? status.available : this.adapters.has(provider),
        models: catalog.map((m) => m.id),
      });
    }
    return result;
  }

  /** The turn as the provider should receive it. For the assistant's threads
   *  that is the user's words behind a `<kone_view>` block describing their
   *  screen (gateway/viewPreamble.ts); every other turn passes through as is.
   *  Applied at the last step before an adapter, so a queued follow-up is
   *  described as the screen stands when it runs rather than when it was typed,
   *  and so the block never reaches the queue row or the transcript. */
  private withViewBlock(input: SendTurnInput): SendTurnInput {
    const block = this.gateway?.viewBlockFor(input.threadId) ?? null;
    return block ? { ...input, input: withViewBlock(input.input, block) } : input;
  }

  /** Hand one turn to the adapter, with what waits in the thread's inbox
   *  folded in front of it when the turn slot carries the inbox. What it
   *  carries is settled with the turn the provider starts, and waits again
   *  when the provider refuses it. `carried` is a turn the inbox already
   *  built — one that carries nothing else. */
  private async dispatchToAdapter(
    threadId: string,
    turn: SendTurnInput,
    ownBlockId?: string,
    carried?: CarriedTurn,
    hooks?: TurnSendOptions,
  ): Promise<TurnStartResult> {
    const carry = carried ?? this.turnInbox?.carry(threadId, turn, ownBlockId) ?? null;
    let accepted = false;
    try {
      return await this.sendToAdapter(threadId, carry ? carry.input : turn, {
        onSending: () => {
          carry?.sending();
          hooks?.onSending?.();
        },
        onAccepted: (turnId) => {
          accepted = true;
          carry?.settle(turnId);
          hooks?.onAccepted?.(turnId);
        },
      });
    } catch (error) {
      if (!accepted) carry?.release();
      throw error;
    }
  }

  /** Hand the turn to the adapter. `onSending` runs right before each send,
   *  so what the turn carries is marked as possibly delivered before it can
   *  be; `onAccepted` the moment the provider takes it — before the
   *  checkpoint, which can take a while — so what the turn delivers (inbox
   *  messages, a queued row) is settled while a crash can still only lose the
   *  checkpoint, never send the turn a second time. */
  private async sendToAdapter(
    threadId: string,
    turn: SendTurnInput,
    hooks: TurnSendOptions = {},
  ): Promise<TurnStartResult> {
    const input = this.withViewBlock(turn);
    if (input.fallbacks && input.fallbacks.length > 0) {
      this.threadFallbacks.set(threadId, input.fallbacks);
    }
    const currentProvider = this.routing.get(threadId);
    const adapter = this.adapterForThread(threadId);
    this.dispatchingTurns.add(threadId);
    try {
      this.noteSending(threadId, hooks.onSending);
      const result = await adapter.sendTurn(input);
      this.noteAccepted(threadId, result.turnId, hooks.onAccepted);
      // The turn id is only known once the adapter accepts the turn, so the
      // pre-turn snapshot lands here — immediately after acceptance, before
      // the agent's first file mutation can arrive over the provider
      // round-trip. Never throws: capture degrades to no checkpoint.
      await this.captureTurnCheckpoint(threadId, result.turnId);
      return result;
    } catch (error) {
      const fallbacks = input.fallbacks ?? this.threadFallbacks.get(threadId);
      if (isQuotaOrRateLimitError(error) && fallbacks && fallbacks.length > 0) {
        const availability = this.buildAvailabilitySnapshot();
        let chain = [...fallbacks];
        while (chain.length > 0) {
          const head = chain[0];
          if (!head) break;
          const resolution = resolveModelWithFallback(head, chain.slice(1), availability);
          if (resolution.outcome !== "resolved") break;
          const target = resolution.ref;
          const targetProvider = target.provider;
          const targetAdapter = this.adapters.get(targetProvider);
          if (!targetAdapter) {
            chain = [...resolution.remaining];
            continue;
          }

          console.warn(
            `[agent] 429/quota error on ${currentProvider ?? "unknown"}; falling back to ${targetProvider}${target.model ? `/${target.model}` : ""}`,
          );

          this.routing.set(threadId, targetProvider);
          this.threadFallbacks.set(threadId, [...resolution.remaining]);
          const nextModel = this.validModelFor(targetProvider, target.model);
          const nextEffort = this.validEffortFor(targetProvider, nextModel, input.effort);
          const nextInput: SendTurnInput = {
            ...input,
            model: nextModel,
            effort: nextEffort,
          };
          if (resolution.remaining.length > 0) nextInput.fallbacks = [...resolution.remaining];

          if ("hasSession" in targetAdapter && targetAdapter.hasSession instanceof Function) {
            const has = await targetAdapter.hasSession(threadId);
            if (!has) {
              const priorSession = this.sessionInputs.get(threadId);
              if (priorSession) {
                await targetAdapter.startSession({
                  ...priorSession,
                  provider: targetProvider,
                  model: nextModel,
                  effort: nextEffort,
                });
              }
            }
          }

          try {
            this.noteSending(threadId, hooks.onSending);
            const fallbackResult = await targetAdapter.sendTurn(nextInput);
            this.noteAccepted(threadId, fallbackResult.turnId, hooks.onAccepted);
            await this.captureTurnCheckpoint(threadId, fallbackResult.turnId);
            return fallbackResult;
          } catch (nextErr) {
            if (isQuotaOrRateLimitError(nextErr)) {
              chain = [...resolution.remaining];
              continue;
            }
            throw nextErr;
          }
        }
      }
      throw error;
    } finally {
      this.dispatchingTurns.delete(threadId);
    }
  }

  /** Tell the caller the turn is going to the provider. A caller that could
   *  not record it throws, and the turn is refused before the provider is
   *  contacted: what it carries must never be sent without its marker. */
  private noteSending(threadId: string, sending: (() => void) | undefined): void {
    if (!sending) return;
    try {
      sending();
    } catch (err) {
      console.error(`[agent] not sending a turn on ${threadId}: what it carries could not be marked sent:`, err);
      throw err;
    }
  }

  /** Tell the caller the provider took the turn. Never throws: the turn is
   *  running whatever the bookkeeping does. */
  private noteAccepted(threadId: string, turnId: string, accepted: ((turnId: string) => void) | undefined): void {
    if (!accepted) return;
    try {
      accepted(turnId);
    } catch (err) {
      console.error(`[agent] settling what turn ${turnId} on ${threadId} delivers failed:`, err);
    }
  }

  /** Where a turn's checkpoint runs: the thread's worktree when it owns one,
   *  else the project checkout. Null when the thread is unknown, still
   *  waiting on a worktree that was never materialized, or otherwise has no
   *  directory to snapshot — callers skip capture rather than fall back to a
   *  directory the turn never ran in. */
  private checkpointDir(threadId: string): string | null {
    const store = this.checkpointStore;
    if (!store) return null;
    try {
      const projectPath = store.threadProjectPath(threadId);
      if (!projectPath) return null;
      const workspace = store.threadWorkspace(threadId);
      if (!workspace) return null;
      return threadWorkingDir({ projectPath, ...workspace });
    } catch {
      return null;
    }
  }

  /** Snapshot the tree for a turn that was just accepted and record
   *  (thread, turn) → ref. Runs on the send path right after the adapter
   *  accepts the turn, while the returned turn id is fresh and before the
   *  agent's first file mutation can arrive.
   *
   *  Never throws and never fails the turn: a non-repo thread, an unreadable
   *  store, or any git error degrades to "no checkpoint for this turn",
   *  logged. A turn that already has a checkpoint keeps it — a second capture
   *  would snapshot a tree the agent already touched, not the pre-turn state.
   *  Evicted refs (past the per-thread cap) lose their git ref and their row
   *  together. */
  private async captureTurnCheckpoint(threadId: string, turnId: string): Promise<void> {
    const store = this.checkpointStore;
    if (!store) return;
    try {
      if (store.getTurnCheckpoint(threadId, turnId)) return;
      const dir = this.checkpointDir(threadId);
      if (!dir) return;
      const checkpoint = await createCheckpoint(dir, { threadId, turnId });
      const recorded = store.recordTurnCheckpoint({
        threadId,
        turnId,
        checkpointId: checkpoint.id,
        ref: `refs/kone/checkpoints/${checkpoint.id}`,
        createdAt: checkpoint.createdAt,
      });
      if (!recorded) {
        // A concurrent capture won the row for this turn — its snapshot is
        // the earlier one, so drop this duplicate ref rather than leak it.
        await dropCheckpoint(dir, checkpoint.id).catch(() => {});
        return;
      }
      const evicted = store.pruneTurnCheckpoints(threadId, MAX_TURN_CHECKPOINTS_PER_THREAD);
      for (const row of evicted) {
        await dropCheckpoint(dir, row.checkpointId).catch(() => {});
      }
    } catch (err) {
      console.warn(
        `[agent] turn checkpoint capture failed for ${threadId}/${turnId} — continuing without one:`,
        err,
      );
    }
  }

  /** Every pre-turn checkpoint recorded for a thread, oldest first. */
  listTurnCheckpoints(threadId: string): TurnCheckpointRecord[] {
    try {
      return this.checkpointStore?.listTurnCheckpoints(threadId) ?? [];
    } catch (err) {
      console.warn(`[agent] listTurnCheckpoints failed for ${threadId}:`, err);
      return [];
    }
  }

  /** What restoring a turn's pre-turn snapshot would change, without
   *  changing anything. Read-only — safe to call while a turn is live, and
   *  never throws: every failure mode answers as a reason. */
  async previewTurnCheckpoint(
    threadId: string,
    turnId: string,
  ): Promise<PreviewTurnCheckpointResult> {
    try {
      const store = this.checkpointStore;
      if (!store) return { ok: false, reason: "missing" };
      const row = store.getTurnCheckpoint(threadId, turnId);
      if (!row) return { ok: false, reason: "missing" };
      const dir = this.checkpointDir(threadId);
      if (!dir) return { ok: false, reason: "no-workdir" };
      if (!existsSync(dir)) return { ok: false, reason: "no-workdir", detail: dir };
      if (!(await checkpointExists(dir, row.checkpointId))) {
        return { ok: false, reason: "checkpoint-gone", detail: row.ref };
      }
      try {
        const preview = await previewCheckpointRestore(dir, row.checkpointId);
        return { ok: true, wouldWrite: preview.wouldWrite, wouldDelete: preview.wouldDelete };
      } catch (err) {
        console.warn(`[agent] preview checkpoint failed for ${threadId}/${turnId}:`, err);
        return failedCheckpoint(err);
      }
    } catch (err) {
      console.warn(`[agent] preview checkpoint failed for ${threadId}/${turnId}:`, err);
      return failedCheckpoint(err);
    }
  }

  /** Restore a thread's working tree to a turn's pre-turn snapshot. Reverts
   *  serialize per thread through a chain: two restores rewriting the same
   *  tree must run one after the other, never interleaved.
   *
   *  Files only — the conversation is never truncated. Blocks are an
   *  append-only ledger journaled through applyEvent, and later rows point at
   *  earlier turns by id: queued-turn promotions anchor to their user block,
   *  compaction boundaries and spawn parent links name their turn, and usage
   *  accounting sums the same rows. Deleting everything after the restored
   *  turn would orphan those references and destroy the record of what was
   *  just undone; keeping the transcript means the undone turn stays readable
   *  above the files it no longer owns. The checkpoint row is kept too, so a
   *  restore stays repeatable (a second run previews empty and no-ops).
   *
   *  The restore is a full-tree restore — files the turn added are removed,
   *  files it deleted come back — because a revert that leaves the turn's
   *  new files behind is only half undone. Without `force` it refuses rather
   *  than guesses: any uncommitted difference answers as `dirty` with the
   *  exact file lists, and the caller re-issues with `force` once the user
   *  has confirmed them. Never throws: every failure mode answers as a
   *  reason. */
  revertToTurnCheckpoint(
    threadId: string,
    turnId: string,
    force?: boolean,
  ): Promise<RevertTurnCheckpointResult> {
    const tail = this.revertChains.get(threadId) ?? Promise.resolve();
    const run = tail.then(() => this.runRevert(threadId, turnId, force === true));
    // The chain entry itself never rejects, or every later revert queued
    // behind a failed one would inherit its rejection without running.
    this.revertChains.set(
      threadId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async runRevert(
    threadId: string,
    turnId: string,
    force: boolean,
  ): Promise<RevertTurnCheckpointResult> {
    try {
      if (this.isBusy(threadId)) return { ok: false, reason: "busy" };
      const store = this.checkpointStore;
      if (!store) return { ok: false, reason: "missing" };
      const row = store.getTurnCheckpoint(threadId, turnId);
      if (!row) return { ok: false, reason: "missing" };
      const dir = this.checkpointDir(threadId);
      if (!dir) return { ok: false, reason: "no-workdir" };
      // The store names a directory; the disk decides whether it is still
      // there. A worktree removed or moved out from under the thread must
      // read as no-workdir (with the expected path attached), never as a
      // restore into whatever happens to sit at a stale path.
      if (!existsSync(dir)) return { ok: false, reason: "no-workdir", detail: dir };
      // The row outlives its object when the ref is pruned or the repo was
      // re-cloned around it. Restoring from a dangling ref could only fail
      // inside git — say so up front, naming the dead ref.
      if (!(await checkpointExists(dir, row.checkpointId))) {
        return { ok: false, reason: "checkpoint-gone", detail: row.ref };
      }
      let preview: { wouldWrite: string[]; wouldDelete: string[] };
      try {
        preview = await previewCheckpointRestore(dir, row.checkpointId);
      } catch (err) {
        console.warn(`[agent] revert to checkpoint failed for ${threadId}/${turnId}:`, err);
        return failedCheckpoint(err);
      }
      // Conservative by default: the caller shows wouldWrite/wouldDelete and
      // re-issues with force. The one exception is the empty diff — restoring
      // a tree that already matches is a no-op, and refusing a no-op would
      // strand the confirmation step on nothing.
      if (!force && (preview.wouldWrite.length > 0 || preview.wouldDelete.length > 0)) {
        return {
          ok: false,
          reason: "dirty",
          wouldWrite: preview.wouldWrite,
          wouldDelete: preview.wouldDelete,
        };
      }
      try {
        await restoreCheckpoint(dir, row.checkpointId, { hard: true });
      } catch (err) {
        console.warn(`[agent] revert to checkpoint failed for ${threadId}/${turnId}:`, err);
        return failedCheckpoint(err);
      }
      // A restore that dies partway leaves a half-written tree — deletes done,
      // rewrites missing. Re-previewing must come back empty; anything left is
      // reported as a failure with the still-dirty files named, never silence.
      try {
        const after = await previewCheckpointRestore(dir, row.checkpointId);
        if (after.wouldWrite.length > 0 || after.wouldDelete.length > 0) {
          const leftovers = [...after.wouldWrite, ...after.wouldDelete].sort();
          console.warn(
            `[agent] revert to checkpoint left ${leftovers.length} file(s) unreconciled for ${threadId}/${turnId}:`,
            leftovers,
          );
          return failedCheckpoint(
            `restore left ${leftovers.length} file(s) unreconciled: ${leftovers.join(", ")}`,
          );
        }
      } catch (err) {
        console.warn(`[agent] revert to checkpoint failed for ${threadId}/${turnId}:`, err);
        return failedCheckpoint(err);
      }
      return { ok: true };
    } catch (err) {
      console.warn(`[agent] revert to checkpoint failed for ${threadId}/${turnId}:`, err);
      return failedCheckpoint(err);
    }
  }

  async interruptTurn(threadId: string): Promise<void> {
    return this.adapterForThread(threadId).interruptTurn(threadId);
  }

  // ── context compaction ────────────────────────────────────────────────────
  // Manual compaction runs provider-native where the adapter names a native
  // mechanism (Codex `thread/compact/start`, OpenCode `POST
  // /session/:id/summarize`) and as a command turn carrying the provider's
  // own documented slash command everywhere else (`/compact`, `/compress`).
  // Either way the settled boundary is the same `thread.state.changed`
  // "compacted" event — observed from the provider when it announces one,
  // synthesized when it compacts silently — which is what the store
  // invalidates its usage snapshot on. Resolves once that boundary has been
  // observed or synthesized, so the caller reads fresh state after.

  /** Whether the thread has a manual compaction in flight. */
  isCompacting(threadId: string): boolean {
    return this.compactingThreads.has(threadId);
  }

  /** Whether manual compaction can be triggered for this provider — natively
   *  or through the command fallback. Derived from the adapter's compaction
   *  union: false means the thread only ever compacts on the provider's own
   *  initiative. */
  supportsThreadCompaction(provider: ProviderKind): boolean {
    return isCompactionSupported(this.adapter(provider).capabilities.compaction);
  }

  /** Trigger context compaction for the thread's session. Rejects when there
   *  is no live session, when a compaction is already running, when a turn is
   *  running, or when the provider supports no manual compaction.
   *
   *  The single-flight claim lands first, synchronously — before the first
   *  await — so two callers can't both enter. `ensureSession` (the
   *  dispatcher's session-adopt preamble) runs inside the claim, which is
   *  what closes the orphaned-session race the dispatcher's own set used to
   *  cover: the claim covers the preamble and the compaction alike. */
  async compactThread(threadId: string, ensureSession?: () => Promise<void>): Promise<CompactThreadResult> {
    if (this.compactingThreads.has(threadId)) {
      throw new Error(`Context compaction is already in progress for thread ${threadId}.`);
    }
    this.compactingThreads.add(threadId);
    let result: CompactThreadResult;
    try {
      // Skipped (not merely awaited) when absent: the watch below must
      // subscribe synchronously with the claim, so a boundary announced on
      // this tick still lands in it.
      if (ensureSession) await ensureSession();
      const provider = this.routing.get(threadId);
      if (!provider) throw new Error(`No agent session for thread ${threadId}`);
      if (this.isBusy(threadId)) {
        throw new Error("Context compaction is unavailable while a provider turn is running.");
      }
      const adapter = this.adapter(provider);
      const capability = adapter.capabilities.compaction;
      if (!isCompactionSupported(capability)) {
        throw new Error(`Context compaction is not supported for provider ${provider}.`);
      }
      const native = await this.runCompaction(threadId, adapter, provider, capability);
      result = { threadId, provider, native };
    } finally {
      this.compactingThreads.delete(threadId);
    }
    // Follow-ups queued behind the compaction run now, against the compacted
    // context. (Fallback turns already promoted on settlement, so for them
    // this finds nothing and returns.)
    this.promoteQueuedTurns(threadId);
    return result;
  }

  /** Run the adapter-named compaction mechanism and report which ran: the
   *  native call where the adapter has one, otherwise a command turn carrying
   *  the provider's own documented slash command. Either way the settled
   *  boundary is the same `thread.state.changed` "compacted" event — the
   *  native path waits for the provider's announcement (synthesizing only
   *  when the wait times out), the command path synthesizes when its turn
   *  settles without one. */
  private async runCompaction(
    threadId: string,
    adapter: ProviderAdapter,
    provider: ProviderKind,
    capability: Extract<ThreadCompactionCapability, { kind: "native" | "command" }>,
  ): Promise<boolean> {
    // Watch before triggering: the boundary may land while the call or the
    // command turn is still in flight.
    const boundary = onceEvent(
      (listener) => this.onEvent(listener),
      (event): true | undefined =>
        event.threadId === threadId &&
        event.type === "thread.state.changed" &&
        event.state === "compacted"
          ? true
          : undefined,
    );
    try {
      if (capability.kind === "native") {
        const compact = adapter.compactThread;
        if (!compact) {
          throw new Error(`Context compaction is not supported for provider ${provider}.`);
        }
        const nativeTimeoutMs = this.options.compactNativeTimeoutMs ?? NATIVE_COMPACT_TIMEOUT_MS;
        try {
          await withTimeout(
            compact.call(adapter, threadId),
            nativeTimeoutMs,
            "Context compaction did not complete within 10 minutes.",
          );
        } catch (error) {
          // A boundary that landed despite a failed call still means the
          // context IS compacted, so it wins over the error.
          if (boundary.arrived()) return true;
          throw error;
        }
        // Call resolution is acceptance, not settlement: both native providers
        // announce the settled boundary, so wait for it within the same native
        // budget. The claim stays held across the wait, so queued turns cannot
        // dispatch mid-compaction. Synthesize only when the wait times out and
        // the provider went quiet.
        try {
          await withTimeout(
            boundary.settled,
            nativeTimeoutMs,
            "Context compaction did not complete within 10 minutes.",
          );
        } catch (error) {
          if (boundary.arrived()) return true;
          this.synthesizeCompactedBoundary(threadId, provider);
          throw error;
        }
        return true;
      }
      // The fallback IS a turn: hold the in-flight marker across the handoff
      // so a concurrent send queues behind it instead of starting a second
      // turn on the same session.
      this.dispatchingTurns.add(threadId);
      let turnId: string;
      try {
        ({ turnId } = await adapter.sendTurn({ threadId, input: capability.command }));
      } finally {
        this.dispatchingTurns.delete(threadId);
      }
      const outcome = await this.awaitCompactionBoundary(
        threadId,
        turnId,
        boundary,
        this.options.compactFallbackTimeoutMs ?? FALLBACK_COMPACT_TIMEOUT_MS,
      );
      switch (outcome.outcome) {
        case "compacted":
          return false;
        case "turn-completed":
          this.synthesizeCompactedBoundary(threadId, provider);
          return false;
        case "turn-aborted":
          throw new Error("Context compaction was interrupted before it could settle.");
        case "timeout":
          throw new Error("Context compaction did not complete within 10 minutes.");
      }
    } finally {
      boundary.cancel();
    }
  }

  /** Wait for a command-turn compaction to settle: the announced boundary
   *  wins; otherwise the turn's own settlement decides; the service's
   *  fallback budget bounds the wait. One flow, one discriminated outcome. */
  private async awaitCompactionBoundary(
    threadId: string,
    turnId: string,
    boundary: EventWait<boolean>,
    timeoutMs: number,
  ): Promise<CompactionBoundaryOutcome> {
    const settlement = onceEvent(
      (listener) => this.onEvent(listener),
      (event): "completed" | "aborted" | undefined => {
        if (event.threadId !== threadId) return undefined;
        if (event.type === "turn.completed" && event.turnId === turnId) return "completed";
        if (event.type === "turn.aborted" && event.turnId === turnId) return "aborted";
        return undefined;
      },
      { timeoutMs },
    );
    try {
      return await Promise.race([
        boundary.settled.then(
          (arrived): CompactionBoundaryOutcome =>
            arrived ? { outcome: "compacted" } : { outcome: "timeout" },
        ),
        settlement.settled.then((settled): CompactionBoundaryOutcome => {
          if (settled === "completed") return { outcome: "turn-completed" };
          if (settled === "aborted") return { outcome: "turn-aborted" };
          return { outcome: "timeout" };
        }),
      ]);
    } finally {
      settlement.cancel();
    }
  }

  /** Announce a compaction the provider performed silently, so the stored
   *  usage snapshot invalidates exactly as if it had announced one. */
  private synthesizeCompactedBoundary(threadId: string, provider: ProviderKind): void {
    this.dispatch({
      type: "thread.state.changed",
      threadId,
      provider,
      at: Date.now(),
      source: "kone.store",
      state: "compacted",
    });
  }

  async stopSession(threadId: string): Promise<void> {
    const provider = this.routing.get(threadId);
    if (!provider) return;
    // Cancel queued follow-ups BEFORE the teardown: a row must never promote
    // into a session that is being torn down (a drain racing the stop could
    // otherwise claim one and hand it to a dead session).
    this.cancelQueuedForStop(threadId, provider);
    this.bumpSessionGeneration(threadId);
    await this.adapter(provider).stopSession(threadId);
    this.routing.delete(threadId);
    this.sessionInputs.delete(threadId);
    this.threadFallbacks.delete(threadId);
    // The adapter's stop already drained parked asks and sealed the live turn
    // (their events clear this state); this is the belt-and-braces pass for
    // any adapter whose drain doesn't emit per-ask resolution events.
    this.forgetThreadState(threadId);
    // The session is gone — its gateway credential must 401 from here on.
    this.gateway?.revokeThread(threadId);
  }

  /** Fan one event out to every listener — the single emit path, shared by the
   *  adapters' closure and the service's own synthesized events (the wedge
   *  watchdog's reset announcement). */
  private dispatch(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Snapshot of every currently parked ask across live sessions — the
   *  reload-recovery replay set. Approvals/user-inputs are live round-trips
   *  (never journaled), so this snapshot is the only way a fresh renderer can
   *  re-present a prompt the turn is still parked on. */
  pendingInteractions(): PendingInteraction[] {
    const out: PendingInteraction[] = [];
    for (const byThread of this.parkedByThread.values()) {
      for (const pending of byThread.values()) out.push(pending);
    }
    return out;
  }

  // ── recovery bookkeeping + wedge watchdog ─────────────────────────────────

  /** Keep the recovery snapshot and watchdog state current off the merged
   *  event stream. Runs for EVERY event, so the heartbeat counts all activity
   *  (token-usage updates included) and a genuinely streaming turn is never
   *  mistaken for a wedged one. */
  private trackEvent(event: RuntimeEvent): void {
    const { threadId } = event;
    this.lastActivity.set(threadId, Date.now());
    switch (event.type) {
      case "approval.requested":
      case "user-input.requested":
        this.setParked(event);
        break;
      case "approval.resolved":
      case "user-input.resolved":
        this.dropParked(threadId, event.requestId);
        break;
      case "turn.started":
        this.activeTurns.set(threadId, event.turnId);
        this.turnStartedAt.set(threadId, event.at);
        // A turn nobody here asked for — the user typing, a peer's message, a
        // queued follow-up — means the thread is being driven from outside the
        // wake chain, so the chain is over and its budget goes back.
        if (this.pendingSubagentWakes.delete(threadId)) break;
        this.subagentWakes.delete(threadId);
        break;
      case "item.started": {
        let items = this.openItems.get(threadId);
        if (!items) {
          items = new Set();
          this.openItems.set(threadId, items);
        }
        items.add(event.item.itemId);
        if (event.item.kind === "tool_call" && !event.subagentToolUseId) {
          this.activeTool.set(threadId, {
            itemId: event.item.itemId,
            name: event.item.name ?? "tool",
            text: event.item.text,
            startedAt: event.at,
          });
        }
        break;
      }
      case "item.completed":
        this.openItems.get(threadId)?.delete(event.item.itemId);
        if (this.activeTool.get(threadId)?.itemId === event.item.itemId) this.activeTool.delete(threadId);
        break;
      case "turn.steered":
        // The provider took the message into its running turn: the journaled
        // prompt is marked, with the turn it went into, so a reload shows it
        // where the live view did — every block of a batch, in order, so they
        // all read above the reply's continuation.
        for (const blockId of steeredBlockIds(event)) {
          this.queueStore.markUserBlockSteered(threadId, blockId, event.turnId, event.at);
        }
        break;
      case "turn.completed":
      case "turn.aborted":
        this.activeTurns.delete(threadId);
        this.openItems.delete(threadId);
        this.turnStartedAt.delete(threadId);
        this.activeTool.delete(threadId);
        // A turn settling frees the one-live-turn slot: promote the next
        // queued follow-up (fire-and-forget; drain is serialized per thread
        // and sends at most one turn, so the next settlement drains again).
        this.promoteQueuedTurns(threadId);
        break;
      case "session.state.changed":
        if (event.state === "stopped" || event.state === "error") {
          this.activeTurns.delete(threadId);
          this.dropAllParked(threadId);
        }
        break;
      case "session.exited":
        this.activeTurns.delete(threadId);
        this.dropAllParked(threadId);
        break;
      case "subagent.background-settled":
        this.wakeForSettledSubagents(event);
        break;
      default:
        break;
    }
  }

  /** Drive one more turn on a thread whose background subagents came back after
   *  it had stopped listening.
   *
   *  The agent that spawned them ended its turn believing it would be told —
   *  and nothing was going to tell it. The findings are on the transcript, but a
   *  transcript nobody reads is the same as no findings, which is why this is a
   *  turn and not a notification: reading takes a turn.
   *
   *  Silent, so the prompt is never journaled as something the user said. The
   *  transcript shows the agent picking its own work back up, which is what
   *  actually happened.
   *
   *  Fire-and-forget, and skipped when a turn is already running: the agent is
   *  awake and looking at the same transcript, so a wake on top of it would only
   *  interrupt. */
  private wakeForSettledSubagents(
    event: Extract<RuntimeEvent, { type: "subagent.background-settled" }>,
  ): void {
    const { threadId } = event;
    if (this.isBusy(threadId)) return;
    // A wake is a turn, and a turn can spawn more background subagents, which
    // settle, which wake it again. That is a legitimate shape of work — and also
    // exactly the shape of a thread that has stopped making progress and is
    // spending money in a circle. The counter is what tells them apart: it only
    // ever grows on a wake that was itself woken, and any turn the user drives
    // resets it (see turnStarted). Past the cap the findings are still on the
    // transcript for the next thing that reads the thread.
    const woken = this.subagentWakes.get(threadId) ?? 0;
    if (woken >= SUBAGENT_WAKE_MAX) {
      console.warn(
        `[agent] subagent wake for ${threadId} suppressed after ${woken} consecutive wakes`,
      );
      return;
    }
    this.subagentWakes.set(threadId, woken + 1);
    this.pendingSubagentWakes.add(threadId);
    const dispatcher = getThreadDispatcher();
    if (!dispatcher) return;
    void (async () => {
      try {
        await dispatcher.sendThreadTurn(
          { threadId, input: subagentWakePrompt(event.subagents) },
          { silent: true },
        );
      } catch (err) {
        // The thread may have been closed, or its session reaped, between the
        // subagents settling and this landing. Nothing is lost that a later turn
        // cannot re-read from the transcript.
        // No turn started, so nothing will consume the mark or the budget.
        this.pendingSubagentWakes.delete(threadId);
        this.subagentWakes.delete(threadId);
        console.warn(`[agent] subagent wake failed for ${threadId}:`, err);
      }
    })();
  }

  private setParked(
    event: Extract<RuntimeEvent, { type: "approval.requested" | "user-input.requested" }>,
  ): void {
    const { threadId, requestId } = event;
    let byThread = this.parkedByThread.get(threadId);
    if (!byThread) {
      byThread = new Map();
      this.parkedByThread.set(threadId, byThread);
    }
    byThread.set(requestId, {
      threadId,
      requestId,
      kind: event.type === "approval.requested" ? "approval" : "user-input",
      event,
    });
  }

  private dropParked(threadId: string, requestId: string): void {
    const byThread = this.parkedByThread.get(threadId);
    if (!byThread) return;
    byThread.delete(requestId);
    if (byThread.size === 0) this.parkedByThread.delete(threadId);
  }

  private dropAllParked(threadId: string): void {
    this.parkedByThread.delete(threadId);
  }

  private forgetThreadState(threadId: string): void {
    this.parkedByThread.delete(threadId);
    this.activeTurns.delete(threadId);
    this.subagentWakes.delete(threadId);
    this.pendingSubagentWakes.delete(threadId);
    this.dispatchingTurns.delete(threadId);
    this.compactingThreads.delete(threadId);
    this.openItems.delete(threadId);
    this.turnStartedAt.delete(threadId);
    this.activeTool.delete(threadId);
    this.lastActivity.delete(threadId);
    this.clearQueueRetry(threadId);
  }

  /** The wedge watchdog: a live turn whose provider has gone silent. A JSON-RPC
   *  timeout already rejected the in-flight promise (jsonRpc.ts), but nothing
   *  kills the child or seals the turn — without this sweep a wedged provider
   *  leaves its block `running` forever and the composer disabled. Resets via
   *  stopSession: the adapters' stop drains parked asks, seals the live turn
   *  as interrupted, and kills the child. Sessions parked on a human answer
   *  are never touched — the parked-ask map is the precise waiting signal. A
   *  thread with an open item (an in-progress tool call or text block) gets the
   *  longer item threshold instead of the short one — that silence is a long
   *  tool call doing its work, not a dead child. */
  private sweepWedgedSessions(): void {
    const now = Date.now();
    for (const threadId of this.activeTurns.keys()) {
      // Waiting on the user is not wedged — the silence is the point.
      if (this.parkedByThread.get(threadId)?.size) continue;
      const last = this.lastActivity.get(threadId);
      const hasOpenItem = (this.openItems.get(threadId)?.size ?? 0) > 0;
      const silenceMs = hasOpenItem
        ? (this.options.wedgeItemSilenceMs ?? WEDGE_ITEM_SILENCE_MS)
        : (this.options.wedgeSilenceMs ?? WEDGE_SILENCE_MS);
      if (last !== undefined && now - last < silenceMs) continue;
      const provider = this.routing.get(threadId);
      if (!provider) {
        // Session already gone — drop the stale live-turn entry.
        this.activeTurns.delete(threadId);
        continue;
      }
      const silentFor =
        last === undefined ? "unknown" : `${Math.max(0, Math.round((now - last) / 1000))}s`;
      console.warn(
        `[agent] wedge watchdog: ${provider} session ${threadId} silent ${silentFor} with live turn ${this.activeTurns.get(threadId)} — resetting`,
      );
      // Best-effort: a failed stop leaves the state in place for the next sweep.
      void this.stopSession(threadId).catch(() => {});
      // The adapters do not announce their stop path, so name it here — the
      // renderer must not keep showing a live thread that is being reset.
      this.dispatch({
        type: "session.state.changed",
        threadId,
        provider,
        at: now,
        source: "kone.store",
        state: "error",
        message: "wedged — session reset",
      });
    }
  }

  private ensureWedgeWatchdog(): void {
    if (this.wedgeTimer) return;
    const timer = setInterval(() => {
      try {
        this.sweepWedgedSessions();
      } catch (err) {
        console.warn("[agent] wedge watchdog sweep failed:", err);
      }
    }, this.options.wedgeSweepMs ?? WEDGE_SWEEP_MS);
    // Never hold the process open on the watchdog's account — clean quit is
    // handled by the before-quit teardown, which clears this timer via stopAll.
    timer.unref?.();
    this.wedgeTimer = timer;
  }

  /** The idle session reaper: sweeps active sessions that have had no turn or
   *  event activity for longer than the inactivity threshold (default 30 min).
   *  Unlike the wedge watchdog (which rescues running turns that stalled), this
   *  reclaims child CLI processes for quiescent sessions while keeping the
   *  conversation store history intact. Sessions with a turn currently running,
   *  sessions parked on human approval/input, or sessions with queued follow-ups
   *  are never reaped. */
  async sweepIdleSessions(): Promise<void> {
    const now = Date.now();
    const thresholdMs = this.options.idleThresholdMs ?? IDLE_THRESHOLD_MS;
    for (const threadId of this.routing.keys()) {
      // Never reap while a turn is in flight (announced or still being handed
      // to the adapter).
      if (this.isBusy(threadId)) continue;
      // Never reap while waiting on user approval or question answer.
      if (this.parkedByThread.get(threadId)?.size) continue;
      // Never reap if queued follow-ups are waiting to run or being promoted.
      if ((this.queuedByThread.get(threadId) ?? 0) > 0 || this.queueDeliveries.has(threadId)) continue;

      const last = this.lastActivity.get(threadId);
      if (last !== undefined && now - last < thresholdMs) continue;

      const provider = this.routing.get(threadId);
      if (!provider) continue;

      const idleSeconds = last === undefined ? "unknown" : `${Math.max(0, Math.round((now - last) / 1000))}s`;
      console.warn(
        `[agent] idle session reaper: stopping inactive ${provider} session ${threadId} (idle ${idleSeconds})`,
      );

      try {
        await this.stopSession(threadId);
        this.dispatch({
          type: "session.state.changed",
          threadId,
          provider,
          at: now,
          source: "kone.store",
          state: "stopped",
          message: "idle session reaped",
        });
      } catch (err) {
        console.warn(`[agent] idle session reaper failed to stop session ${threadId}:`, err);
      }
    }
  }

  private ensureIdleReaper(): void {
    if (this.idleTimer) return;
    const timer = setInterval(() => {
      // The sweep is async, so a failure arrives as a rejection — a try/catch
      // around the call would let it escape as an unhandled rejection instead.
      void this.sweepIdleSessions().catch((err) => {
        console.warn("[agent] idle session reaper sweep failed:", err);
      });
    }, this.options.idleSweepMs ?? IDLE_SWEEP_MS);
    // Never hold the process open on the reaper's account — clean quit is
    // handled by the before-quit teardown, which clears this timer via stopAll.
    timer.unref?.();
    this.idleTimer = timer;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    return this.adapterForThread(threadId).respondToRequest(threadId, requestId, decision);
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: UserInputAnswers,
  ): Promise<UserInputRespondResult> {
    return this.adapterForThread(threadId).respondToUserInput(threadId, requestId, answers);
  }

  // ── durable turn queue + steering ─────────────────────────────────────────
  // A follow-up sent while a turn runs is durably enqueued (survives crashes),
  // promoted automatically when the active turn settles, cancelled on
  // stop/thread-delete, and steerable mid-turn. The store owns persistence
  // (ConversationStore, parallel slice); this class owns the dispatch side.

  /** Deliver a mid-turn message without starting a new turn boundary. With a
   *  live turn: route to the adapter's live-steer channel when the provider
   *  has one (turn.steered on delivery), else fall back to the durable queue
   *  with dispatchMode "steer" — steer rows claim first, so the nudge lands
   *  as the next turn the moment the current one settles. Without a live turn
   *  there is nothing to steer — a steer is just a send.
   *
   *  A turn that has been handed to an adapter but hasn't announced itself yet
   *  (see `isBusy`) has no turn id to steer INTO, so it takes the queue's steer
   *  lane rather than the live channel — the nudge still claims ahead of every
   *  plain follow-up. A `liveOnly` steer is refused there instead: its caller
   *  settles what it carries with the turn that took it, and a queue row is
   *  not one. */
  async steerTurn(input: SendTurnInput, options?: TurnSendOptions): Promise<TurnStartResult> {
    const threadId = input.threadId;
    // A steer needs a live turn to land in. There is none during a native
    // compaction — and during a fallback the live turn IS the compaction
    // command, which a nudge would corrupt. Plain sends queue behind the
    // compaction instead (see sendTurn); steers refuse outright.
    if (this.isCompacting(threadId)) {
      throw new Error("Wait for context compaction to finish before sending another message.");
    }
    const liveTurnId = this.activeTurns.get(threadId);
    if (liveTurnId) {
      const adapter = this.adapterForThread(threadId);
      // The adapter announces turn.steered itself, once, when the message
      // really went into the live turn (it falls back to a plain send when its
      // own turn has just ended).
      if (adapter.steerTurn) {
        this.noteSending(threadId, options?.onSending);
        const result = await adapter.steerTurn(input);
        options?.onAccepted?.(result.turnId);
        return result;
      }
    }
    if (this.isBusy(threadId)) {
      if (options?.liveOnly) throw new Error(`No running turn on ${threadId} can take this steer yet.`);
      const provider = this.routing.get(threadId);
      if (provider) {
        const enqueued = await this.enqueueTurn(input, "steer", provider);
        // A turn parked on the user is not interrupted: on several providers
        // an interrupt drains the parked approvals, so the nudge would decline
        // the user's approval for them. The row waits; once the user answers
        // and the turn ends, it claims first.
        if (liveTurnId && !this.parkedByThread.get(threadId)?.size) {
          void this.interruptTurn(threadId).catch((err) => {
            console.warn(`[agent] interrupt on fallback steer failed for ${threadId}:`, err);
          });
        }
        return enqueued;
      }
    }
    return this.sendTurn(input, options);
  }

  /** Cancel one queued follow-up (user-initiated drop). Emits
   *  turn.queued-cancelled (reason "user") when a row was actually cancelled;
   *  returns false when no such row exists. */
  async cancelQueuedTurn(threadId: string, queueId: string): Promise<boolean> {
    const store = this.queueStore;
    const cancelled = store.cancelQueuedTurn(queueId);
    if (cancelled) {
      this.dropQueuedCount(threadId);
      // Its backoff goes with it; the rest of the queue needn't wait it out.
      if (this.queueRetries.get(threadId)?.queueId === queueId) this.clearQueueRetry(threadId);
      const provider = this.routing.get(threadId);
      if (provider) {
        this.dispatch({
          type: "turn.queued-cancelled",
          threadId,
          provider,
          queueId,
          reason: "user",
          at: Date.now(),
          source: "kone.store",
        });
      }
      // A held row pauses everything behind it; removing it lets the rest run.
      this.promoteQueuedTurns(threadId);
    }
    return cancelled;
  }

  /** The strip's "Send now": deliver one waiting or held row at once, with
   *  the prompt, attachments, skills and settings it was queued with. The row
   *  stays claimed until the provider accepts it, so nothing is lost: into a
   *  live turn it is steered (and marked promoted once the provider took it);
   *  on an idle thread it starts a turn; and on a busy thread with no live
   *  steer channel it moves to the front of the queue and the running turn is
   *  interrupted — the queue's own steer. A failed delivery puts the row back
   *  exactly as it was (waiting or held, same place in line) and rethrows.
   *  Resolves false when the row is no longer waiting or held, or was
   *  cancelled before it reached the provider.
   *
   *  Needs a live session: nothing is claimed without one, since a claimed
   *  row with nowhere to go would sit in 'promoting' where neither Send now
   *  nor remove can reach it. The renderer starts the session first. */
  async sendQueuedTurnNow(threadId: string, queueId: string): Promise<boolean> {
    const store = this.queueStore;
    if (!this.routing.has(threadId)) throw new Error(`No agent session for thread ${threadId}`);
    return this.withQueueDelivery(threadId, () => this.deliverQueuedTurnNow(threadId, queueId, store));
  }

  private async deliverQueuedTurnNow(threadId: string, queueId: string, store: QueuedTurnStore): Promise<boolean> {
    // Checked once this delivery's turn has come: an earlier one may have
    // started a compaction or lost the session. Both refuse before the claim,
    // so the row stays where it was.
    if (this.isCompacting(threadId)) {
      throw new Error("Wait for context compaction to finish before sending another message.");
    }
    if (!this.routing.has(threadId)) throw new Error(`No agent session for thread ${threadId}`);
    const claimed = store.claimQueuedTurn(queueId);
    if (!claimed) return false;
    const { row, from } = claimed;
    // Sent by hand: it no longer waits out a backoff.
    if (this.queueRetries.get(threadId)?.queueId === queueId) this.clearQueueRetry(threadId);
    const generation = this.sessionGeneration(threadId);
    this.announceQueuedState(threadId, row, "promoting");
    try {
      const input = this.turnInputFromQueuedRow(row);
      const adapter = this.adapterForThread(threadId);
      const liveTurnId = this.activeTurns.get(threadId);
      // Last thing before the provider: a stop or delete since the claim
      // cancelled it and handed the words back, so it must not go out too.
      if (!store.isQueuedTurnClaimed(queueId)) return false;
      if (liveTurnId && adapter.steerTurn) {
        const result = await adapter.steerTurn({ ...input, userBlockId: row.userBlockId });
        // A steer can fall back to a fresh turn when the one it aimed at ended
        // meanwhile; if the row was stopped by then, that turn is stopped too.
        if (!this.settlePromoted(threadId, queueId, result.turnId)) {
          this.stopOrphanedDelivery(threadId, generation, result.turnId);
        }
        return true;
      }
      if (this.isBusy(threadId)) {
        if (!this.releaseRow(store, queueId, "queued")) return false;
        await this.reorderQueuedTurns(threadId, [queueId]);
        this.announceQueuedState(threadId, row, "queued");
        if (liveTurnId) {
          void this.interruptTurn(threadId).catch((err) => {
            console.warn(`[agent] interrupt on send-now failed for ${threadId}:`, err);
          });
        }
        return true;
      }
      let promoted = false;
      const result = await this.dispatchToAdapter(threadId, input, row.userBlockId, undefined, {
        onAccepted: (turnId) => {
          promoted = this.settlePromoted(threadId, queueId, turnId);
        },
      });
      if (!promoted) {
        // Stopped while the provider was taking it: the words are already
        // back in the composer, so the turn it started is stopped too.
        this.stopOrphanedDelivery(threadId, generation, result.turnId);
      }
      return true;
    } catch (err) {
      if (this.releaseRow(store, queueId, from)) {
        this.announceQueuedState(threadId, row, from, { error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  }

  /** The thread's queued follow-ups, as the store keeps them — the passthrough
   *  the IPC agent's queued-turns channel reads. */
  async listQueuedTurns(threadId: string): Promise<QueuedTurnRow[]> {
    const store = this.queueStore;
    return store.listQueuedTurns(threadId);
  }

  /** Reorder the thread's active queued follow-ups. Emits
   *  turn.queued-reordered on success. */
  async reorderQueuedTurns(threadId: string, queueIds: string[]): Promise<boolean> {
    const store = this.queueStore;
    const ok = await store.reorderQueuedTurns(threadId, queueIds);
    if (ok) {
      const provider = this.routing.get(threadId);
      if (provider) {
        this.dispatch({
          type: "turn.queued-reordered",
          threadId,
          provider,
          queueIds,
          at: Date.now(),
          source: "kone.store",
        });
      }
    }
    return ok;
  }

  /** Archive (or restore) a thread and its spawned subtree — the one path the
   *  renderer's archive request and the retention sweep both walk. The store
   *  writes the stamp; this method owns the announcement side: cancelling the
   *  subtree's queued turns (a hidden thread must not carry a queue the user
   *  can no longer see or reach) and emitting one thread.archived /
   *  thread.unarchived event per affected thread so every surface — the
   *  archive request's own list, the inbox, the home recents — reconciles.
   *  A refused request writes and emits nothing. */
  async setThreadArchived(threadId: string, archived: boolean): Promise<ThreadArchiveResult> {
    const history = this.historyStore;
    if (!history) return { ok: false, reason: "error" };
    const result = history.setArchived(threadId, archived);
    if (!result.ok) return result;
    for (const id of result.threadIds) {
      const meta = history.threadMeta(id);
      const provider = meta?.provider ?? this.routing.get(id);
      if (!provider) continue;
      const at = Date.now();
      if (archived) {
        this.cancelThreadQueue(id, provider, "archive");
        this.dispatch({
          type: "thread.archived",
          threadId: id,
          provider,
          at,
          source: "kone.store",
          archivedAt: at,
        });
      } else {
        this.dispatch({
          type: "thread.unarchived",
          threadId: id,
          provider,
          at,
          source: "kone.store",
        });
      }
    }
    return result;
  }

  /** Mark a thread done, or take the mark off — the one path the renderer's
   *  set-done request and the retention sweep both walk. The store writes the
   *  stamp; this method owns the announcement side: one thread.done.updated
   *  event so every surface — the request's own list, the inbox, the home
   *  recents, other windows — reconciles. Done never touches queues or
   *  sessions: it is an attention mark, not a hiding, so there is nothing to
   *  cancel and no refusal to report. */
  setThreadDone(threadId: string, done: boolean): void {
    const history = this.historyStore;
    if (!history) return;
    const meta = history.threadMeta(threadId);
    const provider = meta?.provider ?? this.routing.get(threadId);
    // Unknown threads have no row to agree with and no provider to route by —
    // announcing would send every list chasing a thread that isn't there, so
    // skip the write too instead of stamping a row that doesn't exist.
    if (!provider) return;
    history.setDone(threadId, done);
    const at = Date.now();
    this.dispatch({
      type: "thread.done.updated",
      threadId,
      provider,
      at,
      source: "kone.store",
      done,
      doneAt: done ? at : DONE_CLEARED,
    });
  }

  /** The thread-retention sweep, in two passes over the same timer:
   *
   *  1. Mark done — a thread quiet for three days stops asking. Done is an
   *     attention mark, not a hiding: the thread stays in the live list and
   *     the mark self-clears the moment the agent speaks in it. Never applied
   *     to threads already done, and never to `done_at = 0` (the user's
   *     explicit "not finished", which outranks age for good). Each mark is
   *     announced, so lists waiting on the event stream move the row without
   *     needing a turn to happen first.
   *  2. Archive — a thread quiet for a week is put away entirely (the same
   *     week-old thread already reads as done by then, so the funnel is
   *     done-at-three-days, archived-at-seven).
   *
   *  Candidates come from staleThreadIds (stale, unpinned, roots with nothing
   *  queued); a candidate that turned busy between the query and its write is
   *  simply skipped by the write's refusal, and the next sweep picks it up.
   *  Public for tests. */
  async sweepStaleThreads(): Promise<void> {
    const history = this.historyStore;
    if (!history) return;
    try {
      this.queueStore.recoverStaleClaims();
    } catch (err) {
      console.warn("[agent] recoverStaleClaims failed during sweep:", err);
    }
    const doneMs = this.options.retentionDoneMs ?? RETENTION_DONE_MS;
    if (doneMs > 0) {
      const doneCandidates = history.staleThreadIds({
        unusedMs: doneMs,
        limit: RETENTION_BATCH_SIZE,
        undone: true,
      });
      let done = 0;
      for (const threadId of doneCandidates) {
        this.setThreadDone(threadId, true);
        done++;
        if (RETENTION_BATCH_PAUSE_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, RETENTION_BATCH_PAUSE_MS));
        }
      }
      if (done > 0) {
        console.info(`[agent] retention: marked ${done} idle thread(s) done`);
      }
    }
    const unusedMs = this.options.retentionUnusedMs ?? RETENTION_UNUSED_MS;
    const candidates = history.staleThreadIds({ unusedMs, limit: RETENTION_BATCH_SIZE });
    let archived = 0;
    for (const threadId of candidates) {
      // The query reads timestamps; this reads the process table. A thread with
      // a session attached is one somebody has open in a column right now — the
      // stamps can still be a week old (an idle pane nobody has typed in) and
      // archiving it would close that column out from under them.
      if (this.hasLiveSession(threadId)) continue;
      const result = await this.setThreadArchived(threadId, true);
      if (result.ok) archived++;
      if (RETENTION_BATCH_PAUSE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RETENTION_BATCH_PAUSE_MS));
      }
    }
    if (archived > 0) {
      console.info(`[agent] retention: archived ${archived} idle thread(s)`);
    }
  }

  /** Retention is about stored rows, not live sessions, so its timer starts at
   *  construction — a quiet app that never opens a session still sweeps. The
   *  first pass waits out the boot window; the rest run daily. */
  private ensureRetentionSweep(): void {
    if (this.options.retentionSweepMs === 0 || this.retentionStartTimer) return;
    this.retentionStartTimer = setTimeout(() => {
      this.retentionStartTimer = null;
      void this.sweepStaleThreads().catch((err) => {
        console.warn("[agent] retention sweep failed:", err);
      });
      if (this.retentionTimer) return;
      const timer = setInterval(() => {
        void this.sweepStaleThreads().catch((err) => {
          console.warn("[agent] retention sweep failed:", err);
        });
      }, this.options.retentionSweepMs ?? RETENTION_SWEEP_MS);
      // Never hold the process open on the sweep's account — clean quit is
      // handled by the before-quit teardown, which clears this timer via stopAll.
      timer.unref?.();
      this.retentionTimer = timer;
    }, this.options.retentionInitialDelayMs ?? RETENTION_INITIAL_DELAY_MS);
    this.retentionStartTimer.unref?.();
  }

  /** The busy-path enqueue shared by sendTurn and steerTurn: persist a durable
   *  row, emit turn.queued, and ack with the queue id as the turn id (the
   *  renderer correlates the ack with the eventual turn.promoted by queueId). */
  private async enqueueTurn(
    input: SendTurnInput,
    dispatchMode: "queue" | "steer",
    provider: ProviderKind,
  ): Promise<TurnStartResult> {
    const store = this.queueStore;
    const queueId = randomUUID();
    const userBlockId = input.userBlockId ?? this.latestUserBlockId(input.threadId) ?? randomUUID();
    const row: QueuedTurnEnqueueInput = {
      queueId,
      threadId: input.threadId,
      userBlockId,
      dispatchMode,
      input: input.input,
    };
    if (input.attachments?.length) row.attachments = input.attachments;
    if (input.skills?.length) row.skills = input.skills;
    if (input.model) row.model = input.model;
    if (input.mode) row.mode = input.mode;
    if (input.effort) row.effort = input.effort;
    if (input.serviceTier) row.serviceTier = input.serviceTier;
    if (input.contextWindow) row.contextWindow = input.contextWindow;
    try {
      const accepted = store.enqueueQueuedTurn(row);
      if (!accepted) {
        // A row with this (thread_id, user_block_id) is still pending — an
        // idempotent replay of this exact follow-up. Ack with the existing
        // row's queue id so the caller correlates with the original chip.
        const existing = store.listQueuedTurns(input.threadId);
        return {
          threadId: input.threadId,
          turnId: existing.find((r) => r.userBlockId === userBlockId)?.queueId ?? queueId,
          queued: true,
        };
      }
    } catch (err) {
      console.error("[agent] enqueueQueuedTurn failed — falling back to direct send:", err);
      return this.adapterForThread(input.threadId).sendTurn(this.withViewBlock(input));
    }
    this.queuedByThread.set(input.threadId, (this.queuedByThread.get(input.threadId) ?? 0) + 1);
    const rows = await this.pendingQueueRows(input.threadId);
    const pending = rows ? rows.map((r) => r.queueId) : null;
    const sender = rows?.find((r) => r.queueId === queueId)?.sender;
    const queued: Extract<RuntimeEvent, { type: "turn.queued" }> = {
      type: "turn.queued",
      threadId: input.threadId,
      provider,
      queueId,
      userBlockId,
      dispatchMode,
      position: pending ? Math.max(1, pending.length) : Math.max(1, this.queuedByThread.get(input.threadId) ?? 1),
      at: Date.now(),
      source: "kone.store",
      input: input.input,
      attachmentsJson: row.attachments ? JSON.stringify(row.attachments) : null,
    };
    if (pending) queued.order = pending;
    if (sender) queued.sender = sender;
    if (row.skills?.length) queued.skills = row.skills;
    // The stamps the row was journaled with, so the renderer can mark the
    // promoted turn without waiting for a re-read of the queue.
    copyTurnStamp(row, queued);
    if (input.mode) queued.mode = input.mode;
    this.dispatch(queued);
    return { threadId: input.threadId, turnId: queueId, queued: true };
  }

  /** Every pending queue row on the thread, in the order they will run — what
   *  a new row's position, turn.queued's `order` and its `sender` are read
   *  from. Null when the store read fails; positions then fall back to the
   *  in-memory mirror. */
  private async pendingQueueRows(threadId: string): Promise<QueuedTurnRow[] | null> {
    const store = this.queueStore;
    try {
      return await store.listQueuedTurns(threadId);
    } catch {
      return null;
    }
  }

  /** The store block id of the user prompt dispatch just journaled for this
   *  thread — the LAST user block. dispatch.recordUserBlock mints the id
   *  internally and doesn't return it, so the queue path derives it by reading
   *  the transcript back, synchronously, before any await (no other send can
   *  interleave). The queue row's userBlockId must match the transcript block
   *  so the renderer's queued chip anchors to the same block and replayed
   *  enqueues dedupe. Null when the store has no user block (a send that
   *  never journaled); the caller then mints a fresh uuid. */
  private latestUserBlockId(threadId: string): string | null {
    try {
      return this.queueStore.latestUserBlockId(threadId);
    } catch {
      return null;
    }
  }

  /** Kick the queue drain for `threadId` (fire-and-forget). Called when a
   *  turn settles (trackEvent), when a session starts — the crash-recovery
   *  path: rows survive a quit and drain when the thread reopens — and when a
   *  retry's backoff runs out. A drain already waiting its turn covers this
   *  call too, so they don't pile up. */
  private promoteQueuedTurns(threadId: string): void {
    if (this.drainWaiting.has(threadId)) return;
    const store = this.queueStore;
    this.drainWaiting.add(threadId);
    void this.withQueueDelivery(threadId, () => {
      this.drainWaiting.delete(threadId);
      return this.drainQueuedTurns(threadId, store);
    });
  }

  /** Run one delivery of a queued row on `threadId` — a drain or a Send now —
   *  after every earlier one on that thread has finished. Claiming a row only
   *  reserves that row; this reserves the thread's one turn slot, so a Send
   *  now that is still handing its row over can't be overtaken by a drain
   *  that sees the thread idle and starts a second turn beside it. */
  private withQueueDelivery<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.queueDeliveries.get(threadId) ?? Promise.resolve();
    const result = prior.then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queueDeliveries.set(threadId, tail);
    void tail.then(() => {
      if (this.queueDeliveries.get(threadId) === tail) this.queueDeliveries.delete(threadId);
    });
    return result;
  }

  /** Claim and dispatch at most ONE queued turn per drain. Exactly one turn
   *  may be live per thread, so a drain that sent a turn stops there — the
   *  next turn.completed (or next startSession) triggers the next drain. A
   *  send failure is retried with backoff and then held (retryOrHold). */
  private async drainQueuedTurns(threadId: string, store: QueuedTurnStore): Promise<void> {
    try {
      // A compaction in flight owns the session until its boundary lands, and
      // so does the queue drain — a row must never promote into a session
      // mid-compaction and read a half-compacted context.
      if (this.isBusy(threadId) || this.isCompacting(threadId) || !this.routing.has(threadId)) return;
      // A row waiting out its backoff is retried by its own timer, not by
      // whatever turn event happens to come first.
      if (this.queueRetries.has(threadId)) return;
      if (this.turnInbox?.cutsIn?.(threadId)) {
        await this.runInboxTurn(threadId);
        return;
      }
      const row = store.claimNextQueuedTurn(threadId);
      if (!row) {
        await this.runInboxTurn(threadId);
        return;
      }
      const generation = this.sessionGeneration(threadId);
      this.announceQueuedState(threadId, row, "promoting");
      try {
        const input = this.turnInputFromQueuedRow(row);
        // Stopped or deleted since the claim: the cancel already announced it.
        if (!store.isQueuedTurnClaimed(row.queueId)) return;
        let promoted = false;
        const result = await this.dispatchToAdapter(threadId, input, row.userBlockId, undefined, {
          onAccepted: (turnId) => {
            promoted = this.settlePromoted(threadId, row.queueId, turnId);
          },
        });
        // Stopped while the provider was taking it: stop the turn it started.
        if (!promoted) this.stopOrphanedDelivery(threadId, generation, result?.turnId);
      } catch (err) {
        console.warn(`[agent] promotion of queued turn ${row.queueId} failed (try ${row.attemptCount}):`, err);
        this.retryOrHold(threadId, row, err instanceof Error ? err.message : String(err), store);
      }
    } catch (err) {
      console.error(`[agent] queue drain for ${threadId} failed:`, err);
    }
  }

  /** With nothing of the user's queued, what rings in the inbox starts a turn
   *  of its own. A refused one puts the messages back; they ring again when
   *  something next lets the turn slot run. */
  private async runInboxTurn(threadId: string): Promise<void> {
    if (!this.routing.has(threadId) || !this.turnInbox) return;
    const carried = this.turnInbox.carry(threadId, null);
    if (!carried) return;
    try {
      await this.dispatchToAdapter(threadId, carried.input, undefined, carried);
    } catch (err) {
      console.warn(`[agent] a turn for ${threadId}'s inbox did not start:`, err);
    }
  }

  /** Let the turn slot run for `threadId`: when the thread is free it starts
   *  the next turn — the user's next queued message, or one for what rings in
   *  its inbox — and when it is not, the turn ending does. */
  kickTurnSlot(threadId: string): void {
    this.promoteQueuedTurns(threadId);
  }

  /** Have every turn this service starts carry what waits in the thread's
   *  inbox. Null hands the inbox back to the dispatcher's own delivery. */
  setTurnInbox(inbox: TurnInbox | null): void {
    this.turnInbox = inbox;
  }

  /** Settle a claimed row that the provider accepted: mark it promoted and
   *  announce turn.promoted. False, and silent, when the claim was lost
   *  meanwhile — a stop or delete cancelled the row mid-flight and already
   *  announced that. */
  private settlePromoted(threadId: string, queueId: string, turnId: string | undefined): boolean {
    const store = this.queueStore;
    if (!store.markQueuedTurnPromoted(queueId)) return false;
    this.dropQueuedCount(threadId);
    const provider = this.routing.get(threadId);
    if (!provider) return true;
    const promoted: Extract<RuntimeEvent, { type: "turn.promoted" }> = {
      type: "turn.promoted",
      threadId,
      provider,
      queueId,
      at: Date.now(),
      source: "kone.store",
    };
    if (turnId) promoted.turnId = turnId;
    this.dispatch(promoted);
    return true;
  }

  /** A delivery whose row was cancelled while the provider was taking it
   *  stops the turn it started — only if that turn is still the thread's live
   *  one, in the session it was delivered into. By the time a slow delivery
   *  gets here the session may have been stopped and restarted and be running
   *  an ordinary turn that is none of this delivery's business. */
  private stopOrphanedDelivery(threadId: string, generation: number, turnId: string | undefined): void {
    if (!turnId || this.sessionGeneration(threadId) !== generation) return;
    if (this.activeTurns.get(threadId) !== turnId) return;
    void this.interruptTurn(threadId).catch((err) => {
      console.warn(`[agent] stopping a cancelled delivery's turn failed for ${threadId}:`, err);
    });
  }

  private sessionGeneration(threadId: string): number {
    return this.sessionGenerations.get(threadId) ?? 0;
  }

  private bumpSessionGeneration(threadId: string): void {
    this.sessionGenerations.set(threadId, this.sessionGeneration(threadId) + 1);
  }

  /** Give a claimed row back (to waiting, or held). Never throws: a store
   *  failure here is logged, and the row is then recovered as a stale claim. */
  private releaseRow(store: QueuedTurnStore, queueId: string, to: "queued" | "failed"): boolean {
    try {
      return store.releaseQueuedTurn(queueId, to);
    } catch (err) {
      console.error(`[agent] releasing queued turn ${queueId} failed:`, err);
      return false;
    }
  }

  /** A drained row the provider refused. While it has retries left it goes
   *  back in line and the drain runs again after the next backoff delay;
   *  after the last one it is held ('failed'), which pauses what runs after
   *  it until the user sends it now or removes it. Either way the row and the
   *  warning say which. A row that was cancelled meanwhile (the release finds
   *  nothing to release) is left alone: no status, no warning, no timer. */
  private retryOrHold(threadId: string, row: QueuedTurnRow, error: string, store: QueuedTurnStore): void {
    const delays = this.options.queueRetryDelaysMs ?? QUEUE_RETRY_DELAYS_MS;
    // attemptCount already counts this try (the claim bumped it).
    const retryIn = delays[row.attemptCount - 1];
    const provider = this.routing.get(threadId);
    if (retryIn === undefined) {
      if (!this.releaseRow(store, row.queueId, "failed")) return;
      // Held now: nothing retries it until the user says so.
      this.clearQueueRetry(threadId);
      this.announceQueuedState(threadId, row, "failed", { error });
      if (provider) {
        this.warn(
          threadId,
          provider,
          `A queued message didn't start after ${row.attemptCount} tries (${error}). It's held in the queue: send it now or remove it.`,
        );
      }
      return;
    }
    if (!this.releaseRow(store, row.queueId, "queued")) return;
    const retryAt = Date.now() + retryIn;
    this.announceQueuedState(threadId, row, "queued", { retryAt, error });
    if (provider) {
      this.warn(
        threadId,
        provider,
        `A queued message didn't start (${error}). Trying again in ${Math.ceil(retryIn / 1000)}s.`,
      );
    }
    this.clearQueueRetry(threadId);
    const timer = setTimeout(() => {
      this.queueRetries.delete(threadId);
      this.promoteQueuedTurns(threadId);
    }, retryIn);
    timer.unref?.();
    this.queueRetries.set(threadId, { queueId: row.queueId, timer });
  }

  private clearQueueRetry(threadId: string): void {
    const retry = this.queueRetries.get(threadId);
    if (!retry) return;
    clearTimeout(retry.timer);
    this.queueRetries.delete(threadId);
  }

  private warn(threadId: string, provider: ProviderKind, message: string): void {
    this.dispatch({ type: "session.warning", threadId, provider, at: Date.now(), source: "kone.store", message });
  }

  /** Announce a pending row's state change (turn.queued-updated). */
  private announceQueuedState(
    threadId: string,
    row: QueuedTurnRow,
    state: "queued" | "promoting" | "failed",
    detail: { retryAt?: number; error?: string } = {},
  ): void {
    const provider = this.routing.get(threadId);
    if (!provider) return;
    this.dispatch({
      type: "turn.queued-updated",
      threadId,
      provider,
      at: Date.now(),
      source: "kone.store",
      queueId: row.queueId,
      state,
      attemptCount: row.attemptCount,
      ...detail,
    });
  }

  /** Rebuild a SendTurnInput from a claimed queue row — the prompt,
   *  attachments, and every per-turn override the user chose when they sent
   *  it. */
  private turnInputFromQueuedRow(row: QueuedTurnRow): SendTurnInput {
    let attachments = row.attachments;
    if (attachments?.length) {
      try {
        const store = getAttachmentStore();
        const valid = attachments.filter((att) => {
          const absPath = store.resolveAbsPath(att.id);
          if (!absPath || !existsSync(absPath)) {
            console.warn(
              `[agent] queued turn attachment ${att.id} (${att.name}) missing on disk — dropped from dispatch`,
            );
            return false;
          }
          return true;
        });
        attachments = valid.length > 0 ? valid : undefined;
      } catch {
        // Attachment store lookup failed — proceed with parsed attachments
      }
    }
    const input: SendTurnInput = {
      threadId: row.threadId,
      input: row.input,
    };
    if (attachments?.length) input.attachments = attachments;
    if (row.skills?.length) input.skills = row.skills;
    if (row.model) input.model = row.model;
    const mode = QUEUED_MODES.find((m) => m === row.mode);
    if (mode) input.mode = mode;
    if (row.effort) input.effort = row.effort;
    if (row.serviceTier) input.serviceTier = row.serviceTier;
    if (row.contextWindow) input.contextWindow = row.contextWindow;
    return input;
  }

  /** Cancel every queued follow-up on a thread while leaving its session up —
   *  for a stop that interrupts the live turn, whose abort would otherwise
   *  promote the next queued follow-up straight away. Announced like a
   *  session stop (reason "stop"). */
  async cancelQueuedTurns(threadId: string): Promise<void> {
    this.cancelQueuedForStop(threadId, this.routing.get(threadId) ?? null);
  }

  /** Cancel a thread's queue because the thread is being deleted — the IPC
   *  delete path, which goes around the session. Announced with reason
   *  "thread-deleted", and its pending retry goes with it. */
  cancelQueuedTurnsForDelete(threadId: string): void {
    this.cancelThreadQueue(threadId, this.routing.get(threadId) ?? null, "thread-deleted");
  }

  /** Cancel every pending row for a thread whose session is stopping. Runs
   *  BEFORE the adapter teardown so no drain can claim into a dying session. */
  private cancelQueuedForStop(threadId: string, provider: ProviderKind | null): void {
    this.cancelThreadQueue(threadId, provider, "stop");
  }

  /** Cancel every pending row for a thread (stop, delete, archive), clear its
   *  pending retry, and emit one turn.queued-cancelled per row. A delivery
   *  holding a claim finds it gone before it reaches the provider. */
  private cancelThreadQueue(
    threadId: string,
    provider: ProviderKind | null,
    reason: "stop" | "thread-deleted" | "archive",
  ): void {
    this.clearQueueRetry(threadId);
    const resolved = provider ?? this.historyStore?.threadMeta(threadId)?.provider ?? null;
    try {
      const queueIds = this.queueStore.cancelQueuedTurnsForThread(threadId);
      if (queueIds.length) this.dropQueuedCount(threadId, queueIds.length);
      if (!resolved) return;
      for (const queueId of queueIds) {
        this.dispatch({
          type: "turn.queued-cancelled",
          threadId,
          provider: resolved,
          queueId,
          reason,
          at: Date.now(),
          source: "kone.store",
        });
      }
    } catch (err) {
      console.error(`[agent] cancelQueuedTurnsForThread(${threadId}) failed:`, err);
    }
  }

  /** Decrement the in-memory queued-count mirror (position fallback only). */
  private dropQueuedCount(threadId: string, by = 1): void {
    const current = this.queuedByThread.get(threadId) ?? 0;
    const next = Math.max(0, current - by);
    if (next === 0) this.queuedByThread.delete(threadId);
    else this.queuedByThread.set(threadId, next);
  }

  // ── subagents (routed; no-op on providers without a nested-agent surface) ──

  /** Fork a thread at one of its user blocks — edit-and-resend of an earlier
   *  message. The fork copies the transcript prefix and journals the edited
   *  text; dispatching its first turn is the caller's job (the dispatcher
   *  starts the fork's session and sends it silent, so the bootstrap hands
   *  the copied history to the model exactly once).
   *
   *  Refuses while the source thread has a turn in flight: forking would slice
   *  a moving transcript, and the new turn would race the live one. The
   *  renderer disables the affordance while busy; this is the second guard
   *  for races. Queued follow-ups are NOT a refusal — they stay on the
   *  source, and the fork branches from settled history only. */
  forkThreadForEdit(input: ForkThreadAtBlockInput): ForkThreadAtBlockResult {
    if (this.isBusy(input.sourceThreadId)) {
      throw new Error(
        "A turn is still running on this thread — wait for it to finish (or stop it) before editing an earlier message.",
      );
    }
    return forkThreadForEdit(input);
  }

  /** Stop one nested subagent run without ending the parent turn. */
  async stopSubagent(threadId: string, toolUseId: string): Promise<void> {
    return this.adapterForThread(threadId).stopSubagent?.(threadId, toolUseId);
  }

  /** Send a mid-task message to a running nested subagent. */
  async steerSubagent(threadId: string, toolUseId: string, message: string): Promise<void> {
    return this.adapterForThread(threadId).steerSubagent?.(threadId, toolUseId, message);
  }

  async listSessions(): Promise<Session[]> {
    const all = await Promise.all([...this.adapters.values()].map((a) => a.listSessions()));
    return all.flat();
  }

  /** Tear down everything — called on app quit so no agent subprocess is left. */
  async stopAll(): Promise<void> {
    if (this.wedgeTimer) {
      clearInterval(this.wedgeTimer);
      this.wedgeTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.retentionStartTimer) {
      clearTimeout(this.retentionStartTimer);
      this.retentionStartTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    await Promise.all([...this.adapters.values()].map((a) => a.stopAll()));
    this.routing.clear();
    this.parkedByThread.clear();
    this.activeTurns.clear();
    this.dispatchingTurns.clear();
    this.openItems.clear();
    // Queued ROWS are deliberately NOT cleared on quit — durability is the
    // point of the queue; the next startSession drains them. Only the
    // in-memory mirrors reset.
    this.queueDeliveries.clear();
    this.drainWaiting.clear();
    this.queuedByThread.clear();
    for (const retry of this.queueRetries.values()) clearTimeout(retry.timer);
    this.queueRetries.clear();
    this.lastActivity.clear();
  }
}
