import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  query,
  type AccountInfo,
  type CanUseTool,
  type HookInput,
  type HookJSONOutput,
  type ModelInfo,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildClaudeEnv,
  parseClaudeCliVersion,
  resolveClaudeExecutable,
  summarizeClaudeAccount,
} from "../claudeHome.js";
import { claudeSystemPromptAppend } from "../gateway/appContext.js";
import { claudeMcpServers } from "../gateway/injection.js";
import { buildAgentEnv } from "../processEnv.js";
import { probe } from "../spawn.js";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  BaseEvent,
  EmitEvent,
  InteractionMode,
  ModelDescriptor,
  ProviderAdapter,
  ProviderRefs,
  ProviderStatus,
  RuntimeEvent,
  RuntimeItem,
  RuntimeItemStatus,
  Session,
  SendTurnInput,
  SessionStartInput,
  SubagentStatus,
  TokenUsage,
  TurnStartResult,
  UserInputAnswers,
} from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";
import {
  buildClaudeSubagentDefinitions,
  claudeSubagentEffort,
  claudeSubagentSteerContext,
  isClaudeSubagentTool,
  CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND,
} from "../claudeSubagents.js";
import {
  applyClaudeTaskToolResult,
  isClaudeTaskTool,
  planTasksFromClaudeTracked,
} from "../claudeTaskTracker.js";
import { formatPlanTasks } from "../planTasks.js";
import { isResumeRefusalError } from "./errors.js";
import {
  buildClaudeAttachmentContent,
  composePromptText,
  type ClaudeImageBlock,
} from "../promptAttachments.js";

// Claude adapter — drives Claude Code through `@anthropic-ai/claude-agent-sdk`'s
// `query()`. One kone thread = one live `query()` session: prompts are pushed
// into an async queue the SDK consumes, and every SDKMessage the query yields is
// translated into kone's normalized RuntimeEvent union. The SDK is the
// supported programmatic surface (raw `claude --output-format stream-json` is
// only for one-shot text generation, not interactive tool/approval streaming).
//
// "Bring your own subscription": the SDK runs the user's own Claude Code login
// (macOS keychain OAuth / ~/.claude credentials / an external Bedrock-Vertex
// backend). kone never runs `claude login`, never writes or holds a token — see
// claudeHome.ts, which also strips a stray ANTHROPIC_API_KEY from the child env
// so the subscription always wins over a leaked key.
//
// `canUseTool` parks every tool call the SDK isn't already auto-approving and
// surfaces it to the user via an `approval.requested` event (see canUseTool).
// The InteractionMode sets the SDK permissionMode (default / acceptEdits /
// bypassPermissions), which is exactly what gates how often we stop to ask:
// `ask` consults this callback for every tool, `accept-edits` only for the
// non-file-edit tools, `full-access` never reaches it.
//
// Effort is a spawn-time SDK option (`Options.effort`), not a live control, so
// the adapter advertises `sessionModelSwitch: "restart-session"`: changing the
// model or effort restarts the session (ProjectView drives that). The cheap
// live controls the SDK *does* expose — permission mode and fast mode — are
// applied in-place.
//
// "Fast mode" is Claude's low-latency tier. Unlike effort it's a session
// *Setting* (`Settings.fastMode`), so the SDK flips it live mid-session via
// `query.applyFlagSettings({ fastMode })` — no restart. kone surfaces it through
// the same generic "fast" service-tier the composer already renders for Codex:
// a model that reports `supportsFastMode` advertises one synthetic `fast` tier
// (FAST_SERVICE_TIER), and a turn carrying `serviceTier: "fast"` toggles the
// Setting on for the session (see sendTurn). fastMode is gated per-model: only
// models that report `supportsFastMode` advertise the tier.
//
// Context window is a second live Setting in the same shape. Current Claude
// Subagents: the SDK is handed a catalog of nested agents (claudeSubagents.ts)
// the main agent spawns with its Task/Agent tool, and `forwardSubagentText: true`
// makes it forward the child's whole conversation — every message tagged with
// `parent_tool_use_id` = the spawning tool-use id. This adapter keeps one
// projection *scope* per live run (ClaudeScope), so a child's text/thinking/tool
// items are emitted against the run instead of the parent turn, nested under the
// parent's tool_call item (see types.ts SubagentRun).
// The run's status/spend come from the SDK's task lifecycle
// (task_started/task_progress/task_updated/task_notification), which is also
// where the `task_id` needed to stop one arrives.
//
// models are natively 1M (not the legacy `context-1m` beta, which was Sonnet
// 4/4.5-only), so the real per-thread choice is the *auto-compact window* — the
// token budget Claude Code compacts the transcript at. kone offers 200k (a safer
// `contextWindow` and applied live via applyFlagSettings({ autoCompactWindow })
// — no session restart.

import {
  CURATED_CLAUDE_MODELS,
  DEFAULT_CLAUDE_CONTEXT_WINDOW,
  FAST_SERVICE_TIER,
  INTERRUPT_TIMEOUT_MS,
  STOP_TASK_TIMEOUT_MS,
  contextWindowTokens,
  mapClaudeModels,
  mergeClaudeModels,
  newScope,
  normalizeEffort,
  recognizedSubagentToolUseId,
  scopeItemId,
  toPermissionMode,
  toSessionPermissionUpdates,
  type ClaudeItemBuffer,
  type ClaudeScope,
  type ClaudeSession,
  type ClaudeSubagentRun,
} from "./claudeAdapterTypes.js";

import {
  type ClaudeJsonObject,
  type ClaudeWirePayload,
  MessageQueue,
  applyPlanSnapshot,
  asRecord,
  claudeApprovalRequest,
  extractToolResultText,
  fileEditDiffBody,
  idlePrompt,
  isClaudeFileEditTool,
  isEmptyToolInput,
  isInterruptedResult,
  parseAskUserQuestions,
  readNumber,
  readString,
  summarizeToolInput,
} from "./claudeAdapterHelpers.js";

type ClaudeStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claudeAgent" as const;
  readonly capabilities: AdapterCapabilities = {
    // Model + effort are baked when the SDK subprocess spawns, so a change
    // restarts the session (ProjectView handles that). Permission mode is the
    // one thing switched live, in sendTurn.
    sessionModelSwitch: "restart-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    supportsSubagents: true,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, ClaudeSession>();
  /** One throwaway `initializationResult()` probe, cached — it returns both the
   *  account (for discover) and the model list (for listModels). Only successes
   *  are cached; a failed probe is retried next call (auth may have changed). */
  private initCache: Promise<{ account?: AccountInfo; models: ModelInfo[] } | null> | null = null;

  constructor(emit: EmitEvent) {
    this.emit = emit;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const [init, version] = await Promise.all([this.probeInit(), this.probeVersion()]);

    if (!init) {
      // The SDK ships its own CLI, so "installed" isn't the failure mode here —
      // an un-initializable session almost always means no login.
      return {
        provider: this.provider,
        label: "Claude",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `claude login` to sign in to Claude Code.",
      };
    }

    const auth = summarizeClaudeAccount(init.account);
    if (!auth.authenticated) {
      return {
        provider: this.provider,
        label: "Claude",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `claude login` to sign in to Claude Code.",
      };
    }

    return {
      provider: this.provider,
      label: "Claude",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
      authLabel: auth.label,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const init = await this.probeInit();
    const discovered = init ? mapClaudeModels(init.models) : [];
    return mergeClaudeModels(CURATED_CLAUDE_MODELS, discovered);
  }

  /** Best-effort installed-CLI version, for the status row only. */
  private async probeVersion(): Promise<string | undefined> {
    const env = await buildAgentEnv();
    const output = await probe("claude", ["--version"], env, 5_000);
    return output ? parseClaudeCliVersion(output) : undefined;
  }

  private probeInit(): Promise<{ account?: AccountInfo; models: ModelInfo[] } | null> {
    if (!this.initCache) {
      this.initCache = this.runInitProbe().then((result) => {
        if (!result) this.initCache = null; // don't cache a failure
        return result;
      });
    }
    return this.initCache;
  }

  /** Spawn a throwaway session that never runs a turn, read its init handshake
   *  (account + model list), then abort it. This is the Claude analogue of
   *  CodexAdapter's short-lived app-server spawn for model/list. */
  private async runInitProbe(): Promise<{ account?: AccountInfo; models: ModelInfo[] } | null> {
    const controller = new AbortController();
    try {
      const env = await buildClaudeEnv();
      const executable = resolveClaudeExecutable();
      // SAFETY: buildClaudeEnv returns the process-env shape the SDK widens to a string record.
      const probeOptions: ClaudeQueryOptions = {
        cwd: homedir(),
        env: env as Record<string, string | undefined>,
        abortController: controller,
        // Plan mode + a deny-all callback guarantee no tool ever executes even
        // if a turn somehow started; the idle prompt means none will.
        permissionMode: "plan",
        canUseTool: async () => ({ behavior: "deny", message: "kone discovery probe" }),
        settingSources: [],
        includePartialMessages: false,
        systemPrompt: { type: "preset", preset: "claude_code" },
      };
      if (executable) probeOptions.pathToClaudeCodeExecutable = executable;
      const q = query({
        prompt: idlePrompt(controller.signal),
        options: probeOptions,
      });
      const init = await q.initializationResult();
      return { account: init.account, models: init.models };
    } catch (error) {
      // A failed probe is reported to the user as the generic "Needs sign-in",
      // which is indistinguishable from a real logged-out state. Log the actual
      // reason so a spawn/auth failure in a packaged build is diagnosable.
      console.error("[kone] Claude discovery probe failed:", error);
      return null;
    } finally {
      controller.abort();
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Start a session, tolerating a dead or foreign resume id. Every sibling
   *  adapter already falls back to a fresh conversation when resume fails (Codex
   *  swallows `thread/resume` errors, Cursor falls back to `session/new`); Claude
   *  alone rethrew, so a stale stored conversation id surfaced to the user as a
   *  hard "conversation id does not exist" the moment a thread opened. Retry once
   *  without the resume rather than stranding the thread. */
  async startSession(input: SessionStartInput): Promise<Session> {
    // Retire whatever this thread already owns before starting its replacement.
    // `startFreshSession` overwrites the map entry unconditionally, so the
    // previous `query` subprocess would otherwise keep running — and keep
    // emitting events tagged with this same threadId. Guard lives here rather
    // than in startFreshSession so the resume-retry path below doesn't re-run it.
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);

    if (!input.resume) return this.startFreshSession(input);
    try {
      return await this.startFreshSession(input);
    } catch (error) {
      // Only a refusal-class failure (the stored conversation was pruned or is
      // foreign) deserves the fresh-start fallback; a transport, auth or
      // protocol failure must surface, or the thread reopens blank and the
      // user never learns why. Same gate Codex/Cursor/Droid apply.
      if (!isResumeRefusalError(error)) throw error;
      console.warn(
        `[claude] resume "${input.resume}" failed (${
          error instanceof Error ? error.message : String(error)
        }) — starting a fresh conversation`,
      );
      return this.startFreshSession({ ...input, resume: undefined });
    }
  }

  private async startFreshSession(input: SessionStartInput): Promise<Session> {
    const env = await buildClaudeEnv();
    const executable = resolveClaudeExecutable();
    const mode: InteractionMode = input.mode ?? "accept-edits";
    const effort = normalizeEffort(input.effort);
    const abort = new AbortController();
    const prompt = new MessageQueue();

    const permissionMode = toPermissionMode(mode);
    // SAFETY: buildClaudeEnv returns the process-env shape the SDK widens to a string record.
    const options: ClaudeQueryOptions = {
      cwd: input.cwd,
      additionalDirectories: [input.cwd],
      env: env as Record<string, string | undefined>,
      abortController: abort,
      permissionMode,
      // Session-bound so the callback knows which thread asked — a shared arrow
      // can't tell sessions apart. Only `AskUserQuestion` parks for a real
      // answer; every other tool auto-allows (see canUseTool below).
      canUseTool: (toolName, toolInput, opts) => this.canUseTool(session, toolName, toolInput, opts),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        // The preset is preserved; these blocks are appended on top (the SDK's
        // supported preset-append channel — sdk.d.ts: "Use default prompt with
        // appended instructions"). First the subagent catalog guidance, then —
        // when this session owns a gateway connection — the kone host-context
        // block (identity + gateway tools + when to use them), same gate as the
        // mcpServers injection below so an agent is never told about tools it
        // doesn't have. Delivered on resumed sessions too: this is the one
        // options builder fresh and resume paths share.
        //
        // The agent's own identity rides the same channel, but on its own gate:
        // whose name a thread carries has nothing to do with which tools the
        // session got. Absent for a guest thread, which appends nothing.
        append: [
          CLAUDE_SUBAGENT_SYSTEM_PROMPT_APPEND,
          claudeSystemPromptAppend(input.gatewayConnection !== undefined, input.agent),
        ]
          .filter(Boolean)
          .join("\n"),
      },
      // The nested agents this session may spawn (roles + effort-tier workers).
      agents: buildClaudeSubagentDefinitions(),
      // Forward the *whole* subagent conversation (text + thinking), not just
      // its tool blocks, so a run's transcript is real rather than a spinner.
      forwardSubagentText: true,
      // The one channel that reaches a RUNNING subagent: queued steer messages
      // are injected as extra context on the child's next tool call. The audit
      // hook rides the same event: under full-access nothing else sees a tool
      // call before it runs, so this is the only trace one leaves.
      hooks: {
        PreToolUse: [
          { hooks: [(hookInput) => this.subagentSteerHook(session, hookInput)] },
          { hooks: [(hookInput) => this.fullAccessAuditHook(session, hookInput)] },
        ],
      },
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
    };
    if (input.model) options.model = input.model;
    if (effort) options.effort = effort;
    // Resume a prior Claude Code conversation by its session id so the new
    // query continues with its full transcript/context (the SDK's supported
    // resume surface). The resumed run reports its own session id via
    // system/init, which refreshes the stored conversationId on the next
    // turn.completed.
    if (input.resume) options.resume = input.resume;
    // Anchor the resume at the last assistant message: the SDK cannot
    // passes the same `resumeSessionAt: lastAssistantUuid` pair). The anchor
    // is the persisted StoredThreadMeta.resumeSessionAt, refreshed live from
    // assistant messages (see handleMessage).
    if (input.resume && input.resumeSessionAt) options.resumeSessionAt = input.resumeSessionAt;
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    // The kone MCP gateway (docs/mcp-gateway-design.md): the session's
    // loopback connection, minted at startSession. The agent gets the
    // scratchpad tools and — later — spawn/theme/panes. Token is per-session
    // and revoked at stopSession.
    if (input.gatewayConnection) options.mcpServers = claudeMcpServers(input.gatewayConnection);
    if (executable) options.pathToClaudeCodeExecutable = executable;

    const q = query({ prompt: prompt.iterable(), options });
    const session: ClaudeSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      effort,
      mode,
      lastAssistantUuid: input.resumeSessionAt,
      query: q,
      prompt,
      abort,
      main: newScope(),
      subagentRuns: new Map(),
      settledSubagents: new Map(),
      pendingSubagentSteers: new Map(),
      pendingSubagentStops: new Set(),
      consumer: Promise.resolve(),
      disposed: false,
      interrupting: false,
      fastMode: false,
      trackedTasks: new Map(),
      taskPlanStarted: false,
      pendingUserInputs: new Map(),
      pendingApprovals: new Map(),
    };
    session.consumer = this.consume(session);

    try {
      // Resolves once the CLI subprocess has initialized — our request/ack point.
      // A dead or foreign `resume` id fails here ("no conversation found with
      // session id"), which is what startSession's catch retries without it, so
      // getting past this line means the resume was genuinely adopted.
      await q.initializationResult();
    } catch (error) {
      abort.abort();
      throw error;
    }
    if (input.resume) session.resumedFrom = input.resume;

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session, "claude.sdk.lifecycle"), type: "session.started" });
    return this.toSession(session);
  }

  /** kone's permission callback — the SDK consults it for every tool that
   *  isn't auto-approved by the current permission mode: everything under
   *  `default` (kone's `ask`), and the non-file-edit tools under `acceptEdits`
   *  (`accept-edits`). Under `bypassPermissions` (`full-access`) the SDK never
   *  calls this at all — so parking every non-question call here hands the user
   *  exactly the ladder's "ask first" behaviour. The `AskUserQuestion` built-in
   *  is special: it's how Claude asks the user a multiple-choice / free-text
   *  question mid-turn, so we park it for a real answer from the renderer
   *  instead of allowing it to resolve empty. */
  private canUseTool(
    session: ClaudeSession,
    toolName: string,
    input: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // AskUserQuestion is a real question for the human, not a permission gate —
    // it must reach the renderer even when earlier calls were allowed for the
    // session (auto-allowing it would resolve the question empty).
    if (toolName === "AskUserQuestion") {
      return this.askUserQuestion(session, input, options);
    }
    // Fail closed: a canUseTool callback with no active turn (a recovery or
    // replay callback after a crash/interrupt) has no trustworthy mode behind
    // it — deny rather than park a gate nobody is watching.
    if (!session.activeTurnId) {
      return Promise.resolve({
        behavior: "deny",
        message: "No turn is active for this session.",
      });
    }
    return this.askToolApproval(session, toolName, input, options);
  }

  /** Park a tool approval: normalize the ask, emit `approval.requested`, and
   *  await the renderer's decision. "Always allow" applies the SDK's own
   *  permission suggestions rescoped to session-only rules (`see
   *  toSessionPermissionUpdates`) — a scoped rule for what was just approved,
   *  never a blanket bypass, so later, different calls still come back here,
   *  and nothing is written to the user's settings files. If the turn is
   *  interrupted (abort signal) or torn down, the parked promise resolves
   *  rejected so the SDK stops waiting. */
  private async askToolApproval(
    session: ClaudeSession,
    toolName: string,
    input: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    const approval = claudeApprovalRequest(toolName, input);
    // A canUseTool ask raised inside a native subagent carries the SDK's
    // `agentID` — map it back to the run's tool-use id so permission traffic
    // nests under the run (like `item.*` events tagged with subagentToolUseId).
    const subagentToolUseId = options.agentID
      ? this.runByTaskId(session, options.agentID)?.snapshot.toolUseId
      : undefined;
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      session.pendingApprovals.set(requestId, { approval, resolve });
      const approvalRequested: Extract<RuntimeEvent, { type: "approval.requested" }> = {
        ...this.base(session),
        type: "approval.requested",
        requestId,
        turnId: session.activeTurnId,
        approval,
      };
      if (subagentToolUseId) approvalRequested.subagentToolUseId = subagentToolUseId;
      this.emit(approvalRequested);
      // Unblock if the turn aborts mid-approval so the query can settle.
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) this.resolveApproval(session, requestId, "reject-once");
        else signal.addEventListener("abort", () => this.resolveApproval(session, requestId, "reject-once"), { once: true });
      }
    });

    this.emit({ ...this.base(session), type: "approval.resolved", requestId, decision });

    if (decision === "allow-always") {
      // Scoped, session-only rules — the CLI stops re-asking for this exact
      // shape for the rest of the session; nothing persists to disk and no
      // other tool shape is affected.
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: toSessionPermissionUpdates(toolName, options.suggestions),
      };
    }
    if (decision === "reject-and-stop") {
      return {
        behavior: "deny",
        message: "The user stopped this turn.",
        interrupt: true,
      };
    }
    if (decision === "reject-once") {
      return { behavior: "deny", message: "The user rejected this tool call." };
    }
    // `allow-once` is the remaining valid decision; anything unrecognized is
    // denied rather than allowed — a gate must not fail open on bad input.
    if (decision !== "allow-once") {
      return { behavior: "deny", message: `Unrecognized approval decision.` };
    }
    return { behavior: "allow", updatedInput: input };
  }

  /** Settle one parked tool approval (idempotent — a no-op once drained). */
  private resolveApproval(session: ClaudeSession, requestId: string, decision: ApprovalDecision): void {
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  /** Reject every parked approval — on interrupt/stop so no canUseTool promise
   *  leaks and the renderer's pending prompt clears. */
  private drainApprovals(session: ClaudeSession): void {
    for (const [requestId] of session.pendingApprovals) {
      this.resolveApproval(session, requestId, "reject-once");
    }
  }

  /** Park an AskUserQuestion round-trip: parse the questions, emit
   *  `user-input.requested`, and await the renderer's answer. The SDK keys
   *  answers by the question TEXT, so our UserInputQuestion.id === the question
   *  text and the resolved answers map passes straight back as `updatedInput`.
   *  If the turn is interrupted (abort signal) or torn down, the parked promise
   *  resolves empty and we deny so the SDK stops waiting. */
  private async askUserQuestion(
    session: ClaudeSession,
    input: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const questions = parseAskUserQuestions(input);
    if (questions.length === 0) {
      // Nothing coherent to ask — let the SDK proceed unchanged.
      return { behavior: "allow", updatedInput: input };
    }

    const requestId = randomUUID();
    const answers = await new Promise<UserInputAnswers>((resolve) => {
      session.pendingUserInputs.set(requestId, { questions, resolve });
      this.emit({
        ...this.base(session),
        type: "user-input.requested",
        requestId,
        turnId: session.activeTurnId,
        questions,
      });
      // Unblock if the turn aborts mid-question so the query can settle.
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) this.resolveUserInput(session, requestId, {});
        else signal.addEventListener("abort", () => this.resolveUserInput(session, requestId, {}), { once: true });
      }
    });

    this.emit({ ...this.base(session), type: "user-input.resolved", requestId, answers });

    const answered = Object.values(answers).some((value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value && value.length > 0),
    );
    if (!answered) {
      return { behavior: "deny", message: "The user dismissed the question without answering." };
    }
    // The SDK's tool input is a record; spreading it back keeps every original key.
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /** Settle one parked AskUserQuestion (idempotent — a no-op once drained). */
  private resolveUserInput(session: ClaudeSession, requestId: string, answers: UserInputAnswers): void {
    const pending = session.pendingUserInputs.get(requestId);
    if (!pending) return;
    session.pendingUserInputs.delete(requestId);
    pending.resolve(answers);
  }

  /** Resolve every parked question empty — on interrupt/stop so no canUseTool
   *  promise leaks and the renderer's pending prompt clears. */
  private drainUserInputs(session: ClaudeSession): void {
    for (const [requestId] of session.pendingUserInputs) {
      this.resolveUserInput(session, requestId, {});
    }
  }

  /** Build the SDK user message for a turn/steer: the prompt text — with
   *  non-image / unsupported-image files folded in as an <attached_files>
   *  path block — plus native image blocks for gif/jpeg/png/webp (reads any
   *  attachment bytes off disk). An attachment-only turn is valid; we just
   *  skip text. Shared by sendTurn and steerTurn so a steer's message is
   *  byte-for-byte what a turn's would be. */
  private async buildUserMessage(input: SendTurnInput): Promise<SDKUserMessage> {
    const text = input.input.trim();
    const { imageBlocks, fileBlock } = await buildClaudeAttachmentContent(input.attachments);
    const promptText = composePromptText(text, fileBlock);
    const content: Array<{ type: "text"; text: string } | ClaudeImageBlock> = [];
    if (promptText.length > 0) content.push({ type: "text", text: promptText });
    content.push(...imageBlocks);
    if (content.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }
    return {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
  }

  /** The live session Settings a turn — or a steer, which has no new turn
   *  boundary to hang them on — may change in place: permission mode, fast
   *  mode, and the auto-compact window. Model and effort are spawn-fixed and
   *  change via a session restart instead. */
  private async applyLiveSettings(session: ClaudeSession, input: SendTurnInput): Promise<void> {
    // Permission mode is the one selection the SDK lets us change live; model
    // and effort are spawn-fixed and change via a session restart instead.
    const mode = input.mode ?? session.mode;
    if (mode !== session.mode) {
      await session.query.setPermissionMode(toPermissionMode(mode));
      session.mode = mode;
    }

    // Fast mode is a live session Setting — flip it in place when the turn's
    // requested `fast` service tier differs from the session's current state.
    // This is the Claude analogue of CodexAdapter honoring `serviceTier`, but
    // the SDK carries it as a persistent per-session Setting it toggles via
    // applyFlagSettings rather than a per-turn flag. The composer only sends
    // `fast` for models that advertise it, so no per-model gate is needed here.
    const wantsFast = input.serviceTier === FAST_SERVICE_TIER.id;
    if (wantsFast !== session.fastMode) {
      try {
        await session.query.applyFlagSettings({ fastMode: wantsFast ? true : null });
        session.fastMode = wantsFast;
      } catch {
        // The Setting can be refused (model doesn't support fast mode, or it's
        // on cooldown / disabled upstream) — leave state as-is; a later turn
        // retries. The turn itself still runs, just at the standard tier.
      }
    }

    // Context window is the other live session Setting: the auto-compact
    // budget Claude Code compacts the transcript at. Like fast mode it's
    // carried as a persistent per-session Setting toggled via
    // applyFlagSettings. The composer only sends a contextWindow for models
    // that advertise the choice, and an unknown id resolves to undefined here
    // — meaning "leave the window where it is".
    const wantWindow = contextWindowTokens(input.contextWindow);
    if (wantWindow !== undefined && wantWindow !== session.autoCompactWindow) {
      try {
        await session.query.applyFlagSettings({ autoCompactWindow: wantWindow });
        session.autoCompactWindow = wantWindow;
      } catch {
        // Refused (window unsupported, or auto-compact disabled upstream) —
        // leave state as-is; the turn still runs at the current window.
      }
    }
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    const userMessage = await this.buildUserMessage(input);
    await this.applyLiveSettings(session, input);

    // Globally-unique turn id (a UUID) — never a per-session counter like
    // "turn_1", which
    // collides across threads in the shared store. See assistantBlockId.
    const turnId = randomUUID();
    session.activeTurnId = turnId;
    session.main = newScope();
    session.subagentRuns.clear();
    session.settledSubagents.clear();
    session.pendingSubagentSteers.clear();
    session.pendingSubagentStops.clear();
    session.trackedTasks.clear();
    session.taskPlanStarted = false;
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    session.prompt.push(userMessage);

    return { threadId: input.threadId, turnId };
  }

  /** Deliver a follow-up message into a RUNNING turn — the message is offered
   *  into the session's prompt queue, the SDK consumes it when it
   *  builds the next API request — no interrupt, no new turn boundary — the
   *  turn id is REUSED, and no turn.started is emitted. Only a real live turn
   *  can be steered; with no session or no active turn this falls back to
   *  sendTurn. (kone does not track synthetic turns — the only "not a real
   *  turn" state is the absence of activeTurnId.) This converts the old
   *  mid-turn sendTurn behavior (a phantom second "running" block that stole
   *  the activeTurnId and re-pointed interrupt at a turn the SDK never ran)
   *  into a real steer. */
  async steerTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.sessions.get(input.threadId);
    const turnId = session?.activeTurnId;
    if (!session || !turnId) return this.sendTurn(input);

    const userMessage = await this.buildUserMessage(input);
    await this.applyLiveSettings(session, input);
    // No UUID, no turn.started, no activeTurnId overwrite, no scope resets:
    // the work continues as the same turn. On session stop the queue is
    // shutdown, so a steer still parked here is dropped with it.
    session.prompt.push(userMessage);

    const steerText = input.input.trim();
    if (steerText) {
      this.emit({ ...this.base(session), type: "turn.steered", turnId, message: steerText });
    }
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId) return;
    session.interrupting = true;
    // Unblock any parked AskUserQuestion so the interrupt can land cleanly.
    this.drainUserInputs(session);
    // interrupt() alone only ends the parent turn — live subagent tasks keep
    // "users reach for Stop precisely when a fleet ran away"). Stop each live
    // task best-effort, bounded per task so one wedged child can't block the
    // interrupt itself; an acknowledged stop is settled synthetically so no
    // run renders as forever-running if the notification loses the race.
    // Snapshot, not live iteration: each task's stop races a bounded timeout,
    // and run records can still arrive from the stream mid-await.
    for (const run of Array.from(session.subagentRuns.values())) {
      const taskId = run.snapshot.taskId;
      if (!taskId) continue;
      const acknowledged = await Promise.race([
        session.query.stopTask(taskId).then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_TASK_TIMEOUT_MS)),
      ]).catch(() => false);
      if (acknowledged && session.subagentRuns.has(run.snapshot.toolUseId)) {
        this.settleSubagent(session, run, "stopped");
      }
    }
    try {
      // Bounded: a wedged CLI can leave interrupt() pending forever, and the
      // Stop button must never hang on it (the wedge watchdog still sweeps a
      // session that stays silent afterwards).
      await Promise.race([
        session.query.interrupt(),
        new Promise<void>((resolve) => setTimeout(resolve, INTERRUPT_TIMEOUT_MS)),
      ]);
    } catch {
      // The query may already be settling; the result event still lands.
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.disposed = true;
    // Schedule process termination BEFORE any cleanup that could wait on the
    // subprocess down, and doing it first also shrinks the window where late
    // stream events could race past the terminal emit below. Everything after
    // is synchronous bookkeeping that must never block on the provider.
    session.prompt.close();
    session.abort.abort();
    this.settleLiveSubagents(session, "stopped");
    this.drainUserInputs(session);
    this.drainApprovals(session);
    this.sealLiveTurn(session);
    // Identity-guarded eviction: a stale close (consume()'s finally, or a
    // replacement session for this thread) must never evict a session it
    // doesn't own.
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
    // Deliberate stop = the one stop-lifecycle contract every adapter now
    // shares: a terminal `session.exited` with code null (Codex/Cursor/Droid
    // already emit it on their kill paths). `disposed` gates consume()'s
    // finally, so this is the single emit — no double-exit.
    this.emit({ ...this.base(session, "claude.sdk.lifecycle"), type: "session.exited", code: null });
  }

  async stopAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.disposed = true;
      // Termination first, then synchronous bookkeeping — same contract as
      session.prompt.close();
      session.abort.abort();
      this.settleLiveSubagents(session, "stopped");
      this.drainUserInputs(session);
      this.drainApprovals(session);
      // stopSession seals a live turn as `interrupted`; stopAll must too, or a
      // quit while a turn is running journals it as a failure (the consume
      // finally only emits `session.exited`, which seals as 'failed' — and only
      // when not disposed). Same contract as stopSession.
      this.sealLiveTurn(session);
      this.emit({ ...this.base(session, "claude.sdk.lifecycle"), type: "session.exited", code: null });
    }
    this.sessions.clear();
  }

  /** Seal a turn that's still live as we tear the session down. `disposed`
   *  gates the `session.exited` emit in consume()'s finally, so a deliberate
   *  stop otherwise emits nothing terminal at all — the journaled assistant
   *  block would stay 'running' forever and the thread would reopen
   *  permanently busy. Must run after settleLiveSubagents, which reads
   *  activeTurnId while it's still set. */
  private sealLiveTurn(session: ClaudeSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnId = undefined;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveApproval(session, requestId, decision);
  }

  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveUserInput(session, requestId, answers);
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((s) => this.toSession(s));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── message stream → RuntimeEvents ─────────────────────────────────────────

  private async consume(session: ClaudeSession): Promise<void> {
    try {
      for await (const message of session.query) {
        this.handleMessage(session, message);
      }
    } catch (error) {
      if (!session.disposed) {
        this.emit({
          ...this.base(session, "claude.sdk.lifecycle"),
          type: "session.state.changed",
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
      // Fail closed on the way out: resolve every parked canUseTool round-trip
      // (approvals + questions) as rejected so no SDK callback hangs on a
      // promise nothing will settle after the query stream died. Idempotent —
      // a deliberate stop already drained these.
      this.drainApprovals(session);
      this.drainUserInputs(session);
      if (!session.disposed) {
        this.emit({ ...this.base(session, "claude.sdk.lifecycle"), type: "session.exited", code: null });
      }
    }
  }

  private handleMessage(session: ClaudeSession, message: SDKMessage): void {
    // A message forwarded from a nested subagent belongs to that run's scope,
    // not the parent turn. Claude also sets parent_tool_use_id on async Bash
    // progress, so only ids we've *recognized* as a subagent spawn are routed.
    const runToolUseId = recognizedSubagentToolUseId(session, message);
    if (runToolUseId !== undefined) {
      // A settled run's tail (messages already in flight when it stopped) is
      // dropped rather than reopening a run the UI has already closed out.
      if (session.settledSubagents.has(runToolUseId)) return;
      const run = this.ensureSubagentRun(session, runToolUseId);
      switch (message.type) {
        case "stream_event":
          this.handleStreamEvent(session, run.scope, message.event);
          return;
        case "assistant":
          this.handleAssistantMessage(session, run.scope, message);
          return;
        case "user":
          this.handleToolResults(session, run.scope, message);
          return;
        default:
          return;
      }
    }

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          session.sessionId = message.session_id;
          if (!session.model) session.model = message.model;
          return;
        }
        // The primary model refused and the SDK retried the turn on a fallback
        // model (safeguard reroute). Surface it as model.rerouted so the UI
        // doesn't keep showing the model that actually refused.
        if (message.subtype === "model_refusal_fallback") {
          this.handleModelRefusalFallback(session, message);
          return;
        }
        this.handleTaskMessage(session, message);
        return;
      case "stream_event":
        this.handleStreamEvent(session, session.main, message.event);
        return;
      case "user":
        this.handleToolResults(session, session.main, message);
        return;
      case "result":
        this.handleResult(session, message);
        return;
      case "assistant":
        // Main conversation: the stream_event deltas are authoritative for
        // rendering, so the settled message isn't re-projected here — but its
        // uuid IS the resume anchor (`resumeSessionAt`). Capture it so the
        // thread can always resume at the last assistant message, even when a
        // turn dies mid-flight (subagent-scoped messages were routed above and
        // never reach this switch).
        if (message.uuid && message.uuid.length > 0) {
          session.lastAssistantUuid = message.uuid;
        }
        return;
      default:
        // status/tool_progress/etc. — for the main conversation the stream_event
        // deltas are authoritative for rendering, so we don't double-handle them
        // (subagent scopes, which get no partials, do).
        return;
    }
  }

  /** A `model_refusal_fallback` system message: the primary model refused and
   *  the SDK retried on a fallback model, with the swap persistent for the
   *  session. Emit model.rerouted and track the fallback so the session's model
   *  label matches what's actually running. */
  private handleModelRefusalFallback(
    session: ClaudeSession,
    message: Extract<SDKMessage, { type: "system"; subtype: "model_refusal_fallback" }>,
  ): void {
    const fromModel = readString(message, "original_model") ?? readString(message, "originalModel");
    const toModel = readString(message, "fallback_model") ?? readString(message, "fallbackModel");
    if (!fromModel || !toModel) return;
    if (session.model === toModel) return;
    session.model = toModel;
    const content = readString(message, "content")?.trim();
    const rerouted: Extract<RuntimeEvent, { type: "model.rerouted" }> = {
      ...this.base(session),
      type: "model.rerouted",
      fromModel,
      toModel,
    };
    if (content) rerouted.reason = content;
    this.emit(rerouted);
  }

  private handleStreamEvent(session: ClaudeSession, scope: ClaudeScope, rawEvent: ClaudeStreamEvent): void {
    const event = asRecord(rawEvent);
    const type = readString(event, "type");
    if (!event || !type) return;
    scope.sawStreamEvent = true;

    if (type === "message_start") {
      scope.msgOrdinal += 1;
      scope.blocks.clear();
      return;
    }

    if (type === "content_block_start") {
      const index = readNumber(event, "index");
      if (index === undefined) return;
      const block = asRecord(event.content_block);
      const blockType = readString(block, "type");
      const itemId = scopeItemId(session, scope, index);

      if (blockType === "text") {
        this.beginBlock(session, scope, index, { itemId, kind: "assistant_text", text: "", detail: "" });
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        this.beginBlock(session, scope, index, { itemId, kind: "reasoning_text", text: "", detail: "" });
      } else if (blockType === "tool_use") {
        const toolName = readString(block, "name");
        const toolUseId = readString(block, "id");
        const isPlan = toolName?.toLowerCase() === "todowrite";
        const buffer: ClaudeItemBuffer = {
          itemId,
          kind: isPlan ? "plan_text" : "tool_call",
          name: isPlan ? undefined : toolName,
          text: "",
          detail: "",
          toolName,
        };
        if (toolUseId) buffer.toolUseId = toolUseId;
        // A streaming tool_use opens with an empty `{}` (or "") placeholder and
        // fills its input in via input_json_delta; seeding detail with that
        // placeholder would corrupt the concatenated JSON ("{}" + "{...}" =
        // unparseable), leaving the tool with no target. Only seed when the
        // start block already carries real input (the non-streaming case).
        const blockInput = block?.input;
        if (blockInput !== undefined && blockInput !== null && !isEmptyToolInput(blockInput)) {
          const raw =
            blockInput instanceof Object ? JSON.stringify(blockInput) : String(blockInput);
          buffer.detail = raw;
          buffer.toolInputRaw = raw;
        }
        scope.blocks.set(index, buffer);
        if (toolUseId) scope.toolItems.set(toolUseId, buffer);
        this.emitItem(session, scope, "item.started", buffer, "in-progress");
      }
      return;
    }

    if (type === "content_block_delta") {
      const index = readNumber(event, "index");
      if (index === undefined) return;
      const buffer = scope.blocks.get(index);
      if (!buffer) return;
      const delta = asRecord(event.delta);
      const deltaType = readString(delta, "type");
      if (deltaType === "text_delta") buffer.text += readString(delta, "text") ?? "";
      else if (deltaType === "thinking_delta") buffer.text += readString(delta, "thinking") ?? "";
      else if (deltaType === "input_json_delta") {
        buffer.detail += readString(delta, "partial_json") ?? "";
        if (buffer.kind === "plan_text") applyPlanSnapshot(buffer, buffer.detail);
      } else return;
      this.emitItem(session, scope, "item.updated", buffer, "in-progress");
      return;
    }

    if (type === "content_block_stop") {
      const index = readNumber(event, "index");
      if (index === undefined) return;
      const buffer = scope.blocks.get(index);
      if (!buffer) return;
      scope.blocks.delete(index);

      if (buffer.kind === "plan_text") {
        applyPlanSnapshot(buffer, buffer.detail);
        buffer.detail = "";
        this.emitItem(session, scope, "item.completed", buffer, "completed");
      } else if (buffer.kind === "tool_call") {
        // Input finished streaming — summarize it, but the tool is now running:
        // stays in-progress until its tool_result lands in a later user message.
        buffer.toolInputRaw = buffer.detail;
        const { text, detail } = summarizeToolInput(buffer.toolName, buffer.detail);
        buffer.text = text;
        buffer.detail = detail;
        this.emitItem(session, scope, "item.updated", buffer, "in-progress");
        // A Task/Agent call spawns a nested agent: open its run now, keyed by
        // the tool-use id its forwarded messages will arrive under. The SDK's
        // task_started (with the task id) usually follows, but the child's first
        // message can beat it — recognizing the spawn here is what lets that
        // traffic be scoped instead of landing on the parent turn.
        if (isClaudeSubagentTool(buffer.toolName) && buffer.toolUseId) {
          this.ensureSubagentRun(session, buffer.toolUseId, buffer);
        }
      } else {
        this.emitItem(session, scope, "item.completed", buffer, "completed");
      }
      return;
    }
  }

  private beginBlock(
    session: ClaudeSession,
    scope: ClaudeScope,
    index: number,
    buffer: ClaudeItemBuffer,
  ): void {
    scope.blocks.set(index, buffer);
    this.emitItem(session, scope, "item.started", buffer, "in-progress");
  }

  /** Project a *complete* assistant message into a scope. Only used for
   *  subagent runs: their conversation is forwarded whole (no partial stream
   *  events), so this is the sole chance to open their items. */
  private handleAssistantMessage(
    session: ClaudeSession,
    scope: ClaudeScope,
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): void {
    // A child that somehow streams is already fully projected by the stream
    // handler; re-projecting the settled message would duplicate every item.
    if (scope.sawStreamEvent) return;

    const content = asRecord(message.message)?.content;
    if (!Array.isArray(content)) return;
    scope.msgOrdinal += 1;

    content.forEach((rawBlock, index) => {
      const block = asRecord(rawBlock);
      const blockType = readString(block, "type");
      const itemId = scopeItemId(session, scope, index);

      if (blockType === "text") {
        const text = readString(block, "text") ?? "";
        if (!text.trim()) return;
        this.emitItem(
          session,
          scope,
          "item.completed",
          { itemId, kind: "assistant_text", text, detail: "" },
          "completed",
        );
        return;
      }

      if (blockType === "thinking" || blockType === "redacted_thinking") {
        const text = readString(block, "thinking") ?? "";
        if (!text.trim()) return;
        this.emitItem(
          session,
          scope,
          "item.completed",
          { itemId, kind: "reasoning_text", text, detail: "" },
          "completed",
        );
        return;
      }

      if (blockType === "tool_use" || blockType === "server_tool_use" || blockType === "mcp_tool_use") {
        const toolUseId = readString(block, "id");
        // Dedupe on the tool-use id: the same message can be replayed.
        if (toolUseId && scope.toolItems.has(toolUseId)) return;
        const toolName = readString(block, "name");
        const isPlan = toolName?.toLowerCase() === "todowrite";
        const rawInput =
          block?.input === undefined || block?.input === null
            ? ""
            : block.input instanceof Object
              ? JSON.stringify(block.input)
              : String(block.input);
        const buffer: ClaudeItemBuffer = {
          // The tool-use id is already unique and is what the result references.
          itemId: toolUseId ?? itemId,
          kind: isPlan ? "plan_text" : "tool_call",
          text: "",
          detail: "",
          toolInputRaw: rawInput,
        };
        if (!isPlan) buffer.name = toolName;
        if (toolName) buffer.toolName = toolName;
        if (toolUseId) buffer.toolUseId = toolUseId;
        if (isPlan) {
          applyPlanSnapshot(buffer, rawInput);
          this.emitItem(session, scope, "item.completed", buffer, "completed");
          return;
        }
        const { text, detail } = summarizeToolInput(toolName, rawInput);
        buffer.text = text;
        buffer.detail = detail;
        if (toolUseId) scope.toolItems.set(toolUseId, buffer);
        // In-progress until its tool_result lands — same contract as the
        // streamed path, so a child's running tool renders as running.
        this.emitItem(session, scope, "item.started", buffer, "in-progress");
      }
    });
  }

  /** Complete tool_call items when their result arrives in a `user` message. */
  private handleToolResults(
    session: ClaudeSession,
    scope: ClaudeScope,
    message: Extract<SDKMessage, { type: "user" }>,
  ): void {
    // SAFETY: probing the optional `tool_use_result` field on the SDK message shape.
    const structuredResult = (message as { tool_use_result?: ClaudeWirePayload }).tool_use_result;
    const content = asRecord(message.message)?.content;
    const blocks = Array.isArray(content) ? content : [];
    let handledTaskTool = false;

    for (const rawBlock of blocks) {
      const block = asRecord(rawBlock);
      if (readString(block, "type") !== "tool_result") continue;
      const toolUseId = readString(block, "tool_use_id");
      if (!toolUseId) continue;
      const buffer = scope.toolItems.get(toolUseId);
      if (!buffer) continue;
      // A subagent the user stopped returns an *error* tool_result; report the
      // run's real outcome instead of a spurious "failed" on the parent's call.
      const settled = session.settledSubagents.get(toolUseId);
      const failed = settled !== undefined ? settled === "failed" : block?.is_error === true;

      if (
        this.applyTaskToolResult(
          session,
          buffer,
          // SAFETY: block is a tool_result content block object or an empty fallback object.
          (block ?? {}) as ClaudeJsonObject,
          structuredResult,
          failed,
        )
      ) {
        handledTaskTool = true;
      }

      scope.toolItems.delete(toolUseId);
      const resultText = extractToolResultText(block?.content).trim();
      // Prefer the structured diff for file edits so the thread and the Changes
      // dock see real +/− lines; fall back to the plain result text otherwise.
      const diffBody = isClaudeFileEditTool(buffer.toolName)
        ? fileEditDiffBody(structuredResult)
        : undefined;
      if (diffBody) buffer.detail = diffBody;
      else if (resultText.length > 0) buffer.detail = resultText;
      this.emitItem(session, scope, "item.completed", buffer, failed ? "failed" : "completed");
    }

    // Some SDK user messages carry structured output on the envelope instead of
    // (or in addition to) parseable tool_result text — TaskCreate's `{ task }`
    // object lives here.
    if (!handledTaskTool && structuredResult !== undefined && message.parent_tool_use_id) {
      const buffer = scope.toolItems.get(message.parent_tool_use_id);
      if (buffer && isClaudeTaskTool(buffer.toolName)) {
        if (
          this.applyTaskToolResult(
            session,
            buffer,
            {},
            structuredResult,
            false,
          )
        ) {
          scope.toolItems.delete(message.parent_tool_use_id);
          this.emitItem(session, scope, "item.completed", buffer, "completed");
        }
      }
    }
  }

  private applyTaskToolResult(
    session: ClaudeSession,
    buffer: ClaudeItemBuffer,
    resultBlock: ClaudeJsonObject,
    structuredResult: ClaudeWirePayload,
    isError: boolean,
  ): boolean {
    if (!isClaudeTaskTool(buffer.toolName)) return false;

    const toolInput = this.parseToolInputRaw(buffer.toolInputRaw ?? buffer.detail);
    if (
      applyClaudeTaskToolResult(
        session.trackedTasks,
        { toolName: buffer.toolName!, input: toolInput },
        resultBlock,
        structuredResult,
        isError,
      )
    ) {
      this.emitTaskPlan(session);
      return true;
    }
    return false;
  }

  private parseToolInputRaw(raw: string): ClaudeJsonObject {
    if (!raw.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed instanceof Object && !Array.isArray(parsed)) {
        // SAFETY: parsed is a non-null object that is not an array.
        return parsed as ClaudeJsonObject;
      }
    } catch {
      /* malformed */
    }
    return {};
  }

  private handleResult(session: ClaudeSession, message: Extract<SDKMessage, { type: "result" }>): void {
    const usage = message.usage;
    if (usage) {
      // The Anthropic usage object splits prompt tokens across three fields:
      // `input_tokens` is ONLY the fresh, uncached bytes; the bulk of an
      // agentic turn's prompt is re-read from the cache and lands in
      // `cache_read_input_tokens` (plus `cache_creation_input_tokens` when a
      // new prefix is written). Reading `input_tokens` alone dropped the
      // cached reads — which dominate — so Claude threads reported a tiny
      // fraction of their real spend. Fold all three in, matching Codex (whose
      // total already counts re-sent context).
      const freshInput = readNumber(usage, "input_tokens");
      const cacheRead = readNumber(usage, "cache_read_input_tokens");
      const cacheCreation = readNumber(usage, "cache_creation_input_tokens");
      const output = readNumber(usage, "output_tokens");
      const hasInput =
        freshInput !== undefined || cacheRead !== undefined || cacheCreation !== undefined;
      const input = hasInput
        ? (freshInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
        : undefined;
      const total = hasInput || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
      const contextWindow = session.autoCompactWindow ?? DEFAULT_CLAUDE_CONTEXT_WINDOW;
      const contextUsed =
        total !== undefined && contextWindow !== undefined
          ? Math.min(total, contextWindow)
          : total;
      // The cache split computed above for `input` used to be discarded the
      // moment it was folded in — pass it through instead so the store's
      // per-turn audit trail (turn_usage) keeps the real cache-read vs.
      // cache-creation breakdown, which is most of an agentic turn's actual
      // cost. Anthropic's usage object has no reasoning-token bucket distinct
      // from output (extended thinking bills as ordinary output tokens), so
      // that count is always 0 for this provider.
      const usageWithSplits: TokenUsage & TokenUsageSplits = {
        input,
        output,
        total,
        cacheReadTokens: cacheRead ?? 0,
        cacheCreationTokens: cacheCreation ?? 0,
        reasoningTokens: 0,
      };
      if (contextUsed !== undefined) usageWithSplits.contextUsed = contextUsed;
      if (contextWindow !== undefined) {
        usageWithSplits.contextWindow = contextWindow;
        usageWithSplits.compactsAutomatically = true;
      }
      this.emit({
        ...this.base(session),
        type: "thread.token-usage.updated",
        usage: usageWithSplits,
      });
    }

    const turnId = session.activeTurnId;
    if (turnId) this.completeTaskPlan(session, turnId);
    // Any run still open when the parent turn ends lost its notification (or the
    // turn was interrupted out from under it) — settle it now, while activeTurnId
    // is still set, so nothing renders as forever-running.
    this.settleLiveSubagents(
      session,
      message.subtype === "success" && !message.is_error ? "completed" : "stopped",
    );
    session.activeTurnId = undefined;
    if (!turnId) {
      // A result with no local turn is never a turn this adapter started: the
      // resume handshake (system/init + result(num_turns: 0)), a late result
      // for a turn already completed/aborted locally, or a stream failure with
      // no turn in flight. An untargeted turn.completed here would carry no
      // turnId, so no consumer could attribute it — and it would flip the
      // still folded in above; the lifecycle event is dropped. Tripwire so the
      // upstream trigger stays measurable in the field.
      // What the untargeted result carried, for the tripwire log line below.
      type OrphanTurnDetail = {
        status: typeof message.subtype;
        numTurns: typeof message.num_turns;
        hasUsage: boolean;
        errors?: string[];
      };
      const orphanDetail: OrphanTurnDetail = {
        status: message.subtype,
        numTurns: message.num_turns,
        hasUsage: usage !== undefined,
      };
      if ("errors" in message && Array.isArray(message.errors) && message.errors.length > 0) {
        orphanDetail.errors = message.errors;
      }
      console.warn("[claude] turn result with no active turn", orphanDetail);
      return;
    }

    const interrupting = session.interrupting;
    session.interrupting = false;

    if (message.subtype === "success" && !message.is_error) {
      this.emit({
        ...this.base(session),
        type: "turn.completed",
        turnId,
        conversationId: session.sessionId,
      });
      return;
    }

    const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    const reason = interrupting || isInterruptedResult(message, errors) ? "interrupted" : "failed";
    const detail = errors.join("; ") || readString(message, "result");
    const aborted: Extract<RuntimeEvent, { type: "turn.aborted" }> = {
      ...this.base(session),
      type: "turn.aborted",
      turnId,
      reason,
    };
    if (detail) aborted.message = detail;
    this.emit(aborted);
  }

  // ── subagents ────────────────────────────────────────────────────────────

  /** Get (or open) the run for a Task/Agent tool-use id. Opening emits
   *  `subagent.started` exactly once; the optional buffer is the parent's tool
   *  call, which carries the item id to nest the run under and the input we read
   *  the requested agent type / model / description out of. */
  private ensureSubagentRun(
    session: ClaudeSession,
    toolUseId: string,
    buffer?: ClaudeItemBuffer,
  ): ClaudeSubagentRun {
    const existing = session.subagentRuns.get(toolUseId);
    if (existing) {
      if (buffer) this.applySpawnInput(existing, buffer);
      return existing;
    }

    const run: ClaudeSubagentRun = {
      snapshot: { toolUseId, status: "starting", startedAt: Date.now() },
      scope: newScope(toolUseId),
      announced: false,
    };
    session.subagentRuns.set(toolUseId, run);
    if (buffer) this.applySpawnInput(run, buffer);
    this.emitSubagent(session, run);
    return run;
  }

  /** Fold what the parent's Task tool call already tells us into the snapshot:
   *  which item the run hangs off, and the requested agent type / model /
   *  description / prompt from the tool input. */
  private applySpawnInput(run: ClaudeSubagentRun, buffer: ClaudeItemBuffer): void {
    run.snapshot.parentItemId = buffer.itemId;
    const input = this.parseToolInputRaw(buffer.toolInputRaw ?? buffer.detail);
    const agentType = readString(input, "subagent_type");
    const description = readString(input, "description");
    const prompt = readString(input, "prompt");
    const model = readString(input, "model");
    if (agentType) {
      run.snapshot.agentType = agentType;
      const effort = claudeSubagentEffort(agentType);
      if (effort) run.snapshot.effort = effort;
    }
    if (description) run.snapshot.description = description;
    if (prompt) run.snapshot.prompt = prompt;
    if (model) run.snapshot.model = model;
  }

  /** The SDK's task lifecycle messages (`system` + task_* subtypes) are the only
   *  place a run's identity, progress and outcome are reported. Everything here
   *  folds into the run snapshot and re-emits it whole. */
  private handleTaskMessage(session: ClaudeSession, message: SDKMessage): void {
    const subtype = readString(message, "subtype");
    const taskId = readString(message, "task_id");
    if (!taskId) return;

    if (subtype === "task_started") {
      // Only Task/Agent spawns are subagents; Claude also reports background
      // Bash and workflow tasks through this channel, which kone doesn't nest.
      const toolUseId = readString(message, "tool_use_id");
      if (!toolUseId) return;
      const run = this.ensureSubagentRun(session, toolUseId);
      run.snapshot.taskId = taskId;
      run.snapshot.status = "running";
      const agentType = readString(message, "subagent_type");
      if (agentType) {
        run.snapshot.agentType = agentType;
        const effort = claudeSubagentEffort(agentType);
        if (effort) run.snapshot.effort = effort;
      }
      const description = readString(message, "description");
      if (description) run.snapshot.description = description;
      const prompt = readString(message, "prompt");
      if (prompt) run.snapshot.prompt = prompt;
      this.emitSubagent(session, run);
      // A stop that arrived before this mapping existed can finally be sent.
      if (session.pendingSubagentStops.delete(toolUseId)) {
        void session.query.stopTask(taskId).catch(() => {
          /* already gone — the notification still settles the run */
        });
      }
      return;
    }

    const run = this.runByTaskId(session, taskId, readString(message, "tool_use_id"));
    if (!run) return;

    if (subtype === "task_progress") {
      run.snapshot.status = "running";
      const lastToolName = readString(message, "last_tool_name");
      if (lastToolName) run.snapshot.lastToolName = lastToolName;
      const summary = readString(message, "summary");
      if (summary) run.snapshot.summary = summary;
      const tokens = readNumber(message, "usage", "total_tokens");
      if (tokens !== undefined) run.snapshot.tokens = tokens;
      const toolUses = readNumber(message, "usage", "tool_uses");
      if (toolUses !== undefined) run.snapshot.toolUses = toolUses;
      this.emitSubagent(session, run);
      return;
    }

    if (message.type === "system" && message.subtype === "task_updated") {
      // The SDK's wire-safe TaskState subset that changed; merge it into the snapshot.
      const patch = message.patch;
      const backgrounded = patch.is_backgrounded;
      if (backgrounded !== undefined) run.snapshot.background = backgrounded;
      const description = patch.description;
      if (description) run.snapshot.description = description;
      const error = patch.error;
      if (error) run.snapshot.summary = error;
      switch (patch.status) {
        case "completed":
          this.settleSubagent(session, run, "completed");
          return;
        case "failed":
          this.settleSubagent(session, run, "failed");
          return;
        case "killed":
          this.settleSubagent(session, run, "stopped");
          return;
        case "running":
          run.snapshot.status = "running";
          break;
        default:
          // pending/paused carry no distinct kone status — keep the current one.
          break;
      }
      this.emitSubagent(session, run);
      return;
    }

    if (subtype === "task_notification") {
      const summary = readString(message, "summary");
      if (summary) run.snapshot.summary = summary;
      const tokens = readNumber(message, "usage", "total_tokens");
      if (tokens !== undefined) run.snapshot.tokens = tokens;
      const toolUses = readNumber(message, "usage", "tool_uses");
      if (toolUses !== undefined) run.snapshot.toolUses = toolUses;
      const status = readString(message, "status");
      this.settleSubagent(
        session,
        run,
        status === "failed" ? "failed" : status === "stopped" ? "stopped" : "completed",
      );
    }
  }

  /** Find a run from a task lifecycle message. `task_updated` carries only the
   *  task id, so the tool-use id is matched first and the task id second. */
  private runByTaskId(
    session: ClaudeSession,
    taskId: string,
    toolUseId?: string,
  ): ClaudeSubagentRun | undefined {
    if (toolUseId) {
      const direct = session.subagentRuns.get(toolUseId);
      if (direct) return direct;
    }
    for (const run of session.subagentRuns.values()) {
      if (run.snapshot.taskId === taskId) return run;
    }
    return undefined;
  }

  /** Close a run out: stamp its final status, drop its live state, and emit
   *  `subagent.completed`. Idempotent — later notifications for the same run are
   *  ignored because its tool-use id is now in `settledSubagents`. */
  private settleSubagent(
    session: ClaudeSession,
    run: ClaudeSubagentRun,
    status: SubagentStatus,
  ): void {
    const { toolUseId } = run.snapshot;
    if (session.settledSubagents.has(toolUseId)) return;
    run.snapshot.status = status;
    run.snapshot.endedAt = Date.now();
    session.settledSubagents.set(toolUseId, status);
    session.subagentRuns.delete(toolUseId);
    session.pendingSubagentSteers.delete(toolUseId);
    session.pendingSubagentStops.delete(toolUseId);
    this.emitSubagent(session, run, "subagent.completed");
  }

  /** Settle every still-live run — the parent turn ended (or the session is
   *  going away), so nothing should be left rendering as forever-running. */
  private settleLiveSubagents(session: ClaudeSession, status: SubagentStatus): void {
    for (const run of session.subagentRuns.values()) {
      this.settleSubagent(session, run, status);
    }
  }

  private emitSubagent(
    session: ClaudeSession,
    run: ClaudeSubagentRun,
    type?: "subagent.completed",
  ): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    // A spawn that names no model runs on the parent's model (the SDK's built-in
    // agents inherit it), so report that rather than leaving the run modelless —
    // otherwise the UI falls back to a generic "Default model" placeholder.
    if (!run.snapshot.model && session.model) run.snapshot.model = session.model;
    const eventType = type ?? (run.announced ? "subagent.updated" : "subagent.started");
    run.announced = true;
    this.emit({
      ...this.base(session),
      type: eventType,
      turnId,
      subagent: { ...run.snapshot },
    });
  }

  /** Audit trail for full-access sessions. `bypassPermissions` never consults
   *  canUseTool, so without this a full-access turn leaves no record of what
   *  it executed. PreToolUse fires for every tool call regardless of mode;
   *  outside full-access this is a cheap no-op, which also keeps the log honest
   *  when the mode is stepped down mid-session. */
  private async fullAccessAuditHook(
    session: ClaudeSession,
    hookInput: HookInput,
  ): Promise<HookJSONOutput> {
    if (session.mode !== "full-access") return {};
    // This hook only ever registers for PreToolUse, but the SDK types the
    // callback with the whole HookInput union — narrow on its discriminant.
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolName = hookInput.tool_name;
    // SAFETY: hookInput.tool_input is an unparsed tool input from the SDK hook.
    const rawInput = asRecord(hookInput.tool_input as ClaudeWirePayload);
    const summary = summarizeToolInput(toolName, JSON.stringify(rawInput ?? {})).text || toolName;
    console.warn(`[kone] full-access ${session.threadId}: ${toolName} ${summary}`);
    return {};
  }

  /** PreToolUse hook — the only channel that reaches a RUNNING subagent. When
   *  the child that's about to call a tool has queued steer messages, they ride
   *  along as extra context; otherwise the hook is a pass-through. */
  private async subagentSteerHook(
    session: ClaudeSession,
    hookInput: HookInput,
  ): Promise<HookJSONOutput> {
    // `agent_id` is the SDK task id and is present only inside a subagent.
    const agentId = readString(hookInput, "agent_id");
    if (!agentId) return {};
    const run = this.runByTaskId(session, agentId);
    if (!run) return {};
    const queued = session.pendingSubagentSteers.get(run.snapshot.toolUseId);
    if (!queued?.length) return {};
    session.pendingSubagentSteers.delete(run.snapshot.toolUseId);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: queued.map((message) => claudeSubagentSteerContext(message)).join("\n"),
      },
    };
  }

  /** Stop one running subagent without touching the parent turn. Before
   *  `task_started` lands there's no task id to stop, so the request is queued
   *  and fired the moment the mapping arrives. */
  async stopSubagent(threadId: string, toolUseId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const run = session.subagentRuns.get(toolUseId);
    if (!run) return;
    const taskId = run.snapshot.taskId;
    if (!taskId) {
      session.pendingSubagentStops.add(toolUseId);
      return;
    }
    // fix-thread-kill-handling), and the caller must not hang on it.
    const acknowledged = await Promise.race([
      session.query.stopTask(taskId).then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_TASK_TIMEOUT_MS)),
    ]).catch(() => false);
    // stopTask only acknowledges the control request; its task_notification
    // can lose the race (the child never reports back), so the acknowledged
    // stop is authoritative for the UI: settle the run now — idempotent if
    // the notification does land later.
    if (acknowledged && session.subagentRuns.has(toolUseId)) {
      this.settleSubagent(session, run, "stopped");
    }
  }

  /** Queue a mid-task message for a running subagent. It's delivered by the
   *  PreToolUse hook on the child's next tool call, so a child that never calls
   *  another tool simply finishes without seeing it (the SDK has no other way
   *  in — there's no user turn inside a nested run). */
  async steerSubagent(threadId: string, toolUseId: string, message: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const text = message.trim();
    if (!text) return;
    if (!session.subagentRuns.has(toolUseId)) return;
    const queued = session.pendingSubagentSteers.get(toolUseId);
    if (queued) queued.push(text);
    else session.pendingSubagentSteers.set(toolUseId, [text]);
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private emitTaskPlan(session: ClaudeSession): void {
    const turnId = session.activeTurnId;
    if (!turnId || session.trackedTasks.size === 0) return;

    const tasks = planTasksFromClaudeTracked(session.trackedTasks);
    const buffer: ClaudeItemBuffer = {
      itemId: `${turnId}:plan`,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    const type = session.taskPlanStarted ? "item.updated" : "item.started";
    session.taskPlanStarted = true;
    this.emitItem(session, session.main, type, buffer, "in-progress");
  }

  private completeTaskPlan(session: ClaudeSession, turnId: string): void {
    if (!session.taskPlanStarted || session.trackedTasks.size === 0) {
      session.taskPlanStarted = false;
      session.trackedTasks.clear();
      return;
    }
    const tasks = planTasksFromClaudeTracked(session.trackedTasks);
    const buffer: ClaudeItemBuffer = {
      itemId: `${turnId}:plan`,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    this.emitItem(session, session.main, "item.completed", buffer, "completed");
    session.taskPlanStarted = false;
    session.trackedTasks.clear();
  }

  private emitItem(
    session: ClaudeSession,
    scope: ClaudeScope,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: ClaudeItemBuffer,
    status: RuntimeItemStatus,
  ): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    const item: RuntimeItem = {
      itemId: buffer.itemId,
      kind: buffer.kind,
      status,
      text: buffer.text,
    };
    if (buffer.tasks?.length) item.tasks = buffer.tasks;
    if (buffer.name) item.name = buffer.name;
    if (buffer.detail.length > 0) item.detail = buffer.detail;
    // Items produced inside a subagent run carry its tool-use id, so consumers
    // nest them under the spawning tool call instead of the parent turn's body.
    const itemEvent: Extract<
      RuntimeEvent,
      { type: "item.started" | "item.updated" | "item.completed" }
    > = {
      ...this.base(session),
      type,
      turnId,
      item,
    };
    if (scope.subagentToolUseId) itemEvent.subagentToolUseId = scope.subagentToolUseId;
    this.emit(itemEvent);
  }

  private base(
    session: ClaudeSession,
    source: "claude.sdk.message" | "claude.sdk.lifecycle" = "claude.sdk.message",
  ): BaseEvent {
    const envelope: BaseEvent = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source,
    };
    // Carry the Claude session id on every envelope so the store can persist
    // the thread's resume id as soon as system/init reports it, instead of
    // waiting for turn.completed — a turn killed mid-flight used to leave the
    // thread with no resume id at all. The resume anchor rides alongside it:
    // the store persists refs.resumeSessionAt exactly like conversationId,
    // so a thread always has the anchor it needs to resume reliably at the
    // last assistant message — even when the latest turn never completed.
    if (session.sessionId || session.lastAssistantUuid) {
      const refs: ProviderRefs = {};
      if (session.sessionId) refs.conversationId = session.sessionId;
      if (session.lastAssistantUuid) refs.resumeSessionAt = session.lastAssistantUuid;
      envelope.refs = refs;
    }
    return envelope;
  }

  private toSession(session: ClaudeSession): Session {
    return {
      threadId: session.threadId,
      provider: this.provider,
      cwd: session.cwd,
      status: session.activeTurnId ? "running" : "ready",
      conversationId: session.sessionId,
      resumedFrom: session.resumedFrom,
      activeTurnId: session.activeTurnId,
      model: session.model,
      effort: session.effort,
      mode: session.mode,
    };
  }

  private requireSession(threadId: string): ClaudeSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Claude session for thread ${threadId}`);
    return session;
  }
}
