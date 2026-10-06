import type {
  ApprovalRequest,
  ChatAttachment,
  InteractionMode,
  KoneAgentApi,
  MessageSender,
  ProviderKind,
  RuntimeItem,
  SendTurnInput,
  SkillReference,
  TurnStartResult,
  UserInputQuestion,
} from "~/types/desktop";
import type { EffortTier } from "~/utils/modelCatalog";
import type { ActivePlanTask } from "~/utils/planTasks";

/** A send or steer the backend refused, with what it carried. The composer
 *  that sent it restores its own draft (chips where they sat); any other
 *  composer on the thread — the inbox hands a new thread over before the
 *  answer is in — rebuilds one from `input` and `skills`. */
export type SendRejection = {
  at: number;
  message: string;
  input: string;
  skills: SkillReference[];
};

/** One user turn as the composer meant it: prose plus what rode along. A
 *  single object so the next per-turn field lands here instead of threading
 *  another optional positional through every send path. */
export type TurnDraft = {
  text: string;
  attachments?: ChatAttachment[];
  skills?: SkillReference[];
  /** While a turn runs, deliver this into it instead of queueing it behind
   *  it. Ignored on an idle thread, where every send starts a turn. */
  steer?: boolean;
};

/** The naming source for a turn: prose first, then the invoked skill, then
 *  the first file. Empty when the turn carries nothing nameable. Callers add
 *  their own fallback (a title helper, an "Attachment" placeholder). */
export function turnLabel(draft: TurnDraft): string {
  const trimmed = draft.text.trim();
  return trimmed || draft.skills?.[0]?.name || draft.attachments?.[0]?.name || "";
}

/** Whether a send argument is already a draft object. Reads through
 *  `instanceof` so no raw type test sits at the call boundary. */
export function isTurnDraft(value: string | TurnDraft): value is TurnDraft {
  return value instanceof Object;
}

/** Fold the legacy positional send shape into a draft. An object wins over
 *  positionals when both arrive; a string builds from the positionals. */
export function normalizeTurnDraft(
  textOrDraft: string | TurnDraft,
  attachments?: ChatAttachment[],
  skills?: SkillReference[],
): TurnDraft {
  if (isTurnDraft(textOrDraft)) {
    const draft: TurnDraft = { text: textOrDraft.text };
    const resolvedAttachments = textOrDraft.attachments ?? attachments;
    if (resolvedAttachments) draft.attachments = resolvedAttachments;
    const resolvedSkills = textOrDraft.skills ?? skills;
    if (resolvedSkills) draft.skills = resolvedSkills;
    if (textOrDraft.steer) draft.steer = true;
    return draft;
  }
  const draft: TurnDraft = { text: textOrDraft };
  if (attachments) draft.attachments = attachments;
  if (skills) draft.skills = skills;
  return draft;
}

/** What a host composer hands its session: prose plus the still-local files.
 *  Kept beside TurnDraft so the four hosts share one shape — the upload maps
 *  `files` to the draft's `attachments` before sending. */
export type ComposerDraft = {
  text: string;
  files?: File[];
  skills?: SkillReference[];
  /** The composer chose to steer this into the running turn (see TurnDraft). */
  steer?: boolean;
};

/** Whether a host send argument is already a composer draft object. */
export function isComposerDraft(value: string | ComposerDraft): value is ComposerDraft {
  return value instanceof Object;
}

/** Fold a host's legacy positional send into a composer draft. */
export function normalizeComposerDraft(
  textOrDraft: string | ComposerDraft,
  files?: File[],
  skills?: SkillReference[],
): ComposerDraft {
  if (isComposerDraft(textOrDraft)) {
    const draft: ComposerDraft = { text: textOrDraft.text };
    const resolvedFiles = textOrDraft.files ?? files;
    if (resolvedFiles) draft.files = resolvedFiles;
    const resolvedSkills = textOrDraft.skills ?? skills;
    if (resolvedSkills) draft.skills = resolvedSkills;
    if (textOrDraft.steer) draft.steer = true;
    return draft;
  }
  const draft: ComposerDraft = { text: textOrDraft };
  if (files) draft.files = files;
  if (skills) draft.skills = skills;
  return draft;
}

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
  /** Skills invoked on this prompt, as they were sent. The prompt text never
   *  names them, so this is the only record the timeline has of them. */
  skills?: SkillReference[];
  /** The reasoning-effort tier this turn was sent with — stamped at send time
   *  so the timeline can mark effort changes between turns. Absent on blocks
   *  that predate the stamp (stored history) — those never claim a change. */
  effort?: ReasoningTier;
  /** The raw model id this turn was sent with, stamped for the same reason
   *  and read the same way: absent never claims a change. Raw rather than a
   *  display name so history keeps naming the model that actually ran, even
   *  after a catalog renames it. */
  model?: string;
  /** Who said it. Absent = the user typed it; an agent's brief, follow-up or
   *  message carries that agent and how it relates to this thread, and a kone
   *  notice carries `{ kind: "system" }`. Only the user's own words sit on the
   *  user's side of the conversation. */
  sender?: MessageSender;
  /** Delivered into a turn that was already running rather than starting
   *  one; set once the provider took it (turn.steered), and on reload. */
  steered?: boolean;
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
  /** A message steered into the turn splits its reply where it landed: this
   *  piece follows that message, and names the turn's first piece. Absent on
   *  a turn's first (or only) piece. Every piece shares the turn's `turnId`. */
  continues?: string;
} & Historical;

export type ThreadBlock = UserBlock | AssistantBlock;

/** A live question whose answer resolves the waiting tool call. */
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

/** A parked approval held outside any resident session, with the project
 *  whose registry saw the ask — how a surface that owns no session routes the
 *  jump back into the waiting thread. This covers both headless spawned
 *  children (answered from the parent's dock) and top-level threads whose
 *  replayed ask arrived before any session claimed their id — the name says
 *  "routed" because the ask was filed by thread id at the registry level,
 *  not because a child spawn was involved. */
export type RoutedPendingApproval = PendingApproval & {
  /** The project whose registry recorded the ask. Absent for entries recorded
   *  before the route was kept — those answer in place only. */
  projectPath?: string;
};

/** Deprecated alias of {@link RoutedPendingApproval} — kept so existing
 *  importers keep compiling. New code should use the canonical name. */
export type SpawnedApproval = RoutedPendingApproval;

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

/** One parked-on-you thread, anywhere in the app — the cross-project feed the
 *  inbox bot row reads. Same derivation as the per-session `attention`, lifted
 *  to module scope so a surface that owns no session (the inbox list owns
 *  none) can still see every live claim. Read-only: answering still happens
 *  through the owning session. */
export type LiveAttentionItem = {
  /** Stable registry id (survives provider threadId changes). */
  key: string;
  /** The provider-native thread id (used to reopen / route). */
  threadId: string;
  title: string;
  provider: ProviderKind;
  /** The raw model id the thread last ran on, if known. */
  model?: string;
  /** Which project's registry owns the live session — how the host routes the
   *  jump back into the thread. */
  projectPath: string;
  kind: ThreadAttentionKind;
  /** The headline of what's being asked — the tool/command for a permission,
   *  the question's header. */
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
  /** "promoting" = the backend claimed the row and is handing it to the
   *  provider; "failed" = it didn't start after its retries and is held,
   *  pausing the queue behind it, until the user sends or removes it. */
  state: "queued" | "promoting" | "failed";
  /** The user's prompt text (also derivable from the anchored block; kept so
   *  an optimistic chip can render before a block is ever matched). */
  input: string;
  /** Who wrote the row's words, read from the block it was journaled as:
   *  `{ kind: "user" }` for the user, an agent or kone otherwise. Absent when
   *  the row has no block on record, which a user's send always has — so
   *  absent is never the user's. */
  sender?: MessageSender;
  createdAt: number;
  /** Files/images queued with the request (metadata only). A stored row
   *  arrives with these parsed; a live turn.queued row is parsed into them. */
  attachments?: ChatAttachment[];
  /** The serialized form turn.queued carries; read `attachments` instead. */
  attachmentsJson?: string | null;
  /** Skills invoked on the queued request — the row is the prompt until it is
   *  promoted, so they live here, not only on a block. */
  skills?: SkillReference[];
  /** What the request will run with — the reasoning tier and the raw model id,
   *  as the store journaled them on the row. Read back when the row is promoted
   *  so a turn sent while busy is stamped exactly like an idle one, whether the
   *  row was enqueued a second ago or drained from storage after a quit. */
  effort?: string;
  model?: string;
  /** The permission mode it will run in — handed back to the composer on Edit. */
  mode?: string;
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
  /** A start that failed and is waiting out its backoff: when the next try
   *  runs. Cleared when the row is claimed again. */
  retryAt?: number;
  /** Why the last delivery failed — set on a held row or a refused Send now. */
  error?: string;
  /** The provider took it into the running turn (Send now); the promoted
   *  block is marked steered. */
  steered?: boolean;
  /** When the provider took it in (turn.steered) — where the reply splits. */
  steeredAt?: number;
};

/** Queued messages a Stop handed back to the composer, merged into one draft.
 *  `at` is the cue: a new stamp means a new hand-back to restore. */
export type QueueReturn = {
  at: number;
  text: string;
  attachments: ChatAttachment[];
  skills: SkillReference[];
};

/** The queue slice of the desktop bridge — queuedTurns / cancelQueuedTurn /
 *  steerTurn land on KoneAgentApi with the parallel IPC agent; this local
 *  extension keeps the UI typed against the documented channel shapes until
 *  the mirror arrives (the methods are checked for presence at runtime, so
 *  an older bridge simply skips the queue features). */
export type QueueBridge = {
  queuedTurns?: (threadId: string) => Promise<QueuedTurnRow[]>;
  cancelQueuedTurn?: (threadId: string, queueId: string) => Promise<boolean>;
  reorderQueuedTurns?: (threadId: string, queueIds: string[]) => Promise<boolean>;
  sendQueuedTurnNow?: (threadId: string, queueId: string) => Promise<boolean>;
  steerTurn?: (input: SendTurnInput) => Promise<TurnStartResult>;
  interruptStepWaitNow?: (threadId: string, waitId: string) => Promise<boolean>;
};

/** The composer's reasoning-effort tier. Codex exposes this as a flag-based
 *  turn param (not baked into the model id), so we ride the tier along on each
 *  turn as `effort` and the adapter maps it to its own reasoning-effort param.
 *  Tiers come from the model catalog. */
export type ReasoningTier = EffortTier;

export type UseAgentOptions = {
  provider: ProviderKind | null;
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

/** The result of attempting to hand a live thread to another provider.
 *  `"handed"` keeps the thread id; `"not-applicable"` means there was
 *  nothing live to carry; `"failed"` means the swap itself broke. */
export type HandInOutcome = "handed" | "not-applicable" | "failed";
