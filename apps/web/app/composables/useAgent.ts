import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
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
  Session,
  SpawnedThread,
  StoredThread,
  SubagentRun,
  SubagentRunSnapshot,
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
  /** True once a live turn has actually started here — rehydrated history alone
   *  doesn't count, so a freshly reloaded thread never pills. */
  everRan: boolean;
  isActive: boolean;
};

/** Tag every block from a stored thread as historical so the view mounts them
 *  settled instead of replaying entry/word animations across the whole thread. */
// ── transcript prefetch ───────────────────────────────────────────────────────
// A thread's transcript read is the one unavoidable round-trip left on the open
// path — everything else (the CLI spawn, the pane binding) is now deferred or
// synchronous. But the user tells us which thread they want a beat before they
// click it: they point at it. Hovering a recent-session row starts the read, so
// by the time the click lands the rows are usually already in hand.
//
// Deliberately small and short-lived. A prefetch is a *snapshot*, and a thread
// the agent is still writing to moves on without it, so an entry that isn't
// consumed almost immediately is thrown away rather than served stale. (The live
// case can't reach here anyway — openThreadHandle hands back the resident
// session before openStored is ever called.)
const PREFETCH_TTL_MS = 20_000;
const PREFETCH_MAX = 6;
const prefetched = new Map<string, { at: number; load: Promise<StoredThread | null> }>();

/** Start reading a stored thread's transcript now, so opening it later is free.
 *  Fire-and-forget and idempotent — safe to call on every pointerenter. */
export function prefetchThread(id: string): void {
  if (!import.meta.client || !id) return;
  const api = window.koneDesktop?.agent;
  if (!api) return;
  const hit = prefetched.get(id);
  if (hit && Date.now() - hit.at < PREFETCH_TTL_MS) return;
  // Never let a rejected read reach an unhandled-rejection: the consumer may
  // never come, and a failed prefetch just means openStored does the read itself.
  const load = api.history.thread(id).catch(() => null);
  prefetched.delete(id); // re-insert, so this id is now the newest in Map order
  prefetched.set(id, { at: Date.now(), load });
  while (prefetched.size > PREFETCH_MAX) {
    const oldest = prefetched.keys().next().value;
    if (oldest === undefined) break;
    prefetched.delete(oldest);
  }
}

/** Consume a prefetched transcript, if one is in hand and still fresh. Always
 *  removes the entry — a transcript is read once, on open. */
function takePrefetched(id: string): Promise<StoredThread | null> | null {
  const hit = prefetched.get(id);
  if (!hit) return null;
  prefetched.delete(id);
  return Date.now() - hit.at < PREFETCH_TTL_MS ? hit.load : null;
}

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

// ── spawned children's approvals (the registry-level inbox) ──────────────────
// A spawned child has no session in this registry, so its `approval.requested`
// event is dropped by the by-threadId fan-out — its gate would be surfaced but
// unanswerable. These live in ONE module-scope inbox keyed by the CHILD's id
// (unique app-wide), fed by the event router below, cleared on
// `approval.resolved`. A child that IS resident (opened/revealed in the
// renderer) is a normal session — its approvals route into its session's
// pendingApprovals and the composer modal, never here. The dock/panel read the
// inbox to render a parked child's gate with real decide buttons.
const childApprovals = shallowRef(new Map<string, PendingApproval>());
/** The inbox as a read-only computed — the dock/panel bind to it so a child's
 *  parked ask appears (and its decide buttons work) without a resident session. */
export const childApprovalsInbox = computed(() => childApprovals.value);

function setChildApproval(childThreadId: string, pending: PendingApproval): void {
  childApprovals.value = new Map(childApprovals.value).set(childThreadId, pending);
}

/** Clear the inbox entry for a child — a resolved request, or a newer request
 *  that replaced it. Only removes when the parked requestId matches, so a stale
 *  resolve can't wipe a fresher ask. */
function clearChildApproval(childThreadId: string, requestId: string): void {
  const current = childApprovals.value.get(childThreadId);
  if (!current || current.requestId !== requestId) return;
  const next = new Map(childApprovals.value);
  next.delete(childThreadId);
  childApprovals.value = next;
}

/** Drop the inbox entry for a child regardless of requestId — used when the
 *  child's projection settles out of an approval gate (its turn ended, so no
 *  `approval.resolved` ever arrives). */
function clearChildApprovalFor(childThreadId: string): void {
  if (!childApprovals.value.has(childThreadId)) return;
  const next = new Map(childApprovals.value);
  next.delete(childThreadId);
  childApprovals.value = next;
}

/** Decide a spawned child's parked approval. The child has no session here, so
 *  the response goes straight over the bridge to the existing agent:respond IPC
 *  (the child's own thread id + the parked requestId) — no gateway tool, no
 *  parent session involved. Cleared optimistically; the adapter's
 *  `approval.resolved` is the belt-and-braces re-clear. */
export async function decideChildApproval(
  childThreadId: string,
  requestId: string,
  decision: ApprovalDecision,
): Promise<void> {
  clearChildApproval(childThreadId, requestId);
  const api = import.meta.client ? window.koneDesktop?.agent : undefined;
  if (!api) return;
  try {
    await api.respond(childThreadId, requestId, decision);
  } catch {
    // If the send fails the child's turn will abort and settle the gate anyway.
  }
}

/** The one nested run still working inside a turn — the only run an approval
 *  landing right now could have come from — else undefined (the parent asked,
 *  or several runs were live at once and the ask can't be pinned to one).
 *  Approvals carry no subagent attribution upstream, so this is the honest
 *  best available read: it lets a single live child's ask render inline in
 *  its shell without ever guessing wrong on a concurrent batch. */
function originSubagentOfApproval(block: AssistantBlock | undefined): string | undefined {
  if (!block) return undefined;
  const live: string[] = [];
  for (const item of block.items) {
    const run = item.subagent;
    if (run && (run.status === "starting" || run.status === "running")) {
      live.push(run.toolUseId);
    }
  }
  return live.length === 1 ? live[0] : undefined;
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
  /** True when this session hosts a side chat — a root thread forked from
   *  another thread (docs/side-chat-design.md). Set when the stored thread's
   *  forkContext is adopted; cleared on restart (a fresh thread is never a
   *  side chat). Drives the temporary look and the timeline's hiding of the
   *  fork-imported transcript. */
  const sideChat = ref(false);
  /** The thread this side chat was forked from (forkContext.sourceThreadId). */
  const sideChatSource = ref<string | null>(null);
  const isSideChat = computed(() => sideChat.value);
  /** The timeline the conversation view renders: a side chat hides its
   *  fork-imported transcript (reference-only context — the model sees it via
   *  the one-shot bootstrap, the user sees only the side chat's own turns), a
   *  normal thread renders everything. `blocks` stays the full source of
   *  truth for busy/persistence/dock state. */
  const timelineBlocks = computed<ThreadBlock[]>(() =>
    isSideChat.value
      ? blocks.value.filter(
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

  // The provider is mutable so a thread can switch engines (Codex ↔ Claude).
  // Because the two are separate CLIs with no shared conversation, a switch is a
  // fresh session — restart() below tears the old one down and starts anew.
  const provider = ref<ProviderKind>(options.provider);
  const model = ref(options.model);
  const mode = ref<InteractionMode>(options.mode ?? "accept-edits");
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
    else block.items[idx] = { ...item, ...(block.items[idx]!.subagent ? { subagent: block.items[idx]!.subagent } : {}) };
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
        pendingApprovals.value = [
          ...pendingApprovals.value,
          {
            requestId: event.requestId,
            approval: event.approval,
            ...(origin ? { originToolUseId: origin } : {}),
          },
        ];
        break;
      }
      case "approval.resolved":
        // The backend settled this round-trip (our decision, or a drain on
        // interrupt/stop). Drop it from the queue — the modal moves to the next.
        pendingApprovals.value = pendingApprovals.value.filter(
          (a) => a.requestId !== event.requestId,
        );
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
    provider?: ProviderKind;
    model?: string;
    conversationId?: string;
    tokens?: number;
    contextUsed?: number;
    contextWindow?: number;
    compactsAutomatically?: boolean;
    /** Present on a side chat — marks this session as one (forkContext
     *  presence is the discriminator, never a title prefix). */
    forkContext?: ForkContext;
  }): void {
    const providerChanged = Boolean(stored.provider) && stored.provider !== provider.value;
    if (stored.provider) provider.value = stored.provider;
    // Carry the thread's own model; if it predates model persistence, only drop
    // the current one when the provider changed (a stale cross-provider model id
    // is worse than the provider default).
    if (stored.model !== undefined) model.value = stored.model;
    else if (providerChanged) model.value = undefined;
    pendingResumeId = stored.conversationId;
    pendingResumeProvider = provider.value;
    if (stored.forkContext) {
      sideChat.value = true;
      sideChatSource.value = stored.forkContext.sourceThreadId;
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
        seedSpawnedChildren();
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
    if (staged && !resume) {
      console.warn(
        `[agent] dropping resume id — staged for ${pendingResumeProvider}, starting on ${provider.value}`,
      );
    }
    pendingResumeId = undefined;
    pendingResumeProvider = undefined;
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
    const api = bridge();
    // Browser dev has no history bridge — just bring a (mock) session up so the
    // composer is live rather than leaving the view without a session.
    if (!api) {
      await start();
      return;
    }
    let stored;
    try {
      // Hovering the row that opened this thread may already have started the
      // read (see prefetchThread) — take that in-flight promise rather than
      // firing a second one.
      stored = await (takePrefetched(id) ?? api.history.thread(id));
    } catch {
      stored = null;
    }
    // Forgotten while the history load was in flight (opened then immediately
    // archived/deleted) — bail before revealing the transcript or arming a
    // session, so the removed thread is never shown or recreated.
    if (forgotten) return;
    // Thread vanished (deleted/archived under us) — fall back to a fresh blank
    // thread rather than an empty, session-less view. Drop the claimed id on the
    // way: keeping it would have the first send hand `startSession` the id of a
    // thread the user just deleted, and ensureThread would write the row back.
    if (!stored) {
      threadId.value = uid();
      deferStart();
      return;
    }
    blocks.value = markHistorical(stored.blocks as ThreadBlock[]);
    title.value = stored.title?.trim() || "";
    adoptStoredThread(stored); // also restores the persisted context-meter snapshot
    error.value = null;
    seedSpawnedChildren();
    deferStart();
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
    } finally {
      dispatching.value = false;
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
    threadId.value = uid();
    tokenUsage.value = null;
    sessionState.value = "starting";
    // A restart is a deliberate re-birth: the new thread is a fresh
    // conversation, never a side chat.
    sideChat.value = false;
    sideChatSource.value = null;
    // …and it has spawned nothing yet — the old thread's children belong to
    // the old thread, not this brand-new one.
    spawnedChildren.value = [];
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
    // A nested subagent spawn — the whole shape the real ClaudeAdapter produces:
    // the parent's Task tool_call opens, `subagent.started` nests a run on it, the
    // child's transcript streams in as items tagged with the run's toolUseId (the
    // corner Subagents dock reads these), the run settles with a summary, then the
    // parent tool call completes carrying that summary. Exercises the dock's
    // starting → running → completed lifecycle end to end.
    const spawnSubagent = async (opts: {
      agentType: string;
      description: string;
      model?: string;
      effort?: string;
      /** Hold before the run opens — staggers concurrent spawns in the dock. */
      leadMs?: number;
      steps: Array<{ kind: RuntimeItemKind; name?: string; text: string; ms: number }>;
      summary: string;
    }): Promise<void> => {
      if (opts.leadMs) await wait(opts.leadMs);
      if (cancelled) return;
      const toolUseId = uid();
      const parentItemId = uid();
      const startedAt = Date.now();
      // 1 — the parent Task tool call opens (the spawn point).
      const parent: RuntimeItem = {
        itemId: parentItemId,
        kind: "tool_call",
        status: "in-progress",
        name: "task",
        text: `task: ${opts.description}`,
      };
      emit(parent, "item.started");
      const snapshot: SubagentRunSnapshot = {
        toolUseId,
        parentItemId,
        agentType: opts.agentType,
        description: opts.description,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        status: "starting",
        startedAt,
        toolUses: 0,
      };
      const emitRun = (type: "subagent.started" | "subagent.updated" | "subagent.completed") =>
        reduce({ ...base(type), type, turnId, subagent: { ...snapshot } } as RuntimeEvent);
      // 2 — the run is recognized and nested onto its parent tool call.
      emitRun("subagent.started");
      await wait(320);
      if (cancelled) return;
      snapshot.status = "running";
      emitRun("subagent.updated");
      // 3 — the child's transcript streams in, tagged with the run's id so it
      //     lands inside the run, not the parent turn's body.
      let toolUses = 0;
      for (const step of opts.steps) {
        if (cancelled) return;
        const child: RuntimeItem = {
          itemId: uid(),
          kind: step.kind,
          status: "in-progress",
          text: step.kind === "tool_call" && step.name ? `${step.name}: ${step.text}` : step.text,
          ...(step.name ? { name: step.name } : {}),
        };
        reduce({ ...base("item.started"), type: "item.started", turnId, item: { ...child }, subagentToolUseId: toolUseId } as RuntimeEvent);
        if (step.kind === "tool_call") {
          toolUses += 1;
          snapshot.toolUses = toolUses;
          snapshot.lastToolName = step.name;
          emitRun("subagent.updated");
        }
        await wait(step.ms);
        if (cancelled) return;
        child.status = "completed";
        reduce({ ...base("item.completed"), type: "item.completed", turnId, item: { ...child }, subagentToolUseId: toolUseId } as RuntimeEvent);
      }
      if (cancelled) return;
      // 4 — the run settles with its report…
      snapshot.status = "completed";
      snapshot.summary = opts.summary;
      snapshot.endedAt = Date.now();
      delete snapshot.lastToolName;
      emitRun("subagent.completed");
      // 5 — …and the parent tool call completes, carrying that report.
      parent.status = "completed";
      parent.detail = opts.summary;
      emit(parent, "item.completed");
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
        // Several real nested subagents, launched together — the corner
        // Subagents dock fills with concurrent runs (each streaming its own
        // transcript) that settle one by one as the parent waits on the batch.
        await Promise.all([
          spawnSubagent({
            agentType: "explore",
            description: "Map the conversation-thread render path",
            model: "claude-haiku-4-5",
            effort: "low",
            leadMs: 0,
            steps: [
              {
                kind: "reasoning_text",
                text: "I'll trace how a turn's parts reach the screen — from the reducer's ordered items through AgentActivity into the thread.",
                ms: 1100,
              },
              { kind: "tool_call", name: "grep_search", text: "segKindOf · 4 matches", ms: 900 },
              { kind: "tool_call", name: "read_file", text: "ConversationThread.vue", ms: 1300 },
              { kind: "tool_call", name: "read_file", text: "AgentActivity.vue", ms: 1200 },
              { kind: "tool_call", name: "list_dir", text: "apps/web/app/components", ms: 800 },
              {
                kind: "assistant_text",
                text: "The reducer folds events into ordered parts; AgentActivity groups thinking + tools, and the thread paints them in arrival order.",
                ms: 900,
              },
            ],
            summary:
              "Mapped the render path: reducer → ordered RuntimeItems → AgentActivity (groups thinking + tools) → ConversationThread paints in arrival order. No indirection between the stream and the timeline.",
          }),
          spawnSubagent({
            agentType: "review",
            description: "Audit the step-list rail for regressions",
            model: "claude-sonnet-5",
            effort: "high",
            leadMs: 700,
            steps: [
              {
                kind: "reasoning_text",
                text: "I'll walk the connecting line across every group shape — thinking-only, tools-only, mixed, and text-broken — and look for gaps.",
                ms: 1300,
              },
              { kind: "tool_call", name: "read_file", text: "AgentActivity.vue", ms: 1100 },
              { kind: "tool_call", name: "grep_search", text: "seg-rail · 5 matches", ms: 900 },
              { kind: "tool_call", name: "read_file", text: "ActivityStep.vue", ms: 1200 },
              { kind: "tool_call", name: "bash", text: "bun test conversation-thread", ms: 1600 },
              {
                kind: "assistant_text",
                text: "Rail holds across all four shapes — the connector never breaks between a thought and the tool that follows it.",
                ms: 800,
              },
            ],
            summary:
              "Reviewed the step-list rail across 4 group shapes (thinking-only, tools-only, mixed, text-broken) — connecting line is continuous, no gaps found. Suite green.",
          }),
          spawnSubagent({
            agentType: "build",
            description: "Draft the nested-transcript inline view",
            model: "claude-sonnet-5",
            effort: "medium",
            leadMs: 1500,
            steps: [
              {
                kind: "reasoning_text",
                text: "I'll sketch a collapsible transcript that hangs under the spawning tool call, reusing the same ordered-parts renderer.",
                ms: 1200,
              },
              { kind: "tool_call", name: "read_file", text: "AgentSubagentDock.vue", ms: 1100 },
              { kind: "tool_call", name: "write_to_file", text: "SubagentTranscript.vue", ms: 1500 },
              { kind: "tool_call", name: "edit_file", text: "ConversationThread.vue", ms: 1400 },
              { kind: "tool_call", name: "bash", text: "bun run check-types", ms: 1800 },
              {
                kind: "assistant_text",
                text: "Drafted SubagentTranscript.vue and wired it under the parent tool call — types pass.",
                ms: 900,
              },
            ],
            summary:
              "Drafted SubagentTranscript.vue — a collapsible child transcript nested under the spawning tool call, reusing the ordered-parts renderer. Types pass; left unwired behind the dock for review.",
          }),
        ]);
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
    tokenUsage,
    // The child threads this one has spawned. Exposed per-session, not just on
    // the active projection: the Subagents dock reads the FOCUSED thread, which
    // on a multi-column board isn't necessarily the active one.
    spawnedChildren,
    pendingUserInput,
    pendingApproval,
    pendingApprovals,
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
    ensureStarted,
    openStored,
    restart,
    send,
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
   *  first, never the active one and never anything still busy. A thread with
   *  live spawned children is never evicted either: evicting tears down the
   *  parent's provider session and revokes its gateway token mid-orchestration,
   *  while its children keep running headless against a parent that can no
   *  longer answer them. */
  function pruneResident(): void {
    const idle = sessions.value.filter(
      (s) =>
        s.key !== activeKey.value &&
        !s.busy.value &&
        !s.spawnedChildren.value.some((c) => !c.terminal),
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
  });

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
  const error = computed(() => active.value?.error.value ?? null);
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
    // Same as newThreadAt: the blank thread is usable immediately; its provider
    // process comes up on the first send.
    fresh.deferStart();
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
   *  seam action bar to insert left or right of a column boundary. Returns the
   *  new column's stable key so a caller can bind to it directly rather than
   *  diffing the session set to work out which one it just made. */
  async function newThreadAt(index: number): Promise<string> {
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

  /** Bring a specific stored thread on-screen, handing back its column's stable
   *  key *immediately* — before a byte of transcript has been read — alongside a
   *  `ready` promise that settles once the load has. The split is what lets the
   *  board bind a pane and paint on the same tick the user clicks: waiting for
   *  `ready` first is what left a reopened conversation showing "Opening…".
   *
   *  If the thread is already resident (still running in the background, say),
   *  just activate it — no reload, no teardown. */
  function openThreadHandle(id: string): { key: string; ready: Promise<void> } {
    const existing = sessions.value.find((x) => x.threadId.value === id);
    if (existing) {
      activeKey.value = existing.key;
      return { key: existing.key, ready: Promise.resolve() };
    }
    // Dedupe concurrent opens of the same thread. While an open is in flight,
    // fold later calls into it — but still re-activate the loading session,
    // since a repeat open is the user's latest intent (open A, B, then A again
    // must end on A, not B).
    const inFlight = opening.get(id);
    if (inFlight) {
      activeKey.value = inFlight.key;
      return { key: inFlight.key, ready: inFlight.promise };
    }
    // If the active thread is idle and never ran a live turn this session (a
    // blank slate or a rehydrated latest the user stepped past), drop it rather
    // than stacking it behind the opened thread — its transcript is on disk.
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
          !prev.busy.value &&
          !prev.everRan.value
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
      fresh.deferStart();
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
    spawnedChildren,
    session,
    sessionState,
    busy,
    error,
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
    openThreadHandle,
    send,
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
