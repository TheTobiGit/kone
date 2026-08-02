import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { OpenCodeAdapter } from "./adapters/OpenCodeAdapter.js";
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

// The cross-provider facade that lives in the Electron main process (the agent
// analogue of ProviderService in research). It owns the adapter registry, routes
// thread-scoped calls to the adapter that owns the thread, and fans every
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

  constructor() {
    const emit: EmitEvent = (event) => {
      for (const listener of this.listeners) listener(event);
    };
    this.register(new CodexAdapter(emit));
    this.register(new ClaudeAdapter(emit));
    this.register(new OpenCodeAdapter(emit));
    // Point each adapter at the user's persisted install settings (custom binary
    // path, …) before anything probes or spawns. Unset providers keep their
    // built-in default, so a fresh install behaves exactly as before.
    const settings = readProviderSettings();
    for (const [provider, adapter] of this.adapters) {
      adapter.setConfig?.(settings[provider] ?? {});
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

  /** Probe every provider on the user's machine — what's installed + logged in. */
  async discover(): Promise<ProviderStatus[]> {
    return Promise.all([...this.adapters.values()].map((a) => a.discover()));
  }

  async listModels(provider: ProviderKind): Promise<ModelDescriptor[]> {
    return this.adapter(provider).listModels();
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

  async startSession(input: SessionStartInput): Promise<Session> {
    const session = await this.adapter(input.provider).startSession(input);
    this.routing.set(input.threadId, input.provider);
    return session;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    return this.adapterForThread(input.threadId).sendTurn(input);
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
