import type { ComputedRef, Ref, ShallowRef } from "vue";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatAttachment,
  ForkContext,
  InteractionMode,
  KoneAgentApi,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeSessionState,
  SendTurnInput,
  Session,
  SessionStartInput,
  SpawnedThread,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
  StoredThreadPage,
  SubagentRun,
  SubagentRunSnapshot,
  TokenUsage,
  TurnStartResult,
  UserInputAnswers,
  UserInputQuestion,
} from "~/types/desktop";
import type { EffortTier } from "~/utils/modelCatalog";
import type { ActivePlanTask, PlanTask } from "~/utils/planTasks";

/** Set on blocks bulk-loaded from storage (rehydrate/openThread) so the view
 *  renders them settled — no entry springs, no per-word blur-in. Live turns
 *  streamed in through the reducer never carry it, so they still animate. */
export type Historical = { historical?: boolean };

export type UserBlock = {
  id: string;
  role: "user";
  text: string;
  at: number;
  /** Files/images the user attached to this prompt (metadata only). */
  attachments?: ChatAttachment[];
} & Historical;

export type AssistantBlock = {
  id: string;
  role: "assistant";
  turnId: string;
  items: RuntimeItem[];
  state: "running" | "completed" | "failed" | "interrupted";
  error?: string;
  /** When the turn started (turn.started). */
  at: number;
  /** When the turn settled (completed/failed/interrupted) — drives "replied in Xs". */
  endedAt?: number;
} & Historical;

export type ThreadBlock = UserBlock | AssistantBlock;

/** A live question the agent is asking mid-turn — the composer swaps its
 *  orb/input for the answer modal while this is set. */
export type PendingUserInput = {
  requestId: string;
  questions: UserInputQuestion[];
};

/** A live tool approval the agent is waiting on — the turn is parked until the
 *  user picks allow-once / allow-always / reject. The composer gives way to the
 *  approval modal while this is set. */
export type PendingApproval = {
  requestId: string;
  approval: ApprovalRequest;
  /** The nested run the ask arrived inside, when it can be attributed: set when
   *  exactly one subagent was live in the turn at the moment the approval
   *  landed. Absent means the ask is the parent's own, or several runs were
   *  working at once — the main modal owns those, never a shell. */
  originToolUseId?: string;
};

/** Why a thread is parked on a person. A permission gate outranks a question
 *  when somehow both are up — you can't answer a question the turn is blocked
 *  behind. `parked-spawn` is a spawned child waiting on its own gate. */
export type ThreadAttentionKind = "permission" | "question" | "parked-spawn";

/** A thread waiting on a human — the state the unmissable indicator reads. It's
 *  derived live from the parked requests, never a stored flag: a crash-resume
 *  rebuilds it from the same events that drive the pane, so it can't be stranded
 *  the way a side flag written only at settle-time could. */
export type ThreadAttention = {
  kind: ThreadAttentionKind;
  /** The headline of what's being asked — the tool/command for a permission,
   *  the question's header — so the indicator can name it, not just flag it. */
  detail?: string;
};

/** A durably queued follow-up row, as the IPC bridge reports it
 *  (agent:queued-turns). Structural twin of the desktop QueuedTurnRow —
 *  the KoneAgentApi mirror lands with the parallel IPC agent, so until then
 *  this keeps the UI typed against the documented channel shape. */
export type QueuedTurnRow = {
  queueId: string;
  threadId: string;
  /** The store-journaled id of the user prompt block this turn was enqueued
   *  for — the chip anchors to the transcript block via it. */
  userBlockId: string;
  dispatchMode: "queue" | "steer";
  /** "promoting" = the backend claimed the row and handed it to the adapter. */
  state: "queued" | "promoting";
  /** The user's prompt text (also derivable from the anchored block; kept so
   *  an optimistic chip can render before a block is ever matched). */
  input: string;
  createdAt: number;
};

/** A queued follow-up as the UI presents it — the bridge row plus the local
 *  anchor and position the chips/badges need. */
export type QueuedTurnEntry = QueuedTurnRow & {
  /** The transcript block id this row anchors to — present when the row's
   *  userBlockId matched a timeline block (rehydrated/persisted rows), or
  *  when a live send's own block was recorded (see pendingQueueAnchors). */
  blockId?: string;
  /** Place in line, counting the running turn as slot 1 (so a fresh entry
   *  reads 2). Renumbered on every add/remove so a cancellation leaves no
   *  gaps. */
  position: number;
};

/** The queue slice of the desktop bridge — queuedTurns / cancelQueuedTurn /
 *  steerTurn land on KoneAgentApi with the parallel IPC agent; this local
 *  extension keeps the UI typed against the documented channel shapes until
 *  the mirror arrives (the methods are checked for presence at runtime, so
 *  an older bridge simply skips the queue features). */
export type QueueBridge = {
  queuedTurns?: (threadId: string) => Promise<QueuedTurnRow[]>;
  cancelQueuedTurn?: (threadId: string, queueId: string) => Promise<boolean>;
  steerTurn?: (input: SendTurnInput) => Promise<TurnStartResult>;
};

/** The composer's reasoning-effort tier. Codex exposes this as a flag-based
 *  turn param (not baked into the model id), so we ride the tier along on each
 *  turn as `effort` and the adapter maps it to its own reasoning-effort param.
 *  Tiers come from the model catalog. */
export type ReasoningTier = EffortTier;

export type UseAgentOptions = {
  provider: ProviderKind;
  /** Absolute path of the project the agent works in — or a getter, resolved
   *  when a session starts so it always reflects the active project. */
  cwd: string | (() => string);
  model?: string;
  mode?: InteractionMode;
  reasoning?: ReasoningTier;
  /** A model's chosen service tier id (e.g. Codex's "fast" tier). */
  serviceTier?: string;
  /** A model's chosen context-window id (Claude's "200k"/"1m" auto-compact
   *  window). Rides each turn; the adapter maps it to a live Setting. */
  contextWindow?: string;
  /** On the first thread's first start, reload the project's last persisted
   *  thread into the timeline (desktop only) so a conversation survives reload /
   *  quit / project switch. Defaults to true. */
  rehydrate?: boolean;
};

/** A background-facing snapshot of one thread — what the away-from-thread pill
 *  stack reads. `block` is the thread's latest assistant turn (or null). */
export type ThreadSummary = {
  /** Stable registry id (survives provider threadId changes). */
  key: string;
  /** The provider-native thread id (used to reopen / route). */
  threadId: string;
  title: string;
  provider: ProviderKind;
  /** The raw model id the thread last ran on, if known — lets the away pill show
   *  a harness provider's true model vendor on its badge corner. */
  model?: string;
  block: AssistantBlock | null;
  /** The checklist row the thread is on right now (null when it has no plan) —
   *  what the pill names while you're away from the conversation. */
  task: ActivePlanTask | null;
  busy: boolean;
  /** Set when the thread is parked on a person (permission / question). Null
   *  otherwise. Surfaced everywhere, on every surface — a blocked thread you've
   *  stepped away from is the one thing that must never go quiet. */
  attention: ThreadAttention | null;
  /** True once a live turn has actually started here — rehydrated history alone
   *  doesn't count, so a freshly reloaded thread never pills. */
  everRan: boolean;
  isActive: boolean;
};

export type SessionCtx = {
  options: UseAgentOptions;
  resolveCwd: () => string;
  bridge: () => KoneAgentApi | null;
  /** Shared sound effects and animations across thread sessions. */
  soundCue?: (cue: string) => void;
};
