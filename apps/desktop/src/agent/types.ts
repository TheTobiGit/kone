// ── Agent provider data model ───────────────────────────────────────────────
// The load-bearing contract for kone's multi-provider agent layer. Everything
// here is flat and serializable — it all crosses the IPC boundary to the
// renderer. Mirror any change in apps/web/app/types/desktop.d.ts.
//
// The design (distilled from research's provider layer): session control is
// request/ack — startSession/sendTurn/interrupt resolve as soon as the turn is
// *accepted* — and ALL streamed output flows through one normalized RuntimeEvent
// union. The renderer is written once against that union and never learns which
// CLI is underneath. Adding a provider is a new adapter, not a UI change.

/** A supported agent provider. Grows as adapters land (claudeAgent, codex, …). */
export type ProviderKind = "antigravity";

// ── Discovery / health ───────────────────────────────────────────────────────

/** Whether the user's provider CLI is logged in (its own subscription/auth). */
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

/** Rolled-up health for a provider row in the UI. */
export type ProviderReadiness = "ready" | "needs-login" | "not-installed" | "error";

/** The result of probing one provider on the user's machine. kone never holds
 *  provider credentials — this only *detects* an already-installed, already
 *  logged-in CLI. */
export type ProviderStatus = {
  provider: ProviderKind;
  /** Display name, e.g. "Antigravity". */
  label: string;
  /** Binary present on PATH and runnable. */
  available: boolean;
  authStatus: AuthStatus;
  readiness: ProviderReadiness;
  /** CLI version string, when detected. */
  version?: string;
  /** How the CLI is authenticated, e.g. "Google Sign-In" / "Antigravity API Key". */
  authLabel?: string;
  /** Human message — a hint to fix a not-ready provider (e.g. run `agy` to log in). */
  message?: string;
};

/** A model the provider can run, from its own `list models` surface. */
export type ModelDescriptor = {
  /** Stable id passed back on a turn (what the CLI's --model flag expects). */
  id: string;
  label: string;
};

// ── Session / turn IO ────────────────────────────────────────────────────────

/** How much the agent may do without asking. Mirrors the calm-UI intent. */
export type InteractionMode = "default" | "accept-edits" | "plan" | "full-access";

export type SessionStartInput = {
  /** Caller-chosen thread id — kone owns this; the CLI's native id is mapped
   *  onto it via ProviderRefs. */
  threadId: string;
  provider: ProviderKind;
  /** Absolute path of the project/workspace root the agent operates in. */
  cwd: string;
  /** Provider model id (ModelDescriptor.id); provider default when omitted. */
  model?: string;
  mode?: InteractionMode;
};

export type Session = {
  threadId: string;
  provider: ProviderKind;
  cwd: string;
  status: RuntimeSessionState;
  /** Provider-native conversation id, once known — used to resume. */
  conversationId?: string;
  /** Turn currently running, if any. */
  activeTurnId?: string;
  model?: string;
  mode: InteractionMode;
};

export type SendTurnInput = {
  threadId: string;
  /** The user's prompt text for this turn. */
  input: string;
  /** Override the session model for this turn. */
  model?: string;
  mode?: InteractionMode;
};

export type TurnStartResult = {
  threadId: string;
  /** kone-owned id for the turn just accepted. */
  turnId: string;
};

export type ApprovalDecision = "allow-once" | "allow-always" | "reject-once";

/** A point-in-time view of a thread (for hydration/rehydration). */
export type ThreadSnapshot = {
  threadId: string;
  provider: ProviderKind;
  conversationId?: string;
  items: RuntimeItem[];
};

// ── Normalized runtime event model ───────────────────────────────────────────
// Every adapter translates its transport (print-mode stdout, JSON-RPC, ACP, an
// SDK) into this union. Keep it flat + serializable.

export type RuntimeSessionState =
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error";

export type RuntimeTurnState = "completed" | "failed" | "interrupted";

/** A unit of work inside a turn the UI renders as one block. */
export type RuntimeItemKind =
  | "assistant_text"
  | "reasoning_text"
  | "plan_text"
  | "tool_call"
  | "command_output";

export type RuntimeItemStatus = "in-progress" | "completed" | "failed";

/** One rendered item within a turn (text block, tool call, command run). */
export type RuntimeItem = {
  itemId: string;
  kind: RuntimeItemKind;
  status: RuntimeItemStatus;
  /** Accumulated text for this item (assistant/reasoning/plan/output). */
  text: string;
  /** Tool/command name, for tool_call / command_output items. */
  name?: string;
};

/** Token accounting for a thread, when the provider exposes it. */
export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
};

/** Maps kone ids to the provider's native ids — needed for resume/interrupt. */
export type ProviderRefs = {
  conversationId?: string;
  providerTurnId?: string;
};

/** Tags the transport an event came from — for debugging + provider-specific
 *  extension without polluting the union. */
export type RuntimeEventSource =
  | "antigravity.print.stdout"
  | "antigravity.print.stderr"
  | "antigravity.print.lifecycle";

type BaseEvent = {
  threadId: string;
  provider: ProviderKind;
  /** Epoch millis when the event was produced. */
  at: number;
  source: RuntimeEventSource;
  refs?: ProviderRefs;
};

export type RuntimeEvent =
  | (BaseEvent & { type: "session.started" })
  | (BaseEvent & { type: "session.state.changed"; state: RuntimeSessionState; message?: string })
  | (BaseEvent & { type: "session.exited"; code: number | null })
  | (BaseEvent & { type: "thread.token-usage.updated"; usage: TokenUsage })
  | (BaseEvent & { type: "turn.started"; turnId: string })
  | (BaseEvent & { type: "turn.completed"; turnId: string; conversationId?: string })
  | (BaseEvent & { type: "turn.aborted"; turnId: string; reason: RuntimeTurnState; message?: string })
  | (BaseEvent & { type: "item.started"; turnId: string; item: RuntimeItem })
  | (BaseEvent & { type: "item.updated"; turnId: string; item: RuntimeItem })
  | (BaseEvent & { type: "item.completed"; turnId: string; item: RuntimeItem });

/** The sink an adapter pushes every event into. AgentService owns it and fans
 *  events out to the renderer over IPC. */
export type EmitEvent = (event: RuntimeEvent) => void;

// ── Adapter interface ────────────────────────────────────────────────────────

/** Static feature flags so the facade/UI can pick fallbacks per provider. */
export type AdapterCapabilities = {
  /** How switching model mid-thread behaves. */
  sessionModelSwitch: "in-session" | "restart-session" | "unsupported";
  /** Emits incremental text deltas (vs one final blob). */
  streamsText: boolean;
  /** Surfaces structured tool-call events. */
  supportsToolEvents: boolean;
  /** Can resume a prior conversation. */
  supportsResume: boolean;
  /** Exposes a model list. */
  supportsModelList: boolean;
};

/** Every provider implements this. Methods return once the request is accepted;
 *  results arrive asynchronously via the EmitEvent sink passed at construction. */
export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: AdapterCapabilities;

  /** Probe the user's machine: is the CLI installed and logged in? Read-only. */
  discover(): Promise<ProviderStatus>;

  /** List the models the CLI offers (empty when unsupported/unauthenticated). */
  listModels(): Promise<ModelDescriptor[]>;

  // lifecycle — request/ack
  startSession(input: SessionStartInput): Promise<Session>;
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: string): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;

  // interactivity (no-ops on providers that don't prompt inline)
  respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;

  // introspection
  listSessions(): Promise<Session[]>;
  hasSession(threadId: string): Promise<boolean>;
}
