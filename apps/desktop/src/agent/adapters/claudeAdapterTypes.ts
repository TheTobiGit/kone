import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionUpdate,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionMode,
  ModelDescriptor,
  PlanTask,
  RuntimeItemKind,
  SubagentRunSnapshot,
  SubagentStatus,
  UserInputAnswers,
  UserInputQuestion,
} from "../types.js";
import type { ClaudeTrackedTask } from "../claudeTaskTracker.js";
import type { MessageQueue } from "./claudeAdapterHelpers.js";

export const EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

export const STOP_TASK_TIMEOUT_MS = 3_000;
export const INTERRUPT_TIMEOUT_MS = 5_000;

export const FAST_SERVICE_TIER = { id: "fast", label: "Fast" };

export const CLAUDE_CONTEXT_WINDOWS = [
  { id: "200k", label: "200K", tokens: 200_000, isDefault: true as const },
  { id: "1m", label: "1M", tokens: 1_000_000 },
];

/** Token budget for a chosen context-window id, or undefined for an unknown id
 *  (which the caller treats as "leave the window at its current setting"). */
export function contextWindowTokens(id: string | undefined): number | undefined {
  return CLAUDE_CONTEXT_WINDOWS.find((w) => w.id === id)?.tokens;
}

export const DEFAULT_CLAUDE_CONTEXT_WINDOW = contextWindowTokens("200k");

/** Which context-window options a Claude model exposes. */
export function contextWindowsForModel(id: string): typeof CLAUDE_CONTEXT_WINDOWS | undefined {
  return /haiku/i.test(id) ? undefined : CLAUDE_CONTEXT_WINDOWS;
}

export const CLAUDE_FULL_EFFORTS: string[] = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_EXTENDED_EFFORTS: string[] = ["low", "medium", "high", "max"];
export const CLAUDE_BASIC_EFFORTS: string[] = ["low", "medium", "high"];

export const CURATED_CLAUDE_MODELS: ModelDescriptor[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-5", label: "Claude Opus 5", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", reasoningEfforts: CLAUDE_EXTENDED_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", reasoningEfforts: CLAUDE_BASIC_EFFORTS, defaultReasoningEffort: "high" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", reasoningEfforts: CLAUDE_EXTENDED_EFFORTS, defaultReasoningEffort: "high", contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export type ClaudeItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
  /** Raw streamed tool input JSON — kept for TaskCreate/TaskUpdate handling. */
  toolInputRaw?: string;
  /** Set for tool_use blocks — the raw tool name, used to shape the summary and
   *  to know the block is still executing after its input finishes streaming. */
  toolName?: string;
  /** Set for tool_use blocks — the provider's tool-use id. Doubles as a
   *  subagent run's identity when the tool is a Task/Agent spawn. */
  toolUseId?: string;
};

/** One projection scope. The main conversation has exactly one; every live
 *  subagent run gets its own, so a child's blocks and tool items can never
 *  collide with the parent's (both stream block index 0 for their first block). */
export type ClaudeScope = {
  /** Undefined for the main conversation; the run's Task tool-use id otherwise
   *  — stamped on every item event this scope emits. */
  subagentToolUseId?: string;
  /** Bumped on each message_start so item ids stay unique across a turn. */
  msgOrdinal: number;
  /** The current message's live content blocks, keyed by block index. Cleared
   *  on each message_start. Holds text/thinking/tool-input while they stream. */
  blocks: Map<number, ClaudeItemBuffer>;
  /** Tool items keyed by tool_use_id, so a tool_result arriving in a later
   *  `user` message can find and complete the right item after the block map
   *  has already rolled over. */
  toolItems: Map<string, ClaudeItemBuffer>;
  /** True once a `stream_event` landed here. */
  sawStreamEvent: boolean;
};

/** One live Task/Agent tool spawn: the snapshot kone reports and the scope its
 *  forwarded traffic is projected through. */
export type ClaudeSubagentRun = {
  snapshot: SubagentRunSnapshot;
  scope: ClaudeScope;
  /** True once `subagent.started` has been emitted for this run. */
  announced: boolean;
};

export type ClaudeSession = {
  threadId: string;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  mode: InteractionMode;
  query: Query;
  prompt: MessageQueue;
  abort: AbortController;
  /** Claude-native session id (from system/init) — for display/resume. */
  sessionId?: string;
  /** The resume id this process actually adopted, when one was honored. */
  resumedFrom?: string;
  /** The uuid of the most recent main-conversation assistant message. */
  lastAssistantUuid?: string;
  activeTurnId?: string;
  /** The main conversation's projection scope. */
  main: ClaudeScope;
  /** Live subagent runs, keyed by the spawning Task tool-use id. */
  subagentRuns: Map<string, ClaudeSubagentRun>;
  /** Final status per run that already settled. */
  settledSubagents: Map<string, SubagentStatus>;
  /** Mid-task messages queued per run. */
  pendingSubagentSteers: Map<string, string[]>;
  /** Stop requests that arrived before `task_started` mapped a run's tool-use
   *  id to an SDK task id; fired the moment that mapping lands. */
  pendingSubagentStops: Set<string>;
  consumer: Promise<void>;
  /** True once we're tearing this session down on purpose (stopSession). */
  disposed: boolean;
  /** True between interruptTurn() and the result that lands from it. */
  interrupting: boolean;
  /** Whether Claude's low-latency "fast mode" Setting is currently on for this session. */
  fastMode: boolean;
  /** The auto-compact window (in tokens) currently applied to this session. */
  autoCompactWindow?: number;
  /** Claude Code TaskCreate/TaskUpdate checklist for the active turn. */
  trackedTasks: Map<string, ClaudeTrackedTask>;
  /** Whether a synthesized `${turnId}:plan` item has been started this turn. */
  taskPlanStarted: boolean;
  /** In-flight AskUserQuestion round-trips, keyed by our requestId. */
  pendingUserInputs: Map<string, PendingUserInput>;
  /** In-flight tool approvals, keyed by our requestId. */
  pendingApprovals: Map<string, PendingApproval>;
};

/** A parked AskUserQuestion. */
export type PendingUserInput = {
  questions: UserInputQuestion[];
  resolve: (answers: UserInputAnswers) => void;
};

/** A parked tool approval. */
export type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

export function newScope(subagentToolUseId?: string): ClaudeScope {
  const scope: ClaudeScope = {
    msgOrdinal: 0,
    blocks: new Map(),
    toolItems: new Map(),
    sawStreamEvent: false,
  };
  if (subagentToolUseId) scope.subagentToolUseId = subagentToolUseId;
  return scope;
}

/** Item ids are scoped so a subagent's block 0 can't collide with the parent's. */
export function scopeItemId(session: ClaudeSession, scope: ClaudeScope, index: number): string {
  const prefix = scope.subagentToolUseId
    ? `${session.activeTurnId}:sub:${scope.subagentToolUseId}`
    : `${session.activeTurnId}`;
  return `${prefix}:${scope.msgOrdinal}:${index}`;
}

/** The subagent run a forwarded message belongs to, or undefined for the main conversation. */
export function recognizedSubagentToolUseId(
  session: ClaudeSession,
  message: SDKMessage,
): string | undefined {
  const parent = readParentToolUseId(message);
  if (!parent) return undefined;
  if (session.subagentRuns.has(parent) || session.settledSubagents.has(parent)) return parent;
  return undefined;
}

function readParentToolUseId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "parent_tool_use_id" in value) {
    // SAFETY: the typeof-object + `"parent_tool_use_id" in value` checks on this line are the narrowing.
    const parent = (value as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    return typeof parent === "string" ? parent : undefined;
  }
  return undefined;
}

export function normalizeEffort(value: string | undefined): EffortLevel | undefined {
  // SAFETY: the EFFORT_LEVELS membership check on this line is the narrowing; both casts name its result.
  return value && EFFORT_LEVELS.has(value as EffortLevel) ? (value as EffortLevel) : undefined;
}

/** kone's InteractionMode → the SDK's spawn-time permission mode. */
export function toPermissionMode(mode: InteractionMode): PermissionMode {
  switch (mode) {
    case "ask":
      return "default";
    case "full-access":
      return "bypassPermissions";
    case "accept-edits":
    default:
      return "acceptEdits";
  }
}

/**
 * The permission updates an "Always allow" decision applies: the SDK's own
 * suggestions when it offered any, rescoped to `destination: "session"` —
 * echoing them verbatim would persist a session-only choice as a permanent
 * rule (suggestions usually target `.claude/settings.local.json`). When no
 * suggestion exists — typical for MCP and other non-built-in tools — fall
 * back to a whole-tool allow rule for the session, so the decision still
 * sticks instead of silently degrading into a one-shot accept.
 */
export function toSessionPermissionUpdates(
  toolName: string,
  suggestions: readonly PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  const sessionScoped = (suggestions ?? []).map(
    (suggestion): PermissionUpdate => ({ ...suggestion, destination: "session" }),
  );
  if (sessionScoped.length > 0) return sessionScoped;
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

/** Map the SDK's live ModelInfo list to kone's ModelDescriptor. */
export function mapClaudeModels(models: ModelInfo[]): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const model of models) {
    if (model.value === "default") continue;
    const id = model.resolvedModel ?? model.value;
    if (!id || !id.startsWith("claude") || seen.has(id)) continue;
    seen.add(id);
    const efforts = model.supportsEffort && model.supportedEffortLevels?.length ? [...model.supportedEffortLevels] : undefined;
    const descriptor: ModelDescriptor = {
      id,
      label: model.displayName || id,
    };
    if (efforts) descriptor.reasoningEfforts = efforts;
    if (model.supportsFastMode) descriptor.serviceTiers = [FAST_SERVICE_TIER];
    const contextWindows = contextWindowsForModel(id);
    if (contextWindows) descriptor.contextWindows = contextWindows;
    out.push(descriptor);
  }
  return out;
}

/** Merge kone's curated Claude catalog with whatever the live SDK reports. */
export function mergeClaudeModels(
  curated: ModelDescriptor[],
  discovered: ModelDescriptor[],
): ModelDescriptor[] {
  const curatedIds = new Set(curated.map((m) => m.id));
  const fresh = discovered.filter((m) => !curatedIds.has(m.id));
  return [...fresh, ...curated];
}
