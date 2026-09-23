import { detect, diffStatBetween, snapshotWorkingTree } from "@kone/git-core/status.js";
import { GitError } from "@kone/git-core/core.js";
import type { AgentService } from "./AgentService.js";
import { threadWorkingDir, threadWorkspaceState } from "./threadWorkspace.js";
import type { ThreadWorkspace } from "./threadWorkspace.js";
import { workingDirFor } from "./assistantWorkspace.js";
import type { ConversationStore } from "./ConversationStore.js";
import {
  claimQuitResumeRecordAtStartup,
  resumeQuitInterruptedChats,
  type QuitResumeAssistantTurn,
  type QuitResumeSkipped,
  type QuitResumeThreadSnapshot,
} from "./quitResume.js";
import { buildResumeContext } from "./resumeContext.js";
import {
  buildPromptThreadTitleFallback,
  canReplaceThreadTitle,
  generateThreadTitle,
} from "./threadTitle.js";
import type {
  CompactThreadResult,
  ForkThreadAtBlockInput,
  ForkThreadAtBlockResult,
  ThreadWorkspaceStep,
  ProviderKind,
  RuntimeEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  TurnStartResult,
} from "./types.js";

// The thread dispatcher: the session lifecycle that used to live inside the
// agent:* IPC closures (docs/thread-spawning-design.md §5.1). Driving a thread
// is a main-process capability now — the spawn engine starts and sends turns
// on a child thread headlessly, doing exactly what the renderer's path does.
// ipc.ts forwards to this module, so the renderer path is unchanged.

/** Build the directory a worktree thread runs in. Injected because git lives in
 *  the desktop layer, and a headless host (a test, the spawn engine's own
 *  harness) can run every thread local without one. Absent means worktrees are
 *  unavailable here, and a thread that asked for one fails its send rather than
 *  quietly running in the project's checkout. */
export type ProvisionThreadWorkspace = (input: {
  projectPath: string;
  branch?: string;
  base?: string;
}) => Promise<{
  path: string;
  branch: string;
  /** True when the provisioner invented the branch name, so the caller may
   *  clean it up later. Absent reads as not generated: never delete unless
   *  the provisioner positively says it invented the name. */
  generatedBranch?: boolean;
  /** The branch already existed and was moved into this worktree. Its history
   *  is not ours to discard, even when the name looks generated. */
  attachedExisting?: boolean;
  /** Project-relative paths of the private files (`.env` and the like) brought
   *  into the new directory, for the setup steps to name. */
  copiedFiles?: string[];
}>;

/** What the create step says about the private files a new worktree was
 *  given, or nothing when it was given none. */
export function describeCopiedFiles(copied: readonly string[] | undefined): string | undefined {
  if (!copied || copied.length === 0) return undefined;
  const shown = copied.slice(0, 3).join(", ");
  const more = copied.length - 3;
  return more > 0 ? `Copied ${shown} and ${more} more.` : `Copied ${shown}.`;
}

/** Tear down a worktree this dispatcher built. Only ever called on one it just
 *  created and then had to give back — a user who cancelled while it was being
 *  made. Best effort: a worktree left behind is untidy, a failed teardown that
 *  masked the real error would be worse. */
export type ReleaseThreadWorkspace = (input: {
  projectPath: string;
  worktreePath: string;
  /** The branch the worktree was built on, for logging. The remover re-reads
   *  the live branch itself rather than trusting this. */
  branch?: string;
  /** Delete the worktree's branch after removal, when it was generated for
   *  this build. The remover still refuses user-named branches regardless. */
  reclaimGeneratedBranch?: boolean;
}) => Promise<void>;

/** Where a new worktree's branch should start: the freshest copy of `base`
 *  (the project's current branch when absent) that loses nothing. Never throws —
 *  a starting point that cannot be freshened is still a starting point. `note`
 *  is a sentence for the setup card, present only when there is one to say. */
export type FreshenThreadWorkspaceBase = (input: {
  projectPath: string;
  base?: string;
}) => Promise<{ base?: string; note?: string }>;

/** Give the placeholder branch a worktree was built on a name taken from the
 *  thread's title. Returns the new name, or null when the branch was left
 *  alone. Never throws — a thread keeps working on its placeholder either way. */
export type RenameThreadWorkspaceBranch = (input: {
  worktreePath: string;
  title: string;
}) => Promise<string | null>;

/** The sentence worth showing from a failure, or `fallback` when it carries
 *  none worth reading. */
function messageOf(error: Error, fallback: string): string {
  return error.message.trim() || fallback;
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
}

export interface StartThreadOptions {
  /** When this thread is being spawned by another thread's turn, that
   *  spawning turn's id. Every event the child emits is stamped with it at the
   *  broadcast choke point (ipc.ts), so consumers correlate the child's
   *  traffic to the parent turn without a store walk (F10). */
  parentTurnId?: string;
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
  ensureThreadSession(threadId: string, options: { resume: boolean }): Promise<void>;
  /** Fresh snapshot of one thread for the quit-resume filter: liveness from the
   *  service, settled-state facts per assistant turn from the store. */
  readQuitResumeSnapshot(threadId: string): QuitResumeThreadSnapshot;
  /** One silent continuation turn for a thread interrupted by a quit: adopts its
   *  session with resume first, then dispatches without journaling — the prompt
   *  is the app's own voice, not something the user said. */
  dispatchQuitResumeTurn(threadId: string, prompt: string): Promise<void>;
  /** Claim the quit-resume record (if any) and dispatch one continuation per
   *  surviving thread, serialized with a fresh re-check before each. Best-effort:
   *  resuming never fails boot — every failure is contained per thread and
   *  reported as skipped. */
  resumeQuitInterruptedChatsAtBoot(): Promise<{ resumed: string[]; skipped: QuitResumeSkipped[] }>;
  /** Back out of a worktree that is still being built. Does not interrupt git —
   *  the creation is awaited and what it made is then removed. */
  cancelThreadWorkspace(threadId: string): void;
  /** The id of the turn that spawned this thread, when it is a spawned child
   *  (registered via startThread/sendThreadTurn parentTurnId) — used by the
   *  IPC broadcast choke point to stamp child events. */
  spawnParentTurnId(threadId: string): string | undefined;
  /** Called when a turn settles — snapshots the repo state it left behind. */
  onTurnCompleted(threadId: string): void;
  /** Drop per-thread bookkeeping when a thread is deleted. */
  forgetThread(threadId: string): void;
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
  /** The app started this turn, not a person: journal nothing. */
  silent?: boolean;
}): TurnDelivery {
  return {
    journal: input.silent ? null : input.message,
    dispatch: input.preamble ? `${input.preamble}\n\n${input.message}` : input.message,
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
  /** Threads whose user backed out while their worktree was being built.
   *
   *  Cancelling is not "stop trying" — git is already mid-checkout and there is
   *  nothing to interrupt. It is "undo whatever finishes": the creation is still
   *  awaited, and the directory it produces is then removed. The alternative is
   *  a worktree nobody asked for, owned by a thread that never started. */
  private readonly cancelledWorkspaces = new Set<string>();

  // Threads whose live provider session came up with none of the thread's
  // context — no stored resume id to offer, or the provider refused the one we
  // had (see Session.resumedFrom). kone still has the transcript, so the next
  // turn on such a thread carries a condensed replay of it (resumeContext.ts)
  // instead of asking a blank agent to "continue". One-shot: the first turn
  // re-establishes the context, and everything after it is a normal
  // continuation.
  private readonly threadsNeedingReplay = new Set<string>();

  // Spawned children: threadId → the parent turn that spawned it, registered
  // at dispatch (startThread/sendThreadTurn parentTurnId). The IPC broadcast
  // choke point reads it to stamp every event the child emits with its
  // spawning turn's id (F10).
  private readonly spawnParentTurnIds = new Map<string, string>();

  constructor(deps: ThreadDispatcherDeps) {
    this.service = deps.service;
    this.store = deps.store;
    this.broadcast = deps.broadcast;
    this.provisionWorkspace = deps.provisionWorkspace;
    this.releaseWorkspace = deps.releaseWorkspace;
    this.freshenWorkspaceBase = deps.freshenWorkspaceBase;
    this.renameWorkspaceBranch = deps.renameWorkspaceBranch;
  }

  spawnParentTurnId(threadId: string): string | undefined {
    return this.spawnParentTurnIds.get(threadId);
  }

  async startThread(input: SessionStartInput, options?: StartThreadOptions): Promise<Session> {
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
    const workingDir = await this.resolveThreadPlace(input);
    let session: Session;
    try {
      session = await this.service.startSession(
        workingDir === input.cwd ? input : { ...input, cwd: workingDir },
      );
    } catch (error) {
      // Closes the stepper's last step when one is open. A thread that never
      // asked for a worktree has no stepper and nothing reads this.
      this.reportWorkspaceStep(
        input,
        "start",
        "failed",
        error instanceof Error ? messageOf(error, "Could not start.") : "Could not start.",
      );
      throw error;
    }
    this.reportWorkspaceStep(input, "start", "done");
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

  async ensureThreadSession(threadId: string, options: { resume: boolean }): Promise<void> {
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
    if (meta.selection?.mode) start.mode = meta.selection.mode;
    if (meta.selection?.effort) start.effort = meta.selection.effort;
    await this.startThread(start);
  }

  readQuitResumeSnapshot(threadId: string): QuitResumeThreadSnapshot {
    const meta = this.store.threadMeta(threadId);
    if (!meta) return { threadId, missing: true, archived: false, busy: false, turns: [] };
    const thread = this.store.loadThread(threadId);
    const turns: QuitResumeAssistantTurn[] = [];
    if (thread) {
      for (const block of thread.blocks) {
        if (block.role !== "assistant") continue;
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
      busy: this.service.isThreadBusy(threadId),
      turns,
    };
  }

  async dispatchQuitResumeTurn(threadId: string, prompt: string): Promise<void> {
    await this.ensureThreadSession(threadId, { resume: true });
    // Silent: this prompt is the app's own voice, not something the user said
    // — journaling it would put words in their mouth.
    await this.sendThreadTurn(
      { threadId, input: prompt },
      { silent: true, generateTitle: false },
    );
  }

  async resumeQuitInterruptedChatsAtBoot(): Promise<{
    resumed: string[];
    skipped: QuitResumeSkipped[];
  }> {
    const claimed = claimQuitResumeRecordAtStartup();
    if (claimed.kind !== "record") return { resumed: [], skipped: [] };
    try {
      const result = await resumeQuitInterruptedChats({
        claimed,
        readSnapshot: (id) => this.readQuitResumeSnapshot(id),
        dispatchResumeTurn: (id, prompt) => this.dispatchQuitResumeTurn(id, prompt),
      });
      if (result.resumed.length > 0) {
        console.info(
          `[agent] resumed ${result.resumed.length} chat(s) interrupted by the previous quit`,
        );
      }
      if (result.skipped.length > 0) {
        console.info("[agent] quit-resume skipped threads that moved on:", result.skipped);
      }
      return result;
    } catch (err) {
      console.warn("[agent] quit-resume failed — continuing boot without it:", err);
      return { resumed: [], skipped: [] };
    }
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
    input: SendTurnInput,
    destination: "send" | "steer",
    options?: StartThreadTurnOptions,
  ): Promise<TurnStartResult> {
    if (options?.parentTurnId) this.spawnParentTurnIds.set(input.threadId, options.parentTurnId);
    const delivery = composeTurnDelivery({
      message: input.input,
      preamble: this.replayPreamble(input.threadId),
      silent: options?.silent,
    });
    // Persist the user prompt (with any attachment metadata) before dispatching,
    // so it precedes the turn in arrival order (turn.started lands after this).
    const userTurnCount =
      delivery.journal === null
        ? 0
        : this.store.recordUserBlock({
            blockId: input.userBlockId,
            threadId: input.threadId,
            text: delivery.journal,
            attachments: input.attachments,
            effort: input.effort,
            model: input.model,
          });
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
      const provider = this.store.threadMeta(input.threadId)?.provider;
      if (provider) {
        this.maybeNameThread(
          {
            threadId: input.threadId,
            provider,
            // An attachment-only first turn has no prompt text — name the thread
            // after the first attached file instead of leaving it blank.
            message: input.input.trim() || input.attachments?.[0]?.name || "",
          },
          options,
        );
      }
    }
    const dispatched =
      delivery.dispatch === input.input ? input : { ...input, input: delivery.dispatch };
    return destination === "steer"
      ? this.service.steerTurn(dispatched)
      : this.service.sendTurn(dispatched);
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
    this.cancelledWorkspaces.delete(threadId);
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
   *  Whichever title the thread settles on also names its worktree's branch,
   *  once — the placeholder a worktree is built on means nothing to anyone
   *  reading the branch list. */
  private maybeNameThread(
    input: { threadId: string; provider: ProviderKind; message: string },
    options?: StartThreadTurnOptions,
  ): void {
    if (options?.title) {
      this.publishTitle({
        threadId: input.threadId,
        provider: input.provider,
        title: options.title,
      });
      this.nameWorkspaceBranch(input.threadId, options.title);
      return;
    }
    const fallback = buildPromptThreadTitleFallback(input.message);
    this.publishTitle({
      threadId: input.threadId,
      provider: input.provider,
      title: fallback,
    });
    if (options?.generateTitle === false) {
      this.nameWorkspaceBranch(input.threadId, fallback);
      return;
    }

    const projectPath = this.store.threadProjectPath(input.threadId);
    if (!projectPath) return;

    // An unknown or unreadable workspace skips naming rather than falling back
    // to the shared checkout: the one-shot must run where the thread runs.
    let namingDir: string | null = null;
    try {
      const workspace = this.store.threadWorkspace(input.threadId);
      if (!workspace) return;
      namingDir = threadWorkingDir({ projectPath, ...workspace });
    } catch {
      return;
    }
    // A thread whose worktree is not built yet has nowhere to run the one-shot.
    // Naming is a convenience; skipping it costs a generated title, and running
    // it in the project's checkout would be the wrong directory.
    if (!namingDir) return;

    void generateThreadTitle({
      // Another spawn, and the same reason the session's own cwd is resolved:
      // the naming one-shot runs in a directory too.
      cwd: namingDir,
      message: input.message,
      provider: input.provider,
    })
      .then((generated) => {
        if (!generated) return fallback;
        // Someone renamed the thread while the title was generating; their
        // title is the one the branch should carry.
        const current = this.store.getTitle(input.threadId);
        if (!canReplaceThreadTitle(current, fallback)) return current ?? fallback;
        this.publishTitle({
          threadId: input.threadId,
          provider: input.provider,
          title: generated,
        });
        return generated;
      })
      .catch((err: unknown) => {
        console.error("[thread-title] background rename failed:", err);
        return fallback;
      })
      .then((title) => this.nameWorkspaceBranch(input.threadId, title));
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
    void this.renameWorkspaceBranch({ worktreePath, title }).catch((err: unknown) => {
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
  private async resolveThreadPlace(input: SessionStartInput): Promise<string> {
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
      if (settled) return settled;
    }

    if (wanted) {
      const branch = wanted.branch?.trim() ? wanted.branch.trim() : null;
      // The intent is recorded before the build, with the requested branch
      // beside it, so a crash mid-creation leaves a thread that still knows
      // both what it wanted and what it asked to call it rather than one that
      // silently reverts to sharing the project's checkout.
      this.store.setThreadWorkspace(input.threadId, { envMode: "worktree", requestedBranch: branch });
      return this.buildThreadWorktree(input, {
        branch: branch ?? undefined,
        base: wanted.base,
      });
    }

    if (state === "worktree-pending") {
      if (!this.provisionWorkspace) throw new Error("Worktrees aren't available here.");
      const storedBranch = recorded.requestedBranch?.trim() ? recorded.requestedBranch.trim() : undefined;
      return this.buildThreadWorktree(input, { branch: storedBranch });
    }
    return workingDirFor(input.cwd);
  }

  /** Provision the worktree, wire its progress reports, and record the outcome.
   *  Shared by the explicit request and the stored-pending rebuild so the two
   *  can never disagree about ordering, cancellation, or what the row says. */
  private async buildThreadWorktree(
    input: SessionStartInput,
    requestBranch: { branch?: string; base?: string },
  ): Promise<string> {
    if (!this.provisionWorkspace) throw new Error("Worktrees aren't available here.");
    this.cancelledWorkspaces.delete(input.threadId);
    const step = (
      name: ThreadWorkspaceStep,
      state: "running" | "done" | "failed",
      message?: string,
    ): void => this.emitWorkspaceStep(input, name, state, message);

    const request: Parameters<ProvisionThreadWorkspace>[0] = { projectPath: input.cwd };
    if (requestBranch.branch) request.branch = requestBranch.branch;
    if (requestBranch.base) request.base = requestBranch.base;

    // The starting point, made current first. Always reported, even when there
    // is nothing to fetch, because the stepper lists it and waits for it. Only
    // a new branch has a starting point to freshen — a named branch that
    // already exists is moved in as it stands.
    step("fetch", "running");
    let freshNote: string | undefined;
    if (this.freshenWorkspaceBase && !request.branch) {
      try {
        const fresh = await this.freshenWorkspaceBase({
          projectPath: input.cwd,
          ...(request.base ? { base: request.base } : {}),
        });
        if (fresh.base) request.base = fresh.base;
        freshNote = fresh.note;
      } catch {
        freshNote = "Couldn't get the latest changes — started from your copy.";
      }
    }
    step("fetch", "done", freshNote);

    step("create", "running");
    let made: Awaited<ReturnType<ProvisionThreadWorkspace>>;
    try {
      made = await this.provisionWorkspace(request);
    } catch (error) {
      this.cancelledWorkspaces.delete(input.threadId);
      step(
        "create",
        "failed",
        error instanceof Error
          ? messageOf(error, "Could not create the worktree.")
          : "Could not create the worktree.",
      );
      throw error;
    }
    step("create", "done", describeCopiedFiles(made.copiedFiles));

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
      throw GitError.classified("WORKSPACE_CANCELLED", "Preparing the worktree was cancelled.");
    }

    step("link", "running");
    this.store.setThreadWorkspace(input.threadId, { worktreePath: made.path, requestedBranch: null });
    step("link", "done");
    step("start", "running");
    return made.path;
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
    message?: string,
  ): void {
    if (input.workspace?.mode === "worktree") {
      this.emitWorkspaceStep(input, step, state, message);
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
      this.emitWorkspaceStep(input, step, state, message);
    }
  }

  /** Broadcast one workspace step unconditionally. The build path calls this
   *  directly because it already knows it is building; the start boundary
   *  above decides whether a given input warrants one. */
  private emitWorkspaceStep(
    input: SessionStartInput,
    step: ThreadWorkspaceStep,
    state: "running" | "done" | "failed",
    message?: string,
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
    if (message) event.message = message;
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
   *  fall back to the shared checkout. */
  private threadWorkingDir(threadId: string, projectPath: string): string | null {
    try {
      const workspace = this.store.threadWorkspace(threadId);
      if (!workspace) return null;
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
   *  or null. Read before the new prompt is journaled, so the digest ends at the
   *  last thing the agent actually saw. Consumed once. */
  private replayPreamble(threadId: string): string | null {
    if (!this.threadsNeedingReplay.delete(threadId)) return null;
    const thread = this.store.loadThread(threadId);
    return thread ? buildResumeContext(thread) : null;
  }
}
