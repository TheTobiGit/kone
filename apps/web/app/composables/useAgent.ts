import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type {
  ChatAttachment,
  InteractionMode,
  KoneAgentApi,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeSessionState,
  Session,
  TokenUsage,
  UserInputAnswers,
  UserInputQuestion,
} from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";
import type { EffortTier } from "~/utils/modelCatalog";
import {
  activePlanTask,
  formatPlanTasks,
  type ActivePlanTask,
  type PlanTask,
} from "~/utils/planTasks";

// The brain behind a project's agent conversations. It starts provider sessions
// in the Electron main process, sends turns, and folds the single normalized
// `agent:event` stream into a reactive timeline the calm UI renders — so the UI
// never learns which CLI is underneath. In `nuxt dev` (no bridge) it falls back
// to a faithful mock that streams a canned reply, keeping threads demoable in
// the browser (mirrors how useGitClone mocks the clone).
//
// A project owns MANY threads at once. Each thread is one `ThreadSession` (its
// own timeline, session process, provider/model, busy state); the manager keeps
// them in a registry keyed by a stable id, routes the event stream to the right
// one by `threadId`, and projects whichever is *active* as the public API the
// conversation view reads. Non-active threads stay live in the background — a
// turn you stepped away from keeps streaming — which is what lets the away-from-
// thread status pill surface every running/just-settled thread as a stack.
// (Pattern borrowed from research's by-id store + research's per-thread atoms.)

/** Set on blocks bulk-loaded from storage (rehydrate/openThread) so the view
 *  renders them settled — no entry springs, no per-word blur-in. Live turns
 *  streamed in through the reducer never carry it, so they still animate. */
type Historical = { historical?: boolean };

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
  block: AssistantBlock | null;
  /** The checklist row the thread is on right now (null when it has no plan) —
   *  what the pill names while you're away from the conversation. */
  task: ActivePlanTask | null;
  busy: boolean;
  /** True once a live turn has actually started here — rehydrated history alone
   *  doesn't count, so a freshly reloaded thread never pills. */
  everRan: boolean;
  isActive: boolean;
};

/** Tag every block from a stored thread as historical so the view mounts them
 *  settled instead of replaying entry/word animations across the whole thread. */
function markHistorical(blocks: ThreadBlock[]): ThreadBlock[] {
  return blocks.map((b) => ({ ...b, historical: true }));
}

function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** Read a File's bytes as base64 (no `data:` prefix) for upload over IPC.
 *  Uses FileReader.readAsDataURL — safe for multi-MB files, unlike btoa on a
 *  giant char string — then strips the data-URL header. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      if (typeof res !== "string") return reject(new Error("Unexpected file read result"));
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

/** The latest assistant turn in a timeline, or null. */
function latestAssistant(blocks: ThreadBlock[]): AssistantBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.role === "assistant") return b;
  }
  return null;
}

/** First-turn word-cap fallback — mirrors desktop `buildPromptThreadTitleFallback`
 *  so browser-dev / the instant before the agent rename lands still has a label. */
function titleFromPrompt(message: string): string {
  const words = message
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) return "New thread";
  const joined = words.join(" ");
  return joined.length > 60 ? `${joined.slice(0, 60)}...` : joined;
}

/** Everything a ThreadSession needs from its owning manager: options, the
 *  desktop bridge accessor, and the (lazily resolved) working directory. */
type SessionCtx = {
  options: UseAgentOptions;
  bridge: () => KoneAgentApi | undefined;
  resolveCwd: () => string;
};

export type ThreadSession = ReturnType<typeof createThreadSession>;

// ── one thread ────────────────────────────────────────────────────────────────

/** One conversation thread: its own timeline, provider session, model/config,
 *  and the reducer that folds its slice of the event stream. Self-contained —
 *  the manager owns the single event listener and calls `reduce` for events
 *  bearing this thread's id. */
function createThreadSession(ctx: SessionCtx, init: { rehydrate?: boolean } = {}) {
  const { options } = ctx;
  // Stable registry identity — never changes, even when the provider threadId
  // is overwritten on rehydrate/openThread or minted anew on restart.
  const key = uid();

  const threadId = ref(uid());
  const blocks = ref<ThreadBlock[]>([]);
  /** Agent-named (or first-turn word-fallback) working title. Empty until the
   *  first user turn or a rehydrated/opened thread that already has one. */
  const title = ref("");
  const session = shallowRef<Session | null>(null);
  const sessionState = ref<RuntimeSessionState>("starting");
  const error = ref<string | null>(null);
  const tokenUsage = ref<TokenUsage | null>(null);
  // A live question the agent is asking (AskUserQuestion / Codex requestUserInput).
  // Non-null while the modal is up; cleared once answered or resolved/aborted.
  const pendingUserInput = ref<PendingUserInput | null>(null);

  // The provider is mutable so a thread can switch engines (Codex ↔ Claude).
  // Because the two are separate CLIs with no shared conversation, a switch is a
  // fresh session — restart() below tears the old one down and starts anew.
  const provider = ref<ProviderKind>(options.provider);
  const model = ref(options.model);
  const mode = ref<InteractionMode>(options.mode ?? "accept-edits");
  const reasoning = ref<ReasoningTier>(options.reasoning ?? "medium");
  const serviceTier = ref<string | undefined>(options.serviceTier);
  const contextWindow = ref<string | undefined>(options.contextWindow);

  // Busy while a turn is in flight — the composer disables send + shows stop.
  const busy = computed(
    () =>
      sessionState.value === "running" ||
      blocks.value.some((b) => b.role === "assistant" && b.state === "running"),
  );
  // Flips true the first time a live turn starts here (turn.started). Rehydrated
  // history never trips it, so a reloaded thread stays out of the pill stack
  // until it actually runs something.
  const everRan = ref(false);

  const bridge = ctx.bridge;

  // ── event reduction (the one place the stream becomes UI state) ─────────────

  function currentAssistant(turnId: string): AssistantBlock | undefined {
    for (let i = blocks.value.length - 1; i >= 0; i--) {
      const b = blocks.value[i];
      if (b && b.role === "assistant" && b.turnId === turnId) return b;
    }
    return undefined;
  }

  function upsertItem(block: AssistantBlock, item: RuntimeItem): void {
    const idx = block.items.findIndex((i) => i.itemId === item.itemId);
    if (idx === -1) block.items.push(item);
    else block.items[idx] = item;
    // Reassign so the shallow array ref stays reactive on nested edits.
    block.items = [...block.items];
  }

  /** Fold one event into this thread's state. The manager only calls this for
   *  events whose `threadId` matches ours; the guard is belt-and-braces. */
  function reduce(event: RuntimeEvent): void {
    if (event.threadId !== threadId.value) return;
    switch (event.type) {
      case "session.state.changed":
        sessionState.value = event.state;
        if (event.state === "error" && event.message) error.value = event.message;
        break;
      case "session.exited": {
        sessionState.value = "stopped";
        if (event.code && error.value === null) {
          error.value = "Agent process exited unexpectedly";
        }
        blocks.value = blocks.value.map((b) =>
          b.role === "assistant" && b.state === "running"
            ? { ...b, state: "failed", endedAt: event.at }
            : b,
        );
        break;
      }
      case "thread.token-usage.updated":
        tokenUsage.value = event.usage;
        break;
      case "thread.title.updated":
        title.value = event.title;
        break;
      case "turn.started":
        everRan.value = true;
        blocks.value = [
          ...blocks.value,
          {
            id: event.turnId,
            role: "assistant",
            turnId: event.turnId,
            items: [],
            state: "running",
            at: event.at,
          },
        ];
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const block = currentAssistant(event.turnId);
        if (block) {
          upsertItem(block, event.item);
          blocks.value = [...blocks.value];
        }
        break;
      }
      case "turn.completed": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = "completed";
          block.endedAt = event.at;
        }
        blocks.value = [...blocks.value];
        break;
      }
      case "turn.aborted": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = event.reason === "interrupted" ? "interrupted" : "failed";
          block.error = event.message;
          block.endedAt = event.at;
        }
        // An aborted turn can never have its question answered — drop the modal.
        pendingUserInput.value = null;
        blocks.value = [...blocks.value];
        break;
      }
      case "user-input.requested":
        pendingUserInput.value = { requestId: event.requestId, questions: event.questions };
        break;
      case "user-input.resolved":
        // The backend settled this round-trip (our answer, or a drain on
        // interrupt/stop). Clear the modal if it's the one we're showing.
        if (pendingUserInput.value?.requestId === event.requestId) {
          pendingUserInput.value = null;
        }
        break;
      default:
        break;
    }
  }

  // Rehydration runs once. A restart() (provider/model switch) keeps the
  // on-screen history but must not reload a stale thread over the new session;
  // a session created for a specific thread (openThread) latches it closed.
  let rehydratedOnce = init.rehydrate === false;
  // Latched by dispose(): once torn down, an in-flight openStored() must not go
  // on to adopt an id, start a provider process, or reveal a thread — the case
  // where a stored thread is opened and immediately archived/deleted while its
  // history load is still awaiting. start() and openStored() both check it.
  let forgotten = false;
  // The provider-native conversation id to resume on the next start(): set when
  // a stored thread is brought on-screen so continued turns keep its full
  // context. Consumed and cleared in start() — a later fresh start never resumes.
  let pendingResumeId: string | undefined;

  /** Adopt a stored thread's provider/model and stage its conversation id for
   *  resume, so continuing it runs on the CLI + model that produced it and keeps
   *  its full context. Resume ids are provider-native, so provider and model
   *  must move together — otherwise we'd hand a Codex thread id to Claude (or a
   *  Claude model id to Codex). */
  function adoptStoredThread(stored: {
    provider?: ProviderKind;
    model?: string;
    conversationId?: string;
    contextUsed?: number;
    contextWindow?: number;
    compactsAutomatically?: boolean;
  }): void {
    const providerChanged = Boolean(stored.provider) && stored.provider !== provider.value;
    if (stored.provider) provider.value = stored.provider;
    // Carry the thread's own model; if it predates model persistence, only drop
    // the current one when the provider changed (a stale cross-provider model id
    // is worse than the provider default).
    if (stored.model !== undefined) model.value = stored.model;
    else if (providerChanged) model.value = undefined;
    pendingResumeId = stored.conversationId;
    // Restore the last context-window snapshot so a reopened thread shows its
    // meter filled straight away (sweeping in), instead of an empty ring until
    // the next turn re-reports usage. Absent snapshot → leave the meter hidden.
    tokenUsage.value =
      stored.contextWindow !== undefined || stored.contextUsed !== undefined
        ? {
            total: stored.contextUsed,
            contextUsed: stored.contextUsed,
            contextWindow: stored.contextWindow,
            compactsAutomatically: stored.compactsAutomatically,
          }
        : null;
  }

  /** Reload the project's last persisted thread into this timeline, adopting its
   *  id so continued turns append to the same stored thread. Best-effort: any
   *  failure just leaves a fresh, empty thread. Desktop only. */
  async function rehydrate(api: NonNullable<ReturnType<typeof bridge>>): Promise<void> {
    if (rehydratedOnce || options.rehydrate === false) return;
    rehydratedOnce = true;
    try {
      const stored = await api.history.latest(ctx.resolveCwd());
      if (stored && stored.blocks.length > 0) {
        threadId.value = stored.threadId;
        blocks.value = markHistorical(stored.blocks as ThreadBlock[]);
        title.value = stored.title?.trim() || title.value;
        adoptStoredThread(stored);
      }
    } catch {
      // History is a convenience — never block starting a session over it.
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  /** Start this thread's session. The manager owns the event listener, so this
   *  only spawns the provider process (after an optional rehydrate). */
  async function start(): Promise<void> {
    // Forgotten mid-load (opened then archived/deleted) — never spawn a process
    // for a thread the user just removed (startSession → ensureThread would
    // recreate a deleted row).
    if (forgotten) return;
    const api = bridge();
    error.value = null;
    if (!api) {
      // Browser dev: no real session — pretend it's ready so the composer works.
      sessionState.value = "ready";
      return;
    }
    await rehydrate(api);
    // One-shot: read and clear now so neither a throw below nor a later fresh
    // start re-resumes a stale conversation.
    const resume = pendingResumeId;
    pendingResumeId = undefined;
    try {
      session.value = await api.startSession({
        threadId: threadId.value,
        provider: provider.value,
        cwd: ctx.resolveCwd(),
        model: model.value,
        mode: mode.value,
        // Providers that fix effort when the session process spawns (Claude)
        // read it here; flag-based ones (Codex) ignore it and take effort per
        // turn instead. Safe to always send — the adapter picks what it needs.
        effort: reasoning.value,
        // Resume the stored thread's provider conversation so continued turns
        // keep its full context (rehydrate/openStored set this).
        ...(resume ? { resume } : {}),
      });
      sessionState.value = session.value.status;
    } catch (e) {
      error.value = peelIpcError(e, "Could not start the agent");
      sessionState.value = "error";
    }
  }

  /** Bring a specific stored thread on-screen and continue it: adopt the
   *  thread's id + transcript and start a session bound to it so new turns
   *  append to it. Best-effort; desktop only. */
  async function openStored(id: string): Promise<void> {
    const api = bridge();
    // Browser dev has no history bridge — just bring a (mock) session up so the
    // composer is live rather than leaving the view without a session.
    if (!api) {
      await start();
      return;
    }
    let stored;
    try {
      stored = await api.history.thread(id);
    } catch {
      stored = null;
    }
    // Forgotten while the history load was in flight (opened then immediately
    // archived/deleted) — bail before adopting the id or starting, so the
    // removed thread is never revealed or recreated.
    if (forgotten) return;
    // Thread vanished (deleted/archived under us) — fall back to a fresh session
    // rather than an empty, session-less view.
    if (!stored) {
      await start();
      return;
    }
    // start() must not reload the project's *latest* thread over this one.
    rehydratedOnce = true;
    threadId.value = stored.threadId;
    blocks.value = markHistorical(stored.blocks as ThreadBlock[]);
    title.value = stored.title?.trim() || "";
    adoptStoredThread(stored); // also restores the persisted context-meter snapshot
    error.value = null;
    sessionState.value = "starting";
    await start();
  }

  /** Send a user turn. Pushes the user block immediately; the reply streams in.
   *  `attachments` (already uploaded to disk via the bridge, so bytes-free) ride
   *  the turn — a turn is valid with text, attachments, or both. */
  async function send(text: string, attachments?: ChatAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const files = attachments ?? [];
    if ((!trimmed && files.length === 0) || busy.value) return;
    blocks.value = [
      ...blocks.value,
      {
        id: uid(),
        role: "user",
        text: trimmed,
        at: Date.now(),
        ...(files.length ? { attachments: files } : {}),
      },
    ];
    // Instant label for a brand-new thread; desktop may refine it via
    // thread.title.updated once the agent rename lands. An attachment-only turn
    // seeds the label from the first file name.
    if (!title.value) title.value = titleFromPrompt(trimmed || files[0]?.name || "");

    const api = bridge();
    if (!api) {
      mockTurn(trimmed || files[0]?.name || "Attachment");
      return;
    }
    try {
      await api.sendTurn({
        threadId: threadId.value,
        input: trimmed,
        ...(files.length ? { attachments: files } : {}),
        model: model.value,
        mode: mode.value,
        effort: reasoning.value,
        serviceTier: serviceTier.value,
        contextWindow: contextWindow.value,
      });
    } catch (e) {
      error.value = peelIpcError(e, "Could not send to the agent");
    }
  }

  /** Upload one picked/dropped/pasted file's bytes to disk (scoped to this
   *  thread) and resolve to the bytes-free ChatAttachment the composer holds and
   *  later sends. In browser dev (no bridge) we synthesize metadata so the
   *  composer UI still works — nothing is persisted. */
  async function uploadAttachment(file: File): Promise<ChatAttachment> {
    const name = file.name || "attachment";
    const mimeType = file.type || "application/octet-stream";
    const api = bridge();
    if (!api) {
      return {
        type: mimeType.toLowerCase().startsWith("image/") ? "image" : "file",
        id: `mock_${uid()}`,
        name,
        mimeType,
        sizeBytes: file.size,
      };
    }
    const data = await fileToBase64(file);
    return api.uploadAttachment({ threadId: threadId.value, name, mimeType, data });
  }

  /** Interrupt the running turn. */
  async function interrupt(): Promise<void> {
    const api = bridge();
    if (!api) {
      // Browser dev: mark the running mock turn as stopped, then halt its timers.
      const tid = mockTurnId;
      stopMock();
      if (tid)
        reduce({
          ...base("turn.aborted"),
          type: "turn.aborted",
          turnId: tid,
          reason: "interrupted",
        } as RuntimeEvent);
      sessionState.value = "ready";
      return;
    }
    try {
      await api.interrupt(threadId.value);
    } catch {
      // The turn.aborted event (or its absence) is the source of truth.
    }
  }

  /** Answer the agent's live question. Clears the modal optimistically, then
   *  hands the answers to the adapter — which resolves the parked tool call and
   *  emits `user-input.resolved` (a belt-and-braces re-clear). */
  async function respondUserInput(requestId: string, answers: UserInputAnswers): Promise<void> {
    if (pendingUserInput.value?.requestId === requestId) {
      pendingUserInput.value = null;
    }
    const api = bridge();
    if (!api) return;
    try {
      await api.respondUserInput(threadId.value, requestId, answers);
    } catch {
      // If the send fails the turn will abort and clear state via turn.aborted.
    }
  }

  function setProvider(next: ProviderKind): void {
    provider.value = next;
  }
  function setModel(id: string | undefined): void {
    model.value = id;
  }
  function setMode(next: InteractionMode): void {
    mode.value = next;
  }
  function setReasoning(next: ReasoningTier): void {
    reasoning.value = next;
  }
  function setServiceTier(id: string | undefined): void {
    serviceTier.value = id;
  }
  function setContextWindow(id: string | undefined): void {
    contextWindow.value = id;
  }

  /** Tear down: stop the session process + halt any mock. The manager owns the
   *  shared event listener, so there's nothing to detach here. */
  async function dispose(): Promise<void> {
    // Latch first — a still-awaiting openStored() reads this the moment its
    // history load resolves and bails before adopting the id or starting.
    forgotten = true;
    stopMock();
    const api = bridge();
    // Only stop a session we actually started — on the recent-open fast path
    // dispose() may run before any spawn, so there's nothing to tear down.
    if (api && session.value) {
      try {
        await api.stopSession(threadId.value);
      } catch {
        // best-effort
      }
    }
    session.value = null;
  }

  /** Tear the live session down and start a fresh one under a new thread id.
   *  Used when a change can't be applied to a running session — switching
   *  provider (a different CLI entirely), or changing a Claude model, whose
   *  effort/model are baked when the SDK subprocess spawns. Prior turns stay on
   *  screen as history; new turns stream in under the new session. */
  async function restart(): Promise<void> {
    await dispose();
    // A restart is a deliberate re-birth of this session (provider/model switch),
    // not a teardown — clear the dispose() latch so start() below runs.
    forgotten = false;
    rehydratedOnce = true;
    threadId.value = uid();
    tokenUsage.value = null;
    error.value = null;
    sessionState.value = "starting";
    await start();
  }

  // ── browser dev mock ────────────────────────────────────────────────────────

  // Pending timers for the in-flight mock turn, plus a cancel latch the async
  // script checks between steps — stopMock clears both so an interrupt or unmount
  // halts the reply cleanly.
  let mockTimers: Array<ReturnType<typeof setTimeout>> = [];
  let mockCancel: (() => void) | null = null;
  let mockTurnId: string | null = null;

  function stopMock(): void {
    for (const t of mockTimers) clearTimeout(t);
    mockTimers = [];
    mockCancel?.();
    mockCancel = null;
    mockTurnId = null;
  }

  // Browser dev only. Streams a canned turn that exercises the WHOLE interleaved
  // timeline the real providers produce — a short thought, a tool call mid-think,
  // a line of narration, another tool call AFTER that text, an optional second
  // thought, then the final answer. Items arrive in true chronological order
  // (the same order CodexAdapter's item/started · item/completed notifications
  // feed the desktop side), so the thread can render every ordering case —
  // tools-at-start, tool-after-text, thinking, final text — without the bridge.
  function mockTurn(prompt: string, opts: { demo?: boolean } = {}): void {
    const turnId = uid();
    mockTurnId = turnId;
    let cancelled = false;
    mockCancel = () => (cancelled = true);
    sessionState.value = "running";
    // The turn starts immediately but produces nothing yet — we simulate the
    // model connecting before the first item arrives.
    reduce({ ...base("turn.started"), type: "turn.started", turnId } as RuntimeEvent);

    const emit = (item: RuntimeItem, type: "item.started" | "item.updated" | "item.completed") =>
      reduce({ ...base(type), type, turnId, item: { ...item } } as RuntimeEvent);
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          mockTimers = mockTimers.filter((x) => x !== t);
          resolve();
        }, ms);
        mockTimers.push(t);
      });
    // Stream a text-bearing item (a thought or the answer) word-by-word.
    const stream = async (kind: RuntimeItemKind, full: string, perWord = 42): Promise<void> => {
      const item: RuntimeItem = { itemId: uid(), kind, status: "in-progress", text: "" };
      emit(item, "item.started");
      for (const w of full.split(" ")) {
        if (cancelled) return;
        item.text += (item.text ? " " : "") + w;
        emit(item, "item.updated");
        await wait(perWord);
      }
      item.status = "completed";
      emit(item, "item.completed");
    };
    // A tool call: lands in-progress (its live slot pulses), then completes.
    // `output`, when given, is the expandable full result body (fake stdout/
    // diff) — exercises the same detail-expand path a real tool call uses.
    const tool = async (name: string, summary: string, output?: string, ms = 640): Promise<void> => {
      const item: RuntimeItem = {
        itemId: uid(),
        kind: "tool_call",
        status: "in-progress",
        name,
        text: `${name}: ${summary}`,
      };
      emit(item, "item.started");
      await wait(ms);
      if (cancelled) return;
      item.status = "completed";
      if (output) item.detail = output;
      emit(item, "item.completed");
    };
    // A tool call that comes back failed — the red "failed" state + its error
    // output, so that path is on screen too instead of only the happy one.
    const toolFail = async (name: string, summary: string, error: string, ms = 640): Promise<void> => {
      const item: RuntimeItem = {
        itemId: uid(),
        kind: "tool_call",
        status: "in-progress",
        name,
        text: `${name}: ${summary}`,
      };
      emit(item, "item.started");
      await wait(ms);
      if (cancelled) return;
      item.status = "failed";
      item.detail = error;
      emit(item, "item.completed");
    };

    // A thinking segment with no surfaced text — the "model didn't share its
    // reasoning" case (a bare "Thought for Xs" label, no disclosure).
    const emptyThought = async (ms = 900): Promise<void> => {
      const item: RuntimeItem = { itemId: uid(), kind: "reasoning_text", status: "in-progress", text: "" };
      emit(item, "item.started");
      await wait(ms);
      if (cancelled) return;
      item.status = "completed";
      emit(item, "item.completed");
    };
    // A TodoWrite-style plan — one item that can be updated in place as tasks
    // move pending → in-progress → completed, then settles at the end.
    let planItem: RuntimeItem | null = null;
    const setPlan = async (tasks: readonly PlanTask[], hold = 0): Promise<void> => {
      if (hold) await wait(hold);
      if (cancelled) return;
      const text = formatPlanTasks(tasks);
      const structured = tasks.map((t) => ({ ...t }));
      if (!planItem) {
        planItem = {
          itemId: uid(),
          kind: "plan_text",
          status: "in-progress",
          text,
          tasks: structured,
        };
        emit(planItem, "item.started");
      } else {
        planItem.text = text;
        planItem.tasks = structured;
        emit(planItem, "item.updated");
      }
    };
    const finishPlan = async (): Promise<void> => {
      if (!planItem || cancelled) return;
      planItem.status = "completed";
      emit(planItem, "item.completed");
    };

    const demoPlan: PlanTask[] = [
      { id: uid(), content: "Tour every tool family in the thread", status: "pending" },
      { id: uid(), content: "Show task plans updating mid-turn", status: "pending" },
      { id: uid(), content: "Stream the final markdown answer", status: "pending" },
      {
        id: uid(),
        content: "Verify failed-tool and empty-thought states",
        status: "pending",
      },
    ];
    const demoPlanAt = (updates: Partial<Record<number, PlanTask["status"]>>): PlanTask[] =>
      demoPlan.map((task, i) => ({
        ...task,
        status: updates[i] ?? task.status,
      }));

    // The demo forces the full spread regardless of the picked reasoning tier;
    // a normal turn only shows thinking when the model is actually reasoning.
    const thinky = opts.demo || reasoning.value === "high" || reasoning.value === "thinking";

    void (async () => {
      await wait(1400); // connecting beat
      if (cancelled) return;
      if (thinky) {
        await stream(
          "reasoning_text",
          "Let me trace how the composer talks to the session before I touch anything — reading the wiring first, then the reducer.",
        );
        if (cancelled) return;
      }
      if (opts.demo) {
        await setPlan(demoPlan, 360);
        if (cancelled) return;
      }
      // Tool calls at the start of the turn (before any answer text).
      await tool("read_file", "AgentComposer.vue");
      if (cancelled) return;
      if (opts.demo) {
        await setPlan(demoPlanAt({ 0: "in-progress" }), 420);
        if (cancelled) return;
      }
      await tool(
        "grep_search",
        "useAgent · 6 matches",
        "AgentComposer.vue:42:  emit(\"send\", trimmed);\nAgentComposer.vue:58:  emit(\"interrupt\");\nuseAgent.ts:205:  async function send(text: string)\nuseAgent.ts:233:  async function interrupt()\nuseAgent.ts:256:  function setModel(id)\nuseAgent.ts:262:  function setReasoning(next)",
      );
      if (cancelled) return;
      // A longer, unhurried middle for the normal (non-demo) mock — enough steps,
      // with generous pauses between them, that you can step back out to the
      // working tree and watch the away-from-thread status pill work through its
      // states (Reading → Thinking → Editing → Working) before the reply lands.
      if (!opts.demo) {
        await tool("read_file", "app/components/example.vue", undefined, 1500);
        if (cancelled) return;
        await tool("list_dir", "app/components", undefined, 1100);
        if (cancelled) return;
        await stream(
          "reasoning_text",
          "I can see how the pieces connect now — the composer hands each turn to the session and the reducer folds the events back into this timeline. Let me line up the edits before I touch anything.",
        );
        if (cancelled) return;
        await tool("grep_search", "describeTurnActivity · 3 matches", undefined, 1200);
        if (cancelled) return;
        await tool("edit_file", "app/components/example.vue", undefined, 1600);
        if (cancelled) return;
        await tool("write_to_file", "docs/example.md", undefined, 1400);
        if (cancelled) return;
        await tool(
          "bash",
          "bun run check-types",
          " ✓ no type errors\nDone in 3.1s",
          1800,
        );
        if (cancelled) return;
      }
      // The demo tours every tool family the real providers can produce — list,
      // code-intel, run, web, sub-agent, delete — plus a failed call, so every
      // visual state is on screen to review, not just the read/write/search trio.
      if (opts.demo) {
        await setPlan(demoPlanAt({ 0: "completed", 1: "in-progress" }), 380);
        if (cancelled) return;
        await tool("list_dir", "apps/web/app/components", undefined, 420);
        if (cancelled) return;
        await tool("go_to_definition", "segKindOf → useAgent.ts:167", undefined, 380);
        if (cancelled) return;
        await setPlan(demoPlanAt({ 0: "completed", 1: "completed", 2: "in-progress" }), 360);
        if (cancelled) return;
      }
      // A line of narration…
      await stream(
        "assistant_text",
        "Here's the shape of it: the composer emits a turn, and `useAgent` folds the provider's event stream into this timeline in arrival order.",
      );
      if (cancelled) return;
      // …then a tool call AFTER that text (the interleaving case). The demo gives
      // it an expandable diff body so the tool-output case is on screen too.
      await tool(
        "edit_file",
        "ConversationThread.vue",
        opts.demo
          ? "@@ -472,3 +472,4 @@\n-    <p class=\"body body--stream\">{{ segText(seg) }}</p>\n+    <MarkdownMessage class=\"answer\" :source=\"segText(seg)\" />\n"
          : undefined,
      );
      if (cancelled) return;
      if (opts.demo) {
        await setPlan(
          demoPlanAt({ 0: "completed", 1: "completed", 2: "completed", 3: "in-progress" }),
          360,
        );
        if (cancelled) return;
      }
      if (opts.demo) {
        await tool(
          "write_to_file",
          "MarkdownMessage.vue",
          "+ // Each word gets its own stable key so it mounts as a genuinely new\n+ // element the instant it streams in.\n+ function renderWords(content: string, key: number): VNode { … }\n",
          520,
        );
        if (cancelled) return;
        // A second thought, mid-turn — the demo's first thinking segment is
        // interrupted by tool calls, so this shows a fresh one re-opening the
        // rail further down the same steps group.
        await stream(
          "reasoning_text",
          "Before wiring it up, let me make sure the existing suite still passes and the lint config agrees.",
        );
        if (cancelled) return;
        await tool(
          "bash",
          "bun test useAgent",
          " 12 pass\n 0 fail\n 27 expect() calls\nRan 12 tests across 1 file. [412ms]",
          900,
        );
        if (cancelled) return;
        await toolFail(
          "bash",
          "bun run lint",
          "apps/web/app/components/ConversationThread.vue\n  482:11  error  'toolsLive' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)",
          700,
        );
        if (cancelled) return;
        await tool("web_search", "markdown-it incremental token streaming", undefined, 640);
        if (cancelled) return;
        await tool(
          "web_fetch",
          "vercel.com/blog/ai-sdk · smoothStream",
          "Fetched 1 page · 2.1 KB extracted",
          760,
        );
        if (cancelled) return;
        await tool(
          "task",
          "Audit the step-list rail for regressions",
          "Sub-agent checked the connecting line across 4 group shapes (thinking-only, tools-only, mixed, text-broken) — no gaps found.",
          1400,
        );
        if (cancelled) return;
        await tool("rm", "tmp/scratch.log", undefined, 340);
        if (cancelled) return;
        // A tool name the table doesn't recognise — exercises the fallback
        // (neutral hue, auto Title-Cased label) rather than a mapped family.
        await tool("capture_screenshot", "conversation-thread--states.png", undefined, 420);
        if (cancelled) return;
      }
      // The demo shows the no-content thinking case; a normal thinky turn shows a
      // second thought that DOES carry text.
      if (opts.demo) {
        await setPlan(
          demoPlan.map((task) => ({ ...task, status: "completed" as const })),
          360,
        );
        if (cancelled) return;
        await finishPlan();
        if (cancelled) return;
        await emptyThought();
        if (cancelled) return;
      } else if (thinky) {
        await stream("reasoning_text", "That covers the ordering; now I'll state the result plainly.");
        if (cancelled) return;
      }
      // The final answer. The demo's closing reply also tours MarkdownMessage's
      // whole rendering surface — heading, list, table, fenced code, a callout,
      // and a local file chip — so typography states are reviewable too.
      await stream(
        "assistant_text",
        opts.demo
          ? `Done — for "${prompt}", here's the full tour.\n\n### What ran\n\n- Every part above — thinking, tool calls, narration — renders in the true order it arrived\n- The agent's task plan docks bottom-right (folder-picker shell) while it works the list\n- Tool calls span every family: read, write, list, code intel, shell, web, sub-agent, and delete\n- One \`bash\` call above **failed on purpose** — the red state is real, not a screenshot\n\n| Family | Tool | Hue |\n| --- | --- | --- |\n| Read | \`read_file\` | blue |\n| Write | \`edit_file\` | violet |\n| Search | \`grep_search\` | amber |\n| Run | \`bash\` | green |\n\n\`\`\`ts\nfunction segKindOf(item: RuntimeItem): SegKind {\n  if (item.kind === "reasoning_text") return "thinking";\n  if (item.kind === "tool_call") return "tools";\n  if (item.kind === "plan_text") return "plan";\n  return "text";\n}\n\`\`\`\n\n> [!NOTE]\n> This whole reply is a mocked stream — no agent ran in the browser — but every event passed through the same [ConversationThread.vue](file:///apps/web/app/components/ConversationThread.vue) timeline the real providers feed. Press **⇧⌘D** any time to replay it.`
          : `Done — for "${prompt}", the parts now render in the true order they arrived: thinking, tool calls, and text interleaved, exactly like a real ${provider.value} session. This is a mocked reply (no agent ran in the browser), but every event flowed through the same stream.`,
      );
      if (cancelled) return;
      // Feed the context meter so its come-in and fill are reviewable in browser
      // dev (no bridge) — it grows with each turn toward the window, crossing the
      // warm/full colour steps after enough turns. No-op cost in the desktop mock.
      const priorTurns = blocks.value.filter((b) => b.role === "user").length;
      const contextWindow = 200_000;
      const contextUsed = Math.min(contextWindow, 14_000 + priorTurns * 26_000);
      tokenUsage.value = { total: contextUsed, contextUsed, contextWindow, compactsAutomatically: true };
      reduce({ ...base("turn.completed"), type: "turn.completed", turnId } as RuntimeEvent);
      sessionState.value = "ready";
      stopMock();
    })();
  }

  /** Play a scripted demo conversation — a user turn plus a full assistant reply
   *  (thinking with text, a live task plan, tool calls with output, narration, a
   *  no-content thought, and the final answer). Runs the in-browser mock directly
   *  so it works even in the desktop shell, for reviewing the conversation UI
   *  without a live agent. Bound to ⇧⌘D via the shortcuts registry. */
  function demo(): void {
    if (busy.value) return;
    const prompt = "Show me a full conversation";
    blocks.value = [...blocks.value, { id: uid(), role: "user", text: prompt, at: Date.now() }];
    if (!title.value) title.value = titleFromPrompt(prompt);
    mockTurn(prompt, { demo: true });
  }

  function base(_type: string) {
    return {
      threadId: threadId.value,
      provider: provider.value,
      at: Date.now(),
      source: "codex.rpc.lifecycle" as const,
    };
  }

  return {
    key,
    // identity
    threadId,
    provider,
    title,
    // state
    blocks,
    session,
    sessionState,
    busy,
    everRan,
    error,
    tokenUsage,
    pendingUserInput,
    model,
    mode,
    reasoning,
    serviceTier,
    contextWindow,
    // reduction (manager calls this for our events)
    reduce,
    // actions
    start,
    openStored,
    restart,
    send,
    uploadAttachment,
    demo,
    interrupt,
    respondUserInput,
    setProvider,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    setContextWindow,
    dispose,
  };
}

// ── the project's thread manager ────────────────────────────────────────────────

import { isThreadSessionBlank } from "~/utils/panes";

/** How many idle, settled background threads to keep resident. Busy threads are
 *  never evicted; this only bounds the settled backlog so the registry (and the
 *  pill stack) can't grow without end. */
const MAX_RESIDENT_THREADS = 6;

export function useAgent(options: UseAgentOptions) {
  const ctx: SessionCtx = {
    options,
    bridge: () => (import.meta.client ? window.koneDesktop?.agent : undefined),
    resolveCwd: () => (typeof options.cwd === "function" ? options.cwd() : options.cwd),
  };

  // The registry: every thread this project has open, live or backgrounded.
  // shallowRef so Vue doesn't deep-reactive-wrap the session objects (which
  // would unwrap their inner refs) — we swap the array on add/remove instead.
  const sessions = shallowRef<ThreadSession[]>([]);
  const activeKey = ref("");
  // In-flight openThread() calls, keyed by thread id — guards the double-open
  // race (a second open before the first has adopted the id). Carries the
  // loading session's key so a repeat open can re-activate it (the session's
  // threadId isn't adopted until openStored resolves, so it can't be found by
  // id yet).
  const opening = new Map<string, { key: string; promise: Promise<void> }>();

  function spawn(init: { rehydrate?: boolean } = {}): ThreadSession {
    const s = createThreadSession(ctx, init);
    sessions.value = [...sessions.value, s];
    return s;
  }

  async function evict(s: ThreadSession): Promise<void> {
    sessions.value = sessions.value.filter((x) => x !== s);
    await s.dispose();
  }

  /** Copy the user's picked settings from one session onto another before it
   *  starts, so spawning a replacement thread (new conversation, or a fresh
   *  thread after forgetting the active one) keeps the provider/model/reasoning/
   *  mode/serviceTier/contextWindow the composer is showing rather than snapping
   *  back to the registry's boot defaults. start() bakes provider+model into the
   *  session spawn, so this must run before start(). */
  function inheritSettings(from: ThreadSession, to: ThreadSession): void {
    to.setProvider(from.provider.value);
    to.setModel(from.model.value);
    to.setMode(from.mode.value);
    to.setReasoning(from.reasoning.value);
    to.setServiceTier(from.serviceTier.value);
    to.setContextWindow(from.contextWindow.value);
  }

  /** Trim settled, idle background threads down to the resident cap — oldest
   *  first, never the active one and never anything still busy. */
  function pruneResident(): void {
    const idle = sessions.value.filter(
      (s) => s.key !== activeKey.value && !s.busy.value,
    );
    const overflow = sessions.value.length - MAX_RESIDENT_THREADS;
    for (let i = 0; i < overflow && i < idle.length; i++) {
      const s = idle[i];
      if (s) void evict(s);
    }
  }

  // The first thread — rehydrates the project's latest on its first start.
  const first = spawn({ rehydrate: options.rehydrate });
  activeKey.value = first.key;

  /** The thread the conversation view currently shows. Falls back to the first
   *  resident one — and to null when the registry is empty, which is a legitimate
   *  board state now: the board may hold only a terminal / scratchpad, with no
   *  thread column at all. Every projection below is null-safe for that case
   *  (the composer is hidden when the focused pane isn't a thread, so nothing
   *  renders the fallbacks; they exist so a stray read can't throw). */
  const active = computed<ThreadSession | null>(
    () => sessions.value.find((s) => s.key === activeKey.value) ?? sessions.value[0] ?? null,
  );

  // ── one event ingress, fanned out by threadId ───────────────────────────────
  // Replaces the old per-session "drop if not my thread" filter: a single
  // listener routes each event to the session that owns its threadId, so a
  // backgrounded thread keeps folding its turns while another is on screen.
  let detach: (() => void) | null = null;
  if (import.meta.client) {
    const api = ctx.bridge();
    if (api) {
      detach = api.onEvent((event: RuntimeEvent) => {
        const s = sessions.value.find((x) => x.threadId.value === event.threadId);
        s?.reduce(event);
      });
    }
  }

  // A slow tick so "working · Xs" counts up live while ANY thread runs (the
  // final "replied in Xs" is read from at/endedAt). Only runs while something is
  // busy — shared across the active thread and every backgrounded pill.
  const anyBusy = computed(() => sessions.value.some((s) => s.busy.value));
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | null = null;
  watch(anyBusy, (on) => {
    if (on && clock === null) {
      now.value = Date.now();
      clock = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!on && clock !== null) {
      clearInterval(clock);
      clock = null;
    }
  });

  // ── active-thread projection (the public state the view binds) ───────────────
  const NO_BLOCKS: ThreadBlock[] = [];
  const threadId = computed(() => active.value?.threadId.value ?? "");
  const provider = computed(() => active.value?.provider.value ?? options.provider);
  const title = computed(() => active.value?.title.value ?? "");
  const blocks = computed(() => active.value?.blocks.value ?? NO_BLOCKS);
  const session = computed(() => active.value?.session.value ?? null);
  const sessionState = computed<RuntimeSessionState>(
    () => active.value?.sessionState.value ?? "stopped",
  );
  const busy = computed(() => active.value?.busy.value ?? false);
  const error = computed(() => active.value?.error.value ?? null);
  const tokenUsage = computed(() => active.value?.tokenUsage.value ?? null);
  const pendingUserInput = computed(() => active.value?.pendingUserInput.value ?? null);
  const model = computed(() => active.value?.model.value ?? options.model);
  const mode = computed<InteractionMode>(
    () => active.value?.mode.value ?? options.mode ?? "accept-edits",
  );
  const reasoning = computed<ReasoningTier>(
    () => active.value?.reasoning.value ?? options.reasoning ?? "medium",
  );
  const serviceTier = computed(() => active.value?.serviceTier.value ?? options.serviceTier);
  const contextWindow = computed(() => active.value?.contextWindow.value ?? options.contextWindow);

  /** Every thread's background snapshot — what the away-from-thread pill stack
   *  reads to decide which threads to surface. */
  const threads = computed<ThreadSummary[]>(() =>
    sessions.value.map((s) => ({
      key: s.key,
      threadId: s.threadId.value,
      title: s.title.value,
      provider: s.provider.value,
      block: latestAssistant(s.blocks.value),
      task: activePlanTask(s.blocks.value),
      busy: s.busy.value,
      everRan: s.everRan.value,
      isActive: s.key === activeKey.value,
    })),
  );

  // ── active-thread actions (delegate to whichever thread is on screen) ────────
  // Each delegates to the focused thread — and no-ops when the board has no
  // thread column at all (see `active`).
  const start = async () => { await active.value?.start(); };
  const send = async (text: string, attachments?: ChatAttachment[]) => {
    await active.value?.send(text, attachments);
  };
  const uploadAttachment = (file: File): Promise<ChatAttachment> => {
    const s = active.value;
    if (!s) return Promise.reject(new Error("No thread column is open."));
    return s.uploadAttachment(file);
  };
  const interrupt = async () => { await active.value?.interrupt(); };
  const respondUserInput = async (requestId: string, answers: UserInputAnswers) => {
    await active.value?.respondUserInput(requestId, answers);
  };
  const demo = () => active.value?.demo();
  const restart = async () => { await active.value?.restart(); };
  const setProvider = (next: ProviderKind) => active.value?.setProvider(next);
  const setModel = (id: string | undefined) => active.value?.setModel(id);
  const setMode = (next: InteractionMode) => active.value?.setMode(next);
  const setReasoning = (next: ReasoningTier) => active.value?.setReasoning(next);
  const setServiceTier = (id: string | undefined) => active.value?.setServiceTier(id);
  const setContextWindow = (id: string | undefined) => active.value?.setContextWindow(id);

  // ── thread lifecycle (registry-level: switch, never tear the others down) ────

  /** Make a resident thread the active one — no teardown, the others keep
   *  running in the background. */
  function setActiveThread(id: string): void {
    const s = sessions.value.find((x) => x.threadId.value === id);
    if (s) activeKey.value = s.key;
  }

  /** Begin a brand-new, empty thread and make it active. The previously-active
   *  thread stays resident (it may still be running — the pill will surface it),
   *  unless it was a never-used throwaway, which we prune. No-ops when the
   *  active thread is already empty — don't stack blank slates. */
  async function newThread(): Promise<void> {
    const prev = active.value;
    if (prev && isThreadSessionBlank(prev)) return;
    const fresh = spawn({ rehydrate: false });
    // Carry the active thread's picked settings onto the new one (see
    // inheritSettings) so starting a conversation from Project Home keeps the
    // composer's provider/model/reasoning/mode rather than the boot defaults.
    if (prev && prev !== fresh) inheritSettings(prev, fresh);
    activeKey.value = fresh.key;
    await fresh.start();
    // Drop the prior thread if it's idle and never ran a live turn this session —
    // whether a blank slate or the project's rehydrated latest the user stepped
    // past to start something new. Its transcript is on disk, so reopening it
    // from recent sessions just resumes it. A thread that ran (or is running)
    // stays resident so it keeps streaming and pilling.
    if (prev && prev !== fresh && !prev.busy.value && !prev.everRan.value) {
      await evict(prev);
    }
    pruneResident();
  }

  /** Open a blank thread at a specific strip index (0 = left edge). Used by the
   *  seam action bar to insert left or right of a column boundary. */
  async function newThreadAt(index: number): Promise<void> {
    const fresh = spawn({ rehydrate: false });
    const list = [...sessions.value];
    list.pop();
    const insertAt = Math.min(Math.max(0, index), list.length);
    list.splice(insertAt, 0, fresh);
    sessions.value = list;

    const neighbor = list[insertAt - 1] ?? list[insertAt + 1];
    if (neighbor) inheritSettings(neighbor, fresh);

    activeKey.value = fresh.key;
    await fresh.start();
    pruneResident();
  }

  /** Bring a specific stored thread on-screen. If it's already resident (still
   *  running in the background, say), just activate it — no reload, no teardown.
   *  Otherwise spin up a session for it, load its transcript, and continue it. */
  async function openThread(id: string): Promise<void> {
    const existing = sessions.value.find((x) => x.threadId.value === id);
    if (existing) {
      activeKey.value = existing.key;
      return;
    }
    // Dedupe concurrent opens of the same thread. openStored only adopts the
    // thread id after an `await`, so a second rapid call would miss the
    // `existing` check above and spin up a duplicate session bound to the same
    // thread. While an open is in flight, fold later calls into it — but still
    // re-activate the loading session, since a repeat open is the user's latest
    // intent (open A, B, then A again must end on A, not B).
    const inFlight = opening.get(id);
    if (inFlight) {
      activeKey.value = inFlight.key;
      return inFlight.promise;
    }
    // If the active thread is idle and never ran a live turn this session (a
    // blank slate or a rehydrated latest the user stepped past), drop it rather
    // than stacking it behind the opened thread — its transcript is on disk.
    const prev = active.value;
    const s = spawn({ rehydrate: false });
    activeKey.value = s.key;
    const promise = (async () => {
      await s.openStored(id);
      // Never evict the thread that's now active (under interleaved opens `prev`
      // may have been re-activated by a later request) nor one whose own open is
      // still in flight (evicting would dispose it mid-load).
      const prevOpening = prev && [...opening.values()].some((e) => e.key === prev.key);
      if (
        prev &&
        prev !== s &&
        prev.key !== activeKey.value &&
        !prevOpening &&
        !prev.busy.value &&
        !prev.everRan.value
      ) {
        await evict(prev);
      }
      pruneResident();
    })();
    opening.set(id, { key: s.key, promise });
    try {
      await promise;
    } finally {
      opening.delete(id);
    }
  }

  /** Drop a thread from the registry entirely — for when it's archived or
   *  deleted from the recent-sessions list. Tears the session down so its pill
   *  can't linger and stay clickable. If the forgotten thread was on screen,
   *  fall back to a fresh empty thread so the view never points at a disposed
   *  session (and `active` never falls back to a stale one). */
  async function forgetThread(id: string): Promise<void> {
    // A thread whose open is still in flight hasn't adopted `id` yet, so it
    // can't be found by threadId — fall back to the loading session the open
    // registered under this id. Evicting it latches it forgotten (see
    // dispose()), so its pending openStored bails before revealing or (on
    // delete) recreating the removed thread.
    const pending = opening.get(id);
    const s =
      sessions.value.find((x) => x.threadId.value === id) ??
      (pending ? sessions.value.find((x) => x.key === pending.key) : undefined);
    if (!s) return;
    const wasActive = s.key === activeKey.value;
    // Stand up the replacement BEFORE evicting, so `active` never falls back to
    // an undefined session mid-teardown (evict removes `s` before its dispose()
    // resolves). Inherit the forgotten thread's settings so the replacement
    // keeps the composer's provider/model/reasoning/mode, not the boot defaults.
    if (wasActive) {
      const fresh = spawn({ rehydrate: false });
      inheritSettings(s, fresh);
      activeKey.value = fresh.key;
      await fresh.start();
    }
    await evict(s);
  }

  // ── the strip (niri-style scrollable tiling over the registry) ───────────────
  // The registry's array order IS the left-to-right column order of the thread
  // strip, and `activeKey` is the focused column. These four are what the strip
  // navigates with; they all work in terms of the stable registry key rather than
  // the provider threadId, because a brand-new column has no threadId yet.

  /** Focus a column by its stable registry key. */
  function focusThread(key: string): void {
    if (sessions.value.some((s) => s.key === key)) activeKey.value = key;
  }

  /** Step focus `delta` columns along the strip. Clamped at both ends — niri's
   *  focus-column-left/right stop at the edge rather than wrapping, and wrapping
   *  would make the strip feel like a carousel instead of a place. */
  function focusByOffset(delta: number): void {
    const list = sessions.value;
    const i = list.findIndex((s) => s.key === activeKey.value);
    if (i === -1) return;
    const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next) activeKey.value = next.key;
  }

  /** Carry a column along the strip, focus and all (niri's move-column-left/
   *  right). Reordering the registry reorders the strip, since the strip renders
   *  `sessions` in order. */
  function moveThread(key: string, delta: number): void {
    const list = [...sessions.value];
    const i = list.findIndex((s) => s.key === key);
    if (i === -1) return;
    const j = Math.min(list.length - 1, Math.max(0, i + delta));
    if (i === j) return;
    const [s] = list.splice(i, 1);
    if (!s) return;
    list.splice(j, 0, s);
    sessions.value = list;
  }

  /** Close one column and hand focus to a neighbour (right first, then left —
   *  the strip collapses toward where you were heading).
   *
   *  Closing the LAST thread leaves the registry empty rather than respawning a
   *  blank one. The board owns the strip now, and a board of only a terminal (or
   *  only the scratchpad) is a legitimate layout — the old "never empty" respawn
   *  is what made an empty thread column reappear every time you closed the last
   *  one. `active` projects null in that state; the board re-opens a thread if
   *  the whole board would otherwise be empty. */
  async function closeThread(key: string): Promise<void> {
    const list = sessions.value;
    const i = list.findIndex((s) => s.key === key);
    const s = list[i];
    if (!s) return;
    if (s.key === activeKey.value) {
      const neighbour = list[i + 1] ?? list[i - 1];
      activeKey.value = neighbour ? neighbour.key : "";
    }
    await evict(s);
  }

  onBeforeUnmount(() => {
    if (clock !== null) clearInterval(clock);
    detach?.();
    detach = null;
    for (const s of sessions.value) void s.dispose();
  });

  return {
    // identity (active-thread projection)
    threadId,
    provider,
    title,
    // state (active-thread projection)
    blocks,
    session,
    sessionState,
    busy,
    error,
    tokenUsage,
    pendingUserInput,
    model,
    mode,
    reasoning,
    serviceTier,
    contextWindow,
    now,
    // the whole registry — for the away-from-thread pill stack
    threads,
    activeThreadId: threadId,
    setActiveThread,
    forgetThread,
    // the strip: live sessions in column order + the focused column. The strip
    // takes the sessions themselves (not the `threads` projection) on purpose —
    // each column reads its own `blocks` ref, so one thread streaming a token
    // re-renders only its own column instead of every column on screen.
    sessions,
    activeKey,
    focusThread,
    focusByOffset,
    moveThread,
    closeThread,
    // actions
    start,
    restart,
    newThread,
    newThreadAt,
    openThread,
    send,
    uploadAttachment,
    demo,
    interrupt,
    respondUserInput,
    setProvider,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    setContextWindow,
  };
}
