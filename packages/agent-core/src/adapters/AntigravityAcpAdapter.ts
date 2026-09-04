import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  buildAntigravityAcpEnv,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  parseAntigravityAuthUrl,
  parseAntigravityBrowserLine,
  resolveAntigravityAcpSharedProfile,
  ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE,
} from "../antigravityAcpProfile.js";
import {
  resolveAntigravityAcpBinary,
  type AntigravityAcpResolvedBinary,
} from "../antigravityAcpBinary.js";
import { ANTIGRAVITY_ACP_RELEASE_VERSION } from "../antigravityRelease.js";
import { resolveAntigravityBinary, buildAntigravityProbeEnv } from "../antigravityHome.js";
import { JsonRpcClient } from "../jsonRpc.js";
import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import { formatPlanTasks, reconcilePlanTasks } from "@kone/protocol/plan-tasks";
import { refuseCriticalCommand } from "./acpSafety.js";
import { isResumeRefusalError } from "./errors.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { acpAgentSupportsHttp, acpMcpServers } from "../gateway/injection.js";
import type { CursorImageBlock } from "../promptAttachments.js";
import { probeResult } from "../spawn.js";
import { getUserDataDir } from "../userDataDir.js";
import {
  TOOL_KIND_NAMES,
  acpArray,
  antigravityToolDetail,
  antigravityToolStatus,
  antigravityToolTarget,
  buildAntigravityApprovalRequestWithWarnings,
  findOption,
  isAcpRecord,
  isAntigravityQuestion,
  parseAntigravityConfigOptions,
  parseAntigravityPlan,
  readNumber,
  readString,
  readValue,
  selectPermissionOption,
  selectQuestionOption,
  toAntigravityModelDescriptor,
  toAntigravityQuestion,
  type AntigravityAcpConfigOption,
  type AntigravityAcpRecord,
  type AntigravityAcpValue,
} from "./antigravityAcpProtocol.js";
import type { TokenUsageSplits } from "../usage/report.js";
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
  UserInputQuestion,
} from "../types.js";

// The pure protocol shapes live in antigravityAcpProtocol.ts; the previously
// public ones are re-exported here so existing importers keep working.
export type { AntigravityAcpRecord, AntigravityAcpValue } from "./antigravityAcpProtocol.js";
export {
  antigravityOptionWarning,
  antigravityToolDetail,
  antigravityToolStatus,
  antigravityToolTarget,
  isAntigravityQuestion,
  parseAntigravityConfigOptions,
  parseAntigravityPlan,
  selectQuestionOption,
  toAntigravityModelDescriptor,
  toAntigravityQuestion,
} from "./antigravityAcpProtocol.js";

// Antigravity ACP adapter — drives the official `agy_acp_server` over
// JSON-RPC stdio (the Agent Client Protocol), one persistent child per thread,
// reusing the same transport as CursorAdapter/DroidAdapter (jsonRpc.ts).
//
// This replaces the print-mode adapter's transcript polling with a real
// session: streaming chunks, server→client permission round-trips, protocol
// cancel, and resume. The server shares the `agy` CLI's login (shared
// profile), so discovery's auth signal is the CLI's own `agy models` answer
// and a missing login is answered with "run `agy` once" — kone never runs a
// sign-in and never touches a credential.
//
// Protocol facts, verified against t3code's ground truth for this exact
// server (1.1.1) rather than guessed from the ACP spec:
//
//  1. Resume is `session/resume` only — there is no `session/load`. A refused
//     resume means the session is gone from the server's store: start fresh.
//  2. `authenticate` takes `{ methodId: "oauth-personal" }` and answers `{}`.
//  3. Interaction mode is a `session/set_config_option` with configId "mode":
//     full-access → "yolo", accept-edits → "auto_edit", everything else →
//     "default". Models go through the same call with the model option's id.
//     Thinking levels are separate model options, not an effort axis — there
//     is nothing per-turn to apply for `effort`.
//  4. A cancelled turn resolves `session/prompt` with `stopReason:
//     "cancelled"`, but the server may also wait the prompt out
//     (wait-for-prompt cancel) — the `interrupting` flag decides the terminal
//     event either way, exactly like CursorAdapter's ambiguous end_turn.
//  5. Native questions share the permission channel: a `toolCall.toolCallId`
//     starting with `interaction_` is a fixed-choice question, not an
//     approval. It offers no custom text and fires in every mode.
//  6. "Allow for this thread" on shell/web tools carries a prompt-injection
//     warning in the option's `_meta["agy.security.warning"]` — surfaced in
//     the ask's detail so the choice is an informed one.

/** How this adapter's child is named in transport-level errors (JsonRpcClient
 *  is shared with Codex, Cursor and Droid, so each names its own). */
const ANTIGRAVITY_RPC_LABEL = "agy_acp_server";

const ANTIGRAVITY_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientInfo: { name: "kone", title: "kone", version: "0.1.0" },
  clientCapabilities: {
    // kone doesn't proxy the filesystem or a terminal for the agent — the
    // server runs its own tools in the workspace it was spawned in. Reads and
    // writes then arrive as ordinary permission requests, which is what the
    // approval flow already handles.
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
} as const;

/** The ACP `authenticate` method id for the shared CLI login. */
const ANTIGRAVITY_AUTH_METHOD_ID = "oauth-personal";

/** Config-option ids on the session matrix, by kone axis. */
const MODEL_CONFIG_IDS = ["model"] as const;
const MODE_CONFIG_ID = "mode";

/** kone InteractionMode → the server's permission-mode value (fact 3). */
const ANTIGRAVITY_MODE_VALUES = {
  "full-access": "yolo",
  "accept-edits": "auto_edit",
  ask: "default",
} satisfies Record<InteractionMode, string>;

/** The JsonRpcClient surface this adapter drives. JsonRpcClient satisfies it
 *  structurally; tests inject a scripted fake instead of spawning a child, so
 *  no test in this repo ever depends on module-registry order (several suites
 *  mock.module the real transport). */
export type AntigravityRpcClient = {
  call<T = AntigravityAcpValue>(method: string, params?: AntigravityAcpValue, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: AntigravityAcpValue): void;
  onNotification(method: string, handler: (params: AntigravityAcpValue | null | undefined) => void): () => void;
  onRequest(method: string, handler: (params: AntigravityAcpValue | null | undefined) => Promise<AntigravityAcpValue>): void;
  onExit(handler: (code: number | null) => void): () => void;
  onStderrLine(handler: (line: string) => void): () => void;
  kill(): Promise<void>;
};

export type AntigravityRpcFactory = (
  command: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; label?: string },
) => AntigravityRpcClient;

/** Per-step startup budgets. `authenticate` hits the login store, which is
 *  normally instant but must never hang session open. */
const INITIALIZE_TIMEOUT_MS = 20_000;
const AUTHENTICATE_TIMEOUT_MS = 30_000;
const SESSION_SETUP_TIMEOUT_MS = 20_000;
/** A turn runs as long as it needs to — `session/prompt` only settles when the
 *  agent is done — so the RPC deadline has to be far past any real turn. */
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const CONFIG_TIMEOUT_MS = 15_000;
/** How long to wait for the `config_option_update` that follows a
 *  `session/set_config_option` (`{}` response). */
const CONFIG_REFRESH_TIMEOUT_MS = 5_000;
/** How long stopSession waits for the old child to actually exit before
 *  returning — a replacement session must never spawn while the predecessor
 *  still runs. */
const TEARDOWN_GRACE_MS = 5_000;

type AntigravityAcpItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
};

type AntigravityAcpSession = {
  threadId: string;
  cwd: string;
  model?: string;
  mode: InteractionMode;
  conversationId?: string;
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  /** The kone gateway connection minted at startSession — the agent's app
   *  tools (kone_scratchpad_read/write via the gateway's MCP server). */
  gatewayConnection?: GatewayConnection;
  /** The named agent this session works as, when the thread was handed to one.
   *  Rides the first prompt beside the host-context block (this provider has no
   *  system-instruction surface), so it is held here for that one turn. */
  agent?: AgentPersona;
  /** User turns sent so far; the kone host-context block rides the first one. */
  runOrdinal: number;
  activeTurnId?: string;
  rpc: AntigravityRpcClient;
  items: Map<string, AntigravityAcpItemBuffer>;
  /** Config options as the server last reported them — the source of truth for
   *  which model/mode values actually apply. */
  configOptions: AntigravityAcpConfigOption[];
  /** Set by interruptTurn so the turn's terminal event is `turn.aborted`
   *  however the prompt settles (fact 4). */
  interrupting: boolean;
  /** Assistant/reasoning text arrives as bare chunks with no item identity, so
   *  one contiguous run of one kind is one synthetic item. */
  segment?: { itemId: string; kind: RuntimeItemKind };
  segmentCount: number;
  /** Items emitted as started/updated but never completed — a tool call that a
   *  cancel cut mid-flight would otherwise spin in the transcript forever. */
  openItemIds: Set<string>;
  /** In-flight `session/request_permission` round-trips, keyed by our
   *  requestId. The RPC handler awaits the promise; respondToRequest resolves
   *  it (or we drain on interrupt/stop) — the decision selects the reply
   *  option by its kind. */
  pendingApprovals: Map<string, PendingApproval>;
  /** Parked native questions (`interaction_` tool calls), keyed the same way —
   *  answered through respondToUserInput, drained on interrupt/stop. */
  pendingQuestions: Map<string, PendingQuestion>;
  /** Latest Google sign-in URL the server printed on stderr while no handler
   *  could complete it — surfaced on the next sign-in failure so the user can
   *  finish in a browser on this machine. */
  lastAuthUrl?: string;
  /** Resolves once the child process has actually exited. stopSession awaits
   *  this — bounded — so a replacement never spawns mid-teardown. */
  exited: Promise<void>;
};

/** A parked ACP permission request: the ask we surfaced and the resolver the
 *  awaited `session/request_permission` handler is blocked on. */
type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

/** A parked native question: the normalized question plus the raw options the
 *  answer must be mapped back onto (answers arrive as labels). */
type PendingQuestion = {
  questions: UserInputQuestion[];
  optionIds: Map<string, string[]>;
  resolve: (answers: UserInputAnswers) => void;
};

// ── lifecycle helpers ──────────────────────────────────────────────────────

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AntigravityAcpAdapter implements ProviderAdapter {
  readonly provider = "antigravity" as const;
  readonly capabilities: AdapterCapabilities = {
    // `session/set_config_option` takes effect on a live session, so a model
    // or mode switch never restarts it.
    sessionModelSwitch: "in-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // Subagent invocations surface as ordinary tool calls — no child ids or
    // models cross the protocol, so a delegated run isn't distinguishable as
    // a nested one.
    supportsSubagents: false,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, AntigravityAcpSession>();
  private modelsCache: Promise<ModelDescriptor[]> | null = null;
  private modelsCacheIsSeed = false;
  /** The user's configured ACP server override (binary path). Empty means the
   *  managed runtime, then PATH — see antigravityAcpBinary.ts. */
  private binaryPathOverride?: string;
  private readonly userDataDir?: string;
  private readonly resolveBinaryOption?: () => AntigravityAcpResolvedBinary | null;
  private readonly createRpc: AntigravityRpcFactory;

  constructor(
    emit: EmitEvent,
    options: {
      userDataDir?: string;
      resolveBinary?: () => AntigravityAcpResolvedBinary | null;
      /** Transport factory — production spawns the real server child; tests
       *  inject a scripted fake. */
      createRpc?: AntigravityRpcFactory;
    } = {},
  ) {
    this.emit = emit;
    this.userDataDir = options.userDataDir;
    this.resolveBinaryOption = options.resolveBinary;
    this.createRpc =
      options.createRpc ??
      ((command, args, opts) => new JsonRpcClient(command, args, opts));
  }

  setConfig(config: ProviderConfig): void {
    const next = config.binaryPath?.trim() || undefined;
    if (next === this.binaryPathOverride) return;
    this.binaryPathOverride = next;
    this.modelsCache = null;
    this.modelsCacheIsSeed = false;
  }

  /** The ACP server to spawn, or null when no transport is available — the
   *  caller (facade) falls back to print mode. */
  resolveBinary(): AntigravityAcpResolvedBinary | null {
    if (this.resolveBinaryOption) return this.resolveBinaryOption();
    let userDataDir: string;
    try {
      userDataDir = this.userDataDir ?? getUserDataDir();
    } catch {
      return null;
    }
    return resolveAntigravityAcpBinary({ userDataDir, binaryPath: this.binaryPathOverride });
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const resolved = this.resolveBinary();
    if (!resolved) {
      return {
        provider: this.provider,
        label: "Antigravity",
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        message:
          "Antigravity ACP server not found. Install it from the Providers settings pane, or run `agy` once to use print mode.",
      };
    }

    // The server shares the CLI's login, so the CLI's own `agy models` answer
    // is the sign-in signal — no server spawn needed. A non-empty list means
    // signed in; an empty one means "run `agy` once". This always probes the
    // default CLI name: the binary-path setting now addresses the ACP server,
    // not the CLI.
    const env = await buildAntigravityProbeEnv();
    try {
      const modelsResult = await probeResult(resolveAntigravityBinary(undefined), ["models"], env, 15_000);
      if (modelsResult.outcome !== "timeout" && modelsResult.outcome !== "failure") {
        if (modelsResult.stdout.trim().length > 0) {
          return {
            provider: this.provider,
            label: "Antigravity",
            available: true,
            authStatus: "authenticated",
            readiness: "ready",
            version:
              resolved.source === "managed" ? ANTIGRAVITY_ACP_RELEASE_VERSION : undefined,
          };
        }
        return {
          provider: this.provider,
          label: "Antigravity",
          available: true,
          authStatus: "unauthenticated",
          readiness: "needs-login",
          version:
            resolved.source === "managed" ? ANTIGRAVITY_ACP_RELEASE_VERSION : undefined,
          message: "Run `agy` once to sign in.",
        };
      }
    } catch {
      // No CLI to ask — fall through to the unknown-auth answer below.
    }

    // Managed-only install with no CLI beside it: the binary is here, but
    // sign-in can only be confirmed by opening a session. Report ready with
    // unknown auth rather than spawning the (slow-starting) server on every
    // discovery round; a real sign-in failure surfaces at session open.
    return {
      provider: this.provider,
      label: "Antigravity",
      available: true,
      authStatus: "unknown",
      readiness: "ready",
      version: resolved.source === "managed" ? ANTIGRAVITY_ACP_RELEASE_VERSION : undefined,
      message: "Antigravity sign-in will be confirmed on the first session.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.modelsCache && !this.modelsCacheIsSeed) return this.modelsCache;
    const seeded = this.modelsCache;
    this.modelsCacheIsSeed = false;
    this.modelsCache = this.fetchModels()
      .then((models) => {
        // An empty probe means unauthenticated or a session that wouldn't
        // open — never throw away a good seed for it.
        if (models.length === 0 && seeded) {
          this.modelsCacheIsSeed = true;
          return seeded;
        }
        return models;
      })
      .catch((error) => {
        this.modelsCache = seeded;
        this.modelsCacheIsSeed = seeded !== null;
        throw error;
      });
    return this.modelsCache;
  }

  /** Discover the catalog in-protocol: a disposable ACP session's `session/new`
   *  config matrix carries the `model` select, which is the per-account truth.
   *  Thinking levels are separate options, so no per-model probing is needed. */
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const spawned = await this.spawnDisposable();
    if (!spawned) return [];
    const { rpc } = spawned;
    try {
      await this.initializeRpc(rpc);
      const response = await rpc.call<AntigravityAcpValue>(
        "session/new",
        { cwd: homedir(), mcpServers: [] },
        SESSION_SETUP_TIMEOUT_MS,
      );
      if (!readString(response, "sessionId")) return [];
      const options = parseAntigravityConfigOptions(readValue(response, "configOptions"));
      const modelOption = findOption(options, MODEL_CONFIG_IDS);
      return (modelOption?.options ?? []).map((option) => toAntigravityModelDescriptor(option));
    } catch {
      // Not authenticated, or the session couldn't be created — an empty
      // catalog beats offering models the account can't run.
      return [];
    } finally {
      await rpc.kill();
    }
  }

  // ── spawning ───────────────────────────────────────────────────────────────

  /** Spawn one ACP server child with the shared-profile environment. Null when
   *  no binary resolves — the caller falls back to print mode. */
  private async spawnServer(cwd: string): Promise<{ rpc: AntigravityRpcClient } | null> {
    const resolved = this.resolveBinary();
    if (!resolved) return null;
    const profile = resolveAntigravityAcpSharedProfile();
    const env = await buildAntigravityAcpEnv(profile, resolved.harnessPath);
    const spawn = buildAntigravityAcpSpawnInput({ executable: resolved, profile, cwd, env });
    const rpc = this.createRpc(spawn.command, [...spawn.args], {
      cwd: spawn.cwd,
      env: spawn.env,
      label: ANTIGRAVITY_RPC_LABEL,
    });
    return { rpc };
  }

  /** A throwaway child for probes that never owns a thread (bounded by the
   *  catalog timeout by the caller). */
  private async spawnDisposable(): Promise<{ rpc: AntigravityRpcClient } | null> {
    return this.spawnServer(homedir());
  }

  private async initializeRpc(rpc: AntigravityRpcClient): Promise<AntigravityAcpValue> {
    const initializeResult = await rpc.call<AntigravityAcpValue>(
      "initialize",
      ANTIGRAVITY_INITIALIZE_PARAMS,
      INITIALIZE_TIMEOUT_MS,
    );
    try {
      await rpc.call(
        "authenticate",
        { methodId: ANTIGRAVITY_AUTH_METHOD_ID },
        AUTHENTICATE_TIMEOUT_MS,
      );
    } catch (error) {
      if (isAntigravitySignInRequiredError(error)) {
        throw new Error(ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE);
      }
      throw error;
    }
    return initializeResult;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    // Retire whatever this thread already owns before spawning its replacement —
    // the map is overwritten unconditionally below, so the previous child would
    // otherwise never be killed. A replacement arriving mid-turn is always a
    // caller bug, so refuse it loudly instead of aborting the live turn with
    // no message; legitimate restarts stop the old session first.
    const prior = this.sessions.get(input.threadId);
    if (prior) {
      if (prior.activeTurnId) {
        throw new Error(
          `Refusing to replace the live Antigravity ACP session for thread ${input.threadId} while turn ${prior.activeTurnId} is still running. Stop it first if the replacement is intentional.`,
        );
      }
      await this.stopSession(input.threadId);
    }

    const spawned = await this.spawnServer(input.cwd);
    if (!spawned) {
      throw new Error("Antigravity ACP server not found — no managed runtime and no binary override.");
    }
    const { rpc } = spawned;
    const exited = new Promise<void>((resolve) => rpc.onExit(() => resolve()));
    const mode: InteractionMode = input.mode ?? "accept-edits";

    const session: AntigravityAcpSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      mode,
      rpc,
      items: new Map(),
      configOptions: [],
      gatewayConnection: input.gatewayConnection,
      agent: input.agent,
      runOrdinal: 0,
      interrupting: false,
      segmentCount: 0,
      openItemIds: new Set(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      exited,
    };
    this.wireNotifications(session);
    this.wireRequests(session);
    rpc.onExit((code) => {
      // Only the session the map still points at may retire the entry; a
      // replacement can claim this threadId while this child shuts down.
      const current = this.sessions.get(input.threadId);
      if (current && current !== session) {
        this.drainParked(session);
        return;
      }
      if (current) this.sessions.delete(input.threadId);
      // Fail closed on the way out: reject every parked ask so no RPC handler
      // hangs on a promise nothing will settle.
      this.drainParked(session);
      this.emit({ ...this.base(session), source: "antigravity.acp.lifecycle", type: "session.exited", code });
    });
    // A Google sign-in URL the server prints while no turn can complete it is
    // stashed for the next sign-in failure instead of opening a browser.
    rpc.onStderrLine((line) => {
      const candidate = parseAntigravityBrowserLine(line);
      if (!candidate) return;
      const parsed = parseAntigravityAuthUrl(candidate);
      if (!parsed) return;
      session.lastAuthUrl = parsed.authorizationUrl;
      this.warn(session, "Antigravity asked for a Google sign-in", parsed.authorizationUrl);
    });

    try {
      const initializeResult = await this.initializeRpc(rpc);

      // The kone gateway (docs/mcp-gateway-design.md §4): thread the app's MCP
      // server into every session door. An agent that advertises
      // `agentCapabilities.mcpCapabilities.http` gets the direct loopback HTTP
      // entry; otherwise the session spawns the stdio proxy (stdioProxy.mjs),
      // which forwards JSON-RPC to the same endpoint. No gateway connection →
      // no mcpServers at all — never promise tools the session can't reach.
      const mcpServers = input.gatewayConnection
        ? acpMcpServers(input.gatewayConnection, {
            // SAFETY: AntigravityAcpValue is this adapter's decoded-JSON alias
            // for the same JSON document shape JsonValue names; the MCP helper
            // only reads the agentCapabilities path through its own schema.
            httpCapable: acpAgentSupportsHttp(initializeResult as JsonValue),
          })
        : [];

      // Resume is `session/resume` only (fact 1) — no `session/load`. A refused
      // resume means the session is gone from the server's store: start fresh
      // rather than failing the thread open. A `session/resume` replay lands
      // while the session is still opening, and every transcript handler is
      // gated on an `activeTurnId` no turn has set yet, so a replayed chunk
      // has nowhere to go.
      let response: AntigravityAcpValue | undefined;
      if (input.resume) {
        try {
          response = await rpc.call<AntigravityAcpValue>(
            "session/resume",
            { sessionId: input.resume, cwd: input.cwd, mcpServers },
            SESSION_SETUP_TIMEOUT_MS,
          );
          session.conversationId = input.resume;
          session.resumedFrom = input.resume;
        } catch (error) {
          if (!isResumeRefusalError(error)) throw error;
          response = undefined;
        }
      }
      if (!response) {
        response = await rpc.call<AntigravityAcpValue>(
          "session/new",
          { cwd: input.cwd, mcpServers },
          SESSION_SETUP_TIMEOUT_MS,
        );
        const sessionId = readString(response, "sessionId");
        if (!sessionId) throw new Error("Antigravity session/new response did not include a session id.");
        session.conversationId = sessionId;
      }

      session.configOptions = parseAntigravityConfigOptions(readValue(response, "configOptions"));

      // The session response's model select is the per-account truth; seed the
      // picker cache with it so the catalog is never stale. It stays
      // upgradeable: the listModels probe replaces it in place once it lands.
      const descriptors = (findOption(session.configOptions, MODEL_CONFIG_IDS)?.options ?? []).map(
        (option) => toAntigravityModelDescriptor(option),
      );
      if (descriptors.length > 0 && (this.modelsCache === null || this.modelsCacheIsSeed)) {
        this.modelsCache = Promise.resolve(descriptors);
        this.modelsCacheIsSeed = true;
      }

      await this.applyMode(session, mode);
      if (input.model) await this.applyModel(session, input.model);
      // A session started on the server's default model never went through
      // applyModel, so read it from the config matrix for reporting.
      if (!session.model) {
        const current = findOption(session.configOptions, MODEL_CONFIG_IDS)?.currentValue;
        if (current) session.model = current;
      }
    } catch (error) {
      await rpc.kill();
      throw error;
    }

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), source: "antigravity.acp.lifecycle", type: "session.started" });
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    const mode = input.mode ?? session.mode;

    // Imported at call time, and only when there's something to attach:
    // promptAttachments reaches the attachment store, which pulls in
    // node:sqlite — statically importing it would make this module unloadable
    // outside the Electron runtime (same pattern as CursorAdapter/DroidAdapter).
    // The server takes native image blocks; other files become a path block
    // for the agent to inspect with its own tools.
    let imageBlocks: CursorImageBlock[] = [];
    let promptText = input.input.trim();
    if (input.attachments?.length) {
      const attachments = await import("../promptAttachments.js");
      const built = await attachments.buildCursorAttachmentInput(input.attachments);
      imageBlocks = built.imageBlocks;
      promptText = attachments.composePromptText(promptText, built.fileBlock ?? "");
    }
    if (!promptText && imageBlocks.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }
    // First-prompt host-context channel — tells the agent the kone gateway
    // tools exist.
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

    // The server holds mode/model on the session, not the turn, so re-assert
    // whatever this turn asked for before prompting. Each is best-effort: an
    // unavailable model degrades to the session's current value rather than
    // failing a turn the user already sent.
    if (mode !== session.mode) await this.applyMode(session, mode);
    session.mode = mode;
    if (input.model && input.model !== session.model) await this.applyModel(session, input.model);
    // `effort` is deliberately not applied: thinking levels are separate model
    // options on this server (fact 3), so a per-turn effort has no target.

    // kone mints the turn id: ACP has no turn identity (a turn is one
    // `session/prompt` round-trip).
    const turnId = `antigravity-turn-${randomUUID()}`;
    session.activeTurnId = turnId;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    // `session/prompt` only settles when the whole turn is done, so it is
    // deliberately not awaited here — sendTurn is request/ack.
    void session.rpc
      .call<AntigravityAcpValue>(
        "session/prompt",
        { sessionId: session.conversationId, prompt },
        PROMPT_TIMEOUT_MS,
      )
      .then(
        (response) => this.completeTurn(session, turnId, readString(response, "stopReason")),
        (error) => this.failTurn(session, turnId, this.describeFailure(session, error)),
      );

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId || !session.conversationId) return;
    this.drainParked(session);
    // Flag first: the cancel may land as `cancelled` or be waited out
    // (fact 4) — the flag decides the terminal event either way.
    session.interrupting = true;
    session.rpc.notify("session/cancel", { sessionId: session.conversationId });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.drainParked(session);
    this.abortLiveTurn(session);
    await session.rpc.kill();
    this.sessions.delete(threadId);
    // Bounded teardown gate so a replacement session never spawns while the
    // predecessor still runs.
    await withTimeout(session.exited, TEARDOWN_GRACE_MS);
  }

  /** Seal a turn that's still live as we tear the session down. Killing the
   *  transport means the prompt reply never arrives, so nothing else will ever
   *  speak for this turn — without this the journaled assistant block stays
   *  'running' forever and the thread reopens permanently busy. */
  private abortLiveTurn(session: AntigravityAcpSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnId = undefined;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId)));
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveApproval(session, requestId, decision);
    // "Reject and stop" — the parked call resolves with a cancelled outcome
    // (selectPermissionOption matched nothing) and the TURN is interrupted, not
    // just the call. Same session/cancel the interrupt path sends.
    if (decision === "reject-and-stop") void this.interruptTurn(threadId);
  }

  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const pending = session.pendingQuestions.get(requestId);
    if (!pending) return;
    session.pendingQuestions.delete(requestId);
    pending.resolve(answers);
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((session) => this.toSession(session));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── session configuration ────────────────────────────────────────────────

  /** Apply kone's mode rung as the server's permission-mode value (fact 3).
   *  The response is `{}`; the refreshed matrix arrives as a
   *  `config_option_update` notification, which is awaited so the next prompt
   *  runs under the requested mode. */
  private async applyMode(session: AntigravityAcpSession, mode: InteractionMode): Promise<void> {
    const value = ANTIGRAVITY_MODE_VALUES[mode];
    const configId = findOption(session.configOptions, [MODE_CONFIG_ID])?.id ?? MODE_CONFIG_ID;
    try {
      await session.rpc.call(
        "session/set_config_option",
        { sessionId: session.conversationId, configId, value },
        CONFIG_TIMEOUT_MS,
      );
      await this.waitForConfigValue(session, configId, value);
    } catch (error) {
      this.warn(session, `Antigravity rejected mode="${value}"`, this.describeFailure(session, error));
    }
  }

  private async applyModel(session: AntigravityAcpSession, model: string): Promise<void> {
    const configId = findOption(session.configOptions, MODEL_CONFIG_IDS)?.id ?? MODEL_CONFIG_IDS[0];
    if (!configId) return;
    try {
      await session.rpc.call(
        "session/set_config_option",
        { sessionId: session.conversationId, configId, value: model },
        CONFIG_TIMEOUT_MS,
      );
      await this.waitForConfigValue(session, configId, model);
    } catch (error) {
      this.warn(session, `Antigravity rejected model="${model}"`, this.describeFailure(session, error));
    }
    // Only claim the model applied when the matrix actually reflects it — an
    // unavailable model leaves the session on its current model.
    const applied = findOption(session.configOptions, MODEL_CONFIG_IDS);
    if (applied?.currentValue?.trim() === model.trim()) session.model = model;
  }

  /** Wait for the `config_option_update` notification reflecting a config
   *  change. Resolves with the refreshed matrix, or undefined when the change
   *  never landed (rejected value, or a server that skips the notification). */
  private async waitForConfigValue(
    session: AntigravityAcpSession,
    configId: string,
    value: string,
  ): Promise<readonly AntigravityAcpConfigOption[] | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < CONFIG_REFRESH_TIMEOUT_MS) {
      const option = findOption(session.configOptions, [configId]);
      if (option?.currentValue !== undefined && option.currentValue.trim() === value.trim()) {
        return session.configOptions;
      }
      await sleep(25);
    }
    return undefined;
  }

  // ── notifications / server requests ─────────────────────────────────────

  private wireNotifications(session: AntigravityAcpSession): void {
    session.rpc.onNotification("session/update", (params) => {
      // SAFETY: the notification hands back arbitrary ACP JSON; every field is
      // revalidated through the decoders before use.
      const update = readValue(params as AntigravityAcpValue, "update");
      if (!isAcpRecord(update)) return;
      this.handleSessionUpdate(session, update);
    });
  }

  private wireRequests(session: AntigravityAcpSession): void {
    // A permission request is parked and surfaced to the user — as an approval
    // or, for the server's native fixed-choice questions, as a user-input
    // question — while the RPC handler blocks on the resolver. The decision
    // selects the reply option by its kind because the server's optionIds are
    // its own spellings.
    // SAFETY: the reverse request hands back arbitrary ACP JSON; the decoders
    // below revalidate every field before use.
    session.rpc.onRequest("session/request_permission", (params) =>
      this.requestPermission(session, params as AntigravityAcpValue),
    );
  }

  private async requestPermission(
    session: AntigravityAcpSession,
    params: AntigravityAcpValue | undefined,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const options = acpArray(readValue(params, "options"));
    // Fail closed: a permission request with no active turn (a recovery or
    // replay callback after a crash/interrupt) has no trustworthy mode behind
    // it — cancel rather than park a gate nobody is watching.
    if (!session.activeTurnId) {
      return { outcome: { outcome: "cancelled" } };
    }

    // Native fixed-choice questions (fact 5) are answered through the
    // user-input flow, in every mode — including full-access.
    if (isAntigravityQuestion(params)) {
      return this.requestUserInput(session, params);
    }

    // Full Access never stops to ask: select an allow option (the persistent
    // rung first, then the request-scoped one).
    if (session.mode === "full-access") {
      // …except for the handful of commands that end the machine rather than
      // the working tree. This gate is the only one a full-access session
      // passes through, so it is the only place left to refuse them.
      const refusal = refuseCriticalCommand(
        readString(readValue(params, "toolCall"), "command"),
        session.threadId,
      );
      if (refusal) return refusal;
      const optionId =
        selectPermissionOption(options, "allow-always") ?? selectPermissionOption(options, "allow-once");
      return optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const requestId = randomUUID();
    const turnId = session.activeTurnId;
    const approval = buildAntigravityApprovalRequestWithWarnings(params);
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
    const optionId = selectPermissionOption(options, decision);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }

  /** Park one native fixed-choice question: normalize it, emit
   *  `user-input.requested`, and block the RPC handler until the renderer
   *  answers (or we drain on interrupt/stop). */
  private async requestUserInput(
    session: AntigravityAcpSession,
    params: AntigravityAcpValue | undefined,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const parsed = toAntigravityQuestion(params);
    if (!parsed) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = randomUUID();
    const turnId = session.activeTurnId;
    const answers = await new Promise<UserInputAnswers>((resolve) => {
      const optionIds = new Map<string, string[]>();
      optionIds.set(parsed.question.id, parsed.optionIds);
      session.pendingQuestions.set(requestId, { questions: [parsed.question], optionIds, resolve });
      this.emit({
        ...this.base(session),
        type: "user-input.requested",
        requestId,
        turnId,
        questions: [parsed.question],
      });
    });
    this.emit({ ...this.base(session), type: "user-input.resolved", requestId, answers });
    const optionId = selectQuestionOption(parsed, answers, params);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }

  /** Settle one parked permission request (idempotent — a no-op once drained). */
  private resolveApproval(session: AntigravityAcpSession, requestId: string, decision: ApprovalDecision): void {
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  /** Reject every parked ask — approvals answer "reject-once", questions
   *  resolve skipped — on interrupt/stop so no RPC handler hangs and the
   *  renderer's pending prompts clear. */
  private drainParked(session: AntigravityAcpSession): void {
    for (const [requestId] of session.pendingApprovals) {
      this.resolveApproval(session, requestId, "reject-once");
    }
    for (const [requestId, pending] of session.pendingQuestions) {
      session.pendingQuestions.delete(requestId);
      const skipped: UserInputAnswers = {};
      for (const question of pending.questions) skipped[question.id] = null;
      pending.resolve(skipped);
    }
  }

  private handleSessionUpdate(session: AntigravityAcpSession, update: AntigravityAcpRecord): void {
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
      case "current_mode_update":
      case "available_commands_update":
        // Session state kone doesn't surface yet.
        return;
      case "config_option_update": {
        const refreshed = parseAntigravityConfigOptions(readValue(update, "configOptions"));
        if (refreshed.length > 0) session.configOptions = refreshed;
        return;
      }
      default:
        // `user_message_chunk` and anything the server adds later — the
        // renderer already owns the user's own message.
        return;
    }
  }

  /** Assistant and reasoning text stream as bare chunks with no item id, so a
   *  contiguous run of one kind becomes one synthetic item. A switch of kind —
   *  or a tool call landing between chunks — closes the open segment. */
  private appendText(session: AntigravityAcpSession, kind: RuntimeItemKind, text: string | undefined): void {
    if (!text || !session.activeTurnId) return;

    if (session.segment && session.segment.kind !== kind) this.closeSegment(session);

    if (!session.segment) {
      session.segmentCount += 1;
      const itemId = `${session.activeTurnId}:${kind}:${session.segmentCount}`;
      session.segment = { itemId, kind };
      session.items.set(itemId, { itemId, kind, text: "", detail: "" });
      this.emitItem(session, "item.started", session.items.get(itemId), "in-progress");
    }

    const buffer = session.items.get(session.segment.itemId);
    if (!buffer) return;
    buffer.text += text;
    this.emitItem(session, "item.updated", buffer, "in-progress");
  }

  private closeSegment(session: AntigravityAcpSession): void {
    const open = session.segment;
    if (!open) return;
    session.segment = undefined;
    const buffer = session.items.get(open.itemId);
    if (buffer) this.emitItem(session, "item.completed", buffer, "completed");
  }

  private handleToolCall(session: AntigravityAcpSession, update: AntigravityAcpRecord): void {
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
    if (kind) buffer.name = TOOL_KIND_NAMES[kind] ?? "tool";
    if (!buffer.name) buffer.name = "tool";
    const target = antigravityToolTarget(update);
    if (target) buffer.text = target;
    const detail = antigravityToolDetail(update);
    if (detail) buffer.detail = detail;

    const status = antigravityToolStatus(readString(update, "status"));
    if (isNew) this.emitItem(session, "item.started", buffer, status);
    else if (status === "in-progress") this.emitItem(session, "item.updated", buffer, status);
    else this.emitItem(session, "item.completed", buffer, status);
  }

  private handlePlan(session: AntigravityAcpSession, update: AntigravityAcpRecord): void {
    if (!session.activeTurnId) return;
    const snapshot = parseAntigravityPlan(update);
    if (!snapshot) return;

    const itemId = `${session.activeTurnId}:plan`;
    const existing = session.items.get(itemId);
    const tasks = reconcilePlanTasks(existing?.tasks ?? [], snapshot);
    const buffer: AntigravityAcpItemBuffer = {
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
   *  Defensive ground truth, kept for the day the server starts reporting it —
   *  the shape is the ACP standard. */
  private handleUsage(session: AntigravityAcpSession, update: AntigravityAcpRecord): void {
    const used = readNumber(update, "used");
    const size = readNumber(update, "size");
    if (used === undefined && size === undefined) return;
    // The ACP `usage_update` shape is only ever `used`/`size` — no
    // input/output split, so no cache/reasoning split either. Per-turn token
    // backfill for stored threads still comes from the on-disk conversation
    // scan (ConversationStore.backfillAntigravityTokens).
    const usage: TokenUsage & TokenUsageSplits = {
      compactsAutomatically: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
    if (used !== undefined) {
      usage.contextUsed = used;
      usage.total = used;
    }
    if (size !== undefined) usage.contextWindow = size;
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
  }

  // ── turn completion ──────────────────────────────────────────────────────

  /** Close out a turn's bookkeeping: settle anything still marked in-progress,
   *  then drop the turn's buffers so a long thread doesn't accumulate them. */
  private endTurn(session: AntigravityAcpSession, turnId: string, status: RuntimeItemStatus): void {
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

  private completeTurn(session: AntigravityAcpSession, turnId: string, stopReason: string | undefined): void {
    if (session.activeTurnId !== turnId) return;
    const aborted =
      session.interrupting || stopReason === "cancelled" || stopReason === "refusal" || stopReason === "max_tokens";
    this.endTurn(session, turnId, aborted ? "failed" : "completed");

    // Both the flag and the reason decide: a cancel the server waited out
    // still settles `end_turn` (fact 4). `refusal`/`max_tokens` are genuine
    // failures.
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
        message: `Antigravity stopped the turn (${stopReason}).`,
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

  private failTurn(session: AntigravityAcpSession, turnId: string, message: string): void {
    if (session.activeTurnId !== turnId) return;
    this.endTurn(session, turnId, "failed");
    // A prompt rejected because the child died is already covered by the
    // `session.exited` event; report the turn as failed either way so the
    // renderer never keeps a turn spinning.
    const reason = session.interrupting ? "interrupted" : "failed";
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason, message });
  }

  /** A prompt failure owes the user an actionable message: a missing sign-in
   *  says so (with the captured browser URL when the server printed one),
   *  everything else passes through. */
  private describeFailure(session: AntigravityAcpSession, cause: unknown): string {
    if (isAntigravitySignInRequiredError(cause)) {
      const url = session.lastAuthUrl ? ` ${session.lastAuthUrl}` : "";
      return `${ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE}${url}`;
    }
    return cause instanceof Error ? cause.message : String(cause);
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  /** A degraded-but-continuing condition (a rejected model, a mode the server
   *  doesn't have). Surfaced as session state, never thrown — none of these
   *  are worth losing a session over. */
  private warn(session: AntigravityAcpSession, summary: string, detail: string): void {
    this.emit({
      ...this.base(session),
      source: "antigravity.acp.lifecycle",
      type: "session.state.changed",
      state: session.activeTurnId ? "running" : "ready",
      message: `${summary}: ${detail}`,
    });
  }

  private emitItem(
    session: AntigravityAcpSession,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: AntigravityAcpItemBuffer | undefined,
    status: RuntimeItemStatus,
    turnId: string | undefined = session.activeTurnId,
  ): void {
    if (!turnId || !buffer) return;
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

  private base(session: AntigravityAcpSession) {
    const envelope = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "antigravity.acp.notification" as const,
    };
    // The resume id rides every envelope so a turn that never completes still
    // leaves the thread resumable.
    if (session.conversationId) {
      return { ...envelope, refs: { conversationId: session.conversationId } };
    }
    return envelope;
  }

  private toSession(session: AntigravityAcpSession): Session {
    // The server holds the model on the session's live config matrix — the
    // `model` option's currentValue is the honest read.
    const result: Session = {
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
    return result;
  }

  private requireSession(threadId: string): AntigravityAcpSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Antigravity ACP session for thread ${threadId}`);
    return session;
  }
}
