import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { CursorAdapter } from "./adapters/CursorAdapter.js";
import { DroidAdapter } from "./adapters/DroidAdapter.js";
import { OpenCodeAdapter } from "./adapters/OpenCodeAdapter.js";
import {
  cacheModels,
  cacheStatuses,
  readProviderCache,
  type ProviderCacheSnapshot,
} from "./providerCache.js";
import { readProviderSettings, writeProviderSettings } from "./providerSettings.js";
import type {
  ApprovalDecision,
  EmitEvent,
  ModelDescriptor,
  ProviderAdapter,
  ProviderConfig,
  ProviderKind,
  ProviderSettingsMap,
  ProviderStatus,
  RuntimeEvent,
  Session,
  SendTurnInput,
  SessionStartInput,
  TurnStartResult,
  UserInputAnswers,
} from "./types.js";

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
  private warming: Promise<void> | null = null;

  constructor() {
    const emit: EmitEvent = (event) => {
      for (const listener of this.listeners) listener(event);
    };
    this.register(new CodexAdapter(emit));
    this.register(new ClaudeAdapter(emit));
    this.register(new OpenCodeAdapter(emit));
    this.register(new CursorAdapter(emit));
    this.register(new DroidAdapter(emit));
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

  /** Subscribe to the merged runtime event stream. Returns an unsubscribe fn. */
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /** The last known provider surface, straight off the disk cache — no CLI is
   *  spawned, so this answers in microseconds. The renderer hydrates its picker
   *  from this at app open and refreshes in the background, which is what makes
   *  a cold launch present a provider list that's actually usable rather than
   *  one that only *looks* populated. Empty on a first-ever run. */
  cachedSurface(): ProviderCacheSnapshot {
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
    const session = await this.adapter(input.provider).startSession({ ...input, model, effort });
    this.routing.set(input.threadId, input.provider);
    return session;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    // SendTurnInput.model overrides the session model per turn (CodexAdapter
    // sets `session.model = input.model`), so guarding startSession alone left
    // the desync fully live — every turn re-supplied the foreign id.
    const provider = this.routing.get(input.threadId);
    if (!provider) return this.adapterForThread(input.threadId).sendTurn(input);
    const model = this.validModelFor(provider, input.model);
    const effort = this.validEffortFor(provider, model, input.effort);
    return this.adapterForThread(input.threadId).sendTurn({ ...input, model, effort });
  }

  async interruptTurn(threadId: string): Promise<void> {
    return this.adapterForThread(threadId).interruptTurn(threadId);
  }

  async stopSession(threadId: string): Promise<void> {
    const provider = this.routing.get(threadId);
    if (!provider) return;
    await this.adapter(provider).stopSession(threadId);
    this.routing.delete(threadId);
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
    await Promise.all([...this.adapters.values()].map((a) => a.stopAll()));
    this.routing.clear();
  }
}
