import { detect, diffStatBetween, snapshotWorkingTree } from "@kone/git-core/status.js";
import type { AgentService } from "./AgentService.js";
import type { ConversationStore } from "./ConversationStore.js";
import { buildResumeContext } from "./resumeContext.js";
import {
  buildPromptThreadTitleFallback,
  canReplaceThreadTitle,
  generateThreadTitle,
} from "./threadTitle.js";
import type {
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

export interface ThreadDispatcherDeps {
  service: AgentService;
  store: ConversationStore;
  /** Push one runtime event to every subscribed renderer. `journal` false
   *  skips store.applyEvent — ipc.ts owns both. */
  broadcast: (event: RuntimeEvent, journal?: boolean) => void;
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
    const session = await this.service.startSession(input);
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
    this.captureBaseline(input.threadId, input.cwd);
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
            threadId: input.threadId,
            text: delivery.journal,
            attachments: input.attachments,
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
   *  background round trip. */
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
      return;
    }
    const fallback = buildPromptThreadTitleFallback(input.message);
    this.publishTitle({
      threadId: input.threadId,
      provider: input.provider,
      title: fallback,
    });
    if (options?.generateTitle === false) return;

    const cwd = this.store.threadProjectPath(input.threadId);
    if (!cwd) return;

    void generateThreadTitle({
      cwd,
      message: input.message,
      provider: input.provider,
    })
      .then((generated) => {
        if (!generated) return;
        if (!canReplaceThreadTitle(this.store.getTitle(input.threadId), fallback)) return;
        this.publishTitle({
          threadId: input.threadId,
          provider: input.provider,
          title: generated,
        });
      })
      .catch((err) => {
        console.error("[thread-title] background rename failed:", err);
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

  /** Resolve the thread's project path, run git against it, and persist the
   *  snapshot. The diffstat is scoped to this conversation: baseline snapshot →
   *  a fresh snapshot of the tree as the turn settles, so the +/− count only the
   *  lines the conversation moved, not the repo's whole uncommitted state.
   *  Swallows everything: history enrichment is a convenience. */
  private captureRepoStats(threadId: string): void {
    const projectPath = this.store.threadProjectPath(threadId);
    if (!projectPath) return;
    void detect(projectPath)
      .then(async (repo) => {
        if (!repo) return;
        const baseline = this.store.getBaseline(threadId);
        const current = baseline ? await snapshotWorkingTree(projectPath) : null;
        const stat =
          baseline && current
            ? await diffStatBetween(projectPath, baseline, current)
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
