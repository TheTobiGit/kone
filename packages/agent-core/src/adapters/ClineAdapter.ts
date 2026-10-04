import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import {
  CLINE_BINARY,
  buildClineEnv,
  buildClineProbeEnv,
  detectClineAuth,
  parseClineVersion,
  resolveClineBinary,
} from "../clineHome.js";
import { JsonRpcClient } from "../jsonRpc.js";
import { formatPlanTasks, reconcilePlanTasks } from "@kone/protocol/plan-tasks";
import { configValueEquals } from "./acpConfigAxes.js";
import { refuseCriticalCommand } from "./acpSafety.js";
import {
  CLINE_MODEL_CONFIG_IDS,
  CLINE_SIGN_IN_MESSAGE,
  CLINE_TOOL_KIND_NAMES,
  acpArray,
  buildClineApprovalRequest,
  clineActModeToApply,
  clineCurrentModel,
  clineModelCatalog,
  clinePermissionAutoApproves,
  clinePermissionCommand,
  clinePermissionToolKind,
  clineToolDetail,
  clineToolStatus,
  clineToolTarget,
  findOption,
  isAcpRecord,
  isClineAuthRequired,
  jsonRpcErrorCode,
  mergeClineFeaturedModels,
  parseClineConfigOptions,
  parseClineFeaturedModels,
  parseClinePlan,
  readNumber,
  readString,
  readValue,
  selectClinePermissionOption,
  type ClineAcpRecord,
  type ClineAcpValue,
  type ClineConfigOption,
} from "./clineProtocol.js";
import { errorText, isResumeRefusalError } from "./errors.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { acpAgentSupportsHttp, acpMcpServers, type AcpMcpServer } from "../gateway/injection.js";
import type { CursorImageBlock } from "../promptAttachments.js";
import { probeResult } from "../spawn.js";
import { versionProbeFailure, versionProbeUsable } from "../providerHealth.js";
import type {
  AdapterCapabilities,
  AgentPersona,
  ApprovalDecision,
  ApprovalRequest,
  EmitEvent,
  GatewayConnection,
  InteractionMode,
  ModelDescriptor,
  PlanTask,
  ProviderAdapter,
  ProviderConfig,
  ProviderStatus,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeItemStatus,
  Session,
  SendTurnInput,
  SessionStartInput,
  TokenUsage,
  TurnStartResult,
  UserInputAnswers,
  UserInputRespondResult,
} from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";
import { inlineSkills } from "../skillInvocation.js";

// Cline adapter — drives `cline --acp`, a persistent JSON-RPC-over-stdio child
// per thread speaking ACP (the Agent Client Protocol), the same transport
// DroidAdapter drives for `droid exec --output-format acp`.
//
// "Bring your own subscription" holds: kone never runs `cline auth` and never
// opens a credential. discover() checks CLINE_API_KEY / provider-settings file
// *presence* only (clineHome.detectClineAuth), every child is spawned with
// NO_BROWSER, and a missing login surfaces as a message telling the user to
// run `cline auth` themselves (CLINE_SIGN_IN_MESSAGE).
//
// Protocol facts, checked against cline 3.0.65 on 2026-09-29. No prompt was
// sent (that would spend the account's credits), so everything on the streamed
// -turn side is UNVERIFIED and follows the ACP standard, decoded defensively:
//
//  VERIFIED
//  1. `initialize` → `agentCapabilities: { loadSession: true,
//     promptCapabilities: { image: true, audio: false, embeddedContext: false } }`
//     and `authMethods` (`cline`, `cline-pass`, `openai-codex`). No
//     `mcpCapabilities`, so MCP rides the stdio proxy, not HTTP.
//  2. `session/new` → `{ sessionId, modes, models, configOptions }`. `modes`
//     is `plan`/`act` (starts on `act`); `models` is the account's live catalog
//     (`availableModels: [{ modelId, name }]` + `currentModelId`, 318 entries
//     on the probe account); `configOptions` are `provider`, `model`, `mode`
//     (selects) and `auto_approve` (a boolean, off).
//  3. Signed out, `session/new` fails `-32000 "Authentication required: Call
//     authenticate before starting a session"`. With stored credentials it
//     succeeds without any `authenticate`, and `authenticate` answers `{}` ("Using
//     existing credentials"). The adapter never calls `authenticate` unless
//     CLINE_API_KEY is set, because with nothing stored it starts a browser OAuth.
//  4. `session/set_mode` answers `{}` and emits `current_mode_update`.
//     `session/set_config_option` on a select answers the whole refreshed
//     `{ configOptions }` (unlike Droid's `{}`) and also emits a
//     `config_option_update`, so a config change needs no polling.
//  5. `session/set_config_option model` ACCEPTS ANY STRING, including ids not in
//     the catalog; the failure would only surface on the next prompt. So a
//     requested model is checked against the live catalog before it is set.
//  6. There is no `session/resume` (`-32601`). `session/load` of an unknown id
//     is `-32002 "Resource not found: <id>"`, and a session that was created but
//     never prompted is not loadable — so resume only ever works for a thread
//     that completed a turn, and every other resume falls back to a fresh
//     session through isResumeRefusalError.
//  7. `session/prompt` on an unknown id is `-32603 "Internal error"` with
//     `data.details: "unknown session: <id>"`.
//  8. Cline's stderr is log noise (a multi-line `Error handling request {…}` dump
//     per failed call), so it is not forwarded as session events.
//
//  UNVERIFIED (no signed-in turn was run)
//  - `session/update` payload shapes for message/thought chunks, tool calls,
//    plans and `usage_update`; the `session/prompt` result (`stopReason`, any
//    `usage`); `session/request_permission` option kinds and `toolCall` fields;
//    whether `mcpServers` on `session/new` is honoured; whether a set
//    `CLINE_API_KEY` is picked up by `authenticate`; what a `session/load`
//    replay and its response look like.
//
// Cline's `auto_approve` option is never turned on: kone owns the approval
// ladder at `session/request_permission` (see requestPermission), and an agent
// that stops asking can be neither prompted nor screened.

/** How this adapter's child is named in transport-level errors (JsonRpcClient
 *  is shared with Codex, Cursor and Droid, so each names its own). */
const CLINE_RPC_LABEL = "cline --acp";

const CLINE_ACP_ARGS = ["--acp"];

const CLINE_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientInfo: { name: "kone", title: "kone", version: "0.1.0" },
  clientCapabilities: {
    // kone doesn't proxy the filesystem or a terminal for the agent — cline
    // runs its own tools in the workspace it was spawned in. It advertises
    // `promptCapabilities.image`, so images ride as native ACP blocks.
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
} as const;

/** The auth method to call when CLINE_API_KEY is set and `session/new` still
 *  asked for authentication. UNVERIFIED that the key is honoured through it. */
const CLINE_API_KEY_AUTH_METHOD = "cline";

/** Per-step startup budgets. `session/new` is the longest: the first spawn also
 *  starts Cline's shared hub daemon and fetches the account's model catalog. */
const INITIALIZE_TIMEOUT_MS = 20_000;
const AUTHENTICATE_TIMEOUT_MS = 30_000;
const SESSION_SETUP_TIMEOUT_MS = 30_000;
/** A turn runs as long as it needs to — `session/prompt` only settles when the
 *  agent is done — so the RPC deadline has to be far past any real turn. */
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const CONFIG_TIMEOUT_MS = 15_000;

/** Where Cline publishes the models it features live — new releases and free or
 *  stealth models that the catalog bundled with the CLI hasn't caught up to. */
const CLINE_FEATURED_MODELS_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
/** Bounded so an unreachable API only costs the featured extras, never a
 *  session start. */
const FEATURED_MODELS_TIMEOUT_MS = 5_000;

/** Cline's featured models, or none on any failure. */
export async function fetchClineFeaturedModels(): Promise<ModelDescriptor[]> {
  try {
    const response = await fetch(CLINE_FEATURED_MODELS_URL, {
      signal: AbortSignal.timeout(FEATURED_MODELS_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[cline] featured models unavailable: HTTP ${response.status}`);
      return [];
    }
    // SAFETY: a parsed JSON body is exactly the ClineAcpValue union.
    return parseClineFeaturedModels((await response.json()) as ClineAcpValue);
  } catch (error) {
    console.warn("[cline] featured models unavailable:", errorText(error));
    return [];
  }
}
/** How long stopSession waits for the old child to actually exit before it
 *  returns, so a replacement session never spawns while its predecessor still
 *  holds Cline's sqlite session store. Bounded: a child that ignores SIGTERM
 *  must not hang the user's stop. */
const CLINE_TEARDOWN_GRACE_MS = 5_000;

/** JSON-RPC "invalid params" — how a server refuses a `session/new` whose
 *  `mcpServers` entries it can't parse. */
const JSON_RPC_INVALID_PARAMS = -32602;

type ClineItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
};

type ClineSession = {
  threadId: string;
  cwd: string;
  model?: string;
  mode: InteractionMode;
  conversationId?: string;
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  /** The kone gateway connection minted at startSession — the agent's app
   *  tools (scratchpad_read/write via the gateway's MCP server). */
  gatewayConnection?: GatewayConnection;
  /** The named agent this session works as, when the thread was handed to one.
   *  Rides the first prompt beside the host-context block (this provider has no
   *  system-instruction surface), so it is held here for that one turn. */
  agent?: AgentPersona;
  /** User turns sent so far; the kone host-context block rides the first one. */
  runOrdinal: number;
  activeTurnId?: string;
  rpc: JsonRpcClient;
  items: Map<string, ClineItemBuffer>;
  /** Config options as cline last reported them (session/new response, every
   *  `set_config_option` response, every `config_option_update`). */
  configOptions: ClineConfigOption[];
  /** The model ids this session's catalog offers — a requested model outside
   *  it is never set (cline would accept it and fail at the next prompt). */
  modelIds: Set<string>;
  /** Set by interruptTurn so the turn's terminal event is `turn.aborted`
   *  whatever stop reason the agent reports. */
  interrupting: boolean;
  /** Assistant/reasoning text arrives as bare chunks with no item identity, so
   *  one contiguous run of one kind is one synthetic item. */
  segment?: { itemId: string; kind: RuntimeItemKind };
  segmentCount: number;
  /** Items emitted as started/updated but never completed — a tool call a
   *  cancel cut mid-flight would otherwise spin in the transcript forever. */
  openItemIds: Set<string>;
  /** In-flight `session/request_permission` round-trips, keyed by our
   *  requestId. The RPC handler awaits `resolve`; respondToRequest settles it
   *  (or we drain on interrupt/stop) — the decision selects the reply option. */
  pendingApprovals: Map<string, PendingApproval>;
  /** Resolves once the child process has actually exited (fires on the RPC
   *  client's close). stopSession awaits this — bounded — so a replacement
   *  session never spawns while the predecessor still runs. */
  exited: Promise<void>;
};

/** A parked ACP permission request: the ask we surfaced and the resolver the
 *  awaited `session/request_permission` handler is blocked on. */
type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

/** Resolve with the value, or `undefined` after `ms` — used to bound the
 *  teardown gate so a stuck child can't hang stopSession. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** The cancelled reply to `session/request_permission`. */
const CANCELLED_OUTCOME = { outcome: { outcome: "cancelled" } } as const;

export class ClineAdapter implements ProviderAdapter {
  readonly provider = "cline" as const;
  readonly capabilities: AdapterCapabilities = {
    // `session/set_config_option {configId: "model"}` takes effect on the live
    // session and answers with the refreshed matrix, so a switch never restarts.
    sessionModelSwitch: "in-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // ACP reports one flat tool stream — a delegated run isn't distinguishable
    // as a nested one.
    supportsSubagents: false,
    // No compaction entry: Cline compacts on its own (`--compaction agentic`)
    // and no manual trigger was verified.

    // The completed read survives the cancel into the next turn. A resumed
    // session answers nothing at all, cancelled or not, so the resume half
    // says nothing about cancelling.
    cancelKeepsCompletedTools: true,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, ClineSession>();
  /** The catalog `session/new` reports, before the featured models join it. */
  private modelsCache: Promise<ModelDescriptor[]> | null = null;
  private featuredCache: Promise<ModelDescriptor[]> | null = null;
  private readonly fetchFeatured: () => Promise<ModelDescriptor[]>;
  /** The CLI executable to spawn — the user's override or `cline`. */
  private binary = CLINE_BINARY;

  constructor(emit: EmitEvent, fetchFeatured: () => Promise<ModelDescriptor[]> = fetchClineFeaturedModels) {
    this.emit = emit;
    this.fetchFeatured = fetchFeatured;
  }

  setConfig(config: ProviderConfig): void {
    const next = resolveClineBinary(config.binaryPath);
    if (next === this.binary) return;
    this.binary = next;
    this.modelsCache = null;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const env = await buildClineProbeEnv();
    const versionResult = await probeResult(this.binary, ["--version"], env, 5_000);
    const version = parseClineVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (!versionProbeUsable(versionResult, version)) {
      return {
        provider: this.provider,
        label: "Cline",
        ...versionProbeFailure({
          label: "Cline CLI",
          installHint: "Cline CLI not found. Install it with `npm i -g cline`, then run `cline auth`.",
          result: versionResult,
        }),
      };
    }

    const auth = await detectClineAuth();
    if (!auth.authenticated) {
      return {
        provider: this.provider,
        label: "Cline",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `cline auth` in a terminal to sign in, or set CLINE_API_KEY.",
      };
    }

    return {
      provider: this.provider,
      label: "Cline",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
      authLabel: auth.label,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Cached apart, so a featured fetch that failed is retried on the next read
    // without the session catalog it joins being probed again.
    const [catalog, featured] = await Promise.all([this.sessionCatalog(), this.featuredModels()]);
    return mergeClineFeaturedModels(catalog, featured);
  }

  private sessionCatalog(): Promise<ModelDescriptor[]> {
    if (this.modelsCache) return this.modelsCache;
    this.modelsCache = this.fetchModels().then((models) => {
      // An empty probe means signed out or a session that wouldn't open — don't
      // pin that for the app run; the next call probes again.
      if (models.length === 0) this.modelsCache = null;
      return models;
    });
    return this.modelsCache;
  }

  /** Discover the catalog IN-PROTOCOL: a disposable ACP session's `session/new`
   *  response is the account's live model list (fact 2) — Cline has no CLI
   *  model-list surface. Signed out, or any failure, yields an empty catalog
   *  rather than offering models the account can't run. */
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildClineEnv();
    const rpc = new JsonRpcClient(this.binary, CLINE_ACP_ARGS, {
      cwd: tmpdir(),
      env,
      label: CLINE_RPC_LABEL,
    });
    try {
      await rpc.call<ClineAcpRecord>("initialize", CLINE_INITIALIZE_PARAMS, INITIALIZE_TIMEOUT_MS);
      const response = await rpc.call<ClineAcpRecord>(
        "session/new",
        { cwd: tmpdir(), mcpServers: [] },
        SESSION_SETUP_TIMEOUT_MS,
      );
      return clineModelCatalog(response, parseClineConfigOptions(readValue(response, "configOptions")));
    } catch {
      return [];
    } finally {
      void rpc.kill();
    }
  }

  /** The featured models, fetched once per app run. A failed or empty fetch
   *  isn't pinned — the next catalog read tries again — and never rejects, so
   *  neither a session start nor the catalog can fail on it. */
  private featuredModels(): Promise<ModelDescriptor[]> {
    if (this.featuredCache) return this.featuredCache;
    this.featuredCache = this.fetchFeatured()
      .catch((): ModelDescriptor[] => [])
      .then((models) => {
        if (models.length === 0) this.featuredCache = null;
        return models;
      });
    return this.featuredCache;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    // Retire whatever this thread already owns before spawning its replacement —
    // the map is overwritten unconditionally below, so the previous `cline --acp`
    // child would otherwise never be killed. See CodexAdapter for the same guard.
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);

    // In flight while the child spawns and handshakes, so it adds no wait.
    const featured = this.featuredModels();
    const env = await buildClineEnv();
    const rpc = new JsonRpcClient(this.binary, CLINE_ACP_ARGS, {
      cwd: input.cwd,
      env,
      label: CLINE_RPC_LABEL,
    });
    // The teardown gate's completion signal: resolves when this child's
    // process actually closes, so a replacement session can await the
    // predecessor's real exit before spawning.
    const exited = new Promise<void>((resolve) => rpc.onExit(() => resolve()));
    const mode: InteractionMode = input.mode ?? "accept-edits";

    const session: ClineSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      mode,
      rpc,
      items: new Map(),
      configOptions: [],
      modelIds: new Set(),
      gatewayConnection: input.gatewayConnection,
      agent: input.agent,
      runOrdinal: 0,
      interrupting: false,
      segmentCount: 0,
      openItemIds: new Set(),
      pendingApprovals: new Map(),
      exited,
    };
    this.wireNotifications(session);
    this.wireRequests(session);
    rpc.onExit((code) => {
      // Only the session the map still points at may retire the entry; a
      // replacement can claim this threadId while this child shuts down. No
      // entry means stopSession already took ours, so still announce the exit.
      const current = this.sessions.get(input.threadId);
      if (current && current !== session) {
        // A replacement owns the thread now — the old session's parked asks
        // still die with it.
        this.drainApprovals(session);
        return;
      }
      if (current) this.sessions.delete(input.threadId);
      // Fail closed on the way out: resolve every parked permission request as
      // rejected so no RPC handler hangs on a promise nothing will settle.
      this.drainApprovals(session);
      this.emit({ ...this.base(session), source: "cline.acp.lifecycle", type: "session.exited", code });
    });

    try {
      const initializeResult = await rpc.call<ClineAcpRecord>(
        "initialize",
        CLINE_INITIALIZE_PARAMS,
        INITIALIZE_TIMEOUT_MS,
      );

      // The kone gateway (docs/mcp-gateway-design.md §4): cline advertises no
      // `mcpCapabilities`, so the session gets the stdio proxy entry, which
      // forwards JSON-RPC to the gateway endpoint. No gateway connection → no
      // mcpServers at all — never promise tools the session can't reach.
      // UNVERIFIED (no signed-in account): that `session/new` honours
      // `mcpServers` at all.
      const mcpServers = input.gatewayConnection
        ? acpMcpServers(input.gatewayConnection, {
            httpCapable: acpAgentSupportsHttp(initializeResult),
          })
        : [];

      // Cline has no `session/resume`; `session/load` is the only door back in
      // (fact 6). A refused load means the session is gone from Cline's store —
      // or was never prompted — so start fresh rather than failing the thread
      // open, matching DroidAdapter's stale-id handling.
      //
      // A load may replay the prior transcript as `session/update` notifications,
      // and nothing here suppresses them — nothing has to. Replay lands while the
      // session is still opening, and every transcript handler is gated on an
      // `activeTurnId` that no turn has set yet, so a replayed chunk has nowhere
      // to go.
      const supportsLoad = readValue(initializeResult, "agentCapabilities", "loadSession") === true;
      let response: ClineAcpRecord | undefined;
      if (input.resume && supportsLoad) {
        try {
          response = await this.openSession(rpc, "session/load", {
            resume: input.resume,
            cwd: input.cwd,
            mcpServers,
          });
          session.conversationId = input.resume;
          session.resumedFrom = input.resume;
        } catch (error) {
          // Only a refusal-class failure (session gone/pruned) deserves the
          // fresh-session fallback — a transport, auth or protocol error must
          // surface, or the thread would reopen blank for no reason.
          if (!isResumeRefusalError(error) || isClineAuthRequired(error)) throw error;
          response = undefined;
        }
      }
      if (!response) {
        try {
          response = await this.openSession(rpc, "session/new", { cwd: input.cwd, mcpServers });
        } catch (error) {
          // A server that can't parse the gateway's stdio entry refuses the
          // whole session with "invalid params". Losing the app tools beats
          // losing the thread: retry bare and say so.
          const refusedMcp =
            mcpServers.length > 0 && jsonRpcErrorCode(error) === JSON_RPC_INVALID_PARAMS;
          if (!refusedMcp) throw error;
          this.warn(session, "Cline rejected the kone MCP server; continuing without app tools", errorText(error));
          session.gatewayConnection = undefined;
          response = await this.openSession(rpc, "session/new", { cwd: input.cwd, mcpServers: [] });
        }
        const sessionId = readString(response, "sessionId");
        if (!sessionId) throw new Error("session/new response did not include a session id.");
        session.conversationId = sessionId;
      }

      // `configOptions` from the session response — the starting matrix before
      // any `config_option_update` notification arrives.
      session.configOptions = parseClineConfigOptions(readValue(response, "configOptions"));

      // The session response's model catalog is the account's live truth
      // (fact 2); seed the picker cache with it so the catalog is never stale.
      // The featured models it hasn't caught up to are settable here too.
      const catalog = clineModelCatalog(response, session.configOptions);
      if (catalog.length > 0 && this.modelsCache === null) this.modelsCache = Promise.resolve(catalog);
      const settable = mergeClineFeaturedModels(catalog, await featured);
      session.modelIds = new Set(settable.map((model) => model.id));

      await this.applyActMode(session, response);
      if (input.model) await this.applyModel(session, input.model);
      // A session started on cline's default model never went through
      // applyModel, so `session.model` is still unset — read it from the
      // response so toSession/reporting carry the real model.
      if (!session.model || !session.modelIds.has(session.model)) {
        session.model = clineCurrentModel(response, session.configOptions) ?? session.model;
      }
    } catch (error) {
      void rpc.kill();
      throw error;
    }

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), source: "cline.acp.lifecycle", type: "session.started" });
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    const mode = input.mode ?? session.mode;

    // Imported at call time, and only when there's something to attach, like
    // CursorAdapter does: promptAttachments reaches the attachment store,
    // which pulls in node:sqlite — statically importing it would make this
    // module unloadable outside the Electron runtime. cline advertises
    // `promptCapabilities.image`, so images ride as the same native ACP blocks
    // Cursor sends; other files become an `<attached_files>` path block.
    let imageBlocks: CursorImageBlock[] = [];
    let promptText = input.input.trim();
    if (input.attachments?.length) {
      const attachments = await import("../promptAttachments.js");
      const built = await attachments.buildCursorAttachmentInput(input.attachments);
      imageBlocks = built.imageBlocks;
      promptText = attachments.composePromptText(promptText, built.fileBlock ?? "");
    }
    // No skill input this CLI can be handed: an invoked skill's SKILL.md is
    // inlined after the prompt.
    promptText = await inlineSkills(promptText, input.skills);
    // The app-context block rides the very first user turn so the agent knows
    // the gateway tools exist.
    promptText = koneHostContextForFirstRun({
      prompt: promptText,
      runOrdinal: session.runOrdinal + 1,
      gateway: session.gatewayConnection,
      agent: session.agent,
    });
    session.runOrdinal += 1;
    const prompt: Array<{ type: "text"; text: string } | CursorImageBlock> = [];
    if (promptText.length > 0) prompt.push({ type: "text", text: promptText });
    prompt.push(...imageBlocks);
    if (prompt.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }

    // cline holds the model on the session, not the turn, so re-assert whatever
    // this turn asked for before prompting. Best-effort: an unavailable model
    // degrades to the session's current one rather than failing a turn the user
    // already sent. The approval mode needs no RPC — it is enforced kone-side at
    // the permission gate. `effort` / `serviceTier` / `contextWindow` are
    // deliberately not applied: cline's ACP surface advertises no such axes.
    session.mode = mode;
    if (input.model !== undefined && input.model !== session.model) {
      await this.applyModel(session, input.model);
    }

    // kone mints the turn id: ACP has no turn identity (a turn is one
    // `session/prompt` round-trip), and a per-session counter would collide
    // across threads in the shared store (a documented bug in this repo).
    const turnId = `cline-turn-${randomUUID()}`;
    session.activeTurnId = turnId;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    // `session/prompt` only settles when the whole turn is done, so it is
    // deliberately not awaited here — sendTurn is request/ack.
    void session.rpc
      .call<ClineAcpRecord>(
        "session/prompt",
        { sessionId: session.conversationId, prompt },
        PROMPT_TIMEOUT_MS,
      )
      .then(
        (response) => this.completeTurn(session, turnId, response),
        (cause) => this.failTurn(session, turnId, cause),
      );

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId || !session.conversationId) return;
    this.drainApprovals(session);
    // Flag first: the flag decides the terminal event whatever stop reason the
    // agent answers the cancel with.
    session.interrupting = true;
    session.rpc.notify("session/cancel", { sessionId: session.conversationId });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.drainApprovals(session);
    this.abortLiveTurn(session);
    void session.rpc.kill();
    this.sessions.delete(threadId);
    // Teardown gate: startSession replaces this session the moment stopSession
    // returns, and the replacement's child opens the same sqlite session store
    // the old one still holds. Wait (bounded) for the old child's actual exit.
    await withTimeout(session.exited, CLINE_TEARDOWN_GRACE_MS);
  }

  /** Seal a turn that's still live as we tear the session down. Killing the
   *  transport means cline's `session/cancel` reply never arrives, so nothing
   *  else will ever speak for this turn — without this the journaled assistant
   *  block stays 'running' forever and the thread reopens permanently busy.
   *  See CodexAdapter for the same guard. */
  private abortLiveTurn(session: ClineSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnId = undefined;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
  }

  async stopAll(): Promise<void> {
    // Delegates to stopSession so every session gets the same drain → seal →
    // kill → teardown-gate sequence.
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId)));
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveApproval(session, requestId, decision);
    // "Reject and stop" — the parked call resolves with a cancelled outcome
    // (selectClinePermissionOption matched nothing) and the TURN is interrupted,
    // not just the call. Same session/cancel the interrupt path sends; drain's
    // reject-once resolves are idempotent, so firing after the specific resolve
    // is safe.
    if (decision === "reject-and-stop") void this.interruptTurn(threadId);
  }

  async respondToUserInput(_threadId: string, _requestId: string, _answers: UserInputAnswers): Promise<UserInputRespondResult> {
    // UNVERIFIED (no signed-in account): Cline's `ask_followup_question` tool is
    // not known to surface as an `elicitation/create` reverse request, so
    // nothing parks a question and there is nothing to resolve.
    return { owned: false };
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((session) => this.toSession(session));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── session configuration ────────────────────────────────────────────────

  /** Open (or re-open) an ACP session, mapping the two ways Cline says "sign
   *  in first" onto one actionable error. Signed out, the call fails with
   *  "Authentication required" (fact 3); kone can't complete a login, so that
   *  surfaces as CLINE_SIGN_IN_MESSAGE — except when CLINE_API_KEY is set, where
   *  one `authenticate` is tried headlessly and the open retried.
   *  UNVERIFIED (no signed-in account): that the key is honoured that way. */
  private async openSession(
    rpc: JsonRpcClient,
    method: "session/new" | "session/load",
    open: { resume?: string; cwd: string; mcpServers: AcpMcpServer[] },
  ): Promise<ClineAcpRecord> {
    const { cwd, mcpServers } = open;
    const attempt = () =>
      open.resume
        ? rpc.call<ClineAcpRecord>(method, { sessionId: open.resume, cwd, mcpServers }, SESSION_SETUP_TIMEOUT_MS)
        : rpc.call<ClineAcpRecord>(method, { cwd, mcpServers }, SESSION_SETUP_TIMEOUT_MS);
    try {
      return await attempt();
    } catch (cause) {
      if (!isClineAuthRequired(cause)) throw cause;
      if (!process.env.CLINE_API_KEY?.trim()) throw new Error(CLINE_SIGN_IN_MESSAGE, { cause });
      try {
        await rpc.call("authenticate", { methodId: CLINE_API_KEY_AUTH_METHOD }, AUTHENTICATE_TIMEOUT_MS);
        return await attempt();
      } catch (retryCause) {
        if (isClineAuthRequired(retryCause)) throw new Error(CLINE_SIGN_IN_MESSAGE, { cause: retryCause });
        throw retryCause;
      }
    }
  }

  /** Every kone session runs in Cline's `act` mode — the ladder is enforced at
   *  the permission gate, and `plan` mode would leave the agent unable to do
   *  what the user asked (see clineActModeToApply). Only issues a `set_mode`
   *  when the session opened elsewhere, e.g. a loaded session last left in
   *  `plan`. */
  private async applyActMode(session: ClineSession, response: ClineAcpRecord): Promise<void> {
    const available = acpArray(readValue(response, "modes", "availableModes"))
      .map((raw) => readString(raw, "id"))
      .filter((id): id is string => id !== undefined);
    const modeId = clineActModeToApply(readString(response, "modes", "currentModeId"), available);
    if (!modeId) return;
    try {
      await session.rpc.call(
        "session/set_mode",
        { sessionId: session.conversationId, modeId },
        CONFIG_TIMEOUT_MS,
      );
    } catch (error) {
      this.warn(session, `Cline rejected mode "${modeId}"`, errorText(error));
    }
  }

  /** Switch the session model. Cline accepts any string here (fact 5), so the id
   *  is checked against the live catalog first — an unknown model leaves the
   *  session on its current one and says so. The response carries the refreshed
   *  config matrix (fact 4), which is adopted directly. */
  private async applyModel(session: ClineSession, model: string): Promise<void> {
    if (session.modelIds.size > 0 && !session.modelIds.has(model)) {
      this.warn(session, `Cline has no model "${model}"`, "staying on the session's current model");
      return;
    }
    const configId = findOption(session.configOptions, CLINE_MODEL_CONFIG_IDS)?.id ?? CLINE_MODEL_CONFIG_IDS[0];
    try {
      const response = await session.rpc.call<ClineAcpRecord>(
        "session/set_config_option",
        { sessionId: session.conversationId, configId, value: model },
        CONFIG_TIMEOUT_MS,
      );
      const refreshed = parseClineConfigOptions(readValue(response, "configOptions"));
      if (refreshed.length > 0) session.configOptions = refreshed;
      const current = findOption(session.configOptions, CLINE_MODEL_CONFIG_IDS)?.currentValue;
      // Only claim the model applied when cline's matrix reflects it (or sent no
      // matrix back to contradict it).
      if (current === undefined || configValueEquals(current, model)) session.model = model;
    } catch (error) {
      this.warn(session, `Cline rejected ${configId}="${model}"`, errorText(error));
    }
  }

  // ── notifications / server requests ─────────────────────────────────────

  private wireNotifications(session: ClineSession): void {
    session.rpc.onNotification("session/update", (params) => {
      // SAFETY: the notification hands back arbitrary ACP JSON; every field is
      // revalidated through the decoders before use.
      const update = readValue(params as ClineAcpValue, "update");
      if (!isAcpRecord(update)) return;
      this.handleSessionUpdate(session, update);
    });
    // stderr is deliberately not wired: cline logs a multi-line object dump per
    // failed request there (fact 8), which is noise rather than session state.
  }

  private wireRequests(session: ClineSession): void {
    // A permission request is answered by kone's ladder or parked and surfaced
    // to the user via `approval.requested`.
    // SAFETY: the reverse request hands back arbitrary ACP JSON; the decoders
    // below revalidate every field before use.
    session.rpc.onRequest("session/request_permission", (params) =>
      this.requestPermission(session, params as ClineAcpValue),
    );
  }

  /** Answer one ACP permission request. kone owns the approval ladder here
   *  (clinePermissionAutoApproves): what the rung waves through is answered
   *  with an allow option immediately, and everything else is parked, surfaced
   *  through `approval.requested`, and blocked on until the renderer answers (or
   *  we drain on interrupt/stop). The decision selects the option by `kind`,
   *  falling back to a cancelled outcome when none matches. */
  private async requestPermission(
    session: ClineSession,
    params: ClineAcpValue,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const options = acpArray(readValue(params, "options"));
    // Fail closed: a permission request with no active turn (a recovery or
    // replay callback after a crash/interrupt) has no trustworthy mode behind
    // it — cancel rather than park a gate nobody is watching.
    if (!session.activeTurnId) return CANCELLED_OUTCOME;

    // Full Access never stops to ask…
    if (session.mode === "full-access") {
      // …except for the handful of commands that end the machine rather than
      // the working tree. This gate is the only one a full-access session
      // passes through, so it is the only place left to refuse them.
      const refusal = refuseCriticalCommand(clinePermissionCommand(params), session.threadId);
      if (refusal) return refusal;
    }
    if (clinePermissionAutoApproves(session.mode, clinePermissionToolKind(params))) {
      // allow_once before allow_always: an "always" answer can persist a rule in
      // the user's own Cline settings, which is theirs to grant, not kone's.
      const optionId =
        selectClinePermissionOption(options, "allow-once") ?? selectClinePermissionOption(options, "allow-always");
      if (optionId) return { outcome: { outcome: "selected", optionId } };
      // No allow option to select: a full-access session must not deadlock on a
      // gate; a lower rung hands the ask to the user instead.
      if (session.mode === "full-access") return CANCELLED_OUTCOME;
    }

    const requestId = randomUUID();
    const turnId = session.activeTurnId;
    const approval = buildClineApprovalRequest(params);
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      session.pendingApprovals.set(requestId, { approval, resolve });
      this.emit({
        ...this.base(session),
        type: "approval.requested",
        requestId,
        turnId,
        approval,
      });
    });
    this.emit({ ...this.base(session), type: "approval.resolved", requestId, decision });
    const optionId = selectClinePermissionOption(options, decision);
    return optionId ? { outcome: { outcome: "selected", optionId } } : CANCELLED_OUTCOME;
  }

  /** Settle one parked permission request (idempotent — a no-op once drained). */
  private resolveApproval(session: ClineSession, requestId: string, decision: ApprovalDecision): void {
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  /** Reject every parked permission request — on interrupt/stop so no RPC
   *  handler hangs and the renderer's pending prompt clears. */
  private drainApprovals(session: ClineSession): void {
    for (const [requestId] of session.pendingApprovals) {
      this.resolveApproval(session, requestId, "reject-once");
    }
  }

  private handleSessionUpdate(session: ClineSession, update: ClineAcpRecord): void {
    const variant = readString(update, "sessionUpdate");
    switch (variant) {
      case "agent_message_chunk":
        this.appendText(session, "assistant_text", readString(update, "content", "text"));
        return;
      case "agent_thought_chunk":
        this.appendText(session, "reasoning_text", readString(update, "content", "text"));
        return;
      case "tool_call":
      case "tool_call_update":
        this.handleToolCall(session, update);
        return;
      case "plan":
        this.handlePlan(session, update);
        return;
      case "usage_update":
        this.handleUsage(session, update);
        return;
      case "session_info_update": {
        const title = readString(update, "title")?.trim();
        if (title) this.emit({ ...this.base(session), type: "thread.title.updated", title });
        return;
      }
      case "config_option_update": {
        const refreshed = parseClineConfigOptions(readValue(update, "configOptions"));
        if (refreshed.length > 0) session.configOptions = refreshed;
        return;
      }
      case "current_mode_update":
      case "available_commands_update":
        // Session state kone doesn't surface yet.
        return;
      default:
        // `user_message_chunk` and anything cline adds later — the renderer
        // already owns the user's own message.
        return;
    }
  }

  /** Assistant and reasoning text stream as bare chunks with no item id, so a
   *  contiguous run of one kind becomes one synthetic item. A switch of kind —
   *  or a tool call landing between chunks — closes the open segment. */
  private appendText(session: ClineSession, kind: RuntimeItemKind, text: string | undefined): void {
    if (!text || !session.activeTurnId) return;

    if (session.segment && session.segment.kind !== kind) this.closeSegment(session);

    if (!session.segment) {
      session.segmentCount += 1;
      const itemId = `${session.activeTurnId}:${kind}:${session.segmentCount}`;
      session.segment = { itemId, kind };
      session.items.set(itemId, { itemId, kind, text: "", detail: "" });
      this.emitItem(session, "item.started", session.items.get(itemId)!, "in-progress");
    }

    const buffer = session.items.get(session.segment.itemId);
    if (!buffer) return;
    buffer.text += text;
    this.emitItem(session, "item.updated", buffer, "in-progress");
  }

  private closeSegment(session: ClineSession): void {
    const open = session.segment;
    if (!open) return;
    session.segment = undefined;
    const buffer = session.items.get(open.itemId);
    if (buffer) this.emitItem(session, "item.completed", buffer, "completed");
  }

  private handleToolCall(session: ClineSession, update: ClineAcpRecord): void {
    const toolCallId = readString(update, "toolCallId");
    if (!toolCallId || !session.activeTurnId) return;

    // A tool call interrupts whatever text was streaming — close it so the two
    // don't interleave into one block.
    this.closeSegment(session);

    const itemId = `${session.activeTurnId}:${toolCallId}`;
    let buffer = session.items.get(itemId);
    const isNew = buffer === undefined;
    if (!buffer) {
      buffer = { itemId, kind: "tool_call", text: "", detail: "" };
      session.items.set(itemId, buffer);
    }

    const kind = readString(update, "kind");
    if (kind) buffer.name = CLINE_TOOL_KIND_NAMES[kind] ?? "tool";
    if (!buffer.name) buffer.name = "tool";
    const target = clineToolTarget(update);
    if (target) buffer.text = target;
    const detail = clineToolDetail(update);
    if (detail) buffer.detail = detail;

    const status = clineToolStatus(readString(update, "status"));
    if (isNew) this.emitItem(session, "item.started", buffer, status);
    else if (status === "in-progress") this.emitItem(session, "item.updated", buffer, status);
    else this.emitItem(session, "item.completed", buffer, status);
  }

  private handlePlan(session: ClineSession, update: ClineAcpRecord): void {
    if (!session.activeTurnId) return;
    const snapshot = parseClinePlan(update);
    if (!snapshot) return;

    const itemId = `${session.activeTurnId}:plan`;
    const existing = session.items.get(itemId);
    const tasks = reconcilePlanTasks(existing?.tasks ?? [], snapshot);
    const buffer: ClineItemBuffer = {
      itemId,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    session.items.set(itemId, buffer);
    this.emitItem(session, existing ? "item.updated" : "item.started", buffer, "in-progress");
  }

  /** ACP's `usage_update` carrying the session's running `used`/`size` totals.
   *  UNVERIFIED (no signed-in account): cline is not known to emit it. The ACP
   *  shape is only ever `used`/`size` — no input/output split, so no cache or
   *  reasoning split either. `used` is the context fill, not spend, so it sets
   *  no `total`: the store adds each Cline total to the thread's tokens, and
   *  the per-turn spend already arrives with the prompt result. */
  private handleUsage(session: ClineSession, update: ClineAcpRecord): void {
    const used = readNumber(update, "used");
    const size = readNumber(update, "size");
    if (used === undefined && size === undefined) return;
    const usage: TokenUsage & TokenUsageSplits = {
      compactsAutomatically: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
    if (used !== undefined) usage.contextUsed = used;
    if (size !== undefined) usage.contextWindow = size;
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
  }

  // ── turn completion ──────────────────────────────────────────────────────

  /** Close out a turn's bookkeeping: settle anything still marked in-progress,
   *  then drop the turn's buffers so a long thread doesn't accumulate them. */
  private endTurn(session: ClineSession, turnId: string, status: RuntimeItemStatus): void {
    this.closeSegment(session);
    for (const itemId of session.openItemIds) {
      const buffer = session.items.get(itemId);
      if (buffer) this.emitItem(session, "item.completed", buffer, status, turnId);
      else session.openItemIds.delete(itemId);
    }
    session.items.clear();
    session.openItemIds.clear();
    session.segmentCount = 0;
    session.activeTurnId = undefined;
  }

  private completeTurn(session: ClineSession, turnId: string, response: ClineAcpRecord): void {
    if (session.activeTurnId !== turnId) return;
    const stopReason = readString(response, "stopReason");
    const aborted = session.interrupting || stopReason === "cancelled" || stopReason === "refusal" || stopReason === "max_tokens";
    this.endTurn(session, turnId, aborted ? "failed" : "completed");

    // UNVERIFIED (no signed-in account): the prompt result's shape. The ACP
    // standard is a bare `{ stopReason }`; a `usage` block on it (an ACP draft
    // extension) is folded in when present, and nothing is invented when not.
    this.emitPromptUsage(session, response);

    if (session.interrupting || stopReason === "cancelled") {
      session.interrupting = false;
      this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
      return;
    }
    if (stopReason === "refusal" || stopReason === "max_tokens") {
      this.emit({
        ...this.base(session),
        type: "turn.aborted",
        turnId,
        reason: "failed",
        message: `Cline stopped the turn (${stopReason}).`,
      });
      return;
    }
    this.emit({
      ...this.base(session),
      type: "turn.completed",
      turnId,
      conversationId: session.conversationId,
    });
  }

  private emitPromptUsage(session: ClineSession, response: ClineAcpRecord): void {
    const usage = readValue(response, "usage");
    const input = readNumber(usage, "inputTokens");
    const output = readNumber(usage, "outputTokens");
    if (input === undefined && output === undefined) return;
    const report: TokenUsage & TokenUsageSplits = {
      cacheReadTokens: readNumber(usage, "cachedReadTokens") ?? 0,
      cacheCreationTokens: readNumber(usage, "cachedWriteTokens") ?? 0,
      reasoningTokens: readNumber(usage, "thoughtTokens") ?? 0,
    };
    if (input !== undefined) report.input = input;
    if (output !== undefined) report.output = output;
    report.total = readNumber(usage, "totalTokens") ?? (input ?? 0) + (output ?? 0);
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage: report });
  }

  private failTurn(session: ClineSession, turnId: string, cause: unknown): void {
    if (session.activeTurnId !== turnId) return;
    this.endTurn(session, turnId, "failed");
    // A prompt rejected because the child died is already covered by the
    // `session.exited` event; report the turn as failed either way so the
    // renderer never keeps a turn spinning.
    const reason = session.interrupting ? "interrupted" : "failed";
    session.interrupting = false;
    // Signed out mid-thread (a revoked account, a wiped data dir): say what to do.
    const message = isClineAuthRequired(cause) ? CLINE_SIGN_IN_MESSAGE : errorText(cause) || "The turn failed.";
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason, message });
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  /** A degraded-but-continuing condition (a rejected model, an MCP server the
   *  agent refused). Surfaced as session state, never thrown — none of these are
   *  worth losing a session over. */
  private warn(session: ClineSession, summary: string, detail: string): void {
    this.emit({
      ...this.base(session),
      source: "cline.acp.lifecycle",
      type: "session.state.changed",
      state: session.activeTurnId ? "running" : "ready",
      message: `${summary}: ${detail}`,
    });
  }

  private emitItem(
    session: ClineSession,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: ClineItemBuffer,
    status: RuntimeItemStatus,
    turnId: string | undefined = session.activeTurnId,
  ): void {
    if (!turnId) return;
    if (type === "item.completed") session.openItemIds.delete(buffer.itemId);
    else session.openItemIds.add(buffer.itemId);
    const item: RuntimeItem = {
      itemId: buffer.itemId,
      kind: buffer.kind,
      status,
      text: buffer.text,
      name: buffer.name,
    };
    if (buffer.tasks?.length) item.tasks = buffer.tasks;
    if (buffer.detail.length > 0) item.detail = buffer.detail;
    this.emit({ ...this.base(session), type, turnId, item });
  }

  private base(session: ClineSession) {
    const envelope = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "cline.acp.notification" as const,
    };
    // See ClaudeAdapter.base: the resume id rides every envelope so a turn that
    // never completes still leaves the thread resumable.
    if (session.conversationId) {
      return { ...envelope, refs: { conversationId: session.conversationId } };
    }
    return envelope;
  }

  private toSession(session: ClineSession): Session {
    return {
      threadId: session.threadId,
      provider: this.provider,
      cwd: session.cwd,
      status: session.activeTurnId ? "running" : "ready",
      conversationId: session.conversationId,
      resumedFrom: session.resumedFrom,
      activeTurnId: session.activeTurnId,
      model: session.model,
      mode: session.mode,
    };
  }

  private requireSession(threadId: string): ClineSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Cline session for thread ${threadId}`);
    return session;
  }
}
