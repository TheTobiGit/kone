import { randomUUID } from "node:crypto";
import { z } from "zod";
import { detect, diffStatBetween, snapshotWorkingTree } from "@kone/git-core/status.js";
import { GitError } from "@kone/git-core/core.js";
import type { AgentService } from "./AgentService.js";
import { LIMIT_RESUME_CONTINUATION_KIND } from "./AgentService.js";
import { threadWorkingDir, threadWorkspaceState } from "./threadWorkspace.js";
import type { ThreadWorkspace } from "./threadWorkspace.js";
import { workingDirFor } from "./assistantWorkspace.js";
import type { ConversationStore } from "./ConversationStore.js";
import {
  DEFAULT_QUIT_RESUME_PROMPT,
  claimQuitResumeRecordAtStartup,
  planQuitResumeTurns,
  quitResumeSkipReason,
  type QuitResumeAssistantTurn,
  type QuitResumeSkipReason,
  type QuitResumeSkipped,
  type QuitResumeThreadSnapshot,
} from "./quitResume.js";
import { buildResumeContext } from "./resumeContext.js";
import { nextContinuationDeferral, type ContinuationDeferral } from "./continuationDeferral.js";
import {
  restartCancelledBackgroundWorkNote,
  type RestartCancelledBackgroundWork,
} from "./restartBackgroundNote.js";
import type { ContinuationRecord } from "./store/continuations.js";
import { isSnoozed } from "./limitState.js";
import { resumeAtResetFor } from "./providerSettings.js";
import { renderSenderHeader, threadAgentName } from "./senderHeader.js";
import { contractPersona } from "./contractPersona.js";
import { SkillUnavailableError, resolveSkillReferences } from "./skillInvocation.js";
import {
  buildPromptThreadTitleFallback,
  canReplaceThreadTitle,
  generateThreadTitle,
} from "./threadTitle.js";
import type {
  CompactThreadResult,
  ForkThreadAtBlockInput,
  ForkThreadAtBlockResult,
  MessageSender,
  ThreadWorkspaceStep,
  ProviderKind,
  RuntimeEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  TurnSendOptions,
  TurnStartResult,
} from "./types.js";
import { StartCancelled, turnLabel } from "./types.js";
import { getIrcMailbox, type IrcMailbox } from "./gateway/tools/irc.js";
import {
  describeCopiedFiles,
  freshenBase,
  type FreshenThreadWorkspaceBase,
  type ProvisionThreadWorkspace,
  type ReleaseThreadWorkspace,
  type RenameThreadWorkspaceBranch,
  type RunThreadSetupScript,
} from "./workspaceBuild.js";
import { WorktreeSetupTracker, type WorktreeSetupSnapshot } from "./worktreeSetup.js";

export type {
  FreshenThreadWorkspaceBase,
  ProvisionThreadWorkspace,
  ReleaseThreadWorkspace,
  RenameThreadWorkspaceBranch,
  RunThreadSetupScript,
} from "./workspaceBuild.js";

// The thread dispatcher: the session lifecycle that used to live inside the
// agent:* IPC closures (docs/thread-spawning-design.md §5.1). Driving a thread
// is a main-process capability now — the spawn engine starts and sends turns
// on a child thread headlessly, doing exactly what the renderer's path does.
// ipc.ts forwards to this module, so the renderer path is unchanged.

/** The continuation kind quit-resume schedules; Phase 3 adds `limit-reset`. */
const QUIT_RESUME_CONTINUATION_KIND = "quit-resume";

/** How long a failed continuation waits before its next attempt, and how many
 *  attempts it gets before being dropped rather than retried forever. */
const CONTINUATION_RETRY_BACKOFF_MS = 60_000;
const MAX_CONTINUATION_ATTEMPTS = 5;

/** Whether a thread is snoozed right now, and until when. */
export type ThreadSnoozeState = { snoozed: boolean; snoozedUntil: number | null };

/** Thrown when a continuation was cancelled (settled, archived, superseded or
 *  deleted) after its claim but before the handoff to the provider. The sweep
 *  drops the row silently; it is not a dispatch failure. */
export class ContinuationCancelled extends Error {
  constructor(readonly threadId: string) {
    super(`Continuation for ${threadId} was cancelled before dispatch.`);
    this.name = "ContinuationCancelled";
  }
}

/** The silent turn a usage-limit resume sends once the provider's reset lands
 *  (or a manual resume). App-authored, so it is never journaled. */
export const LIMIT_RESUME_PROMPT = "Continue where you left off — the usage limit has reset.";

export class ThreadTurnHeldError extends Error {
  constructor(readonly threadId: string) {
    super(`The prompt for ${threadId} is held by a restore, compaction, or active turn. Try again when it is idle.`);
    this.name = "ThreadTurnHeldError";
  }
}

/** Where a starting thread runs, and whether that place is its own worktree.
 *  `worktreePath` is null for a thread sharing the project's checkout. */
type ThreadPlace = { dir: string; worktreePath: string | null };

/** A worktree the dispatcher just built, with the ownership facts a caller
 *  needs to adopt it or give it back: the branch it is on, and whether kone
 *  invented that branch or merely attached one that already existed. */
type BuiltThreadWorktree = {
  path: string;
  branch: string;
  generatedBranch: boolean;
  attachedExisting: boolean;
};

/** Outcome of moving a thread into its own worktree. `busy` refuses a thread
 *  with a turn in flight; a thread already in a worktree answers `ok` with the
 *  directory it has. */
export type MoveThreadToWorktreeResult =
  | { ok: true; worktreePath: string }
  | { ok: false; reason: "unknown" | "busy" | "restoring" | "stop-unconfirmed" | "failed"; detail?: string };

/** The sentence worth showing from a failure, or `fallback` when it carries
 *  none worth reading. */
function messageOf(error: Error, fallback: string): string {
  return error.message.trim() || fallback;
}

/** The optional payload a continuation carries: the prompt to send, and (for
 *  quit-resume) when it was recorded, which the staleness rules compare a
 *  later completed turn against. Unreadable payloads read as none. */
const ContinuationPayloadSchema = z.object({
  prompt: z.string().min(1),
  recordedAt: z.number().optional(),
});

function parseContinuationPayload(
  json: string | null,
): { prompt: string; recordedAt: number } | null {
  if (!json) return null;
  let raw: unknown;
  try {
    // SAFETY: JSON.parse yields only plain JSON values, which the schema parses.
    raw = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  const parsed = ContinuationPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { prompt: parsed.data.prompt, recordedAt: parsed.data.recordedAt ?? 0 };
}

export interface ThreadDispatcherDeps {
  service: AgentService;
  store: ConversationStore;
  /** Push one runtime event to every subscribed renderer. `journal` false
   *  skips store.applyEvent — ipc.ts owns both. */
  broadcast: (event: RuntimeEvent, journal?: boolean) => void;
  provisionWorkspace?: ProvisionThreadWorkspace;
  releaseWorkspace?: ReleaseThreadWorkspace;
  freshenWorkspaceBase?: FreshenThreadWorkspaceBase;
  renameWorkspaceBranch?: RenameThreadWorkspaceBranch;
  /** Run the project's setup script in a freshly built worktree. Absent, the
   *  setup-script stage is reported skipped. */
  runSetupScript?: RunThreadSetupScript;
  /** The inbox kone's notices are kept in until a turn carries them. Absent,
   *  the app's mailbox, resolved when first needed. */
  mailbox?: IrcMailbox;
}

export interface StartThreadOptions {
  /** When this thread is being spawned by another thread's turn, that
   *  spawning turn's id. Every event the child emits is stamped with it at the
   *  broadcast choke point (ipc.ts), so consumers correlate the child's
   *  traffic to the parent turn without a store walk (F10). */
  parentTurnId?: string;
  /** This start is a workspace handoff's own replacement session, the only
   *  start the move reservation admits while it holds the thread. */
  forWorktreeMove?: boolean;
}

export interface StartThreadTurnOptions {
  /** Use this title verbatim on the thread's first turn instead of the
   *  prompt-derived fallback. */
  title?: string;
  /** Ask the thread's own provider for a generated title in the background.
   *  Defaults to true — the renderer path relies on it. */
  generateTitle?: boolean;
  /** The spawning turn's id, stamped on every event the child emits — the
   *  same parentTurnId as startThread's; accepting it here too keeps the
   *  dispatcher self-describing for callers that only send a turn. */
  parentTurnId?: string;
  /** This prompt is machinery, not a person: journal no user block and never
   *  name the thread after it.
   *
   *  The transcript's user blocks are the record of what was actually said, and
   *  a turn the app started on its own — waking a thread whose background
   *  subagents came back late (subagentWake.ts) — was not said by anyone. The
   *  agent still receives the prompt; it just leaves no quotation marks around
   *  the app's own voice. Same discipline as the replay preamble below, which
   *  rides the dispatched prompt and stays out of the journaled block. */
  silent?: boolean;
  /** Runs once, when the provider takes the turn: before the checkpoint on a
   *  turn the service starts, or as the dispatch resolves on a path that has
   *  nothing slow after the provider. Never for a turn the service queued. */
  onAccepted?: (turnId: string) => void;
  /** Runs right before the turn goes to the provider. */
  onSending?: () => void;
  /** Steer only: refused rather than queued when no announced turn can take
   *  it (AgentService.steerTurn). */
  liveOnly?: boolean;
  /** A continuation row this turn delivers. The dispatcher re-checks it at the
   *  actual handoff (after any dispatch-tail wait) and drops the turn if the
   *  row was cancelled in between. */
  continuationId?: string;
  /** Do not put an app-authored continuation in the durable user queue. */
  noQueue?: boolean;
}

export interface ThreadDispatcher {
  startThread(input: SessionStartInput, options?: StartThreadOptions): Promise<Session>;
  sendThreadTurn(
    input: SendTurnInput,
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult>;
  /** A mid-turn nudge into the RUNNING turn. Journals the user's message and
   *  names a first-turn thread exactly like sendThreadTurn — a steer is the
   *  user speaking, so it belongs in the transcript — then hands it to the
   *  service's steer channel instead of its send channel. */
  steerThreadTurn(
    input: SendTurnInput,
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult>;
  /** Fork a thread at one of its user blocks (edit-and-resend of an earlier
   *  message) and immediately start a turn on the fork from the edited text.
   *  The source thread is never mutated. Resolves with the fork's identity —
   *  the renderer opens it. A dispatch failure after the fork row exists
   *  still rejects, but the fork itself survives (the renderer minted its
   *  id, so it can open the transcript and send manually). */
  forkThreadTurn(input: ForkThreadAtBlockInput): Promise<ForkThreadAtBlockResult>;
  /** Trigger context compaction for a thread. Rejects when the thread is
   *  unknown, has no conversation to compact yet, or the provider supports no
   *  manual compaction — the service owns the busy / single-flight guards.
   *  Nothing is journaled: the settled `thread.state.changed` "compacted"
   *  boundary is the record, not a user message. */
  compactThread(threadId: string): Promise<CompactThreadResult>;
  /** Adopt the thread's stored session when none is live, so a turn can run on
   *  it. Reads the provider, model, picker selection and — when `resume` is
   *  true — the stored provider conversation ids from the thread row and starts
   *  the session from them; a fork passes false so the new thread starts fresh
   *  instead of continuing the source's provider conversation. No-op when a
   *  session is already live. */
  ensureThreadSession(threadId: string, options: { resume: boolean; forWorktreeMove?: boolean }): Promise<void>;
  /** Fresh snapshot of one thread for the quit-resume filter: liveness from the
   *  service, settled-state facts per assistant turn from the store. */
  readQuitResumeSnapshot(threadId: string): QuitResumeThreadSnapshot;
  /** One silent continuation turn for a thread interrupted by a quit: adopts its
   *  session with resume first, then dispatches without journaling — the prompt
   *  is the app's own voice, not something the user said. */
  dispatchQuitResumeTurn(threadId: string, prompt: string): Promise<void>;
  /** Manual resume of a thread waiting out a usage limit: clear the mark,
   *  cancel its scheduled resume, and wake it now with the silent resume turn. */
  resumeLimitedThread(threadId: string): Promise<void>;
  /** Claim the quit-resume record (if any) and dispatch one continuation per
   *  surviving thread, serialized with a fresh re-check before each. Best-effort:
   *  resuming never fails boot — every failure is contained per thread and
   *  reported as skipped. */
  resumeQuitInterruptedChatsAtBoot(): Promise<{ resumed: string[]; skipped: QuitResumeSkipped[] }>;
  /** Dispatch every continuation due now (the boot sweep and the timer both
   *  call this). Public so a test can drive it without a live timer. */
  dispatchDueContinuations(): Promise<{ resumed: string[]; skipped: QuitResumeSkipped[] }>;
  /** Stage one thread's restart-background note (the boot capture's reader). */
  stageRestartBackgroundNote(threadId: string, work: RestartCancelledBackgroundWork[]): void;
  /** Whether a thread is snoozed right now, for the renderer's thread payload:
   *  the computed boolean plus the raw deadline. */
  threadSnoozeState(threadId: string): ThreadSnoozeState;
  /** Stage the restart-background notes captured at the boot seal: one note per
   *  thread that had live background work when the last process died. The note
   *  rides the thread's NEXT turn and never starts one, so a settled thread is
   *  never woken. */
  recoverRestartBackgroundNotesAtBoot(): void;
  /** Back out of a worktree that is still being built. Does not interrupt git —
   *  the creation is awaited and what it made is then removed. */
  cancelThreadWorkspace(threadId: string): void;
  /** Put a message another agent (or kone) wrote on a thread's transcript
   *  without dispatching it — for a caller that delivers the words to the
   *  model some other way, as agent-message delivery batches several into one
   *  turn. Announces it to renderers like any agent-sent block. Returns the
   *  block's id — the caller hands it to the turn that delivers the words, so
   *  a steer splits the reply where they landed — or null when nothing was
   *  written. */
  recordAgentMessage(input: {
    threadId: string;
    text: string;
    sender: MessageSender;
    /** The turn's own block this message reads above, when it is already on
     *  the transcript. */
    beforeBlockId?: string;
    /** The inbox message this writes. Its block id is derived from it, so a
     *  retry after a crash finds the block already written. */
    inboxId?: string;
  }): string | null;
  /** A follow-up from `parentTurnId` is on its way to `threadId`: stamp the
   *  child's events with that turn, as a send carrying it would. */
  noteSpawnParentTurn(threadId: string, parentTurnId: string): void;
  /** Tell a thread something as kone. The notice is stored in its inbox, and
   *  this returns once it is. Held (the default), it never starts a turn: it
   *  rides in front of whatever turn the thread runs next, and is written to
   *  the transcript then. Ringing, it is handed over on its own, as any
   *  message is. Returns the notice's inbox id; throws when it could not be
   *  stored. */
  queueNotice(threadId: string, text: string, options?: { rings?: boolean }): string;
  /** The recovered-transcript preamble for a thread whose session came up
   *  blank, consumed — for a turn started somewhere other than here, which
   *  should carry it as any turn would. Null when none is owed. */
  takeReplayPreamble(threadId: string): string | null;
  /** The id of the turn that spawned this thread, when it is a spawned child
   *  (registered via startThread/sendThreadTurn parentTurnId) — used by the
   *  IPC broadcast choke point to stamp child events. */
  spawnParentTurnId(threadId: string): string | undefined;
  /** Called when a turn settles — snapshots the repo state it left behind. */
  onTurnCompleted(threadId: string): void;
  /** Drop per-thread bookkeeping when a thread is deleted. */
  forgetThread(threadId: string): void;
  /** The live worktree-setup snapshot for a thread, or null when none is
   *  tracked. A renderer attaching mid-setup reads this first, then follows the
   *  thread.worktree.setup events. */
  worktreeSetupSnapshot(threadId: string): WorktreeSetupSnapshot | null;
  /** Move a thread that runs in the shared checkout into a worktree of its
   *  own: build it, then rebind the thread's session to the new directory and
   *  restart it, resuming the provider conversation. Refused while a turn is
   *  running — the session cannot change directory mid-turn. */
  moveThreadToWorktree(
    threadId: string,
    options?: { branch?: string },
  ): Promise<MoveThreadToWorktreeResult>;
}

/** The transcript block an inbox message is written as. */
export function inboxBlockId(inboxId: string): string {
  return `blk_${inboxId}`;
}

/**
 * What one turn's text is on each of the two axes that actually vary: whether
 * the transcript keeps it, and what the provider is sent.
 *
 * They are independent, and kone has been quietly relying on both for a while
 * without naming either. A silent turn — the app waking a thread whose
 * background subagents came back late — is dispatched but journaled nowhere,
 * because nobody said it. A replayed transcript (resumeContext.ts) is the
 * mirror image: dispatched in front of the user's words but journaled nowhere
 * either, because the user did not say it. The transcript's user blocks are the
 * record of what was actually said, and the app's own voice does not belong in
 * quotation marks.
 *
 * Four other paths prepend app-authored text to a turn the same way — the
 * sidechat bootstrap, the `<attached_files>` block, IRC delivery and the
 * subagent wake — each with its own hand-rolled concat at its own call site.
 * This is the shape they should collapse onto.
 */
export interface TurnDelivery {
  /** The user's own words, for the transcript — or null when nobody said it. */
  journal: string | null;
  /** What the provider is actually sent. */
  dispatch: string;
}

/**
 * Split one outgoing turn across the two axes above. Pure, so the rule that the
 * preamble never reaches the journal is a thing a test can hold, rather than a
 * comment sitting next to a string concatenation.
 */
export function composeTurnDelivery(input: {
  message: string;
  /** App-authored context that rides in front of the message. Never journaled. */
  preamble?: string | null;
  /** Who said the message, when it was not the user. Its header rides between
   *  the preamble and the message — closest to the words it attributes — and,
   *  like the preamble, is never journaled: the block keeps the sender as data,
   *  not as text. */
  sender?: MessageSender;
  /** The app started this turn, not a person: journal nothing. */
  silent?: boolean;
}): TurnDelivery {
  const front = [input.preamble, renderSenderHeader(input.sender)].filter(
    (part): part is string => Boolean(part),
  );
  return {
    journal: input.silent ? null : input.message,
    dispatch: front.length > 0 ? `${front.join("\n\n")}\n\n${input.message}` : input.message,
  };
}

/** The dispatcher created at IPC registration, or null before boot. Gateway
 *  tools resolve it lazily at call time, so module import order can't matter. */
let dispatcher: ThreadDispatcher | null = null;

/** Build the dispatcher the app runs on. Called once from ipc.ts at boot. */
export function initThreadDispatcher(deps: ThreadDispatcherDeps): ThreadDispatcher {
  dispatcher = new ThreadDispatcherImpl(deps);
  return dispatcher;
}

/** The live dispatcher, or null until IPC registration initializes it. */
export function getThreadDispatcher(): ThreadDispatcher | null {
  return dispatcher;
}

class ThreadDispatcherImpl implements ThreadDispatcher {
  private readonly service: AgentService;
  private readonly store: ConversationStore;
  private readonly broadcast: ThreadDispatcherDeps["broadcast"];
  private readonly provisionWorkspace: ProvisionThreadWorkspace | undefined;
  private readonly releaseWorkspace: ReleaseThreadWorkspace | undefined;
  private readonly freshenWorkspaceBase: FreshenThreadWorkspaceBase | undefined;
  private readonly renameWorkspaceBranch: RenameThreadWorkspaceBranch | undefined;
  private readonly runSetupScript: RunThreadSetupScript | undefined;
  /** Providers for threads with a setup in flight, so the tracker's snapshot
   *  callback can stamp the event it broadcasts. */
  private readonly worktreeSetupProviders = new Map<string, ProviderKind>();
  /** The staged worktree-setup view (fetch → checkout % → submodules → setup
   *  script → agent). On every change it broadcasts a whole snapshot on the
   *  same runtime stream the coarse workspace steps ride. */
  private readonly worktreeSetup = new WorktreeSetupTracker((snapshot) => {
    const provider = this.worktreeSetupProviders.get(snapshot.threadId);
    if (!provider) return;
    if (snapshot.phase !== "running") this.worktreeSetupProviders.delete(snapshot.threadId);
    this.broadcast(
      {
        type: "thread.worktree.setup",
        threadId: snapshot.threadId,
        provider,
        at: Date.now(),
        source: "kone.store",
        snapshot,
      },
      false,
    );
  });
  /** Threads whose user backed out while their worktree was being built.
   *
   *  Cancelling is not "stop trying" — git is already mid-checkout and there is
   *  nothing to interrupt. It is "undo whatever finishes": the creation is still
   *  awaited, and the directory it produces is then removed. The alternative is
   *  a worktree nobody asked for, owned by a thread that never started. */
  private readonly cancelledWorkspaces = new Set<string>();
  private readonly mailboxDep: IrcMailbox | undefined;

  // Threads whose live provider session came up with none of the thread's
  // context — no stored resume id to offer, or the provider refused the one we
  // had (see Session.resumedFrom). kone still has the transcript, so the next
  // turn on such a thread carries a condensed replay of it (resumeContext.ts)
  // instead of asking a blank agent to "continue". One-shot: the first turn
  // re-establishes the context, and everything after it is a normal
  // continuation.
  private readonly threadsNeedingReplay = new Set<string>();

  // Threads whose background work (subagents, Claude task-tracker tasks) a
  // restart cancelled. Staged once at boot from what the seal captured, and
  // consumed by the thread's next turn (restartBackgroundNote.ts). It is never
  // dispatched on its own: a settled thread hears about the dead work only if
  // and when something wakes it.
  private readonly threadsNeedingRestartNote = new Map<string, RestartCancelledBackgroundWork[]>();

  /** Threads whose restart note is reserved by an in-flight delivery, mapped to
   *  the carrier token of that delivery so only that send can release or consume it. */
  private readonly restartNoteReserved = new Map<string, string>();

  /** Queued turns carrying a restart note reservation: queueId → { threadId, carrierToken }. */
  private readonly queuedCarrierNotes = new Map<string, { threadId: string; carrierToken: string }>();

  /** How queue rows ended before their carrier was registered: queueId →
   *  { threadId, outcome }. The service names the queue id only when it
   *  acknowledges the send, and a cancel or promotion can land first. Kept
   *  only while the thread holds a note reservation, and dropped with it. */
  private readonly earlyQueueOutcomes = new Map<
    string,
    { threadId: string; outcome: "cancelled" | "promoted" }
  >();

  // One timer for the next continuation due in the future; the boot sweep
  // covers everything already due. Nothing polls: each arm schedules exactly
  // the next due time, and a sweep re-arms it after.
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly continuationDeferrals = new Map<
    string,
    { threadId: string; state: ContinuationDeferral }
  >();

  // The move in flight per thread, so a repeated request joins it instead of
  // building a second worktree or publishing a second binding.
  private readonly worktreeMoves = new Map<string, Promise<MoveThreadToWorktreeResult>>();

  // Spawned children: threadId → the parent turn that spawned it, registered
  // at dispatch (startThread/sendThreadTurn parentTurnId). The IPC broadcast
  // choke point reads it to stamp every event the child emits with its
  // spawning turn's id (F10).
  private readonly spawnParentTurnIds = new Map<string, string>();
  // One dispatch tail per thread with a turn still being journaled. Each tail
  // resolves once its turn is journaled and handed to the service — never
  // later, so a slow provider round-trip never holds later transcripts
  // hostage — and a tail only ever follows gates, which only ever resolve, so
  // awaiting one cannot throw.
  private readonly dispatchTails = new Map<string, Promise<void>>();

  constructor(deps: ThreadDispatcherDeps) {
    this.service = deps.service;
    this.store = deps.store;
    this.broadcast = deps.broadcast;
    this.mailboxDep = deps.mailbox;
    this.provisionWorkspace = deps.provisionWorkspace;
    this.releaseWorkspace = deps.releaseWorkspace;
    this.freshenWorkspaceBase = deps.freshenWorkspaceBase;
    this.renameWorkspaceBranch = deps.renameWorkspaceBranch;
    this.runSetupScript = deps.runSetupScript;

    this.service.onEvent?.((event) => {
      if (event.type === "thread.limit.updated") {
        this.armContinuationTimer();
        return;
      }
      if (event.type !== "turn.queued-cancelled" && event.type !== "turn.promoted") return;
      const outcome = event.type === "turn.promoted" ? "promoted" : "cancelled";
      const carrier = this.queuedCarrierNotes.get(event.queueId);
      if (carrier) {
        this.queuedCarrierNotes.delete(event.queueId);
        this.settleQueuedCarrier(carrier.threadId, carrier.carrierToken, outcome);
      } else if (this.restartNoteReserved.has(event.threadId)) {
        this.earlyQueueOutcomes.set(event.queueId, { threadId: event.threadId, outcome });
      }
    });
  }

  spawnParentTurnId(threadId: string): string | undefined {
    return this.spawnParentTurnIds.get(threadId);
  }

  worktreeSetupSnapshot(threadId: string): WorktreeSetupSnapshot | null {
    return this.worktreeSetup.get(threadId);
  }

  async startThread(requested: SessionStartInput, options?: StartThreadOptions): Promise<Session> {
    let input = this.withThreadIdentity(requested);
    const forkContext = this.store.threadForkContext(input.threadId);
    if (forkContext?.nativeFork && !this.store.threadMeta(input.threadId)?.conversationId) {
      if (input.provider === forkContext.sourceProvider) input = { ...input, forkFrom: forkContext.nativeFork };
      else input = { ...input, forkFrom: undefined };
    }
    if (options?.parentTurnId) this.spawnParentTurnIds.set(input.threadId, options.parentTurnId);
    // Register the thread BEFORE the session starts: the gateway mints the
    // session's MCP token in startSession and the provider connects to it
    // synchronously (alwaysLoad), so threadProjectPath must already resolve
    // or every initialize is 401 and the tools never load.
    this.store.ensureThread({
      threadId: input.threadId,
      projectPath: input.cwd,
      provider: input.provider,
      model: input.model,
    });
    if (input.mode !== undefined || input.effort !== undefined) {
      this.store.setThreadSelection(input.threadId, {
        model: input.model,
        effort: input.effort,
        mode: input.mode,
      });
    }
    // A CLI is a child process, so from here down the cwd has to be a real
    // directory. The thread keeps the project path it was registered under —
    // that is its identity, and the assistant's is a sentinel rather than a
    // place — while the process gets somewhere it can actually run.
    //
    // Resolved here rather than trusted from the caller: the renderer sends a
    // per-project cwd at every call site and has no idea a thread might live in
    // a worktree. One authority for the answer, and a caller that forgot to ask
    // cannot defeat it.
    const place = await this.resolveThreadPlace(input);
    const workingDir = place.dir;
    // The setup card's agent stage starts when the provider is asked, not when
    // it answers, so a slow connection reads as "starting the agent", and a
    // startup failure settles it as failed.
    if (this.worktreeSetup.get(input.threadId)) {
      this.worktreeSetup.stage(input.threadId, { stage: "agent", status: "running" });
    }
    let session: Session;
    try {
      session = await this.service.startSession(
        workingDir === input.cwd ? input : { ...input, cwd: workingDir },
        options?.forWorktreeMove === true ? { forWorktreeMove: true } : undefined,
      );
    } catch (error) {
      // Closes the stepper's last step when one is open. A thread that never
      // asked for a worktree has no stepper and nothing reads this.
      const detail =
        error instanceof Error ? messageOf(error, "Could not start.") : "Could not start.";
      this.reportWorkspaceStep(input, "start", "failed", detail);
      // The setup card's agent stage fails with the session.
      this.worktreeSetup.finish(input.threadId, "failed", detail);
      throw error;
    }
    this.reportWorkspaceStep(input, "start", "done");
    // The card is done only now: the provider session actually came up.
    if (this.worktreeSetup.get(input.threadId)) {
      this.worktreeSetup.finish(input.threadId, "done");
    }
    // The provider conversation exists the moment startSession resolves.
    // Capture its id NOW — durably — rather than waiting for the session.started
    // fold (which also captures it): a crash in the window between the CLI
    // minting the conversation and that event landing would otherwise abandon
    // the provider-side conversation, leaving the thread unable to resume it.
    // No-op when the adapter hasn't named an id yet (some providers only know
    // it after the first turn — their session.started/turn.completed capture
    // path covers that).
    if (session.conversationId) {
      this.store.captureConversationId(input.threadId, session.conversationId);
    }
    // Record where the repo stood as this conversation begins, so its settled
    // diffstat measures only what the conversation changes (no-op if the thread
    // already has a baseline — a resumed session keeps its original one).
    this.captureBaseline(input.threadId, workingDir);
    // A session that adopted the provider's own conversation carries its context
    // with it and needs nothing from us. One that didn't, on a thread that has a
    // transcript, is the crash case: stage the replay for its next turn. Side
    // chat threads are exempt — their imported transcript reaches the model via
    // the one-shot `<sidechat_context>` bootstrap instead, and replaying the
    // digest on top of it would hand the agent the same history twice.
    if (session.resumedFrom) this.threadsNeedingReplay.delete(input.threadId);
    else if (!this.store.threadForkContext(input.threadId) && this.store.hasUserTurn(input.threadId))
      this.threadsNeedingReplay.add(input.threadId);
    // Said outright rather than left for the caller to infer from the cwd: a
    // cwd that differs from the project only suggests a worktree, and the
    // assistant's cwd differs without one.
    if (place.worktreePath) return { ...session, worktreePath: place.worktreePath };
    return session;
  }

  sendThreadTurn(
    input: SendTurnInput,
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult> {
    return this.dispatchTurn(input, "send", options);
  }

  steerThreadTurn(
    input: SendTurnInput,
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult> {
    return this.dispatchTurn(input, "steer", options);
  }

  /** Fork a thread at an earlier user block and start the fork's first turn
   *  from the edited text. The service owns the fork (including the busy
   *  refusal); this owns the session lifecycle around it: start the fork's
   *  session from the source's provider/selection, then send the edited
   *  message silent — the fork already journaled it, so this only dispatches,
   *  and the one-shot bootstrap carries the copied prefix to the model. */
  async forkThreadTurn(input: ForkThreadAtBlockInput): Promise<ForkThreadAtBlockResult> {
    const created = this.service.forkThreadForEdit(input);
    if (created.status === "exists") return created;
    await this.ensureThreadSession(created.threadId, { resume: false });
    await this.sendThreadTurn({ threadId: created.threadId, input: input.editedText }, { silent: true });
    return created;
  }

  /** Manual context compaction for a thread: the service runs the provider's
   *  native call or its `/compact` command fallback and resolves once the
   *  "compacted" boundary has been observed or synthesized. Guarded here on
   *  compactability — an empty thread has no context worth compacting — while
   *  the service guards the live-turn and single-flight races. */
  async compactThread(threadId: string): Promise<CompactThreadResult> {
    const meta = this.store.threadMeta(threadId);
    if (!meta) {
      throw new Error(`Unknown thread ${threadId}`);
    }
    if (!this.store.hasUserTurn(threadId)) {
      throw new Error("Context compaction requires an existing conversation.");
    }
    // Compaction runs on the live provider session. A thread whose session
    // went away (fresh launch, idle reap, opened where it never started)
    // adopts one first — resuming its own conversation — rather than
    // refusing work the user explicitly asked for. The preamble runs inside
    // the service's single-flight claim, so two concurrent compactions can't
    // each start a session and orphan the first.
    return this.service.compactThread(threadId, async () => {
      await this.ensureThreadSession(threadId, { resume: true });
    });
  }

  /** A contractor's session wakes as the contractor on every start — first,
   *  resumed, reopened by the user — not only when the spawn engine starts it:
   *  its identity lives on its thread, not the roster, so no caller outside
   *  the engine would think to send it. A guest likewise wakes knowing the
   *  call sign other agents address it by. A thread bound to a teammate is
   *  left to its caller, which sends the teammate's persona. An explicit
   *  persona always wins. */
  private withThreadIdentity(input: SessionStartInput): SessionStartInput {
    if (input.agent) return input;
    const contract = this.store.threadMeta(input.threadId)?.contract;
    if (contract) return { ...input, agent: contractPersona(contract) };
    if (this.store.getThreadAgent(input.threadId)?.agentId) return input;
    return { ...input, agent: { name: threadAgentName(this.store, input.threadId), guest: true } };
  }

  async ensureThreadSession(
    threadId: string,
    options: { resume: boolean; forWorktreeMove?: boolean },
  ): Promise<void> {
    if (this.service.hasLiveSession(threadId)) return;
    const meta = this.store.threadMeta(threadId);
    if (!meta) throw new Error(`Unknown thread ${threadId}`);
    // A fresh process has no live sessions: adopt the thread's own session
    // first, resuming its provider conversation when asked. When the provider
    // honors the resume the continuation lands in full context; when it comes
    // up blank the dispatcher replays the transcript digest in front of it
    // instead of asking a blank agent to "continue".
    const start: SessionStartInput = {
      threadId,
      provider: meta.provider,
      cwd: meta.projectPath,
    };
    if (meta.model) start.model = meta.model;
    if (options.resume) {
      if (meta.conversationId) start.resume = meta.conversationId;
      if (meta.resumeSessionAt) start.resumeSessionAt = meta.resumeSessionAt;
    }
    // A native fork's first start asks the provider to fork the source
    // conversation rather than resuming or starting fresh. Once the fork has
    // its own conversation id, later starts resume it as usual.
    const forkContext = this.store.threadForkContext(threadId);
    if (forkContext?.nativeFork && !meta.conversationId) {
      start.forkFrom = forkContext.nativeFork;
    }
    if (meta.selection?.mode) start.mode = meta.selection.mode;
    if (meta.selection?.effort) start.effort = meta.selection.effort;
    await this.startThread(start, options.forWorktreeMove ? { forWorktreeMove: true } : undefined);
  }

  /** Move a local thread into a worktree of its own. */
  async moveThreadToWorktree(
    threadId: string,
    options?: { branch?: string },
  ): Promise<MoveThreadToWorktreeResult> {
    const meta = this.store.threadMeta(threadId);
    if (!meta) return { ok: false, reason: "unknown" };
    // One move at a time per thread: a repeated request joins the one in
    // flight rather than racing it, so two calls can never build two worktrees
    // or publish two bindings. Once it settles, answer from what the thread
    // actually is — a genuine repeat is then an idempotent success, and a
    // failed move runs the real path again instead of reading a stored path as
    // completion.
    const joined = this.worktreeMoves.get(threadId);
    if (joined) await joined.catch(() => undefined);
    const recorded = this.store.threadWorkspace(threadId);
    if (recorded && threadWorkspaceState(recorded) === "worktree-ready" && recorded.worktreePath) {
      return { ok: true, worktreePath: recorded.worktreePath };
    }
    const move = this.runMoveThreadToWorktree(threadId, options);
    this.worktreeMoves.set(threadId, move);
    try {
      return await move;
    } finally {
      if (this.worktreeMoves.get(threadId) === move) this.worktreeMoves.delete(threadId);
    }
  }

  /** Publish a completed move: the thread's workspace becomes worktree-ready
   *  at the built path. Only called after the old session's stop is confirmed,
   *  so the binding never reads as moved before the move has really moved. */
  private publishThreadWorkspace(threadId: string, built: BuiltThreadWorktree): void {
    this.store.setThreadWorkspace(threadId, { worktreePath: built.path, requestedBranch: null });
  }

  /** The body of a move, after the repeat-join above. */
  private async runMoveThreadToWorktree(
    threadId: string,
    options?: { branch?: string },
  ): Promise<MoveThreadToWorktreeResult> {
    const meta = this.store.threadMeta(threadId);
    if (!meta) return { ok: false, reason: "unknown" };
    // A session cannot change directory mid-turn, and a half-built worktree
    // under a running turn would be worse than a refusal.
    const reservation = this.service.holdThreadForWorktreeMove(threadId, meta.provider);
    if (reservation.reason) return { ok: false, reason: reservation.reason };

    const previousWorkspace = this.store.threadWorkspace(threadId);
    const input: SessionStartInput = {
      threadId,
      provider: meta.provider,
      cwd: meta.projectPath,
    };
    if (meta.model) input.model = meta.model;
    const restorePreviousBinding = (): void => this.store.setThreadWorkspace(threadId, {
      envMode: previousWorkspace?.envMode ?? "local",
      worktreePath: previousWorkspace?.worktreePath ?? null,
      requestedBranch: previousWorkspace?.requestedBranch ?? null,
    });
    let built: BuiltThreadWorktree | null = null;
    let published = false;
    // A refusal after the build must not orphan the worktree. A worktree this
    // build created is given back; one it only adopted (a branch that already
    // had a worktree) is left in place — its history is not ours to discard,
    // and a retry re-adopts it by branch. A branch kone named goes with the
    // worktree it created; a branch the user named is kept.
    const giveBack = async (candidate: BuiltThreadWorktree, detail: string): Promise<void> => {
      if (!candidate.attachedExisting) {
        await this.discardWorkspace(meta.projectPath, candidate.path, {
          branch: candidate.branch,
          reclaimGeneratedBranch: candidate.generatedBranch,
        });
      }
      this.worktreeSetup.finish(threadId, "failed", detail);
    };
    try {
      // Built without publishing the binding: the destination must not read as
      // the thread's workspace until the stop is confirmed and the session is
      // being rebound to it.
      const candidate = await this.buildThreadWorktree(
        input,
        { branch: options?.branch },
        { publishBinding: false },
      );
      built = candidate;
      // The reservation queues new sends; recheck the turn, restore and other
      // ownership after provisioning, because a restore may have started, or
      // an asynchronous owner the busy read misses may have been admitted,
      // while git built.
      if (this.service.isRestoreHoldingThread(threadId) || this.service.isDirRestoreHeld(candidate.path)) {
        await giveBack(candidate, "A checkpoint restore started while the worktree was being prepared.");
        return { ok: false, reason: "restoring" };
      }
      if (this.service.isThreadMoveBlocked(threadId)) {
        await giveBack(candidate, "The thread was still owned when the worktree was ready.");
        return { ok: false, reason: "busy" };
      }
      // The old session was started in the project checkout. Stop it and start
      // a fresh one in the worktree, resuming the provider conversation so the
      // move keeps its context. The stop comes before the binding is published.
      if (this.service.hasLiveSession(threadId)) {
        const stopped = await this.service.stopThread(threadId, { preserveQueue: true });
        if (!stopped.confirmedStopped) {
          await giveBack(candidate, "The previous session could not be stopped.");
          return { ok: false, reason: "stop-unconfirmed", detail: stopped.detail };
        }
        // A restore may have claimed the destination while the old session was
        // stopping: refuse before publishing, so a restore never finds the
        // thread pointing at a directory it is rewriting.
        if (this.service.isDirRestoreHeld(candidate.path)) {
          await giveBack(candidate, "A checkpoint restore started in the new worktree.");
          return { ok: false, reason: "restoring" };
        }
      }
      this.publishThreadWorkspace(threadId, candidate);
      published = true;
      // The replacement start is the one start the reservation admits.
      await this.ensureThreadSession(threadId, { resume: true, forWorktreeMove: true });
      return { ok: true, worktreePath: candidate.path };
    } catch (error) {
      // A failure after the binding was published — the replacement session
      // refused to start — must put it back, then reclaim the worktree, so a
      // stored path alone is never mistaken for a completed move.
      if (published) restorePreviousBinding();
      if (built) await giveBack(built, "The session could not be restarted in the worktree.");
      const normalised = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        reason: "failed",
        detail: messageOf(normalised, "Could not move the thread into a worktree."),
      };
    } finally {
      reservation.release();
    }
  }

  readQuitResumeSnapshot(threadId: string): QuitResumeThreadSnapshot {
    const meta = this.store.threadMeta(threadId);
    if (!meta) return { threadId, missing: true, archived: false, busy: false, turns: [] };
    const thread = this.store.loadThread(threadId);
    const turns: QuitResumeAssistantTurn[] = [];
    if (thread) {
      for (const block of thread.blocks) {
        if (block.role !== "assistant") continue;
        // A message steered into a turn splits its reply into pieces; the
        // turn is one turn, and its last piece carries how it ended.
        const earlier = block.continues ? turns.find((t) => t.turnId === block.turnId) : undefined;
        if (earlier) {
          earlier.state = block.state;
          earlier.endedAt = block.endedAt ?? null;
          continue;
        }
        turns.push({
          turnId: block.turnId,
          state: block.state,
          at: block.at,
          endedAt: block.endedAt ?? null,
        });
      }
    }
    return {
      threadId,
      missing: false,
      archived: (meta.archivedAt ?? null) !== null,
      done: (meta.doneAt ?? 0) > 0,
      busy: this.service.isThreadBusy(threadId),
      turns,
    };
  }

  async dispatchQuitResumeTurn(threadId: string, prompt: string): Promise<void> {
    await this.ensureThreadSession(threadId, { resume: true });
    // Silent: this prompt is the app's own voice, not something the user said
    // — journaling it would put words in their mouth.
    const result = await this.sendThreadTurn(
      { threadId, input: prompt },
      { silent: true, generateTitle: false, noQueue: true },
    );
    if (result.held || result.queued) throw new ThreadTurnHeldError(threadId);
  }

  async resumeLimitedThread(threadId: string): Promise<void> {
    await this.ensureThreadSession(threadId, { resume: true });
    const result = await this.sendThreadTurn(
      { threadId, input: LIMIT_RESUME_PROMPT },
      { silent: true, generateTitle: false, noQueue: true },
    );
    if (result.held || result.queued) throw new ThreadTurnHeldError(threadId);
  }

  async resumeQuitInterruptedChatsAtBoot(): Promise<{
    resumed: string[];
    skipped: QuitResumeSkipped[];
  }> {
    const claimed = claimQuitResumeRecordAtStartup();
    const skipped: QuitResumeSkipped[] = [];
    if (claimed.kind === "record") {
      // The record-level plan is the one place the "did this thread move on"
      // rules live. Turn its survivors into durable continuations before
      // dispatching any: a boot that dies between here and a dispatch leaves
      // rows behind, and the next boot's sweep recovers them instead of
      // losing the resume.
      const plan = planQuitResumeTurns({
        record: claimed.record,
        snapshots: claimed.record.threads.map((entry) =>
          this.readQuitResumeSnapshot(entry.threadId),
        ),
      });
      skipped.push(...plan.skipped);
      for (const threadId of plan.threadIds) {
        const created = this.store.scheduleContinuation({
          threadId,
          kind: QUIT_RESUME_CONTINUATION_KIND,
          dueAt: claimed.record.recordedAt,
          payloadJson: JSON.stringify({
            prompt: claimed.record.continuationPrompt,
            recordedAt: claimed.record.recordedAt,
          }),
        });
        if (created === null) {
          console.warn(`[agent] could not schedule the quit-resume continuation for ${threadId}`);
        }
      }
    }
    try {
      // No dispatcher is live yet on a fresh process: any claim belongs to a
      // boot that died before settling it, so release them all to become due.
      this.store.releaseOrphanedContinuationClaims();
      const result = await this.dispatchDueContinuations();
      const allSkipped = [...skipped, ...result.skipped];
      if (result.resumed.length > 0) {
        console.info(
          `[agent] resumed ${result.resumed.length} chat(s) interrupted by the previous quit`,
        );
      }
      if (allSkipped.length > 0) {
        console.info("[agent] quit-resume skipped threads that moved on:", allSkipped);
      }
      return { resumed: result.resumed, skipped: allSkipped };
    } catch (err) {
      console.warn("[agent] quit-resume failed — continuing boot without it:", err);
      return { resumed: [], skipped };
    }
  }

  /** Stage one restart-background note per thread whose live background work
   *  the boot seal cancelled. Best-effort: a store that cannot be read leaves
   *  the threads without a note, exactly as before this existed. */
  recoverRestartBackgroundNotesAtBoot(): void {
    try {
      for (const [threadId, work] of this.store.takeRestartCancelledBackgroundWork()) {
        // An empty list still stages: the note carries the "shells and monitors
        // cannot be listed" line for an interrupted session with none of the
        // enumerable kinds.
        this.stageRestartBackgroundNote(threadId, work);
      }
    } catch (err) {
      console.warn("[agent] restart background work could not be read at boot:", err);
    }
  }

  /** Stage one thread's restart-background note: it rides the thread's next
   *  turn and is consumed when a provider accepts it. */
  stageRestartBackgroundNote(threadId: string, work: RestartCancelledBackgroundWork[]): void {
    this.threadsNeedingRestartNote.set(threadId, work);
  }

  /** Whether a thread is snoozed right now, from the snooze and the wake-early
   *  rules, for the renderer's thread payload. */
  threadSnoozeState(threadId: string): ThreadSnoozeState {
    const meta = this.store.threadMeta(threadId);
    if (!meta) return { snoozed: false, snoozedUntil: null };
    const snapshot = this.readQuitResumeSnapshot(threadId);
    const latestTurn = snapshot.turns.at(-1) ?? null;
    const parked = this.service.pendingInteractions().some((ask) => ask.threadId === threadId);
    const snoozed = isSnoozed(
      {
        snoozedUntil: meta.snoozedUntil ?? null,
        snoozedAt: meta.snoozedAt ?? null,
        parked,
        latest:
          latestTurn === null
            ? null
            : {
                state: latestTurn.state,
                at: latestTurn.endedAt ?? latestTurn.at,
                limit: (meta.limitedAt ?? null) !== null,
              },
      },
      Date.now(),
    );
    return { snoozed, snoozedUntil: meta.snoozedUntil ?? null };
  }

  /** Dispatch every continuation due now, then arm a timer for the next one.
   *  Each row is re-checked against the thread's current state before dispatch;
   *  a stale one is cancelled rather than resumed. Claims a dead boot left are
   *  released by the boot caller, not here — a timer sweep must not free an
   *  in-flight sweep's claims. */
  async dispatchDueContinuations(): Promise<{
    resumed: string[];
    skipped: QuitResumeSkipped[];
  }> {
    const resumed: string[] = [];
    const skipped: QuitResumeSkipped[] = [];
    const now = Date.now();
    this.pruneContinuationDeferrals();
    let due: ContinuationRecord[];
    try {
      due = this.store.claimDueContinuations(
        now,
        [...this.continuationDeferrals]
          .filter(([, entry]) => entry.state.retryAt > now)
          .map(([continuationId]) => continuationId),
      );
    } catch (err) {
      console.warn("[agent] continuation sweep failed:", err);
      return { resumed, skipped };
    }
    for (const row of due) {
      // A checkpoint restore or a workspace handoff owns this thread: a
      // continuation due meanwhile is held, not enqueued and then cancelled
      // with the rest of the queue. The claim is cleared, no attempt is
      // burned, and it runs once the hold lets go.
      if (this.service.isRestoreHoldingThread(row.threadId) || this.service.isThreadMoveHeld(row.threadId)) {
        this.store.clearContinuationClaim(row.continuationId);
        this.deferContinuation(row);
        continue;
      }
      const decision = this.continuationDecision(row);
      if ("cancel" in decision) {
        this.store.deleteContinuation(row.continuationId);
        this.continuationDeferrals.delete(row.continuationId);
        skipped.push({ threadId: row.threadId, reason: decision.cancel });
        continue;
      }
      try {
        await this.ensureThreadSession(row.threadId, { resume: true });
        // The wait above is where a settle, archive or user turn can land.
        // Re-read the row (a cancellation deletes it) and re-run the skip rules
        // immediately before the send, so a cancelled or now-ineligible
        // continuation never reaches the provider.
        if (this.store.getContinuation(row.continuationId) === null) {
          this.continuationDeferrals.delete(row.continuationId);
          skipped.push({ threadId: row.threadId, reason: "cancelled" });
          continue;
        }
        const recheck = this.continuationDecision(row);
        if ("cancel" in recheck) {
          this.store.deleteContinuation(row.continuationId);
          this.continuationDeferrals.delete(row.continuationId);
          skipped.push({ threadId: row.threadId, reason: recheck.cancel });
          continue;
        }
        const delivery = await this.sendThreadTurn(
          { threadId: row.threadId, input: recheck.prompt },
          { silent: true, generateTitle: false, continuationId: row.continuationId, noQueue: true },
        );
        if (delivery.queued || delivery.held) {
          this.store.clearContinuationClaim(row.continuationId);
          this.deferContinuation(row);
          continue;
        }
        this.store.deleteContinuation(row.continuationId);
        this.continuationDeferrals.delete(row.continuationId);
        resumed.push(row.threadId);
      } catch (err) {
        // Session adoption can race a restore or a move that begins after the
        // preflight check. Its admission refusal is still a hold, not a failed
        // attempt.
        if (this.service.isRestoreHoldingThread(row.threadId) || this.service.isThreadMoveHeld(row.threadId)) {
          this.store.clearContinuationClaim(row.continuationId);
          this.deferContinuation(row);
          continue;
        }
        if (err instanceof ContinuationCancelled || err instanceof StartCancelled) {
          // Cancelled after the claim (settled, archived, superseded) or the
          // session was stopped during adoption: the row is done, not retried.
          this.store.deleteContinuation(row.continuationId);
          this.continuationDeferrals.delete(row.continuationId);
          skipped.push({ threadId: row.threadId, reason: "cancelled" });
          continue;
        }
        this.continuationDeferrals.delete(row.continuationId);
        console.warn(`[agent] continuation for thread ${row.threadId} could not be dispatched:`, err);
        // Back off and retry, but do not spin: each failure pushes the due time
        // out, and after a cap the row is dropped with a log.
        const attempts = this.store.failContinuation(
          row.continuationId,
          Date.now() + CONTINUATION_RETRY_BACKOFF_MS,
        );
        if (attempts >= MAX_CONTINUATION_ATTEMPTS) {
          this.store.deleteContinuation(row.continuationId);
          console.warn(
            `[agent] dropping continuation ${row.continuationId} for ${row.threadId} after ${attempts} failed attempts`,
          );
        }
        skipped.push({ threadId: row.threadId, reason: "dispatch-failed" });
      }
    }
    this.armContinuationTimer();
    return { resumed, skipped };
  }

  /** Whether a claimed continuation still applies, and what to send. The
   *  quit-resume staleness rules are the single source of truth: gone,
   *  archived, settled, busy, or a turn in flight, or one that completed after
   *  the continuation was recorded. */
  private continuationDecision(
    row: ContinuationRecord,
  ): { cancel: QuitResumeSkipReason } | { prompt: string } {
    if (row.kind === LIMIT_RESUME_CONTINUATION_KIND) {
      const meta = this.store.threadMeta(row.threadId);
      if (!meta) return { cancel: "thread-missing" };
      if ((meta.archivedAt ?? null) !== null) return { cancel: "thread-archived" };
      if ((meta.doneAt ?? 0) > 0) return { cancel: "thread-settled" };
      // New work (or a manual resume) already cleared the limit: the scheduled
      // resume is stale.
      if ((meta.limitedAt ?? null) === null) return { cancel: "limit-cleared" };
      // Read fresh: the toggle can be switched off while the resume waits out
      // a long reset.
      if (!resumeAtResetFor(meta.provider)) return { cancel: "resume-off" };
      return { prompt: LIMIT_RESUME_PROMPT };
    }
    const payload = parseContinuationPayload(row.payloadJson);
    const reason = quitResumeSkipReason(
      this.readQuitResumeSnapshot(row.threadId),
      payload?.recordedAt ?? row.createdAt,
    );
    if (reason !== null) return { cancel: reason };
    return { prompt: payload?.prompt ?? DEFAULT_QUIT_RESUME_PROMPT };
  }

  /** Schedule the sweep for the next future continuation. One timer, no
   *  polling: a sweep re-arms it, and nothing is armed when nothing is due. */
  private deferContinuation(row: ContinuationRecord): void {
    const now = Date.now();
    const update = nextContinuationDeferral(
      this.continuationDeferrals.get(row.continuationId)?.state,
      now,
    );
    this.continuationDeferrals.set(row.continuationId, {
      threadId: row.threadId,
      state: update.deferral,
    });
    if (update.shouldWarn) {
      console.warn(
        `[agent] continuation for ${row.threadId} has been held by a restore or a worktree move for more than five minutes; keeping it scheduled`,
      );
    }
  }

  /** Drop in-memory retry state after its durable continuation was cancelled. */
  private pruneContinuationDeferrals(): void {
    for (const continuationId of this.continuationDeferrals.keys()) {
      if (this.store.getContinuation(continuationId) === null) {
        this.continuationDeferrals.delete(continuationId);
      }
    }
  }

  private armContinuationTimer(): void {
    this.pruneContinuationDeferrals();
    if (this.continuationTimer) {
      clearTimeout(this.continuationTimer);
      this.continuationTimer = null;
    }
    let next: number | null;
    try {
      const now = Date.now();
      next = this.store.nextContinuationDueAt(
        [...this.continuationDeferrals]
          .filter(([, entry]) => entry.state.retryAt > now)
          .map(([continuationId]) => continuationId),
      );
    } catch (err) {
      console.warn("[agent] could not read the next continuation due time:", err);
      return;
    }
    for (const { state } of this.continuationDeferrals.values()) {
      if (state.retryAt <= Date.now()) continue;
      next = next === null ? state.retryAt : Math.min(next, state.retryAt);
    }
    if (next === null) return;
    const delay = Math.max(0, next - Date.now());
    const timer = setTimeout(() => {
      this.continuationTimer = null;
      void this.dispatchDueContinuations();
    }, delay);
    timer.unref?.();
    this.continuationTimer = timer;
  }

  /** The shared body of sendThreadTurn and steerThreadTurn. A steer is the same
   *  dispatch with a different destination: the user typed a message, so it is
   *  journaled and can name a thread exactly like a send, and only the service
   *  call at the end differs. Routing steers around this — straight to
   *  AgentService — left them out of the transcript entirely, and left the
   *  durable queue deriving every steer row's userBlockId from the PREVIOUS
   *  send's block, so a second steer collided with the first on the
   *  (thread_id, user_block_id) index and was dropped as a replay. */
  private dispatchTurn(
    requested: SendTurnInput,
    destination: "send" | "steer",
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult> {
    const prior = this.dispatchTails.get(requested.threadId);
    // Fast path: a turn with no skills to resolve and nothing ahead of it on
    // its thread journals in the same tick it was called, which the service's
    // busy check relies on to queue a second send behind the first.
    if (!requested.skills?.length && !prior) {
      const { skills: _none, ...plain } = requested;
      return this.dispatchResolvedTurn(plain, destination, options);
    }
    // Otherwise the turn joins its thread's tail: it waits for every earlier
    // turn to finish journaling before resolving its own skills and journaling
    // itself. Skill resolution reads asynchronously, so a skill-bearing send
    // followed at once by a plain one would otherwise journal second-first.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior ? prior.then(() => gate) : gate;
    this.dispatchTails.set(requested.threadId, tail);
    const settle = (): void => {
      release();
      if (this.dispatchTails.get(requested.threadId) === tail) {
        this.dispatchTails.delete(requested.threadId);
      }
    };
    return (async (): Promise<TurnStartResult> => {
      await prior;
      let resolved: SendTurnInput;
      try {
        if (requested.skills?.length) {
          resolved = await this.withResolvedSkills(requested);
        } else {
          const { skills: _none, ...plain } = requested;
          resolved = plain;
        }
      } catch (error) {
        settle();
        throw error;
      }
      let started: Promise<TurnStartResult>;
      try {
        started = this.dispatchResolvedTurn(resolved, destination, options);
      } catch (error) {
        settle();
        throw error;
      }
      // Journaled, and the service is holding its busy marker: later turns may go.
      settle();
      return started;
    })();
  }

  /** Resolve the skills a turn invokes against what the thread's provider can
   *  run in the thread's working directory, before anything is journaled — a
   *  skill that is gone or disabled rejects the send instead of reaching the
   *  transcript and then doing nothing. The resolved references carry the
   *  listed copy's own name and path, which is what gets journaled, queued and
   *  delivered. */
  private async withResolvedSkills(input: SendTurnInput): Promise<SendTurnInput> {
    const provider = this.store.threadMeta(input.threadId)?.provider;
    const first = input.skills?.[0]?.name ?? "unknown";
    if (!provider) throw new SkillUnavailableError(first, "the thread has no provider to run it.");
    // Project skills resolve against the directory the thread runs in. Null —
    // no project path yet, or a worktree that does not exist — leaves only
    // user-scope skills resolvable.
    const projectPath = this.store.threadProjectPath(input.threadId);
    const dir = projectPath ? this.threadWorkingDir(input.threadId, projectPath, "project") : null;
    const skills = await resolveSkillReferences(provider, dir, input.skills);
    return { ...input, skills };
  }

  private dispatchResolvedTurn(
    requested: SendTurnInput,
    destination: "send" | "steer",
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult> {
    // An agent-sent turn is announced to renderers by block id, so the id has
    // to exist before the journal write rather than be minted inside it.
    const named =
      requested.sender && requested.sender.kind !== "user" && !requested.userBlockId && !options?.silent
        ? { ...requested, userBlockId: randomUUID() }
        : requested;
    if (options?.parentTurnId) this.spawnParentTurnIds.set(named.threadId, options.parentTurnId);
    // A real turn is new work: anything scheduled to resume this thread on its
    // own is now stale. A silent turn is the app's own continuation and must
    // not cancel itself.
    if (!options?.silent) {
      try {
        this.store.cancelContinuationsForThread(named.threadId);
      } catch (err) {
        console.warn(`[agent] could not cancel continuations for ${named.threadId}:`, err);
      }
    }
    // The replay and the restart note are read before anything below is
    // journaled, so both end at the last thing the agent actually saw/ran. The
    // restart note is only *peeked* here: it is consumed when the provider
    // accepts the turn, so a refused send leaves it for the retry.
    const carrierToken = randomUUID();
    const replay = this.takeReplay(named.threadId);
    const restartNote = this.peekRestartNotePreamble(named.threadId, carrierToken);
    const preamble = [replay, restartNote]
      .filter((part): part is string => Boolean(part))
      .join("\n\n") || null;
    // What waits in the inbox is carried by the service's turn slot, not
    // here: a send that ends up queued would otherwise settle it before the
    // turn that carries it has run.
    let accepted = false;
    const onAccepted = (turnId: string): void => {
      if (accepted) return;
      accepted = true;
      // The provider took the turn, so the note it carried is delivered.
      this.consumeRestartNotePreamble(named.threadId, carrierToken);
      options?.onAccepted?.(turnId);
    };
    let started: Promise<TurnStartResult>;
    try {
      started = this.dispatchComposed(named, destination, preamble, { ...options, onAccepted });
    } catch (err) {
      // The composed turn never reached the service: release the note so the
      // next send carries it.
      this.releaseRestartNotePreamble(named.threadId, carrierToken);
      throw err;
    }
    return (async (): Promise<TurnStartResult> => {
      try {
        const result = await started;
        if (!result.queued && !result.held) {
          onAccepted(result.turnId);
        } else if (result.held) {
          // A restore/compaction/busy refusal owns nothing: leave recovery
          // context staged for the next attempt and free this note reservation.
          if (replay !== null) this.threadsNeedingReplay.add(named.threadId);
          this.releaseRestartNotePreamble(named.threadId, carrierToken);
        } else if (restartNote !== null) {
          // The row may already be gone: cancelled or promoted while the
          // service was still acknowledging it.
          const early = this.earlyQueueOutcomes.get(result.turnId);
          if (early) {
            this.earlyQueueOutcomes.delete(result.turnId);
            this.settleQueuedCarrier(named.threadId, carrierToken, early.outcome);
          } else {
            this.queuedCarrierNotes.set(result.turnId, {
              threadId: named.threadId,
              carrierToken,
            });
          }
        }
        return result;
      } catch (err) {
        // A refused send leaves the note for the retry.
        if (replay !== null) this.threadsNeedingReplay.add(named.threadId);
        this.releaseRestartNotePreamble(named.threadId, carrierToken);
        throw err;
      }
    })();
  }

  /** Journal a turn whose preamble is settled, and hand it to the service. */
  private dispatchComposed(
    input: SendTurnInput,
    destination: "send" | "steer",
    preamble: string | null,
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult> {
    if (options?.continuationId !== undefined) {
      // The row may have been cancelled while this turn waited on its thread's
      // dispatch tail. Re-check at the actual handoff: a gone row, or a thread
      // that has become busy with real work, drops the continuation silently.
      if (
        this.store.getContinuation(options.continuationId) === null ||
        this.service.isThreadBusy(input.threadId)
      ) {
        return Promise.reject(new ContinuationCancelled(input.threadId));
      }
    }
    const delivery = composeTurnDelivery({
      message: input.input,
      preamble,
      sender: input.sender,
      silent: options?.silent,
    });
    // Persist the user prompt (with any attachment metadata) before dispatching,
    // so it precedes the turn in arrival order (turn.started lands after this).
    // Named here rather than inside the write, so a send the service refuses
    // can take back the block it journaled.
    const journaledId = input.userBlockId ?? randomUUID();
    const userTurnCount =
      delivery.journal === null
        ? 0
        : this.store.recordUserBlock({
            blockId: journaledId,
            threadId: input.threadId,
            text: delivery.journal,
            attachments: input.attachments,
            skills: input.skills,
            sender: input.sender,
            effort: input.effort,
            model: input.model,
          });
    if (delivery.journal !== null && input.sender && input.sender.kind !== "user") {
      this.announceJournaled(input.threadId, input.userBlockId, delivery.journal, input.sender);
    }
    if (
      input.mode !== undefined ||
      input.model !== undefined ||
      input.effort !== undefined ||
      input.serviceTier !== undefined ||
      input.contextWindow !== undefined
    ) {
      this.store.setThreadSelection(input.threadId, {
        model: input.model,
        effort: input.effort,
        serviceTier: input.serviceTier,
        contextWindow: input.contextWindow,
        mode: input.mode,
      });
    }
    // First user turn → name the thread (fallback now, generated rename async).
    if (userTurnCount === 1) {
      const meta = this.store.threadMeta(input.threadId);
      const provider = meta?.provider;
      if (provider) {
        // The branch is named from whatever title the thread settles on. By
        // now the worktree already exists: startThread builds it before the
        // session starts, and this is a send on that session. A thread whose
        // worktree is not recorded yet has its rename skipped, not deferred.
        void this.maybeNameThread(
          {
            threadId: input.threadId,
            provider,
            model: input.model ?? meta?.model,
            // A skill- or attachment-only first turn has no prompt text — name
            // the thread after the skill or the first attached file instead of
            // leaving it blank.
            message: turnLabel(input),
          },
          options,
        ).then((title) => this.nameWorkspaceBranch(input.threadId, title));
      }
    }
    // The sender has done its work once it is journaled and rendered into the
    // text; the service below only ever sees the words the provider is sent.
    const { sender: _sender, ...forService } = input;
    const dispatched =
      delivery.dispatch === input.input ? forService : { ...forService, input: delivery.dispatch };
    const handOff: TurnSendOptions = {};
    if (options?.onAccepted) handOff.onAccepted = options.onAccepted;
    if (options?.onSending) handOff.onSending = options.onSending;
    if (options?.liveOnly) handOff.liveOnly = true;
    if (options?.noQueue) handOff.noQueue = true;
    const sent =
      destination === "steer"
        ? this.service.steerTurn(dispatched, handOff)
        : this.service.sendTurn(dispatched, handOff);
    if (userTurnCount === 0) return sent;
    // A refused send never reached anything that will answer it: its block
    // goes, as the renderer's own copy does, so a reload doesn't show the
    // words as sent and waiting on a reply.
    return (async (): Promise<TurnStartResult> => {
      try {
        return await sent;
      } catch (error) {
        if (error instanceof StartCancelled) {
          // The session start was cancelled (an interrupt or stop while it was
          // connecting). The prompt is not lost: keep its block so a retry
          // reads above it, and rethrow as cancelled rather than failed.
          throw error;
        }
        if (this.store.discardUnsentUserBlock(input.threadId, journaledId)) {
          this.announceUnjournaled(input.threadId, journaledId);
        }
        throw error;
      }
    })();
  }

  queueNotice(threadId: string, text: string, options?: { rings?: boolean }): string {
    return this.mailbox().sendNotice({
      to: threadId,
      projectPath: this.store.threadProjectPath(threadId) ?? "",
      message: text,
      rings: options?.rings ?? false,
    }).messageId;
  }

  private mailbox(): IrcMailbox {
    return this.mailboxDep ?? getIrcMailbox();
  }

  recordAgentMessage(input: {
    threadId: string;
    text: string;
    sender: MessageSender;
    beforeBlockId?: string;
    inboxId?: string;
  }): string | null {
    // A message's block is named after it. The block and the inbox row's link
    // to it are two writes, so a crash between them leaves the block unlinked;
    // the retry finds it under the same name instead of writing a second.
    const blockId = input.inboxId ? inboxBlockId(input.inboxId) : randomUUID();
    if (input.inboxId && this.store.userBlockSender(input.threadId, blockId)) return blockId;
    const count = this.store.recordUserBlock({
      blockId,
      threadId: input.threadId,
      text: input.text,
      sender: input.sender,
    });
    if (count === 0) return null;
    this.announceJournaled(input.threadId, blockId, input.text, input.sender, input.beforeBlockId);
    return blockId;
  }

  noteSpawnParentTurn(threadId: string, parentTurnId: string): void {
    this.spawnParentTurnIds.set(threadId, parentTurnId);
  }

  /** Tell renderers a block kone wrote for someone else is on the transcript. */
  private announceJournaled(
    threadId: string,
    blockId: string | undefined,
    text: string,
    sender: MessageSender,
    beforeBlockId?: string,
  ): void {
    const provider = this.store.threadMeta(threadId)?.provider;
    if (!provider) return;
    const at = Date.now();
    const event: Extract<RuntimeEvent, { type: "thread.message-journaled" }> = {
      type: "thread.message-journaled",
      threadId,
      provider,
      at,
      source: "kone.store",
      block: { id: blockId ?? randomUUID(), role: "user", text, at, sender },
    };
    if (beforeBlockId) event.beforeBlockId = beforeBlockId;
    this.broadcast(event, false);
  }

  /** Tell renderers a block they may be showing is off the transcript again.
   *  An agent's message was announced when it was journaled, so a view has it
   *  on screen with nothing coming to take it down otherwise. */
  private announceUnjournaled(threadId: string, blockId: string): void {
    const provider = this.store.threadMeta(threadId)?.provider;
    if (!provider) return;
    this.broadcast(
      {
        type: "thread.message-unjournaled",
        threadId,
        provider,
        at: Date.now(),
        source: "kone.store",
        blockId,
      },
      false,
    );
  }

  onTurnCompleted(threadId: string): void {
    // When a turn settles, snapshot the repo state it left behind (branch +
    // working-tree diffstat) onto the thread, so the Project Home "recent
    // conversations" block reads real numbers. Off the hot path and best-effort
    // — a git failure never disturbs the live stream.
    this.captureRepoStats(threadId);
  }

  forgetThread(threadId: string): void {
    this.threadsNeedingReplay.delete(threadId);
    this.spawnParentTurnIds.delete(threadId);
    this.dispatchTails.delete(threadId);
    this.cancelledWorkspaces.delete(threadId);
    this.worktreeSetup.forget(threadId);
    this.worktreeSetupProviders.delete(threadId);
  }

  /** Persist a title and notify renderers. No-ops when the title is unchanged. */
  private publishTitle(input: {
    threadId: string;
    provider: ProviderKind;
    title: string;
  }): void {
    const current = this.store.getTitle(input.threadId);
    if (current === input.title) return;
    this.store.setTitle(input.threadId, input.title);
    this.broadcast(
      {
        type: "thread.title.updated",
        threadId: input.threadId,
        provider: input.provider,
        at: Date.now(),
        source: "kone.store",
        title: input.title,
      },
      false,
    );
  }

  /** First-turn naming: set a word-cap fallback immediately, then ask the
   *  thread's own provider (Codex or Claude) for a
   *  compact generated title in the background. Generation failures leave the
   *  fallback in place; a title the user (or a later rename) already moved off
   *  the seed is never clobbered. An explicit `options.title` replaces the
   *  fallback AND skips generation — it is a deliberate choice, so nothing
   *  races it. `options.generateTitle: false` keeps the fallback but skips the
   *  background round trip.
   *
   *  Resolves to the title the thread settled on, which the caller uses to
   *  name the worktree's branch — the placeholder a worktree is built on
   *  means nothing to anyone reading the branch list. Never rejects. */
  private async maybeNameThread(
    input: { threadId: string; provider: ProviderKind; model?: string; message: string },
    options?: StartThreadTurnOptions,
  ): Promise<string> {
    if (options?.title) {
      this.publishTitle({
        threadId: input.threadId,
        provider: input.provider,
        title: options.title,
      });
      return options.title;
    }
    const fallback = buildPromptThreadTitleFallback(input.message);
    this.publishTitle({
      threadId: input.threadId,
      provider: input.provider,
      title: fallback,
    });
    if (options?.generateTitle === false) return fallback;

    const projectPath = this.store.threadProjectPath(input.threadId);
    if (!projectPath) return fallback;

    // An unknown or unreadable workspace skips naming rather than falling back
    // to the shared checkout: the one-shot must run where the thread runs.
    let namingDir: string | null = null;
    try {
      const workspace = this.store.threadWorkspace(input.threadId);
      if (!workspace) return fallback;
      namingDir = threadWorkingDir({ projectPath, ...workspace });
    } catch {
      return fallback;
    }
    // A thread whose worktree is not built yet has nowhere to run the one-shot.
    // Naming is a convenience; skipping it costs a generated title, and running
    // it in the project's checkout would be the wrong directory.
    if (!namingDir) return fallback;

    let generated: string | null;
    try {
      generated = await generateThreadTitle({
        // Another spawn, and the same reason the session's own cwd is resolved:
        // the naming one-shot runs in a directory too.
        cwd: namingDir,
        message: input.message,
        provider: input.provider,
        model: input.model,
      });
    } catch (err) {
      console.error("[thread-title] background rename failed:", err);
      return fallback;
    }
    // Someone renamed the thread while the title was generating; their title
    // is the one the thread settled on.
    const current = this.store.getTitle(input.threadId);
    if (!generated || !canReplaceThreadTitle(current, fallback)) return current ?? fallback;
    this.publishTitle({
      threadId: input.threadId,
      provider: input.provider,
      title: generated,
    });
    return generated;
  }

  /** Rename the thread's worktree branch after `title`, when it has a worktree
   *  and the branch is still a placeholder. Off the hot path; the info panel
   *  reads the branch from git, so nothing here needs to be told. */
  private nameWorkspaceBranch(threadId: string, title: string): void {
    if (!this.renameWorkspaceBranch || !title.trim()) return;
    let worktreePath: string | null | undefined;
    try {
      worktreePath = this.store.threadWorkspace(threadId)?.worktreePath;
    } catch {
      return;
    }
    if (!worktreePath) return;
    void this.renameWorkspaceBranch({ worktreePath, title }).catch((err) => {
      console.error("[thread-title] could not name the worktree branch:", err);
    });
  }

  /** Snapshot the working tree as the conversation's baseline the first time a
   *  thread starts, so the settled diffstat can be measured against where the
   *  repo stood before the conversation touched anything. Guarded on the stored
   *  baseline: a resumed/re-opened session (start-session re-runs, adopting the
   *  same thread id) must keep the original baseline, not rebase onto the
   *  mid-conversation state. Best-effort and off the hot path. */
  private captureBaseline(threadId: string, projectPath: string): void {
    if (this.store.getBaseline(threadId)) return;
    void snapshotWorkingTree(projectPath)
      .then((tree) => {
        if (tree && !this.store.getBaseline(threadId)) this.store.setBaseline(threadId, tree);
      })
      .catch(() => {});
  }

  /**
   * The directory this session will run in, building it first when the thread
   * asked for a worktree it does not have yet.
   *
   * Ordered so that a worktree is built once and only once: a thread that
   * already has a path is never rebuilt, and the path is written to the row the
   * moment git reports it, so a crash after creation does not strand the
   * directory. The declared mode is recorded alongside it — the row says both
   * what was asked for and what was built.
   *
   * A pending thread rebuilds from the stored request without needing the
   * caller to re-ask: the branch rides durably beside the intent, so a reload
   * that wipes the renderer's in-memory staging still has everything needed to
   * build. An explicit workspace on the input wins over the stored one.
   *
   * Throws rather than falling back. A thread that asked for isolation and got
   * the shared checkout instead is the exact failure this feature exists to
   * prevent, so the send fails loudly and the user can try again.
   */
  private async resolveThreadPlace(input: SessionStartInput): Promise<ThreadPlace> {
    const wanted = input.workspace?.mode === "worktree" ? input.workspace : null;
    // An unknown or unreadable workspace never falls back to the shared
    // checkout: a thread that might want isolation fails loudly instead. An
    // explicit worktree request still builds — the input itself states the
    // intent, so there is nothing unknown about what to make.
    let recorded: ThreadWorkspace;
    try {
      const read = this.store.threadWorkspace(input.threadId);
      if (!read) {
        if (!wanted) throw new Error(`Unknown workspace for thread ${input.threadId}`);
        recorded = {};
      } else {
        recorded = read;
      }
    } catch (error) {
      if (!wanted) {
        throw error instanceof Error
          ? error
          : new Error("Cannot start the thread: its workspace could not be read.");
      }
      recorded = {};
    }
    const state = threadWorkspaceState(recorded);

    // Already built. Nothing about a live worktree is rebuilt or re-chosen —
    // the choice was made before the first message and does not reopen.
    if (state === "worktree-ready") {
      const settled = threadWorkingDir({ ...recorded, projectPath: input.cwd });
      if (settled) return { dir: settled, worktreePath: settled };
    }

    if (wanted) {
      const branch = wanted.branch?.trim() ? wanted.branch.trim() : null;
      // The intent is recorded before the build, with the requested branch
      // beside it, so a crash mid-creation leaves a thread that still knows
      // both what it wanted and what it asked to call it rather than one that
      // silently reverts to sharing the project's checkout.
      this.store.setThreadWorkspace(input.threadId, { envMode: "worktree", requestedBranch: branch });
      const built = await this.buildThreadWorktree(input, {
        branch: branch ?? undefined,
        base: wanted.base,
      });
      return { dir: built.path, worktreePath: built.path };
    }

    if (state === "worktree-pending") {
      if (!this.provisionWorkspace) throw new Error("Worktrees aren't available here.");
      const storedBranch = recorded.requestedBranch?.trim() ? recorded.requestedBranch.trim() : undefined;
      const built = await this.buildThreadWorktree(input, { branch: storedBranch });
      return { dir: built.path, worktreePath: built.path };
    }
    return { dir: workingDirFor(input.cwd), worktreePath: null };
  }

  /** Provision the worktree, wire its progress reports, and record the outcome.
   *  Shared by the explicit request and the stored-pending rebuild so the two
   *  can never disagree about ordering, cancellation, or what the row says.
   *
   *  The binding is published by default, so a thread that asked for a worktree
   *  is recorded as owning it the moment git reports the path. A move passes
   *  `publishBinding: false`: it owns that write itself, and must not make the
   *  thread read as moved until its old session is stopped. */
  private async buildThreadWorktree(
    input: SessionStartInput,
    requestBranch: { branch?: string; base?: string },
    options?: { publishBinding?: boolean },
  ): Promise<BuiltThreadWorktree> {
    if (!this.provisionWorkspace) throw new Error("Worktrees aren't available here.");
    this.cancelledWorkspaces.delete(input.threadId);
    const step = (
      name: ThreadWorkspaceStep,
      state: "running" | "done" | "failed",
      detail?: string,
    ): void => this.emitWorkspaceStep(input, name, state, detail);

    const request: Parameters<ProvisionThreadWorkspace>[0] = { projectPath: input.cwd };
    if (requestBranch.branch) request.branch = requestBranch.branch;
    if (requestBranch.base) request.base = requestBranch.base;

    // The staged setup view for this build. Begin it before the first step so a
    // renderer watching the thread already has somewhere for progress to land.
    this.worktreeSetupProviders.set(input.threadId, input.provider);
    this.worktreeSetup.begin({
      threadId: input.threadId,
      branch: requestBranch.branch ?? null,
      baseRef: request.base ?? null,
    });
    let setupScript: string | null = null;
    try {
      setupScript = this.store.projectScript(input.cwd, "setup");
    } catch {
      setupScript = null;
    }
    this.worktreeSetup.setSnapshotFields(input.threadId, {
      setupScript: setupScript ? { command: setupScript } : null,
    });
    request.onProgress = (progress) => this.worktreeSetup.stage(input.threadId, progress);

    // The starting point, made current first. Always reported, even when there
    // is nothing to fetch, because the stepper lists it and waits for it. Only
    // a new branch has a starting point to freshen — a named branch that
    // already exists is moved in as it stands.
    this.worktreeSetup.stage(input.threadId, { stage: "fetch", status: "running" });
    step("fetch", "running");
    let freshNote: string | undefined;
    if (this.freshenWorkspaceBase && !request.branch) {
      const fresh = await freshenBase(this.freshenWorkspaceBase, input.cwd, request.base);
      if (fresh.base) request.base = fresh.base;
      freshNote = fresh.note;
    }
    step("fetch", "done", freshNote);
    this.worktreeSetup.stage(input.threadId, {
      stage: "fetch",
      status: "done",
      detail: freshNote ?? null,
    });

    step("create", "running");
    let made: Awaited<ReturnType<ProvisionThreadWorkspace>>;
    try {
      made = await this.provisionWorkspace(request);
    } catch (error) {
      this.cancelledWorkspaces.delete(input.threadId);
      const detail =
        error instanceof Error
          ? messageOf(error, "Could not create the worktree.")
          : "Could not create the worktree.";
      step("create", "failed", detail);
      this.worktreeSetup.finish(input.threadId, "failed", detail);
      throw error;
    }
    step("create", "done", describeCopiedFiles(made.copiedFiles));
    this.worktreeSetup.setSnapshotFields(input.threadId, { worktreePath: made.path });

    // The cancel lands here, not earlier: git was already mid-checkout and
    // there was nothing to interrupt. What was made gets unmade, including
    // a branch this build invented. A branch the user named, or one that
    // already existed before the build, is never reclaimed — the remover
    // refuses those regardless, and this flag stays false for them.
    if (this.cancelledWorkspaces.delete(input.threadId)) {
      await this.discardWorkspace(input.cwd, made.path, {
        branch: made.branch,
        reclaimGeneratedBranch:
          made.generatedBranch === true && made.attachedExisting !== true,
      });
      this.store.setThreadWorkspace(input.threadId, { envMode: "local", requestedBranch: null });
      step("link", "failed", "Cancelled.");
      this.worktreeSetup.finish(input.threadId, "cancelled", "Cancelled.");
      throw GitError.classified("WORKSPACE_CANCELLED", "Preparing the worktree was cancelled.");
    }

    // The project's setup script runs after the tree exists and before the
    // agent's first turn. It is the host's shell to run; here we only order it
    // and report it. A failure is reported, not fatal — the worktree is still
    // usable, and a broken setup command should not strand the thread.
    if (setupScript && this.runSetupScript) {
      this.worktreeSetup.stage(input.threadId, { stage: "setup-script", status: "running" });
      let result: { code: number | null; output: string } = { code: null, output: "" };
      try {
        result = await this.runSetupScript({
          projectPath: input.cwd,
          cwd: made.path,
          command: setupScript,
          onOutput: (chunk) => {
            for (const line of chunk.split(/\r?\n/)) {
              if (line.trim()) this.worktreeSetup.appendTail(input.threadId, "setup-script", line);
            }
          },
        });
      } catch (err) {
        console.warn("[agent] setup script failed to run:", err);
      }
      const tail = result.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-4);
      this.worktreeSetup.stage(input.threadId, {
        stage: "setup-script",
        status: result.code === 0 ? "done" : "failed",
        detail: result.code === 0 ? null : `Exited ${result.code ?? "with signal"}`,
        tail,
      });
    } else {
      this.worktreeSetup.stage(input.threadId, { stage: "setup-script", status: "skipped" });
    }

    // A cancel during the setup script is honoured here: the script is the
    // longest await in the build, and linking/starting after a cancel would
    // hand the user a worktree they backed out of.
    if (this.cancelledWorkspaces.delete(input.threadId)) {
      await this.discardWorkspace(input.cwd, made.path, {
        branch: made.branch,
        reclaimGeneratedBranch:
          made.generatedBranch === true && made.attachedExisting !== true,
      });
      this.store.setThreadWorkspace(input.threadId, { envMode: "local", requestedBranch: null });
      step("link", "failed", "Cancelled.");
      this.worktreeSetup.finish(input.threadId, "cancelled", "Cancelled.");
      throw GitError.classified("WORKSPACE_CANCELLED", "Preparing the worktree was cancelled.");
    }

    step("link", "running");
    if (options?.publishBinding !== false) {
      this.store.setThreadWorkspace(input.threadId, { worktreePath: made.path, requestedBranch: null });
    }
    step("link", "done");
    step("start", "running");
    // The agent stage is completed in startThread, once the session has
    // actually started (or failed) — not here, where the provider has not been
    // asked yet.
    return {
      path: made.path,
      branch: made.branch,
      generatedBranch: made.generatedBranch === true,
      attachedExisting: made.attachedExisting === true,
    };
  }

  /** One step of building a thread's worktree, on its way to every renderer.
   *
   *  Never journaled — it describes a few seconds of setup, not anything that
   *  happened in the conversation, and a transcript replayed a week later should
   *  carry no trace of it. Emitted only for a thread that asked for a worktree,
   *  so nothing else is disturbed by it. */
  private reportWorkspaceStep(
    input: SessionStartInput,
    step: ThreadWorkspaceStep,
    state: "running" | "done" | "failed",
    detail?: string,
  ): void {
    if (input.workspace?.mode === "worktree") {
      this.emitWorkspaceStep(input, step, state, detail);
      return;
    }
    // A pending thread rebuilding from its stored request carries no workspace
    // on the input — the caller never re-asked — but its stepper still needs
    // the closing start step. The store is the record there. An unreadable
    // store skips the step: progress reporting never fails a start.
    let recorded: ThreadWorkspace | null = null;
    try {
      recorded = this.store.threadWorkspace(input.threadId);
    } catch {
      return;
    }
    if (recorded && threadWorkspaceState(recorded) !== "local") {
      this.emitWorkspaceStep(input, step, state, detail);
    }
  }

  /** Broadcast one workspace step unconditionally. The build path calls this
   *  directly because it already knows it is building; the start boundary
   *  above decides whether a given input warrants one.
   *
   *  `detail` is the step's one sentence, and the state says which kind it is:
   *  why a failed step failed, or a note on how a finished one went. */
  private emitWorkspaceStep(
    input: SessionStartInput,
    step: ThreadWorkspaceStep,
    state: "running" | "done" | "failed",
    detail?: string,
  ): void {
    const event: RuntimeEvent = {
      type: "thread.workspace.progress",
      threadId: input.threadId,
      provider: input.provider,
      at: Date.now(),
      source: "kone.store",
      step,
      state,
    };
    if (detail && state === "failed") event.error = detail;
    else if (detail && state === "done") event.note = detail;
    this.broadcast(event, false);
  }

  /** Back out of a worktree that is still being built.
   *
   *  Never interrupts git — by the time a user can press this the checkout is
   *  already running, and killing it mid-write is how a half-made directory is
   *  left behind. The flag is read once the creation resolves, and what it made
   *  is removed then. A cancel landing after the link is already written has
   *  nothing left to undo and is cleared on the next start. Harmless on a
   *  thread that is not building anything. */
  cancelThreadWorkspace(threadId: string): void {
    this.cancelledWorkspaces.add(threadId);
  }

  /** Remove a worktree this dispatcher just built and then had to give back.
   *  Best effort: a failed removal is logged and the cancellation error still
   *  throws, so teardown never masks the reason the build ended. */
  private async discardWorkspace(
    projectPath: string,
    worktreePath: string,
    opts?: { branch?: string; reclaimGeneratedBranch?: boolean },
  ): Promise<void> {
    if (!this.releaseWorkspace) return;
    try {
      const release: Parameters<ReleaseThreadWorkspace>[0] = { projectPath, worktreePath };
      if (opts?.branch !== undefined) release.branch = opts.branch;
      if (opts?.reclaimGeneratedBranch === true) release.reclaimGeneratedBranch = true;
      await this.releaseWorkspace(release);
    } catch (err) {
      console.error("[dispatch] could not remove a cancelled worktree:", err);
    }
  }

  /** Where this thread's processes run, or null when it has asked for a worktree
   *  that does not exist yet. `projectPath` is the thread's identity; this is its
   *  place, and the two differ exactly when the thread owns a worktree. An
   *  unknown or unreadable workspace answers null — callers skip rather than
   *  fall back to the shared checkout — unless `fallback` is "project", which
   *  answers the project's own directory when no workspace row exists yet:
   *  listing project skills needs somewhere to read from, while a checkpoint
   *  or diffstat must never be taken in a directory the turn never ran in. */
  private threadWorkingDir(
    threadId: string,
    projectPath: string,
    fallback?: "project",
  ): string | null {
    try {
      const workspace = this.store.threadWorkspace(threadId);
      if (!workspace) return fallback === "project" ? workingDirFor(projectPath) : null;
      return threadWorkingDir({ projectPath, ...workspace });
    } catch {
      return null;
    }
  }

  /** Resolve the thread's project path, run git against it, and persist the
   *  snapshot. The diffstat is scoped to this conversation: baseline snapshot →
   *  a fresh snapshot of the tree as the turn settles, so the +/− count only the
   *  lines the conversation moved, not the repo's whole uncommitted state.
   *  Swallows everything: history enrichment is a convenience. */
  private captureRepoStats(threadId: string): void {
    const projectPath = this.store.threadProjectPath(threadId);
    if (!projectPath) return;
    // The same directory the turn ran in, not the project's. A thread in a
    // worktree that reported the main checkout's branch and diffstat would be
    // telling exactly the lie the worktree exists to end.
    const dir = this.threadWorkingDir(threadId, projectPath);
    if (!dir) return;
    void detect(dir)
      .then(async (repo) => {
        if (!repo) return;
        const baseline = this.store.getBaseline(threadId);
        const current = baseline ? await snapshotWorkingTree(dir) : null;
        const stat =
          baseline && current
            ? await diffStatBetween(dir, baseline, current)
            : { added: 0, removed: 0 };
        this.store.recordRepoStats({
          threadId,
          branch: repo.branch,
          added: stat.added,
          removed: stat.removed,
        });
      })
      .catch(() => {});
  }

  /** The recovered-transcript preamble for a thread whose session came up blank,
   *  or null. Read before anything of the new turn is journaled, so the digest
   *  ends at the last thing the agent actually saw. Consumed once. */
  takeReplayPreamble(threadId: string): string | null {
    return this.takeReplay(threadId);
  }

  private takeReplay(threadId: string): string | null {
    if (!this.threadsNeedingReplay.delete(threadId)) return null;
    const thread = this.store.loadThread(threadId);
    return thread ? buildResumeContext(thread) : null;
  }

  /** The restart-background note for a thread, or null, without consuming it.
   *  Reserved for one in-flight delivery at a time: a second concurrent send
   *  composes no note, so only one provider turn carries it. */
  private peekRestartNotePreamble(threadId: string, carrierToken: string): string | null {
    if (this.restartNoteReserved.has(threadId)) return null;
    const work = this.threadsNeedingRestartNote.get(threadId);
    if (!work) return null;
    this.restartNoteReserved.set(threadId, carrierToken);
    return restartCancelledBackgroundWorkNote(work);
  }

  /** A queued carrier's row ended: promoted delivers the note, cancelled
   *  frees it for the next send. */
  private settleQueuedCarrier(
    threadId: string,
    carrierToken: string,
    outcome: "cancelled" | "promoted",
  ): void {
    if (outcome === "promoted") this.consumeRestartNotePreamble(threadId, carrierToken);
    else this.releaseRestartNotePreamble(threadId, carrierToken);
  }

  /** Consume a thread's restart note, once a turn carrying it was accepted. */
  private consumeRestartNotePreamble(threadId: string, carrierToken: string): void {
    if (this.restartNoteReserved.get(threadId) !== carrierToken) return;
    this.threadsNeedingRestartNote.delete(threadId);
    this.restartNoteReserved.delete(threadId);
    this.dropEarlyQueueOutcomes(threadId);
  }

  /** Release a reservation after a refused or cancelled send, so a retry can
   *  carry the note. */
  private releaseRestartNotePreamble(threadId: string, carrierToken: string): void {
    if (this.restartNoteReserved.get(threadId) !== carrierToken) return;
    this.restartNoteReserved.delete(threadId);
    this.dropEarlyQueueOutcomes(threadId);
  }

  /** Outcomes are only kept while a reservation could still need them. */
  private dropEarlyQueueOutcomes(threadId: string): void {
    for (const [queueId, early] of this.earlyQueueOutcomes) {
      if (early.threadId === threadId) this.earlyQueueOutcomes.delete(queueId);
    }
  }
}
