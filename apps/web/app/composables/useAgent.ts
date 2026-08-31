import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import type {
  ApprovalDecision,
  ChatAttachment,
  ForkContext,
  InteractionMode,
  KoneAgentApi,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
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
  UserInputAnswers,
} from "~/types/desktop";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { agentPersonaForThread, carryThreadAgent } from "~/utils/agents";
import { peelIpcError } from "~/utils/ipcError";
import { EFFORT_META } from "~/utils/modelCatalog";
import { bootMode, MODES } from "~/utils/modelPicker";
import { activePlanTask } from "~/utils/planTasks";

import {
  type UserBlock,
  type AssistantBlock,
  type ThreadBlock,
  type PendingUserInput,
  type PendingApproval,
  type ThreadAttention,
  type QueuedTurnEntry,
  type QueueBridge,
  type ReasoningTier,
  type UseAgentOptions,
  type ThreadSummary,
  type SessionCtx,
} from "./agentTypes";

import {
  takePrefetched,
  markHistorical,
  uid,
  fileToBase64,
  latestAssistant,
  setChildApproval,
  clearChildApproval,
  clearChildApprovalFor,
  originSubagentOfApproval,
  titleFromPrompt,
} from "./agentPrefetch";

import { createMockTurnRunner } from "./agentMock";
import { getSideChatSource, rememberSideChatSource } from "./sideChats";

export type ThreadSession = ReturnType<typeof createThreadSession>;

/** User prompts per windowed page (history.threadPage). This IS the
 *  "threshold" for pagination: the store's window is user-anchored, so a
 *  thread with at most PAGE_LIMIT prompts comes back whole (`hasMore` false)
 *  — byte-for-byte the same transcript the full read would return, in one
 *  round-trip — while a longer thread returns its newest window and pages the
 *  rest on demand. No separate block-count probe is needed (probing would
 *  require loading the full thread first, which is exactly the cost
 *  pagination avoids); `hasMore` is the store's authoritative signal. */
const PAGE_LIMIT = 10;

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
  /** Keyset pagination state for a stored thread adopted windowed (see
   *  history.threadPage): the opaque cursor for the next strictly older page,
   *  null when the whole thread is in hand. `hasOlder` is what the load-older
   *  affordance reads; the cursor itself never leaves the session. */
  const olderCursor = ref<string | null>(null);
  const loadingOlder = ref(false);
  const olderError = ref<string | null>(null);
  const hasOlder = computed(() => olderCursor.value !== null);
  /** True when this session hosts a side chat — a root thread forked from
   *  another thread (docs/side-chat-design.md). Set when the stored thread's
   *  forkContext is adopted; cleared on restart (a fresh thread is never a
   *  side chat). Drives the temporary look and the timeline's hiding of the
   *  fork-imported transcript. */
  const sideChat = ref(false);
  /** The thread this side chat was forked from (forkContext.sourceThreadId). */
  const sideChatSource = ref<string | null>(null);
  /** Did the last openStored read come back empty-handed? The honest signal
   *  behind the "this conversation didn't load" banner — an empty timeline is
   *  NOT the same thing (a side chat's whole transcript is hidden by design,
   *  so inferring failure from emptiness accuses every fresh side chat of a
   *  load it never attempted). Only a read that found neither a page nor a
   *  thread sets this. */
  const transcriptLoadFailed = ref(false);
  const isSideChat = computed(() => sideChat.value);
  /** The timeline the conversation view renders: a side chat hides its
   *  fork-imported transcript (reference-only context — the model sees it via
   *  the one-shot bootstrap, the user sees only the side chat's own turns), a
   *  normal thread renders everything. `blocks` stays the full source of
   *  truth for busy/persistence/dock state. */
  const timelineBlocks = computed<ThreadBlock[]>(() =>
    isSideChat.value
      ? blocks.value.filter(
          // SAFETY: only fork imports carry a `source` tag; others read as undefined.
          (b) => (b as ThreadBlock & { source?: string }).source !== "fork-import",
        )
      : blocks.value,
  );
  /** Agent-named (or first-turn word-fallback) working title. Empty until the
   *  first user turn or a rehydrated/opened thread that already has one. */
  const title = ref("");
  const session = shallowRef<Session | null>(null);
  const sessionState = ref<RuntimeSessionState>("starting");
  const error = ref<string | null>(null);
  /** A non-fatal provider warning (adapter `session.warning` — e.g. a Codex
   *  error notification with willRetry, or a benign notice). The session keeps
   *  running; this is a transient surface, cleared on the next state change or
   *  turn. Never flips the session into the error state. */
  const warning = ref<string | null>(null);
  const tokenUsage = ref<TokenUsage | null>(null);
  // A live question the agent is asking (AskUserQuestion / Codex requestUserInput).
  // Non-null while the modal is up; cleared once answered or resolved/aborted.
  const pendingUserInput = ref<PendingUserInput | null>(null);
  // Live tool approvals the agent is parked on (Codex requestApproval / Claude
  // canUseTool / ACP request_permission / OpenCode permission). A queue, not a
  // single slot: providers can ask for several tools in parallel (Claude's
  // parallel tool calls), and each must be answerable or its parked request
  // hangs the turn. The modal shows the head.
  const pendingApprovals = ref<PendingApproval[]>([]);
  /** The child threads THIS thread spawned via kone_spawn_thread — what the
   *  corner Subagents dock reads. Live-only state: the spawn events are
   *  deliberately not journaled (reduce isn't a replay), so a session that
   *  adopts a stored identity re-seeds it by an explicit query instead (see
   *  seedSpawnedChildren). */
  const spawnedChildren = ref<SpawnedThread[]>([]);
  const pendingApproval = computed<PendingApproval | null>(() => pendingApprovals.value[0] ?? null);

  /** The one "needs a human" signal for this thread, derived straight from the
   *  live parked requests. A permission gate outranks a question — the turn is
   *  blocked behind the gate, so that's the ask to answer first. Null the moment
   *  both clear; nothing here is stored, so a resume can't strand it. */
  const attention = computed<ThreadAttention | null>(() => {
    const gate = pendingApprovals.value[0];
    if (gate) return { kind: "permission", detail: gate.approval.title };
    const q = pendingUserInput.value;
    if (q) return { kind: "question", detail: q.questions[0]?.header };
    return null;
  });

  /** Follow-ups durably queued behind the running turn (the AgentService queue
   *  slice: a send while busy is enqueued, promoted on settle, cancelled on
   *  stop). Live entries fold from turn.queued; a thread that adopts a stored
   *  identity re-seeds by an explicit bridge query (seedQueuedTurns) — the
   *  rows survive crashes, so a reloaded renderer has no record of them
   *  otherwise. Kept raw (backend positions); the exported `queuedTurns`
   *  computed renumbers for display. */
  const queuedTurnsRaw = ref<QueuedTurnEntry[]>([]);
  /** queueId → the renderer-minted user block id of the send that produced it.
   *  The store journals user prompts under ITS OWN block id (recordUserBlock
   *  mints internally), so a live optimistic block can't be matched by the
   *  turn.queued userBlockId until a reload reconciles the timeline. The
   *  send/steer ack carries the queue id (a busy enqueue acks with the queue
   *  id as turnId), which is how the chip finds its own block: recorded here
   *  on ack, consumed by the matching turn.queued, pruned at the next turn
   *  boundary (no queue event can arrive after the turn it belongs to has
   *  started). */
  const pendingQueueAnchors = new Map<string, string>();
  /** The queue as the UI reads it — entries renumbered so a cancellation
   *  leaves no gaps (the live turn is slot 1, so a queued entry reads 2, 3,
   *  …; with no live turn the line starts at 1). */
  const queuedTurns = computed<QueuedTurnEntry[]>(() =>
    queuedTurnsRaw.value.map((q, i) => ({ ...q, position: i + (busy.value ? 2 : 1) })),
  );

  /** Anchor a queue row to a transcript user block: by store id first
   *  (rehydrated/persisted rows), else by the renderer-side block the send
   *  ack recorded (live optimistic rows — see pendingQueueAnchors). Returns
   *  the block id, or undefined when the row predates this renderer
   *  (cross-window queue events) — the chip then renders from the row's own
   *  input text. */
  function anchorFor(userBlockId: string, queueId: string): string | undefined {
    const byId = blocks.value.find((b) => b.role === "user" && b.id === userBlockId);
    if (byId) return byId.id;
    const fromAck = pendingQueueAnchors.get(queueId);
    if (fromAck) {
      pendingQueueAnchors.delete(queueId);
      return fromAck;
    }
    return undefined;
  }

  // The provider is mutable so a thread can switch engines (Codex ↔ Claude).
  // Because the two are separate CLIs with no shared conversation, a switch is a
  // fresh session — restart() below tears the old one down and starts anew.
  const provider = ref<ProviderKind>(options.provider);
  // Module-scope singleton: every thread shares one probe result, so this is a
  // read of shared state, not a per-thread subscription.
  const providers = useAgentProviders();
  const model = ref(options.model);
  const mode = ref<InteractionMode>(
    options.mode ?? bootMode(ctx.resolveCwd() ?? "") ?? "accept-edits",
  );
  const reasoning = ref<ReasoningTier>(options.reasoning ?? "medium");
  const serviceTier = ref<string | undefined>(options.serviceTier);
  const contextWindow = ref<string | undefined>(options.contextWindow);

  // True from the moment a send is accepted until the turn is actually handed to
  // the provider. On a deferred thread that window contains the CLI spawn, so
  // without folding it into `busy` the composer would read as idle — and accept
  // a second send — while the first is still standing the session up.
  const dispatching = ref(false);

  // Busy while a turn is in flight — the composer disables send + shows stop.
  const busy = computed(
    () =>
      dispatching.value ||
      sessionState.value === "running" ||
      blocks.value.some((b) => b.role === "assistant" && b.state === "running"),
  );
  // Flips true the first time a live turn starts here (turn.started). Rehydrated
  // history never trips it, so a reloaded thread stays out of the pill stack
  // until it actually runs something.
  const everRan = ref(false);
  /** When this thread last saw activity — any folded event, a focus, or a send.
   *  The manager's eviction and idle reaper read it: eviction drops the
   *  least-recently-active settled thread (never a freshly-used one), and the
   *  reaper hibernates a started session whose process has sat idle past the
 */
  let lastActivityAt = Date.now();
  function touch(): void {
    lastActivityAt = Date.now();
  }

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
    // A tool_call that spawned a subagent keeps the run we've already nested on
    // it — later updates to the call itself (its result, status) must not drop
    // the child's transcript.
    if (idx === -1) block.items.push(item);
    else {
      const merged: RuntimeItem = { ...item };
      const existingSubagent = block.items[idx]!.subagent;
      if (existingSubagent) merged.subagent = existingSubagent;
      block.items[idx] = merged;
    }
    // Reassign so the shallow array ref stays reactive on nested edits.
    block.items = [...block.items];
  }

  /** Find a nested run within a turn by the tool-use id that spawned it. Runs
   *  live on their parent `tool_call` item, so this is a scan of the turn's
   *  items — cheap at kone's item counts, and it keeps the tree the single
   *  source of truth instead of a parallel index. */
  function findRun(block: AssistantBlock, toolUseId: string): SubagentRun | undefined {
    for (const item of block.items) {
      if (item.subagent?.toolUseId === toolUseId) return item.subagent;
    }
    return undefined;
  }

  /** Merge a subagent snapshot into the turn, attaching the run to its parent
   *  tool_call item the first time we see it. The adapter emits pieces (snapshots
   *  + tagged items); assembling the tree is the consumer's job. */
  function upsertRun(block: AssistantBlock, snapshot: SubagentRunSnapshot): SubagentRun | undefined {
    const existing = findRun(block, snapshot.toolUseId);
    if (existing) {
      Object.assign(existing, snapshot);
      blocks.value = [...blocks.value];
      return existing;
    }
    // The parent tool call is normally already open (the run is recognized when
    // its input finishes streaming); if it isn't, the run is dropped until the
    // parent item shows up and a later snapshot re-attaches it.
    const parent = snapshot.parentItemId
      ? block.items.find((i) => i.itemId === snapshot.parentItemId)
      : undefined;
    if (!parent) return undefined;
    const run: SubagentRun = { ...snapshot, items: [] };
    parent.subagent = run;
    block.items = [...block.items];
    blocks.value = [...blocks.value];
    return run;
  }

  /** Fold one event into this thread's state. The manager only calls this for
   *  events whose `threadId` matches ours; the guard is belt-and-braces. */
  function reduce(event: RuntimeEvent): void {
    // Any event means this conversation is alive — keep it out of the eviction
    // and reaping windows. Runs before the routing guard on purpose: a spawned
    // child's traffic is routed here too, and the parent orchestrating it is
    // very much active.
    touch();
    // The provider's resume cursor travels on the envelope; remember the
    // freshest one so a hibernated session can re-stage it (Claude-only —
    // other providers never set it).
    if (event.refs?.resumeSessionAt) lastResumeSessionAt = event.refs.resumeSessionAt;
    // A spawned child's events bear the CHILD's id — the child is the subject,
    // and its session is never in this registry (only the parent's is; the
    // parent's dock is what these events maintain). The manager routes them to
    // us by `spawned.parentThreadId`; fold by the child's own id, never ours.
    if (
      (event.type === "thread.spawned" || event.type === "thread.spawn-updated") &&
      event.spawned.parentThreadId === threadId.value
    ) {
      const kids = event.spawned;
      const exists = spawnedChildren.value.some((c) => c.threadId === kids.threadId);
      // Replace wholesale — both event types carry the WHOLE SpawnedThread, and
      // patching fields would resurrect stale ones (a cleared status, a dead
      // elapsedMs). A fresh array each time: the dock is a derived view. Kept
      // sorted by createdAt ascending so first-spawned reads as first.
      const next = (
        exists
          ? spawnedChildren.value.map((c) => (c.threadId === kids.threadId ? kids : c))
          : [...spawnedChildren.value, kids]
      ).sort((a, b) => a.createdAt - b.createdAt);
      spawnedChildren.value = next;
      return;
    }
    if (event.threadId !== threadId.value) return;
    switch (event.type) {
      case "session.state.changed":
        sessionState.value = event.state;
        // Any state change supersedes a stale warning — the turn moved on.
        warning.value = null;
        if (event.state === "error" && event.message) error.value = event.message;
        break;
      case "session.warning":
        // Non-fatal: the session keeps running. Surface the message without
        // flipping the state (a Codex error notification with willRetry, a
        // benign notice — the adapter decides what belongs here).
        warning.value = event.message;
        break;
      case "model.rerouted":
        // The provider moved the session onto another model mid-turn (capacity
        // reroute). Keep the picker/UI truthful about what is actually running.
        model.value = event.toModel;
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
        // Providers report usage as they have it; a later event may carry only
        // part of the picture (a fresh contextUsed with no window). Merge, so a
        // partial report refreshes what it knows and leaves the rest standing —
        // the last known contextWindow in particular — instead of clobbering it.
        tokenUsage.value = { ...tokenUsage.value, ...event.usage };
        break;
      case "thread.title.updated":
        title.value = event.title;
        break;
      case "turn.started":
        everRan.value = true;
        // Every queue event for a send arrives before the turn it belongs to
        // starts — anything still recorded is a stale ack (a direct send, a
        // live steer); drop it so the map can't grow unboundedly.
        pendingQueueAnchors.clear();
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
        if (!block) break;
        // An item produced inside a nested run belongs to that run's transcript,
        // not the parent turn's body.
        const run = event.subagentToolUseId
          ? findRun(block, event.subagentToolUseId)
          : undefined;
        if (run) {
          const idx = run.items.findIndex((i) => i.itemId === event.item.itemId);
          if (idx === -1) run.items.push(event.item);
          else run.items[idx] = event.item;
          run.items = [...run.items];
        } else if (!event.subagentToolUseId) {
          upsertItem(block, event.item);
        }
        blocks.value = [...blocks.value];
        break;
      }
      case "subagent.started":
      case "subagent.updated":
      case "subagent.completed": {
        const block = currentAssistant(event.turnId);
        if (block) upsertRun(block, event.subagent);
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
        // (A parked approval clears via the backend's `approval.resolved`, which
        // it emits with reject-once on interrupt.)
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
      case "approval.requested": {
        const block = event.turnId ? currentAssistant(event.turnId) : undefined;
        const origin = originSubagentOfApproval(block);
        const entry: PendingApproval = {
          requestId: event.requestId,
          approval: event.approval,
        };
        if (origin) entry.originToolUseId = origin;
        pendingApprovals.value = [...pendingApprovals.value, entry];
        break;
      }
      case "approval.resolved":
        // The backend settled this round-trip (our decision, or a drain on
        // interrupt/stop). Drop it from the queue — the modal moves to the next.
        pendingApprovals.value = pendingApprovals.value.filter(
          (a) => a.requestId !== event.requestId,
        );
        break;
      case "turn.queued": {
        // A follow-up was durably enqueued behind the running turn — park a
        // chip. The display text comes from the anchored transcript block
        // (via userBlockId), or the send's own recorded block, or falls back
        // to the row input on the rehydrated path.
        const blockId = anchorFor(event.userBlockId, event.queueId);
        const anchorText = blockId
          ? blocks.value.find(
              (b): b is UserBlock => b.role === "user" && b.id === blockId,
            )?.text ?? ""
          : "";
        const entry: QueuedTurnEntry = {
          queueId: event.queueId,
          threadId: event.threadId,
          userBlockId: event.userBlockId,
          dispatchMode: event.dispatchMode,
          state: "queued",
          input: anchorText,
          createdAt: event.at,
          position: event.position,
        };
        if (blockId) entry.blockId = blockId;
        // A re-seed may already hold this queueId — replace, never duplicate.
        queuedTurnsRaw.value = [
          ...queuedTurnsRaw.value.filter((q) => q.queueId !== event.queueId),
          entry,
        ].sort((a, b) => a.position - b.position);
        break;
      }
      case "turn.queued-cancelled":
        // A user drop removes one chip; a stop/delete clears the whole line
        // (the backend emits one cancellation per row on stop).
        queuedTurnsRaw.value =
          event.reason === "stop" ||
          event.reason === "thread-deleted" ||
          event.reason === "archive"
            ? queuedTurnsRaw.value.filter((q) => q.threadId !== event.threadId)
            : queuedTurnsRaw.value.filter((q) => q.queueId !== event.queueId);
        break;
      case "turn.promoted":
        // The backend handed the row to the adapter as a real turn — the chip
        // is consumed. (turn.promoted is the authoritative "row gone" signal:
        // it only fires after the adapter accepted the send and the store
        // marked the row promoted, so a failed promotion never clears the
        // chip. The user block is already in the transcript; turn.started
        // brings the reply.)
        queuedTurnsRaw.value = queuedTurnsRaw.value.filter(
          (q) => q.queueId !== event.queueId,
        );
        break;
      case "turn.steered":
        // The nudge was offered into the LIVE turn — no new boundary, no
        // state to fold beyond the user block already pushed optimistically
        // (a steer that fell back to the queue arrives as turn.queued
        // instead). Keep the switch from erroring on the event.
        pendingQueueAnchors.clear();
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
  /** Claude-only resume cursor: the thread's last assistant message uuid, used
   *  alongside the resume id (see SessionStartInput.resumeSessionAt). Staged
   *  with the resume id on adopt/hibernate, consumed and cleared in start().
   *  Meaningless to any other provider — never sent unless the resume id is. */
  let pendingResumeSessionAt: string | undefined;
  /** The freshest assistant-message uuid this session's provider reported (it
   *  rides the event envelope's refs like conversationId). Kept so hibernate()
   *  can re-stage a complete Claude resume cursor. */
  let lastResumeSessionAt: string | undefined;
  // …and which provider minted it. A resume id means nothing to another CLI, so
  // start() drops the resume if the provider has moved on since it was staged.
  // This used to be implicit — the resume was consumed by the start() that
  // openStored awaited, before the user could touch the picker. Now that opening
  // a stored thread only *arms* a session, the id sits staged across any number
  // of provider switches, and handing a Codex conversation id to Claude is the
  // same desync AgentService's validModelFor guards one axis over.
  let pendingResumeProvider: ProviderKind | undefined;

  /** Adopt a stored thread's provider/model and stage its conversation id for
   *  resume, so continuing it runs on the CLI + model that produced it and keeps
   *  its full context. Resume ids are provider-native, so provider and model
   *  must move together — otherwise we'd hand a Codex thread id to Claude (or a
   *  Claude model id to Codex). */
  function adoptStoredThread(stored: {
    /** The stored thread's own id — what a side-chat hint is filed under. */
    threadId: string;
    provider?: ProviderKind;
    model?: string;
    /** Claude-only resume cursor (see SessionStartInput.resumeSessionAt). */
    resumeSessionAt?: string;
    conversationId?: string;
    tokens?: number;
    contextUsed?: number;
    contextWindow?: number;
    compactsAutomatically?: boolean;
    /** The thread's persisted picker selection snapshot — model/effort/tier/
     *  window the user last committed, restored so a reopened thread keeps
     *  selection per thread; this is the kone-shaped equivalent). */
    selection?: {
      model?: string;
      effort?: string;
      serviceTier?: string;
      contextWindow?: string;
      mode?: string;
    };
    /** Present on a side chat — marks this session as one (forkContext
     *  presence is the discriminator, never a title prefix). */
    forkContext?: ForkContext;
  }): void {
    const providerChanged = Boolean(stored.provider) && stored.provider !== provider.value;
    if (stored.provider) provider.value = stored.provider;
    // Carry the thread's own model — the persisted selection snapshot is the
    // fuller truth (it records what the picker last committed, model + effort +
    // tier + window together); the bare `model` column is the pre-selection
    // fallback. If it predates model persistence, only drop the current one
    // when the provider changed (a stale cross-provider model id is worse than
    // the provider default).
    if (stored.selection?.model !== undefined) model.value = stored.selection.model;
    else if (stored.model !== undefined) model.value = stored.model;
    else if (providerChanged) model.value = undefined;
    // Restore the rest of the committed selection. Effort is validated against
    // the known tier set — a tier added by a newer catalog must not wedge the
    // composer on an unrecognised rung.
    if (stored.selection?.effort && stored.selection.effort in EFFORT_META) {
      // SAFETY: the membership test above guards the cast.
      reasoning.value = stored.selection.effort as ReasoningTier;
    }
    if (stored.selection?.serviceTier !== undefined) serviceTier.value = stored.selection.serviceTier;
    if (stored.selection?.contextWindow !== undefined) contextWindow.value = stored.selection.contextWindow;
    const storedMode = stored.selection?.mode;
    if (storedMode && MODES.some((m) => m === storedMode)) {
      // SAFETY: the membership test above guards the cast.
      mode.value = storedMode as InteractionMode;
    } else {
      const booted = bootMode(ctx.resolveCwd() ?? "");
      if (booted) {
        mode.value = booted;
      }
    }
    pendingResumeId = stored.conversationId;
    pendingResumeProvider = provider.value;
    pendingResumeSessionAt = stored.resumeSessionAt;
    if (stored.forkContext) {
      sideChat.value = true;
      sideChatSource.value = stored.forkContext.sourceThreadId;
      rememberSideChatSource(stored.threadId, stored.forkContext.sourceThreadId);
    }
    // Restore the last context-window snapshot so a reopened thread shows its
    // meter filled straight away (sweeping in), instead of an empty ring until
    // the next turn re-reports usage. Absent snapshot → leave the meter hidden.
    // `total` is the thread's persisted cumulative spend — the faithful value
    // for both running-total (Codex/Cursor) and per-turn (Claude) providers —
    // so a later partial live event merges onto the real total, not contextUsed.
    tokenUsage.value =
      stored.contextWindow !== undefined || stored.contextUsed !== undefined
        ? {
            total: stored.tokens,
            contextUsed: stored.contextUsed,
            contextWindow: stored.contextWindow,
            compactsAutomatically: stored.compactsAutomatically,
          }
        : null;
  }

  /** Re-seed this session's spawned children from the bridge, for a thread that
   *  just adopted a stored identity (rehydrate / openStored) — the spawn events
   *  are deliberately not journaled, so the dock's live-only state must be
   *  rebuilt by an explicit query to survive a reload. Best-effort, all the way
   *  down: a missing bridge or method, a rejected query, or a thread id that
   *  moved on while the query was in flight all leave the dock as it is — never
   *  a surfaced error, never a stale thread's children clobbering newer state. */
  function seedSpawnedChildren(): void {
    const api = bridge();
    // Declared on the bridge, but still checked at runtime: browser dev runs
    // against a partial mock, and a dock that can't seed is a missing
    // convenience, not a broken thread.
    const query = api?.spawnChildren;
    if (!query) return;
    const id = threadId.value;
    void query(id)
      .then((kids) => {
        // The session may have been re-homed onto another thread (a restart, or
        // a newer open) while the query was out — drop the result rather than
        // dump one thread's children into another's dock.
        if (threadId.value !== id) return;
        spawnedChildren.value = [...kids].sort((a, b) => a.createdAt - b.createdAt);
      })
      .catch(() => {
        // The dock is a convenience — a failed seed is never worth an error;
        // live spawn events will fill it in as the children run.
      });
  }

  /** Re-seed this session's queued follow-ups from the bridge, for a thread
   *  that just adopted a stored identity (rehydrate / openStored) — the rows
   *  are durable (they survive crashes), but the queue events are not
   *  journaled, so a reloaded renderer must rebuild the chips by an explicit
   *  query. Best-effort all the way down, exactly like seedSpawnedChildren:
   *  a missing bridge method, a rejected query, or a thread id that moved on
   *  while the query was in flight all leave the chips as they are. */
  function seedQueuedTurns(api: NonNullable<ReturnType<typeof bridge>>): void {
    // SAFETY: QueueBridge is the optional queued-turns slice of the bridge.
    const query = (api as KoneAgentApi & QueueBridge).queuedTurns;
    if (!query) return;
    const id = threadId.value;
    void query(id)
      .then((rows) => {
        // The session may have been re-homed onto another thread while the
        // read was out — drop the rows rather than dump another thread's
        // queue into this timeline.
        if (threadId.value !== id) return;
        if (!rows || rows.length === 0) {
          queuedTurnsRaw.value = [];
          return;
        }
        const anchored = new Set(queuedTurnsRaw.value.map((q) => q.blockId).filter(Boolean));
        const entries: QueuedTurnEntry[] = rows
          .slice()
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((row, i) => {
            const byId = blocks.value.find(
              (b) => b.role === "user" && b.id === row.userBlockId,
            );
            const entry: QueuedTurnEntry = { ...row, position: i + 1 };
            if (byId && !anchored.has(byId.id)) entry.blockId = byId.id;
            return entry;
          });
        queuedTurnsRaw.value = entries;
      })
      .catch(() => {
        // Best-effort: live queue events will fill the chips in as they land.
      });
  }

  /** Load the next strictly older page of a windowed stored thread and prepend
   *  it. The page API returns each slice in ascending timeline order and the
   *  pages are disjoint (the store's keyset cursor is exclusive), so
   *  prepending older blocks in arrival order preserves the timeline exactly.
   *  Best-effort all the way down: a failed page leaves the transcript as it
   *  was and surfaces the reason on the affordance for a retry. */
  async function loadOlder(): Promise<void> {
    const api = bridge();
    const cursor = olderCursor.value;
    if (!api || !cursor || loadingOlder.value) return;
    loadingOlder.value = true;
    olderError.value = null;
    const id = threadId.value;
    try {
      const page =
        api.history.threadPage
          ? await api.history.threadPage(id, { cursor }).catch(() => null)
          : null;
      // The session may have been re-homed onto another thread while the read
      // was out — drop the page rather than dump another thread's transcript
      // into this timeline (the same guard the children re-seed uses).
      if (threadId.value !== id) return;
      if (!page || page.blocks.length === 0) {
        // Nothing older left — the walk is complete; clear the affordance.
        olderCursor.value = null;
        return;
      }
      const known = new Set(blocks.value.map((b) => b.id));
      const older = markHistorical(
        // SAFETY: page blocks deserialize to ThreadBlocks; markHistorical re-checks shape.
        (page.blocks as ThreadBlock[]).filter((b) => !known.has(b.id)),
      );
      if (older.length > 0) blocks.value = [...older, ...blocks.value];
      olderCursor.value = page.nextCursor;
    } catch (e) {
      olderError.value = peelIpcError(e, "Could not load older turns");
    } finally {
      loadingOlder.value = false;
    }
  }

  /** Reload the project's last persisted thread into this timeline, adopting its
   *  id so continued turns append to the same stored thread. Best-effort: any
   *  failure just leaves a fresh, empty thread. Desktop only. */
  async function rehydrate(api: NonNullable<ReturnType<typeof bridge>>): Promise<void> {
    if (rehydratedOnce || options.rehydrate === false) return;
    rehydratedOnce = true;
    try {
      // `latest` is metadata only — it just identifies the thread. The
      // transcript comes from the windowed first page (see PAGE_LIMIT): a very
      // long thread then ships only its newest window and pages the rest on
      // demand. Only if that windowed read is unavailable or comes back empty
      // do we pay for a full reconstruction, to tell "paging failed" apart
      // from "this thread genuinely has nothing yet".
      const meta = await api.history.latest(ctx.resolveCwd());
      if (!meta) return;
      const page =
        api.history.threadPage
          ? await api.history.threadPage(meta.threadId, { limit: PAGE_LIMIT }).catch(() => null)
          : null;
      let resolvedBlocks: ThreadBlock[] | null = null;
      let nextCursor: string | null = null;
      if (page && page.blocks.length > 0) {
        // SAFETY: page.blocks deserializes to ThreadBlocks by IPC contract.
        resolvedBlocks = page.blocks as ThreadBlock[];
        nextCursor = page.nextCursor;
      } else {
        const full = await api.history.thread(meta.threadId).catch(() => null);
        if (full && full.blocks.length > 0) {
          // SAFETY: thread history blocks deserialize to ThreadBlocks by IPC contract.
          resolvedBlocks = full.blocks as ThreadBlock[];
        }
      }
      if (resolvedBlocks && resolvedBlocks.length > 0) {
        threadId.value = meta.threadId;
        blocks.value = markHistorical(resolvedBlocks);
        olderCursor.value = nextCursor;
        title.value = meta.title?.trim() || title.value;
        adoptStoredThread(meta);
        seedSpawnedChildren();
        // The queue rows survive crashes — rebuild the chips from the bridge.
        seedQueuedTurns(api);
      }
    } catch {
      // History is a convenience — never block starting a session over it.
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  // ── lazy start ──────────────────────────────────────────────────────────────
  // Spawning the provider process is the slow part of opening a thread: an IPC
  // round-trip, a CLI process, and a protocol handshake. Doing it before the
  // column paints is what made ⌘N sit on "Opening…" for seconds.
  //
  // A blank thread doesn't need any of that to be *usable* — it needs to render
  // and accept typing. So `deferStart()` marks a session as "will start when
  // first used", and the real handshake happens inside `send()`, in the window
  // where the user is already waiting on a model rather than on the app.
  //
  // This also closes a bug class rather than just hiding it: nothing spawns on
  // the registry's boot default any more, so there's no live session running the
  // wrong provider for the composer to desync from.
  // A ref, not a plain flag: `unstarted` below is a computed over it, and with a
  // bare `let` that computed would only ever re-evaluate when `session.value`
  // happened to change — reading true long after the CLI came up.
  const deferred = ref(false);
  let starting: Promise<void> | null = null;

  /** Latch the pending rehydrate closed without starting anything.
   *
   *  A blank session is fungible — the registry hands the same one back to
   *  whoever asks for a new thread next — but its deferred rehydrate is not. It
   *  belongs to the surface that spawned the session, and firing it under a
   *  caller that asked for a NEW thread adopts the project's latest stored
   *  conversation instead: the id changes to that thread's, the transcript
   *  overwrites the user block send() just pushed, and the turn appends to a
   *  conversation nobody chose. The thread the user wrote in then only shows up
   *  on the next read of the store, at the end of somebody else's.
   *
   *  Cheap and idempotent, so the reuse paths can call it unconditionally
   *  rather than asking first whether this particular blank happens to owe a
   *  rehydrate to whoever made it. */
  function disownRehydrate(): void {
    rehydratedOnce = true;
  }

  /** Mark this session as startable-on-demand instead of starting it now. */
  function deferStart(): void {
    if (session.value) return; // already live — nothing to defer
    deferred.value = true;
    error.value = null;
    // Optimistic: the column is usable. A real failure surfaces on first send,
    // attributed to the send, which is where the user can act on it.
    sessionState.value = "ready";
  }

  /** True while this session is only *notionally* up — deferred and not yet
   *  spawned. Surfaces that need to know whether a real CLI is behind the
   *  column (rather than whether it's usable) read this. */
  const unstarted = computed(() => deferred.value && !session.value);

  /** Start if we haven't yet. Deduped, so a fast double-send can't spawn two
   *  sessions for one thread. Safe to call unconditionally. */
  function ensureStarted(): Promise<void> {
    if (!deferred.value) return Promise.resolve();
    starting ??= start().finally(() => {
      starting = null;
    });
    return starting;
  }

  /** Whether this thread's provider can take a turn, and the sentence to show
   *  when it can't. Reactive — a pushed status correction un-blocks the composer
   *  without the user touching anything. */
  const sendBlockedReason = computed(() => {
    const availability = providers.sendAvailability(provider.value).value;
    return availability.usable ? null : availability.reason;
  });

  /** Re-probe once before refusing an already-blocked send, then answer. The
   *  usual reason a row says "signed out" is that it is stale — the user went and
   *  fixed it — so a refusal is worth one round-trip. A blocked send surfaces the
   *  reason on the thread rather than throwing: the composer still holds the
   *  draft, so there is nothing to recover, only something to explain.
   *
   *  Only ever called on the blocked path. The unblocked send must not await
   *  anything before pushing the user block — the queued-chip anchoring reads
   *  that block in the same tick as the call. */
  async function recheckBeforeRefusing(): Promise<boolean> {
    await providers.refresh().catch(() => {});
    const reason = sendBlockedReason.value;
    if (!reason) return true;
    error.value = reason;
    return false;
  }

  /** Start this thread's session. The manager owns the event listener, so this
   *  only spawns the provider process (after an optional rehydrate). */
  async function start(): Promise<void> {
    // Any explicit start satisfies the deferral — otherwise the flag would
    // survive and the first send would start a second time.
    deferred.value = false;
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
    // start re-resumes a stale conversation. A resume id is provider-native, so
    // it's only good if we're still on the provider that minted it — otherwise
    // drop it and start clean rather than hand one CLI another's conversation.
    const staged = pendingResumeId;
    const resume = pendingResumeProvider === provider.value ? staged : undefined;
    // Claude's resume cursor is the id + the last assistant message uuid; the
    // uuid is meaningless without the id (and to any non-Claude provider), so
    // it rides along only when the resume id itself is being honored.
    const resumeSessionAt = resume ? pendingResumeSessionAt : undefined;
    if (staged && !resume) {
      console.warn(
        `[agent] dropping resume id — staged for ${pendingResumeProvider}, starting on ${provider.value}`,
      );
    }
    pendingResumeId = undefined;
    pendingResumeProvider = undefined;
    pendingResumeSessionAt = undefined;
    try {
      const startInput: SessionStartInput = {
        threadId: threadId.value,
        provider: provider.value,
        cwd: ctx.resolveCwd(),
        model: model.value,
        mode: mode.value,
        // Providers that fix effort when the session process spawns (Claude)
        // read it here; flag-based ones (Codex) ignore it and take effort per
        // turn instead. Safe to always send — the adapter picks what it needs.
        effort: reasoning.value,
      };
      // Who the session answers as. Read here rather than passed in, because
      // this is the moment the provider process comes up and the identity is
      // fixed on a system channel for the life of it — a value captured earlier
      // could be from before the thread settled who was working it. Undefined
      // for a guest thread, which is every thread nobody was picked for: the
      // field is then absent and the session runs exactly as it always has.
      const persona = agentPersonaForThread(threadId.value);
      if (persona) startInput.agent = persona;
      // Resume the stored thread's provider conversation so continued turns
      // keep its full context (rehydrate/openStored set this).
      if (resume) startInput.resume = resume;
      if (resumeSessionAt) startInput.resumeSessionAt = resumeSessionAt;
      session.value = await api.startSession(startInput);
      sessionState.value = session.value.status;
    } catch (e) {
      error.value = peelIpcError(e, "Could not start the agent");
      sessionState.value = "error";
    }
  }

  /** Claim a stored thread's id on this session *synchronously*, before any of
   *  its transcript has been read. Two things need that. The registry's
   *  find-by-id lookups (the openThread dedupe, forgetThread, the event router)
   *  can only see a session once it carries the id, and the board can only bind
   *  a pane to a session it can find — so without this the column sits dormant
   *  on "Opening…" for the whole load. Adopting the id reveals nothing on its
   *  own; `blocks` stays empty until openStored fills it. */
  function claimStoredId(id: string): void {
    // start() must not reload the project's *latest* thread over this one.
    rehydratedOnce = true;
    threadId.value = id;
    const source = getSideChatSource(id);
    if (source) {
      sideChat.value = true;
      sideChatSource.value = source;
    }
  }

  /** Bring a specific stored thread on-screen and continue it: adopt the
   *  thread's id + transcript, and arm a session bound to it so new turns append
   *  to it. Best-effort; desktop only.
   *
   *  Deliberately does NOT spawn the provider process. Resuming a conversation
   *  is the same shape of work as opening a blank one — an IPC round-trip, a CLI
   *  process, a handshake — and making the user watch it is what left an old
   *  thread sitting on "Opening…" for seconds. The resume id is staged on
   *  `pendingResumeId` and start() consumes it whenever the first send finally
   *  brings the CLI up, so continued turns still land on the same provider
   *  conversation with its full context. */
  async function openStored(id: string): Promise<void> {
    claimStoredId(id);
    transcriptLoadFailed.value = false;
    const api = bridge();
    // Browser dev has no history bridge — just bring a (mock) session up so the
    // composer is live rather than leaving the view without a session.
    if (!api) {
      await start();
      return;
    }
    let stored: StoredThread | null = null;
    let page: StoredThreadPage | null = null;
    try {
      // Hovering the row that opened this thread may already have started the
      // read (see prefetchThread) — take that in-flight promise rather than
      // firing a second one. A prefetched snapshot is a FULL transcript, so a
      // windowed read is unnecessary on top of it.
      const prefetched = takePrefetched(id);
      if (prefetched) {
        stored = await prefetched;
      } else {
        // Windowed read (see PAGE_LIMIT): the first page is the thread's
        // newest window; older pages load on demand via loadOlder. Falls back
        // to the full read when the page API is unavailable (older app build,
        // partial mock) or returns nothing — identical to the old path.
        page =
          api.history.threadPage
            ? await api.history.threadPage(id, { limit: PAGE_LIMIT }).catch(() => null)
            : null;
        if (!page || page.blocks.length === 0) {
          stored = await api.history.thread(id).catch(() => null);
        }
      }
    } catch {
      stored = null;
      page = null;
    }
    // Forgotten while the history load was in flight (opened then immediately
    // archived/deleted) — bail before revealing the transcript or arming a
    // session, so the removed thread is never shown or recreated.
    if (forgotten) return;
    // Thread vanished (deleted/archived under us) — fall back to a fresh blank
    // thread rather than an empty, session-less view. Drop the claimed id on the
    // way: keeping it would have the first send hand `startSession` the id of a
    // thread the user just deleted, and ensureThread would write the row back.
    if (!stored && !page) {
      transcriptLoadFailed.value = true;
      threadId.value = uid();
      deferStart();
      return;
    }
    // The page shape carries the metadata under `meta`; the full thread is
    // flat. Normalize both to the same meta + blocks pair here.
    const meta: StoredThreadMeta = page ? page.meta : stored!;
    const sourceBlocks: StoredBlock[] = page ? page.blocks : stored!.blocks;
    // SAFETY: both sources deserialize to ThreadBlocks by IPC contract.
    blocks.value = markHistorical(sourceBlocks as ThreadBlock[]);
    olderCursor.value = page ? page.nextCursor : null;
    title.value = meta.title?.trim() || "";
    adoptStoredThread(meta); // also restores the persisted context-meter snapshot
    error.value = null;
    seedSpawnedChildren();
    // The queue rows survive crashes — rebuild the chips from the bridge.
    seedQueuedTurns(api);
    deferStart();
  }

  /** Send a user turn. Pushes the user block immediately; the reply streams in.
   *  `attachments` (already uploaded to disk via the bridge, so bytes-free) ride
   *  the turn — a turn is valid with text, attachments, or both.
   *
   *  There is NO busy early-return: a send while a turn runs is durably
   *  enqueued by the service (it emits turn.queued and acks with the queue id
   *  as turnId). The user block is already pushed before the call, so the
   *  queued chip anchors to it — via the ack record below (the store journals
   *  the block under its own id, which the turn.queued event carries). */
  async function send(text: string, attachments?: ChatAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const files = attachments ?? [];
    if (!trimmed && files.length === 0) return;
    // Last line of defense. The composer already refuses a blocked send while
    // keeping the draft (`blockedReason`), so reaching here means the surface
    // acted on a status that has since gone stale. The check is synchronous
    // unless it is about to refuse: everything below assumes the user block
    // lands in this tick.
    if (sendBlockedReason.value && !(await recheckBeforeRefusing())) return;
    touch();
    const blockId = uid();
    const block: UserBlock = {
      id: blockId,
      role: "user",
      text: trimmed,
      at: Date.now(),
    };
    if (files.length) block.attachments = files;
    blocks.value = [...blocks.value, block];
    // Instant label for a brand-new thread; desktop may refine it via
    // thread.title.updated once the agent rename lands. An attachment-only turn
    // seeds the label from the first file name.
    if (!title.value) title.value = titleFromPrompt(trimmed || files[0]?.name || "");

    const api = bridge();
    if (!api) {
      // Browser dev: with no live turn, stream the canned reply. While the
      // mock turn runs a send can't start a second concurrent turn — park a
      // chip exactly like the real queue does (the mock consumes it when the
      // turn settles; see mockQueueFollowUp).
      if (busy.value) {
        mockQueueFollowUp(blockId, "queue");
        return;
      }
      mockTurn(trimmed || files[0]?.name || "Attachment");
      return;
    }
    dispatching.value = true;
    try {
      // A deferred thread spawns its CLI here, on the user's first send. The user
      // block is already on screen above, so the handshake reads as the model
      // starting to think rather than the app being slow to open.
      const wasDeferred = deferred.value;
      await ensureStarted();
      // Only bail on a start we actually performed — a stale error from an
      // earlier turn must not wedge every later send.
      if (wasDeferred && !session.value) return;
      const turn: SendTurnInput = {
        threadId: threadId.value,
        input: trimmed,
        model: model.value,
        mode: mode.value,
        effort: reasoning.value,
        serviceTier: serviceTier.value,
        contextWindow: contextWindow.value,
      };
      if (files.length) turn.attachments = files;
      const result = await api.sendTurn(turn);
      // A busy send was durably enqueued — the ack's turnId IS the queue id.
      // Remember which local block it belongs to so the turn.queued chip can
      // anchor to it (the store journals the block under its own id).
      if (result?.turnId) pendingQueueAnchors.set(result.turnId, blockId);
    } catch (e) {
      error.value = peelIpcError(e, "Could not send to the agent");
    } finally {
      dispatching.value = false;
    }
  }

  /** Steer a mid-turn nudge into the RUNNING turn — same turn, no new
   *  boundary. The service routes it to the provider's live-steer channel
   *  (emitting turn.steered), or — when the provider has none — durably
   *  queues it to run first (a steer row claims ahead of plain follow-ups).
   *  Without a live turn the backend treats a steer as a plain send. Mirrors
   *  send(): pushes the user block immediately (the nudge is on screen the
   *  moment it leaves the composer) and rides the same per-turn knobs. */
  async function steerTurn(text: string, attachments?: ChatAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const files = attachments ?? [];
    if (!trimmed && files.length === 0) return;
    touch();
    const blockId = uid();
    const block: UserBlock = {
      id: blockId,
      role: "user",
      text: trimmed,
      at: Date.now(),
    };
    if (files.length) block.attachments = files;
    blocks.value = [...blocks.value, block];
    if (!title.value) title.value = titleFromPrompt(trimmed || files[0]?.name || "");

    const api = bridge();
    if (!api) {
      // Browser dev: a steer into the mock turn falls back to the queue (the
      // mock has no live-steer channel), exactly like the real providers
      // without one.
      if (busy.value) {
        mockQueueFollowUp(blockId, "steer");
        return;
      }
      mockTurn(trimmed || files[0]?.name || "Attachment");
      return;
    }
    dispatching.value = true;
    try {
      const wasDeferred = deferred.value;
      await ensureStarted();
      if (wasDeferred && !session.value) return;
      // SAFETY: QueueBridge is the optional queued-turns slice of the bridge.
      const steer = (api as KoneAgentApi & QueueBridge).steerTurn;
      if (!steer) {
        // Older bridge without the steer channel — fall back to a plain send
        // (the backend's own steer-without-live-turn semantics).
        const turn: SendTurnInput = {
          threadId: threadId.value,
          input: trimmed,
          model: model.value,
          mode: mode.value,
          effort: reasoning.value,
          serviceTier: serviceTier.value,
          contextWindow: contextWindow.value,
        };
        if (files.length) turn.attachments = files;
        await api.sendTurn(turn);
        return;
      }
      const turn: SendTurnInput = {
        threadId: threadId.value,
        input: trimmed,
        model: model.value,
        mode: mode.value,
        effort: reasoning.value,
        serviceTier: serviceTier.value,
        contextWindow: contextWindow.value,
      };
      if (files.length) turn.attachments = files;
      const result = await steer(turn);
      // A steer that fell back to the durable queue acks with the queue id —
      // record the anchor so its chip finds this block (a live-steer ack is
      // the adapter's turn id and never produces a queue event; it's pruned
      // at the next turn boundary).
      if (result?.turnId) pendingQueueAnchors.set(result.turnId, blockId);
    } catch (e) {
      error.value = peelIpcError(e, "Could not steer the agent");
    } finally {
      dispatching.value = false;
    }
  }

  /** Cancel one queued follow-up (user-initiated drop from the chips). The
   *  backend emits turn.queued-cancelled; the chip clears on that event. */
  async function cancelQueuedTurn(queueId: string): Promise<void> {
    const api = bridge();
    // SAFETY: QueueBridge is the optional queued-turns slice of the bridge.
    const cancel = (api as KoneAgentApi & QueueBridge | undefined)?.cancelQueuedTurn;
    if (!cancel) return;
    try {
      await cancel(threadId.value, queueId);
    } catch (e) {
      error.value = peelIpcError(e, "Could not remove queued message");
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

  function base(_type: string) {
    return {
      threadId: threadId.value,
      provider: provider.value,
      at: Date.now(),
      source: "codex.rpc.lifecycle" as const,
    };
  }

  // ── browser dev mock ────────────────────────────────────────────────────────
  const {
    stopMock,
    mockQueueFollowUp,
    mockTurn,
    demo,
    getMockTurnId,
    hasPendingApproval: mockHasPendingApproval,
    respondApproval: mockRespondApproval,
  } = createMockTurnRunner({
    threadId,
    provider,
    sessionState,
    reasoning,
    blocks,
    title,
    tokenUsage,
    queuedTurnsRaw,
    reduce,
    busy,
  });

  /** Interrupt the running turn. */
  async function interrupt(): Promise<void> {
    const tid = getMockTurnId();
    if (tid) {
      // Running a mock turn (browser dev or ⇧⌘D demo): halt its timers and mark aborted.
      stopMock();
      // SAFETY: the literal below spells out the whole aborted-event payload.
      reduce({
        ...base("turn.aborted"),
        type: "turn.aborted",
        turnId: tid,
        reason: "interrupted",
      } as RuntimeEvent);
      sessionState.value = "ready";
      return;
    }
    const api = bridge();
    if (!api) {
      stopMock();
      sessionState.value = "ready";
      return;
    }
    try {
      await api.interrupt(threadId.value);
    } catch {
      // The turn.aborted event (or its absence) is the source of truth.
    }
  }

  /** Stop one nested subagent run, leaving the parent turn running. */
  async function stopSubagent(toolUseId: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    try {
      await api.stopSubagent(threadId.value, toolUseId);
    } catch {
      // The run's `subagent.completed` event (or its absence) is the truth.
    }
  }

  /** Send a mid-task message to a running nested subagent. It's delivered on the
   *  child's next tool call, so a child about to finish may never see it. */
  async function steerSubagent(toolUseId: string, message: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    try {
      await api.steerSubagent(threadId.value, toolUseId, message);
    } catch {
      // Best-effort — the run may have settled between render and click.
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

  /** Decide a parked tool approval. Drops it from the queue optimistically,
   *  then hands the decision to the adapter — which resolves the parked
   *  provider request and emits `approval.resolved` (a belt-and-braces
   *  re-clear). */
  async function respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    pendingApprovals.value = pendingApprovals.value.filter((a) => a.requestId !== requestId);
    if (mockHasPendingApproval(requestId)) {
      mockRespondApproval(requestId, decision);
      return;
    }
    const api = bridge();
    if (!api) return;
    try {
      await api.respond(threadId.value, requestId, decision);
    } catch {
      // If the send fails the turn will abort and clear state via turn.aborted.
    }
  }

  function setProvider(next: ProviderKind): void {
    if (next === provider.value) return;
    provider.value = next;
    // Resume ids are provider-native. Handing one minted by the previous CLI to
    // the new one either hard-fails ("conversation id does not exist" — Claude
    // rethrows on a bad resume) or is silently swallowed into a fresh thread.
    // Switching engines means this conversation can't be continued in-place.
    pendingResumeId = undefined;
    // A model id from the old provider's catalog is meaningless to the new one
    // (a Cursor `composer-*` id sent to Codex draws a 400 from the upstream API).
    // Drop it so start() falls back to the new provider's default.
    model.value = undefined;
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

  /** Park a *started* session without tearing the thread down: stop the provider
   *  process and drop the live session, but keep the thread's identity +
   *  transcript resident so the board's pane stays and a later open re-attaches
   *  it. The next send re-runs start(), which resumes the same provider
   *  conversation via the re-staged conversation id — so hibernation only costs
   *  a CLI spawn, never context. Called by the manager's idle reaper after
   *  IDLE_HIBERNATE_MS without activity; never while busy or parked on an ask.
   *  Unlike dispose(), this does NOT latch `forgotten` — the thread is not
   *  ProviderSessionReaper stops idle sessions the same way; the difference is
   *  kone's pane + transcript stay live and resume is one send away). */
  async function hibernate(): Promise<void> {
    stopMock();
    const api = bridge();
    const wasLive = Boolean(api && session.value);
    if (api && session.value) {
      // Stage the provider conversation id again so the next start() resumes
      // it instead of minting a blank conversation. The provider's last
      // assistant-message uuid rides along for Claude (resumeSessionAt), so
      // that resume path keeps working too.
      const cid = session.value.conversationId;
      if (cid) {
        pendingResumeId = cid;
        pendingResumeProvider = provider.value;
        // Claude resumes with the id + the last assistant message uuid; keep
        // the freshest one we've seen so the re-staged cursor is complete.
        if (lastResumeSessionAt) pendingResumeSessionAt = lastResumeSessionAt;
      }
      try {
        await api.stopSession(threadId.value);
      } catch {
        // best-effort — the process may already be gone
      }
    }
    session.value = null;
    // Only a session that actually had a process demotes to stopped; a
    // never-started (deferred) column keeps its ready state.
    if (wasLive) sessionState.value = "stopped";
    error.value = null;
    // Mark startable-on-demand again: the next send/start brings the CLI back
    // (see ensureStarted). Mirrors deferStart's contract, minus the optimistic
    // "ready" — a hibernated thread is genuinely stopped until it wakes.
    deferred.value = true;
  }

  /** Tear the live session down and start a fresh one under a new thread id.
   *  Used when a change can't be applied to a running session — switching
   *  provider (a different CLI entirely), or changing a Claude model, whose
   *  effort/model are baked when the SDK subprocess spawns. Prior turns stay on
   *  screen as history; new turns stream in under the new session. */
  async function restart(): Promise<void> {
    // Nothing was ever spawned (a deferred thread whose provider the user just
    // switched). There's no CLI to re-birth, and eagerly starting one here would
    // put back exactly the boot-time spawn we removed.
    const wasLive = Boolean(session.value);
    await dispose();
    // A restart is a deliberate re-birth of this session (provider/model switch),
    // not a teardown — clear the dispose() latch so start() below runs.
    forgotten = false;
    rehydratedOnce = true;
    error.value = null;
    if (!wasLive) {
      // Keep this thread's identity. A new id is only right when we're replacing
      // a session that already ran under the old one; here nothing did, and a
      // re-mint on a *reopened stored* thread — now a real case, since opening
      // one no longer spawns — would cut the column loose from its conversation
      // in storage and strand its staged resume on a foreign provider.
      deferStart();
      return;
    }
    const previousThreadId = threadId.value;
    threadId.value = uid();
    // A restart is the same work under a new id, so it keeps the same colleague.
    // Carried rather than re-read from the current selection: the user may have
    // pointed the composer at somebody else since, and switching provider is not
    // a decision about who is working the thread. It has to happen before start()
    // below — the providers that carry an identity on a system channel fix theirs
    // when the process spawns, so a session that comes up nameless stays nameless.
    carryThreadAgent(previousThreadId, threadId.value);
    tokenUsage.value = null;
    // The re-born thread is a fresh conversation — no stored pages to walk.
    olderCursor.value = null;
    loadingOlder.value = false;
    olderError.value = null;
    sessionState.value = "starting";
    // A restart is a deliberate re-birth: the new thread is a fresh
    // conversation, never a side chat, and nothing was read to fail.
    sideChat.value = false;
    sideChatSource.value = null;
    transcriptLoadFailed.value = false;
    // …and it has spawned nothing yet — the old thread's children belong to
    // the old thread, not this brand-new one.
    spawnedChildren.value = [];
    // A restart is a fresh conversation — any queue rows belonged to the old
    // thread (the backend clears them with the session teardown).
    queuedTurnsRaw.value = [];
    pendingQueueAnchors.clear();
    await start();
  }

  return {
    key,
    // identity
    threadId,
    provider,
    title,
    // side-chat state
    isSideChat,
    sideChatSource,
    timelineBlocks,
    // state
    blocks,
    session,
    sessionState,
    busy,
    everRan,
    error,
    warning,
    // Why a send would be refused right now, or null. The composer binds it to
    // keep the draft instead of dispatching into a provider that can't run it.
    sendBlockedReason,
    tokenUsage,
    // The stored-transcript read came back empty-handed — what the thread's
    // "didn't load" banner is allowed to key off.
    transcriptLoadFailed,
    // keyset pagination: the load-older affordance reads these; loadOlder
    // fetches the next strictly older page and prepends it.
    hasOlder,
    loadingOlder,
    olderError,
    // Activity clock: the manager's LRU eviction and idle reaper read it; the
    // manager bumps it on focus and actions, reduce() bumps it on any event.
    lastActivityAt,
    touch,
    // The child threads this one has spawned. Exposed per-session, not just on
    // the active projection: the Subagents dock reads the FOCUSED thread, which
    // on a multi-column board isn't necessarily the active one.
    spawnedChildren,
    // Durable follow-ups queued behind the running turn — the composer's
    // chips and the thread view's per-block badges read these (the strip
    // reads the focused session's own ref; the composer reads the manager's
    // active projection).
    queuedTurns,
    pendingUserInput,
    pendingApproval,
    pendingApprovals,
    attention,
    unstarted,
    model,
    mode,
    reasoning,
    serviceTier,
    contextWindow,
    // reduction (manager calls this for our events)
    reduce,
    // actions
    start,
    deferStart,
    disownRehydrate,
    ensureStarted,
    openStored,
    loadOlder,
    restart,
    send,
    steerTurn,
    cancelQueuedTurn,
    uploadAttachment,
    demo,
    interrupt,
    stopSubagent,
    steerSubagent,
    respondUserInput,
    respondApproval,
    setProvider,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    setContextWindow,
    dispose,
    hibernate,
  };
}

// ── the project's thread manager ────────────────────────────────────────────────

import { isThreadSessionBlank } from "~/utils/panes";

/** How many idle, settled background threads to keep resident. Busy threads are
 *  never evicted; this only bounds the settled backlog so the registry (and the
 *  pill stack) can't grow without end. Matches the board's restored-pane cap so
 *  a saved strip of conversations doesn't immediately go dormant on open. */
const MAX_RESIDENT_THREADS = 8;
/** How long a started session may sit without any activity before the sweep
 *  hibernates it — stops the provider process (and releases the gateway token)
 *  while keeping the thread resident, so the pane stays and the next send
 *  kone's board keeps the pane, so 30 min of genuinely-unused process is the
 *  same tradeoff here. */
const IDLE_HIBERNATE_MS = 30 * 60_000;
/** Sweep cadence. Cheap pass (a handful of sessions); runs forever because the
 *  registry outlives any one <ProjectView> — the sweep is what bounds process
 *  counts while a project is away. */
const SWEEP_INTERVAL_MS = 60_000;

/** One project's live-session registry, hoisted to module scope. <ProjectView>
  * is keyed on project.path (index.vue), so a per-instance registry would
  * dispose every session — and with it kill every provider process, which the
  * renderer's dispose() is the only thing tearing down — the moment the user
  * switches projects. Keeping the registry per project path at module scope
  * makes a project switch a swap of registries: background turns keep folding
  * (the single event listener is also hoisted), and re-entering the project
  * re-attaches the same live sessions — the board re-attaches dormant panes on
  * focus, and openThreadHandle reuses resident sessions by id. Sessions are
  * still disposed on explicit thread close; the sweep hibernates idle ones so
  * processes don't pile up across the run. Bounded by the number of projects
  * opened in one run, like useStudioPersistence's plane cache. */
type ProjectRegistry = {
  sessions: ShallowRef<ThreadSession[]>;
  opening: Map<string, { key: string; promise: Promise<void> }>;
  activeKey: Ref<string>;
  listenerAttached: boolean;
  unsubscribeListener: (() => void) | null;
  sweepTimer: ReturnType<typeof setInterval> | null;
  // Session keys currently bound to a live studio pane, across every column in
  // the strip (not just the focused one). The board is the one thing that
  // knows this — it owns the PaneId → session-key join — so it reports in
  // here via pinToPane/unpinFromPane. Plain Set, not a ref: nothing renders
  // off it, the sweep just reads it on its own tick.
  paneBoundKeys: Set<string>;
};
const registries = new Map<string, ProjectRegistry>();

/** Bumped whenever the *set* of registries changes. The Map itself is plain —
 *  the sessions inside it are refs, so a computed that walks it tracks their
 *  contents, but not a project appearing or going away. Anything reading across
 *  every project (see liveTurns) touches this so a newly-opened project's
 *  threads are not invisible until something else happens to invalidate. */
const registryVersion = ref(0);

function registryFor(projectPath: string): ProjectRegistry {
  let r = registries.get(projectPath);
  if (!r) {
    r = {
      sessions: shallowRef<ThreadSession[]>([]),
      opening: new Map(),
      activeKey: ref(""),
      listenerAttached: false,
      unsubscribeListener: null,
      sweepTimer: null,
      paneBoundKeys: new Set(),
    };
    registries.set(projectPath, r);
    registryVersion.value++;
  }
  return r;
}

/** Every turn running anywhere in the app right now, keyed by thread id.
 *
 *  A surface that owns a session knows its own thread's state from that session.
 *  The inbox list owns none: its rows are read off disk, and a stored row cannot
 *  know that the same thread is mid-turn in a studio column two surfaces away.
 *  The registries do know — they are module-scope and outlive any one view — so
 *  this is the join between "a row on disk" and "a turn in flight", and it is
 *  read-only by design: nothing here starts, adopts, or keeps a session alive. */
export const liveTurns = computed<Map<string, AssistantBlock>>(() => {
  void registryVersion.value;
  const out = new Map<string, AssistantBlock>();
  for (const r of registries.values()) {
    for (const s of r.sessions.value) {
      const threadId = s.threadId.value;
      if (!threadId) continue;
      const block = latestAssistant(s.timelineBlocks.value);
      if (block?.state === "running") out.set(threadId, block);
    }
  }
  return out;
});

/** Explicit teardown for a project's agent registry: clears the background
 *  sweep timer, detaches the IPC event listener, disposes all sessions, and
 *  evicts the entry from memory so background listeners do not leak. */
export async function disposeProjectRegistry(projectPath: string): Promise<void> {
  const r = registries.get(projectPath);
  if (!r) return;
  if (r.sweepTimer !== null) {
    clearInterval(r.sweepTimer);
    r.sweepTimer = null;
  }
  if (r.unsubscribeListener) {
    try {
      r.unsubscribeListener();
    } catch {
      /* ignore unsubscribe failure */
    }
    r.unsubscribeListener = null;
    r.listenerAttached = false;
  }
  const toDispose = [...r.sessions.value];
  r.sessions.value = [];
  await Promise.all(toDispose.map((s) => s.dispose()));
  registries.delete(projectPath);
  registryVersion.value++;
}

export function useAgent(options: UseAgentOptions) {
  const ctx: SessionCtx = {
    options,
    bridge: () => (import.meta.client ? (window.koneDesktop?.agent ?? null) : null),
    resolveCwd: () => (options.cwd instanceof Function ? options.cwd() : options.cwd),
  };

  // A project's whole registry — sessions, in-flight opens, focus — lives at
  // module scope keyed by its path (see registryFor above). Each useAgent call
  // binds to its project's shared state instead of minting a fresh one.
  const registry = registryFor(
    options.cwd instanceof Function ? options.cwd() : options.cwd,
  );

  // The registry: every thread this project has open, live or backgrounded.
  // shallowRef so Vue doesn't deep-reactive-wrap the session objects (which
  // would unwrap their inner refs) — we swap the array on add/remove instead.
  const sessions = registry.sessions;
  const activeKey = registry.activeKey;
  // In-flight openThread() calls, keyed by thread id — guards the double-open
  // race (a second open before the first has adopted the id). Carries the
  // loading session's key so a repeat open can re-activate it (the session's
  // threadId isn't adopted until openStored resolves, so it can't be found by
  // id yet).
  const opening = registry.opening;

  function spawn(init: { rehydrate?: boolean } = {}): ThreadSession {
    const s = createThreadSession(ctx, init);
    sessions.value = [...sessions.value, s];
    return s;
  }

  async function evict(s: ThreadSession): Promise<void> {
    sessions.value = sessions.value.filter((x) => x !== s);
    registry.paneBoundKeys.delete(s.key);
    await s.dispose();
  }

  /** The board calls this when a pane's PaneId → session-key join lands (a
   *  pane attaches, or re-attaches after a restore), and its counterpart below
   *  when that join is torn down (pane closed, or the session it hosted moved
   *  to a different pane). Sweeping never touches a pinned key — see
   *  untouchable() — so a session sitting in a visible column, blank or not,
   *  survives every tick regardless of the resident cap or the blank-collapse
   *  pass. */
  function pinToPane(key: string): void {
    registry.paneBoundKeys.add(key);
  }
  function unpinFromPane(key: string): void {
    registry.paneBoundKeys.delete(key);
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

  /** A session that must never be evicted or hibernated right now: it's the
   *  focused one, a turn is in flight, it's parked on an ask (approval or
   *  user-input), its open is still loading, it has live spawned children —
   *  evicting the parent tears down the provider session and revokes its
   *  gateway token mid-orchestration while its children keep running headless
   *  against a parent that can no longer answer them — or it's bound to a
   *  studio pane the user can currently see. That last one covers every
   *  non-focused column in the strip too, blank or not: the sweep must never
   *  make a visible pane's session disappear out from under it. */
  function untouchable(s: ThreadSession): boolean {
    return (
      s.key === activeKey.value ||
      s.busy.value ||
      Boolean(s.pendingUserInput.value) ||
      s.pendingApprovals.value.length > 0 ||
      s.spawnedChildren.value.some((c) => !c.terminal) ||
      [...opening.values()].some((e) => e.key === s.key) ||
      registry.paneBoundKeys.has(s.key)
    );
  }

  /** Trim surplus blank sessions and enforce the resident cap.
   *  The registry holds at most one *unpinned* blank thread across all panes;
   *  asking again relocates/reuses rather than stacking. If legacy state or a
   *  failed open left multiple such blanks resident, collapse down to one
   *  (keeping the active or most recently touched blank). A blank sitting in
   *  a pane the user can see is untouchable regardless — collapsing to "one
   *  blank" only ever thins out the ones nobody is looking at. Then trim
   *  settled, idle background threads down to MAX_RESIDENT_THREADS —
   *  least-recently-active first. */
  function pruneResident(): void {
    // Collapse surplus blank sessions. Never evict the active blank, a
    // pane-bound blank, a session whose open is in-flight, or anything busy —
    // untouchable() covers all of that.
    const blanks = sessions.value.filter(
      (s) => isThreadSessionBlank(s) && !s.busy.value,
    );
    if (blanks.length > 1) {
      const kept =
        blanks.find((s) => s.key === activeKey.value) ??
        [...blanks].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
      for (const s of blanks) {
        if (s !== kept && !untouchable(s)) {
          void evict(s);
        }
      }
    }

    const overflow = sessions.value.length - MAX_RESIDENT_THREADS;
    if (overflow <= 0) return;
    const evictable = sessions.value
      .filter((s) => !untouchable(s))
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    for (let i = 0; i < overflow && i < evictable.length; i++) {
      const s = evictable[i];
      if (s) void evict(s);
    }
  }

  /** Low-frequency sweep: evicts past the open/new-thread paths (a settled
   *  turn never triggers another prune behind it) and hibernates sessions
   *  whose provider process has sat idle past IDLE_HIBERNATE_MS. One interval
   *  per registry, started on first mount, never cleared — the registry (and
   *  its processes) outlive the <ProjectView>. */
  function startSweep(): void {
    if (registry.sweepTimer !== null) return;
    registry.sweepTimer = setInterval(() => {
      pruneResident();
      const cutoff = Date.now() - IDLE_HIBERNATE_MS;
      for (const s of sessions.value) {
        if (untouchable(s)) continue;
        if (s.lastActivityAt > cutoff) continue;
        // The pane stays; only the process goes (see hibernate).
        void s.hibernate();
      }
    }, SWEEP_INTERVAL_MS);
  }
  startSweep();

  // The first thread — rehydrates the project's latest on its first start.
  // Only a genuinely first mount of this project spawns it: with the registry
  // hoisted, a re-mount finds its sessions still resident and must not stack a
  // fresh boot thread on top of them (the board reconciles those straight onto
  // the strip). Focus comes back to wherever the user left it.
  const firstMount = sessions.value.length === 0;
  // SAFETY: when firstMount is false, sessions.value has at least one entry.
  const first = firstMount
    ? spawn({ rehydrate: options.rehydrate })
    : (sessions.value[0] as ThreadSession);
  if (firstMount) activeKey.value = first.key;

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
  // Attached once per project registry and never detached: the registry (and
  // its background sessions) outlive the <ProjectView>, and a project with no
  // view mounted still needs its turns folding — otherwise the state is stale
  // the moment the user comes back. Re-mounts of the same project skip this.
  if (import.meta.client && !registry.listenerAttached) {
    const api = ctx.bridge();
    if (api) {
      registry.listenerAttached = true;
      registry.unsubscribeListener = api.onEvent((event: RuntimeEvent) => {
        // A spawned child's events carry the CHILD's id — the child is the
        // event's *subject* — but its session is never in this registry (only
        // the parent's is, and the parent's dock is what these events
        // maintain). Routing by `event.threadId` would hand them to nobody and
        // the dock would silently stay empty. So these two types go to the
        // session owning the child's parent instead. The event shape stays
        // exactly as the main process emits it — the child genuinely is the
        // subject — a future reader must not "fix" this back into a by-child
        // lookup.
        if (event.type === "thread.spawned" || event.type === "thread.spawn-updated") {
          const parent = sessions.value.find(
            (x) => x.threadId.value === event.spawned.parentThreadId,
          );
          parent?.reduce(event);
          // A child whose gate settled (turn ended) never emits a matching
          // approval.resolved — clear the inbox so a stale decide can't linger.
          if (event.spawned.status !== "waiting-for-approval") {
            clearChildApprovalFor(event.spawned.threadId);
          }
          return;
        }
        // A spawned child's approval events also carry the CHILD's id. A child
        // resident in the registry (opened/revealed) folds them as a normal
        // session; one that is not would see the ask dropped by the fan-out
        // below, leaving a surfaced gate that cannot be answered. Route those
        // into the registry-level inbox the dock's decide action reads.
        if (event.type === "approval.requested" || event.type === "approval.resolved") {
          const resident = sessions.value.some((x) => x.threadId.value === event.threadId);
          if (!resident) {
            if (event.type === "approval.requested") {
              setChildApproval(event.threadId, {
                requestId: event.requestId,
                approval: event.approval,
              });
            } else {
              clearChildApproval(event.threadId, event.requestId);
            }
            return;
          }
        }
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
  }, { immediate: true });

  // ── active-thread projection (the public state the view binds) ───────────────
  const NO_BLOCKS: ThreadBlock[] = [];
  const NO_SPAWNED_CHILDREN: SpawnedThread[] = [];
  const threadId = computed(() => active.value?.threadId.value ?? "");
  const provider = computed(() => active.value?.provider.value ?? options.provider);
  const title = computed(() => active.value?.title.value ?? "");
  const blocks = computed(() => active.value?.blocks.value ?? NO_BLOCKS);
  const spawnedChildren = computed(() => active.value?.spawnedChildren.value ?? NO_SPAWNED_CHILDREN);
  const session = computed(() => active.value?.session.value ?? null);
  const sessionState = computed<RuntimeSessionState>(
    () => active.value?.sessionState.value ?? "stopped",
  );
  const busy = computed(() => active.value?.busy.value ?? false);
  /** The active thread's queued follow-ups (display positions) — what the
   *  composer's chips read; matches the `busy` projection it sits beside. */
  const queuedTurns = computed<QueuedTurnEntry[]>(() => active.value?.queuedTurns.value ?? []);
  const error = computed(() => active.value?.error.value ?? null);
  const warning = computed(() => active.value?.warning.value ?? null);
  const sendBlockedReason = computed(() => active.value?.sendBlockedReason.value ?? null);
  const tokenUsage = computed(() => active.value?.tokenUsage.value ?? null);
  const pendingUserInput = computed(() => active.value?.pendingUserInput.value ?? null);
  const pendingApproval = computed(() => active.value?.pendingApproval.value ?? null);
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
      model: s.model.value,
      // A side chat's pill reads its own timeline — the fork-imported history
      // is reference context, not something to surface as a "replied" state.
      block: latestAssistant(s.timelineBlocks.value),
      task: activePlanTask(s.timelineBlocks.value),
      busy: s.busy.value,
      attention: s.attention.value,
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
  /** Steer a mid-turn nudge into the RUNNING thread's live turn (same turn,
   *  no new boundary). No-ops when the board has no thread column at all. */
  const steerTurn = async (text: string, attachments?: ChatAttachment[]) => {
    await active.value?.steerTurn(text, attachments);
  };
  /** Cancel one durably queued follow-up (the composer chips' ✕). */
  const cancelQueuedTurn = async (queueId: string) => {
    await active.value?.cancelQueuedTurn(queueId);
  };
  const uploadAttachment = (file: File): Promise<ChatAttachment> => {
    const s = active.value;
    if (!s) return Promise.reject(new Error("No thread column is open."));
    return s.uploadAttachment(file);
  };
  const interrupt = async () => { await active.value?.interrupt(); };
  const stopSubagent = async (toolUseId: string) => {
    await active.value?.stopSubagent(toolUseId);
  };
  const steerSubagent = async (toolUseId: string, message: string) => {
    await active.value?.steerSubagent(toolUseId, message);
  };
  const respondUserInput = async (requestId: string, answers: UserInputAnswers) => {
    await active.value?.respondUserInput(requestId, answers);
  };
  const respondApproval = async (requestId: string, decision: ApprovalDecision) => {
    await active.value?.respondApproval(requestId, decision);
  };
  const demo = (opts?: { fast?: boolean }) => active.value?.demo(opts);
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
    if (s) {
      activeKey.value = s.key;
      s.touch();
    }
  }

  /** Begin a brand-new, empty thread and make it active. The registry holds at
   *  most one blank thread; asking again relocates/reuses rather than stacking.
   *  If any resident session is already a blank slate, it is activated (and
   *  inherits settings from the previously-active non-blank session) without
   *  spawning. Only when no blank exists anywhere is a fresh thread spawned. */
  async function newThread(): Promise<void> {
    const prev = active.value;
    const existing = sessions.value.find(isThreadSessionBlank);
    if (existing) {
      // The blank being reused may be the registry's boot session, which owes
      // its maker a rehydrate. Nobody asking for a new thread wants that (see
      // disownRehydrate) — the reuse is what makes this thread new.
      existing.disownRehydrate();
      activeKey.value = existing.key;
      existing.touch();
      if (prev && prev !== existing && !isThreadSessionBlank(prev)) {
        inheritSettings(prev, existing);
      }
      pruneResident();
      return;
    }
    const fresh = spawn({ rehydrate: false });
    // Carry the active thread's picked settings onto the new one (see
    // inheritSettings) so starting a conversation from Project Home keeps the
    // composer's provider/model/reasoning/mode rather than the boot defaults.
    if (prev && prev !== fresh) inheritSettings(prev, fresh);
    activeKey.value = fresh.key;
    // Same as newThreadAt: the blank thread is usable immediately; its provider
    // process comes up on the first send.
    fresh.deferStart();
    // Drop the prior thread only if it's still a blank slate — no transcript,
    // nothing in flight. A restored conversation has blocks even when it hasn't
    // sent a turn this session; evicting those is what left the column you just
    // left sitting on "Opening…".
    if (prev && prev !== fresh && isThreadSessionBlank(prev)) {
      await evict(prev);
    }
    pruneResident();
  }

  /** A brand-new thread that is nobody else's: always a fresh session, never
   *  the registry's spare blank.
   *
   *  `newThread` reuses a blank when it finds one, and on the board that is
   *  right — a blank column IS where a new thread goes, so reusing it is what
   *  keeps ⌘N from stacking empty columns. A surface off the board has no such
   *  column, and the blank it would be handed belongs to a pane it cannot see:
   *  the thread it starts would appear in the studio's empty column instead of
   *  where it was written. Returns the key, because a caller that means "this
   *  exact session" should not have to find it again.
   *
   *  Synchronous on purpose. The session exists and is usable the moment it is
   *  made — its provider process comes up on the first send (see deferStart) —
   *  so a caller can pin it against the sweep in the same tick, with no window
   *  in which the blank it just asked for is a blank anyone else may take. */
  function newDetachedThread(): string {
    const fresh = spawn({ rehydrate: false });
    fresh.deferStart();
    activeKey.value = fresh.key;
    return fresh.key;
  }

  /** Open a blank thread at a specific strip index (0 = left edge). Used by the
   *  seam action bar to insert left or right of a column boundary. Returns the
   *  column's stable key so a caller can bind to it directly rather than
   *  diffing the session set to work out which one it just made.
   *
   *  Enforces the single-blank-thread invariant: the registry holds at most one
   *  blank thread; asking again relocates/reuses rather than stacking. If a blank
   *  session already exists anywhere in the registry, it is relocated to the
   *  requested index and activated rather than spawning a duplicate. */
  async function newThreadAt(index: number): Promise<string> {
    const existing = sessions.value.find(isThreadSessionBlank);
    if (existing) {
      // As in newThread: a reused blank must not still be carrying somebody
      // else's rehydrate.
      existing.disownRehydrate();
      const list = sessions.value.filter((s) => s !== existing);
      const insertAt = Math.min(Math.max(0, index), list.length);
      list.splice(insertAt, 0, existing);
      sessions.value = list;

      const neighbor = list[insertAt - 1] ?? list[insertAt + 1];
      if (neighbor) inheritSettings(neighbor, existing);

      activeKey.value = existing.key;
      existing.touch();
      pruneResident();
      return existing.key;
    }

    const fresh = spawn({ rehydrate: false });
    const list = [...sessions.value];
    list.pop();
    const insertAt = Math.min(Math.max(0, index), list.length);
    list.splice(insertAt, 0, fresh);
    sessions.value = list;

    const neighbor = list[insertAt - 1] ?? list[insertAt + 1];
    if (neighbor) inheritSettings(neighbor, fresh);

    activeKey.value = fresh.key;
    // Don't await a CLI spawn to show a blank column. The session object exists
    // now, so the board records its key and the pane paints this tick; the
    // provider process comes up on the first send (see deferStart). This is the
    // whole of the ⌘N stall.
    fresh.deferStart();
    pruneResident();
    return fresh.key;
  }

  type ThreadHandle = {
    key: string;
    ready: Promise<void>;
  };

  /** Bring a specific stored thread on-screen, handing back its column's stable
   *  key *immediately* — before a byte of transcript has been read — alongside a
   *  `ready` promise that settles once the load has. The split is what lets the
   *  board bind a pane and paint on the same tick the user clicks: waiting for
   *  `ready` first is what left a reopened conversation showing "Opening…".
   *
   *  If the thread is already resident (still running in the background, say),
   *  just activate it — no reload, no teardown. */
  function openThreadHandle(id: string): ThreadHandle {
    const existing = sessions.value.find((x) => x.threadId.value === id);
    if (existing) {
      activeKey.value = existing.key;
      existing.touch();
      return { key: existing.key, ready: Promise.resolve() };
    }
    // Dedupe concurrent opens of the same thread. While an open is in flight,
    // fold later calls into it — but still re-activate the loading session,
    // since a repeat open is the user's latest intent (open A, B, then A again
    // must end on A, not B).
    const inFlight = opening.get(id);
    if (inFlight) {
      activeKey.value = inFlight.key;
      const loading = sessions.value.find((x) => x.key === inFlight.key);
      loading?.touch();
      return { key: inFlight.key, ready: inFlight.promise };
    }
    // If the active thread is still a blank slate, drop it rather than stacking
    // it behind the opened thread. A restored conversation (transcript already
    // on the session) stays resident — `everRan` only flips on a turn *this*
    // session, so using that as the throwaway test evicted every stored column
    // the moment another one attached.
    const prev = active.value;
    const s = spawn({ rehydrate: false });
    activeKey.value = s.key;
    // openStored() claims the thread id in its synchronous prologue, so by the
    // time this call returns the session is already findable by id — which is
    // what makes the `existing` check above race-free without the opening map
    // having to carry it.
    const ready = (async () => {
      try {
        await s.openStored(id);
        // Never evict the thread that's now active (under interleaved opens
        // `prev` may have been re-activated by a later request) nor one whose
        // own open is still in flight (evicting would dispose it mid-load).
        const prevOpening = prev && [...opening.values()].some((e) => e.key === prev.key);
        if (
          prev &&
          prev !== s &&
          prev.key !== activeKey.value &&
          !prevOpening &&
          isThreadSessionBlank(prev)
        ) {
          await evict(prev);
        }
        pruneResident();
      } finally {
        opening.delete(id);
      }
    })();
    opening.set(id, { key: s.key, promise: ready });
    return { key: s.key, ready };
  }

  /** openThreadHandle, awaited — for callers that just want the thread on screen
   *  and settled. */
  async function openThread(id: string): Promise<void> {
    await openThreadHandle(id).ready;
  }

  /** Drop a thread from the registry entirely — for when it's archived or
   *  deleted from the recent-sessions list. Tears the session down so its pill
   *  can't linger and stay clickable. If the forgotten thread was active, focus
   *  moves to a neighbour; no replacement is spawned — the board owns what's on
   *  screen, and a minted blank session would be adopted as a phantom empty
   *  column. */
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
    if (s.key === activeKey.value) {
      const list = sessions.value;
      const i = list.findIndex((x) => x.key === s.key);
      const neighbour = list[i + 1] ?? list[i - 1];
      activeKey.value = neighbour ? neighbour.key : "";
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
    const s = sessions.value.find((x) => x.key === key);
    if (s) {
      activeKey.value = key;
      s.touch();
    }
  }

  /** Step focus `delta` columns along the strip. Clamped at both ends — niri's
   *  focus-column-left/right stop at the edge rather than wrapping, and wrapping
   *  would make the strip feel like a carousel instead of a place. */
  function focusByOffset(delta: number): void {
    const list = sessions.value;
    const i = list.findIndex((s) => s.key === activeKey.value);
    if (i === -1) return;
    const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next) {
      activeKey.value = next.key;
      next.touch();
    }
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
    s.touch();
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
    // Stop this view's own ticking clock — it restarts on re-mount if any
    // session is still busy (the watch runs immediate).
    if (clock !== null) clearInterval(clock);
    clock = null;
    // Deliberately NOT disposing sessions here. The registry is module-scoped
    // per project path; disposing on unmount is what killed every thread of a
    // project the moment the user switched projects — including busy
    // background turns (the provider processes live in the main process, and
    // the renderer's dispose() is the only thing that stops them). Sessions
    // are torn down on explicit thread close (evict/forgetThread) and
    // hibernated when idle (the sweep) — a project switch is a swap of
    // registries, not a massacre.
  });

  return {
    // identity (active-thread projection)
    threadId,
    provider,
    title,
    // state (active-thread projection)
    blocks,
    spawnedChildren,
    session,
    sessionState,
    busy,
    queuedTurns,
    error,
    warning,
    sendBlockedReason,
    tokenUsage,
    pendingUserInput,
    pendingApproval,
    model,
    mode,
    reasoning,
    serviceTier,
    contextWindow,
    now,
    // the whole registry — for the away-from-thread pill stack
    threads,
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
    // Reported by the board when a pane's session-key join lands or unwinds,
    // so the sweep never disposes a session sitting in a visible column.
    pinToPane,
    unpinFromPane,
    // actions
    start,
    restart,
    newThread,
    newDetachedThread,
    newThreadAt,
    openThread,
    openThreadHandle,
    send,
    steerTurn,
    cancelQueuedTurn,
    uploadAttachment,
    demo,
    interrupt,
    stopSubagent,
    steerSubagent,
    respondUserInput,
    respondApproval,
    setProvider,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    setContextWindow,
  };
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export * from "./agentTypes.js";
export * from "./agentPrefetch.js";

