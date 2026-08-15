import { randomUUID } from "node:crypto";
import { AntigravityAdapter } from "./adapters/AntigravityAdapter.js";
import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { CursorAdapter } from "./adapters/CursorAdapter.js";
import { DroidAdapter } from "./adapters/DroidAdapter.js";
import { OpenCodeAdapter } from "./adapters/OpenCodeAdapter.js";
import { getConversationStore } from "./ConversationStore.js";
import { buildAgentEnv } from "./processEnv.js";
import {
  cacheModels,
  cacheStatuses,
  readProviderCache,
  type ProviderSurfaceSnapshot,
} from "./providerCache.js";
import { resolveProviderMaintenance, runProviderUpdate } from "./providerMaintenance.js";
import { readProviderSettings, writeProviderSettings } from "./providerSettings.js";
import { sidechatBootstrapForTurn } from "./sidechat.js";
import type { GatewayHandle } from "./gateway/index.js";
import type {
  ApprovalDecision,
  ChatAttachment,
  EmitEvent,
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
  TurnStartResult,
  UserInputAnswers,
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

/** How often the idle session reaper sweeps inactive sessions (module constants
 *  so the tuning lives with the mechanism it tunes). */
const IDLE_SWEEP_MS = 5 * 60_000;
/** Inactive session threshold: a session with no active turn and no activity
 *  for this long is cleanly stopped to reclaim child CLI processes and system
 *  resources. Subsequent turns rehydrate/resume on demand. */
const IDLE_THRESHOLD_MS = 30 * 60_000;

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
  idleSweepMs?: number;
  idleThresholdMs?: number;
  /** The conversation store's queue surface, injected by tests. Defaults to
   *  the app-wide store (getConversationStore) when absent. */
  store?: QueuedTurnStore;
  /** Adapters to register instead of the five real ones, handed the service's
   *  emit closure exactly like the real construction path. Injected by tests
   *  so no CLI is ever spawned. */
  adapters?: (emit: EmitEvent) => ProviderAdapter[];
};

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
  private warming: Promise<void> | null = null;
  /** Parked asks per thread (requestId → ask). Approvals/user-inputs are live
   *  round-trips and are never journaled, so this map is the only record a
   *  re-subscribing renderer can be replayed from (reload recovery), and the
   *  precise "waiting on the human" signal the wedge watchdog must respect. */
  private readonly parkedByThread = new Map<string, Map<string, PendingInteraction>>();
  /** Last event arrival per thread — the wedge watchdog's heartbeat and idle reaper clock. */
  private readonly lastActivity = new Map<string, number>();
  /** Turns currently live per thread (turnId) — the wedge watchdog's scope. */
  private readonly activeTurns = new Map<string, string>();
  /** Threads with a queue-drain already in flight — one drain per thread at a
   *  time, so two settlement events can't double-claim the next row. */
  private readonly promotingThreads = new Set<string>();
  /** In-memory mirror of how many rows are queued per thread — the fallback
   *  for `turn.queued` positions when the store read fails. Drift from the
   *  store (crash recovery) self-corrects on the next successful read. */
  private readonly queuedByThread = new Map<string, number>();
  private queueUnavailableWarned = false;
  /** The wedge sweep timer — lazily started on first session, cleared on stopAll. */
  private wedgeTimer: ReturnType<typeof setInterval> | null = null;
  /** The idle session sweep timer — lazily started on first session, cleared on stopAll. */
  private idleTimer: ReturnType<typeof setInterval> | null = null;

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
      if (models?.length) this.catalogs.set(provider as ProviderKind, models);
    }
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

  /** The conversation store's queue surface, or null when the store slice
   *  hasn't landed yet (ConversationStore.ts is owned by the store agent and
   *  lands in parallel; the queue contract's method set is its landing
   *  signal). Every queue path degrades to the pre-queue behavior on null —
   *  a busy send goes straight to the adapter again, and promotion/cancel
   *  paths no-op — instead of crashing the main process mid-tree. */
  private get queueStore(): QueuedTurnStore | null {
    const store = this.options.store ?? (getConversationStore() as unknown);
    if (store && typeof (store as QueuedTurnStore).enqueueQueuedTurn === "function") {
      return store as QueuedTurnStore;
    }
    if (!this.queueUnavailableWarned) {
      this.queueUnavailableWarned = true;
      console.warn(
        "[agent] durable turn queue unavailable (store slice not landed) — " +
          "busy sends fall back to direct dispatch",
      );
    }
    return null;
  }

  /** Subscribe to the merged runtime event stream. Returns an unsubscribe fn. */
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    return readProviderCache();
  }

  /** Probe every provider on the user's machine — what's installed + logged in. */
  async discover(): Promise<ProviderStatus[]> {
    const statuses = await Promise.all([...this.adapters.values()].map((a) => a.discover()));
    cacheStatuses(statuses);
    return statuses;
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
    const next = writeProviderSettings(provider, config);
    this.adapters.get(provider)?.setConfig?.(next[provider] ?? {});
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
      [...this.adapters.keys()].map((provider) =>
        resolveProviderMaintenance({
          provider,
          ...(settings[provider]?.binaryPath
            ? { binaryOverride: settings[provider]?.binaryPath }
            : {}),
          currentVersion: this.knownVersion(provider),
          env,
          checkLatest: options?.checkLatest ?? true,
          force: options?.force ?? false,
        }),
      ),
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

    const run = await runProviderUpdate({
      provider,
      ...(override ? { binaryOverride: override } : {}),
      env,
    });

    if (run.outcome === "unsupported") {
      return {
        provider,
        outcome: run.outcome,
        message: run.message,
        output: run.output,
        maintenance: await resolveProviderMaintenance({
          provider,
          ...(override ? { binaryOverride: override } : {}),
          currentVersion: before,
          env,
          checkLatest: false,
        }),
        statuses: readProviderCache().statuses,
      };
    }

    // The install moved (or tried to), so everything downstream of it is stale:
    // re-probe every provider and refresh the model catalog, since a new CLI can
    // ship new models.
    const statuses = await this.discover();
    const after = statuses.find((s) => s.provider === provider)?.version ?? null;
    void this.listModels(provider).catch(() => []);

    const maintenance = await resolveProviderMaintenance({
      provider,
      ...(override ? { binaryOverride: override } : {}),
      currentVersion: after,
      env,
      checkLatest: true,
      force: true,
    });

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

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    this.lastActivity.set(input.threadId, Date.now());
    // SendTurnInput.model overrides the session model per turn (CodexAdapter
    // sets `session.model = input.model`), so guarding startSession alone left
    // the desync fully live — every turn re-supplied the foreign id.
    const provider = this.routing.get(input.threadId);
    // A side chat's FIRST turn carries the one-shot `<sidechat_context>`
    // bootstrap (sidechat.ts): the imported transcript as reference-only
    // context, the boundary instruction, and the user's message wrapped in
    // `<latest_user_message>`. Null for every other turn/thread. Overlong
    // turns (imported context + message > send cap) reject here, up front.
    const sidechatInput = sidechatBootstrapForTurn(input.threadId, input.input);
    // dispatchMode is the service's own routing hint — strip it before
    // anything reaches an adapter (adapters don't know the queue exists).
    const { dispatchMode, ...base } = input;
    const next = sidechatInput ? { ...base, input: sidechatInput } : base;
    if (!provider) return this.adapterForThread(input.threadId).sendTurn(next);
    const model = this.validModelFor(provider, next.model);
    const effort = this.validEffortFor(provider, model, next.effort);
    const routed = { ...next, model, effort };
    // Busy-intercept: a live turn means this follow-up is durably enqueued
    // rather than racing the live turn (sending straight to the adapter would
    // start a second concurrent turn on the same session). `steer` requests
    // that reach sendTurn go through the same queue — steers claim first.
    if (this.activeTurns.has(input.threadId)) {
      return this.enqueueTurn(routed, dispatchMode ?? "queue", provider);
    }
    return this.adapterForThread(input.threadId).sendTurn(routed);
  }

  async interruptTurn(threadId: string): Promise<void> {
    return this.adapterForThread(threadId).interruptTurn(threadId);
  }

  async stopSession(threadId: string): Promise<void> {
    const provider = this.routing.get(threadId);
    if (!provider) return;
    // Cancel queued follow-ups BEFORE the teardown: a row must never promote
    // into a session that is being torn down (a drain racing the stop could
    // otherwise claim one and hand it to a dead session).
    await this.cancelQueuedForStop(threadId, provider);
    await this.adapter(provider).stopSession(threadId);
    this.routing.delete(threadId);
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
        break;
      case "turn.completed":
      case "turn.aborted":
        this.activeTurns.delete(threadId);
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
      default:
        break;
    }
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
    this.lastActivity.delete(threadId);
  }

  /** The wedge watchdog: a live turn whose provider has gone silent. A JSON-RPC
   *  timeout already rejected the in-flight promise (jsonRpc.ts), but nothing
   *  kills the child or seals the turn — without this sweep a wedged provider
   *  leaves its block `running` forever and the composer disabled. Resets via
   *  stopSession: the adapters' stop drains parked asks, seals the live turn
   *  as interrupted, and kills the child. Sessions parked on a human answer
   *  are never touched — the parked-ask map is the precise waiting signal. */
  private sweepWedgedSessions(): void {
    const now = Date.now();
    for (const threadId of [...this.activeTurns.keys()]) {
      // Waiting on the user is not wedged — the silence is the point.
      if (this.parkedByThread.get(threadId)?.size) continue;
      const last = this.lastActivity.get(threadId);
      const silenceMs = this.options.wedgeSilenceMs ?? WEDGE_SILENCE_MS;
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
    for (const threadId of [...this.routing.keys()]) {
      // Never reap while a turn is in flight.
      if (this.activeTurns.has(threadId)) continue;
      // Never reap while waiting on user approval or question answer.
      if (this.parkedByThread.get(threadId)?.size) continue;
      // Never reap if queued follow-ups are waiting to run or being promoted.
      if ((this.queuedByThread.get(threadId) ?? 0) > 0 || this.promotingThreads.has(threadId)) continue;

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
      try {
        void this.sweepIdleSessions();
      } catch (err) {
        console.warn("[agent] idle session reaper sweep failed:", err);
      }
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
  ): Promise<void> {
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
   *  there is nothing to steer — a steer is just a send. */
  async steerTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const threadId = input.threadId;
    if (this.activeTurns.has(threadId)) {
      const adapter = this.adapterForThread(threadId);
      if (adapter.steerTurn) {
        const liveTurnId = this.activeTurns.get(threadId);
        const result = await adapter.steerTurn(input);
        const provider = this.routing.get(threadId);
        if (liveTurnId && provider) {
          this.dispatch({
            type: "turn.steered",
            threadId,
            provider,
            turnId: liveTurnId,
            message: input.input,
            at: Date.now(),
            source: "kone.store",
          });
        }
        return result;
      }
      const provider = this.routing.get(threadId);
      if (provider) return this.enqueueTurn(input, "steer", provider);
    }
    return this.sendTurn(input);
  }

  /** Cancel one queued follow-up (user-initiated drop). Emits
   *  turn.queued-cancelled (reason "user") when a row was actually cancelled;
   *  returns false when no such row exists. */
  async cancelQueuedTurn(threadId: string, queueId: string): Promise<boolean> {
    const store = this.queueStore;
    if (!store) return false;
    const cancelled = await store.cancelQueuedTurn(queueId);
    if (cancelled) {
      this.dropQueuedCount(threadId);
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
    }
    return cancelled;
  }

  /** The thread's queued follow-ups, as the store keeps them — the passthrough
   *  the IPC agent's queued-turns channel reads. */
  async listQueuedTurns(threadId: string): Promise<QueuedTurnRow[]> {
    const store = this.queueStore;
    if (!store) return [];
    return store.listQueuedTurns(threadId);
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
    if (!store) return this.adapterForThread(input.threadId).sendTurn(input);
    const queueId = randomUUID();
    const userBlockId = this.latestUserBlockId(input.threadId) ?? randomUUID();
    const now = Date.now();
    const row: QueuedTurnRow = {
      queueId,
      threadId: input.threadId,
      userBlockId,
      dispatchMode,
      state: "queued",
      input: input.input,
      attachmentsJson: input.attachments?.length ? JSON.stringify(input.attachments) : null,
      model: input.model ?? null,
      mode: input.mode ?? null,
      effort: input.effort ?? null,
      serviceTier: input.serviceTier ?? null,
      contextWindow: input.contextWindow ?? null,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      promotedAt: null,
    };
    try {
      const accepted = await store.enqueueQueuedTurn(row);
      if (!accepted) {
        // A row with this (thread_id, user_block_id) is already active — an
        // idempotent replay of this exact follow-up. Ack with the existing
        // row's queue id so the caller correlates with the original chip.
        const existing = await store.listQueuedTurns(input.threadId);
        return {
          threadId: input.threadId,
          turnId: existing.find((r) => r.userBlockId === userBlockId)?.queueId ?? queueId,
        };
      }
    } catch (err) {
      console.error("[agent] enqueueQueuedTurn failed — falling back to direct send:", err);
      return this.adapterForThread(input.threadId).sendTurn(input);
    }
    this.queuedByThread.set(input.threadId, (this.queuedByThread.get(input.threadId) ?? 0) + 1);
    this.dispatch({
      type: "turn.queued",
      threadId: input.threadId,
      provider,
      queueId,
      userBlockId,
      dispatchMode,
      position: await this.queuePosition(input.threadId),
      at: Date.now(),
      source: "kone.store",
    });
    return { threadId: input.threadId, turnId: queueId };
  }

  /** The new turn's place in line: the live turn is slot 1 and each already
   *  queued row is another slot, so a fresh queue entry on an idle-but-busy
   *  thread reads 2. Read from the store (positions then survive crash
   *  recovery); the in-memory mirror is the fallback when the read fails. */
  private async queuePosition(threadId: string): Promise<number> {
    const store = this.queueStore;
    if (store) {
      try {
        const queued = await store.listQueuedTurns(threadId);
        return queued.length + 1;
      } catch {
        // fall through to the in-memory mirror
      }
    }
    return (this.queuedByThread.get(threadId) ?? 0) + 1;
  }

  /** The store block id of the user prompt dispatch just journaled for this
   *  thread — the LAST user block. dispatch.recordUserBlock mints the id
   *  internally and doesn't return it, so the queue path derives it by reading
   *  the transcript back, synchronously, before any await (no other send can
   *  interleave). The queue row's userBlockId must match the transcript block
   *  so the renderer's queued chip anchors to the same block and replayed
   *  enqueues dedupe. Falls back to a fresh uuid when the store has no blocks
   *  (e.g. a send that never journaled). */
  private latestUserBlockId(threadId: string): string | null {
    const store = this.queueStore;
    if (!store) return null;
    try {
      if (typeof store.latestUserBlockId === "function") {
        const id = store.latestUserBlockId(threadId);
        if (id) return id;
      }
      const thread = store.loadThread(threadId);
      if (!thread) return null;
      for (let i = thread.blocks.length - 1; i >= 0; i--) {
        const block = thread.blocks[i];
        if (block && block.role === "user") return block.id;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Kick the queue drain for `threadId` (fire-and-forget, serialized per
   *  thread). Called when a turn settles (trackEvent) and when a session
   *  starts — the crash-recovery path: rows survive a quit and drain when the
   *  thread reopens. */
  private promoteQueuedTurns(threadId: string): void {
    if (this.promotingThreads.has(threadId)) return;
    const store = this.queueStore;
    if (!store) return;
    this.promotingThreads.add(threadId);
    void this.drainQueuedTurns(threadId, store).finally(() => {
      this.promotingThreads.delete(threadId);
    });
  }

  /** Claim and dispatch at most ONE queued turn per drain. Exactly one turn
   *  may be live per thread, so a drain that sent a turn stops there — the
   *  next turn.completed (or next startSession) triggers the next drain. A
   *  send failure releases the row (promoting→queued) so a later drain retries
   *  it, and says so on the event stream. */
  private async drainQueuedTurns(threadId: string, store: QueuedTurnStore): Promise<void> {
    const provider = this.routing.get(threadId);
    try {
      if (this.activeTurns.has(threadId)) return;
      const row = await store.claimNextQueuedTurn(threadId);
      if (!row) return;
      try {
        const result = await this.adapterForThread(threadId).sendTurn(
          this.turnInputFromQueuedRow(row),
        );
        const claimed = await store.markQueuedTurnPromoted(row.queueId);
        // Lost the claim (the row was cancelled mid-flight by a stop/delete) —
        // stop; the cancel path already announced it.
        if (!claimed) return;
        this.dropQueuedCount(threadId);
        if (provider) {
          this.dispatch({
            type: "turn.promoted",
            threadId,
            provider,
            queueId: row.queueId,
            ...(result?.turnId ? { turnId: result.turnId } : {}),
            at: Date.now(),
            source: "kone.store",
          });
        }
      } catch (err) {
        // The turn was not accepted — put the row back for a later drain and
        // tell the renderer the queue stalled on this entry.
        await store.releaseQueuedTurn(row.queueId).catch(() => {});
        console.warn(`[agent] promotion of queued turn ${row.queueId} failed — released:`, err);
        if (provider) {
          this.dispatch({
            type: "session.warning",
            threadId,
            provider,
            at: Date.now(),
            source: "kone.store",
            message: "A queued turn didn't start — it stays queued and will retry.",
          });
        }
      }
    } catch (err) {
      console.error(`[agent] queue drain for ${threadId} failed:`, err);
    }
  }

  /** Rebuild a SendTurnInput from a claimed queue row — the prompt,
   *  attachments (deserialized from the JSON column), and every per-turn
   *  override the user chose when they sent it. */
  private turnInputFromQueuedRow(row: QueuedTurnRow): SendTurnInput {
    let attachments: ChatAttachment[] | undefined;
    if (row.attachmentsJson) {
      try {
        const parsed = JSON.parse(row.attachmentsJson) as unknown;
        if (Array.isArray(parsed)) attachments = parsed as ChatAttachment[];
      } catch {
        // Corrupt attachments JSON — send the prompt without attachments
        // rather than dropping the whole queued turn.
      }
    }
    return {
      threadId: row.threadId,
      input: row.input,
      ...(attachments?.length ? { attachments } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.mode ? { mode: row.mode } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      ...(row.serviceTier ? { serviceTier: row.serviceTier } : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    };
  }

  /** Cancel every queued/promoting row for a thread whose session is stopping,
   *  emitting one turn.queued-cancelled (reason "stop") per row. Runs BEFORE
   *  the adapter teardown so no drain can claim into a dying session. */
  private async cancelQueuedForStop(threadId: string, provider: ProviderKind): Promise<void> {
    const store = this.queueStore;
    if (!store) return;
    try {
      const queueIds = await store.cancelQueuedTurnsForThread(threadId);
      if (queueIds.length) this.dropQueuedCount(threadId, queueIds.length);
      for (const queueId of queueIds) {
        this.dispatch({
          type: "turn.queued-cancelled",
          threadId,
          provider,
          queueId,
          reason: "stop",
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
    await Promise.all([...this.adapters.values()].map((a) => a.stopAll()));
    this.routing.clear();
    this.parkedByThread.clear();
    this.activeTurns.clear();
    // Queued ROWS are deliberately NOT cleared on quit — durability is the
    // point of the queue; the next startSession drains them. Only the
    // in-memory mirrors reset.
    this.promotingThreads.clear();
    this.queuedByThread.clear();
    this.lastActivity.clear();
  }
}
