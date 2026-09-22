import { computed, ref, type Ref } from "vue";
import type {
  ForkContext,
  InteractionMode,
  KoneAgentApi,
  ProviderKind,
  RuntimeEvent,
  StoredBlock,
  ThreadEnvMode,
  SessionStartInput,
  TokenUsage,
} from "~/types/desktop";
import { isEffortTier } from "~/utils/modelCatalog";
import { bootMode, MODES } from "~/utils/modelPicker";
import { peelIpcError } from "~/utils/ipcError";
import { adoptStoredBlocks } from "../agentPrefetch";
import { rememberSideChatSource } from "../sideChats";
import type { QueuedTurnEntry, ReasoningTier, ThreadBlock } from "../agentTypes";
import { queuedBlockIdsOf } from "./sessionQueue";

/** User prompts per windowed page (history.threadPage). This IS the
 *  "threshold" for pagination: the store's window is user-anchored, so a
 *  thread with at most PAGE_LIMIT prompts comes back whole (`hasMore` false)
 *  — byte-for-byte the same transcript the full read would return, in one
 *  round-trip — while a longer thread returns its newest window and pages the
 *  rest on demand. No separate block-count probe is needed (probing would
 *  require loading the full thread first, which is exactly the cost
 *  pagination avoids); `hasMore` is the store's authoritative signal. */
export const PAGE_LIMIT = 10;

/** The stored transcript: blocks, keyset paging, and adopting a stored
 *  identity. Rehydration touches queue seeding, compaction seeding and
 *  spawned children — those arrive as the seed callbacks below rather than
 *  imports of the other units. The staged workspace choice and the provider
 *  resume cursor stay in the session that creates this unit (start() consumes
 *  both), so they arrive as read/store callbacks. */
export type SessionTranscriptDeps = {
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | null;
  title: Ref<string>;
  tokenUsage: Ref<TokenUsage | null>;
  sideChat: Ref<boolean>;
  sideChatSource: Ref<string | null>;
  isSideChat: Ref<boolean>;
  readQueuedRows: () => QueuedTurnEntry[];
  worktreePath: Ref<string | null>;
  envMode: Ref<ThreadEnvMode | null>;
  workspacePending: Ref<boolean>;
  requestedBranch: Ref<string | null>;
  provider: Ref<ProviderKind | null>;
  model: Ref<string | undefined>;
  mode: Ref<InteractionMode>;
  reasoning: Ref<ReasoningTier>;
  serviceTier: Ref<string | undefined>;
  contextWindow: Ref<string | undefined>;
  resolveCwd: () => string;
  rehydrateEnabled: boolean;
  claimRehydrate: () => boolean;
  readStagedWorkspace: () => SessionStartInput["workspace"];
  storeStagedWorkspace: (choice: SessionStartInput["workspace"]) => void;
  stageResume: (
    resumeId: string | undefined,
    resumeProvider: ProviderKind | undefined,
    resumeSessionAt: string | undefined,
  ) => void;
  reduce: (event: RuntimeEvent) => void;
  takeOrphanUserInputs: (threadId: string) => RuntimeEvent[];
  takeOrphanApprovals: (threadId: string) => RuntimeEvent[];
  seedQueuedTurns: (api: KoneAgentApi) => void;
  seedCompactions: () => void;
  seedCheckpoints: () => void;
  seedSpawnedChildren: () => void;
};

/** The conversation transcript: the full block timeline, the rendered view
 *  over it, keyset pagination for stored threads, and adopting a stored
 *  thread's identity (provider, model, resume cursor, workspace, meter). */
export function useSessionTranscript(deps: SessionTranscriptDeps) {
  const {
    threadId,
    bridge,
    title,
    tokenUsage,
    sideChat,
    sideChatSource,
    isSideChat,
    readQueuedRows,
    worktreePath,
    envMode,
    workspacePending,
    requestedBranch,
    provider,
    model,
    mode,
    reasoning,
    serviceTier,
    contextWindow,
    resolveCwd,
    rehydrateEnabled,
    claimRehydrate,
    readStagedWorkspace,
    storeStagedWorkspace,
    stageResume,
    reduce,
    takeOrphanUserInputs,
    takeOrphanApprovals,
    seedQueuedTurns,
    seedCompactions,
    seedCheckpoints,
    seedSpawnedChildren,
  } = deps;

  const blocks = ref<ThreadBlock[]>([]);
  /** The stored thread's fork context, when it is a fork (side chat, edit
   *  retry, or provider handoff). Drives provenance reads (the handoff's
   *  "from" label); the side-chat look and timeline hiding stay keyed on
   *  `sideChat`, which is false for continuations. */
  const forkContext = ref<ForkContext | null>(null);  /** Keyset pagination state for a stored thread adopted windowed (see
   *  history.threadPage): the opaque cursor for the next strictly older page,
   *  null when the whole thread is in hand. `hasOlder` is what the load-older
   *  affordance reads; the cursor itself never leaves the session. */
  const olderCursor = ref<string | null>(null);
  const loadingOlder = ref(false);
  const olderError = ref<string | null>(null);
  const hasOlder = computed(() => olderCursor.value !== null);
  /** Did the last openStored read come back empty-handed? The honest signal
   *  behind the "this conversation didn't load" banner — an empty timeline is
   *  NOT the same thing (a side chat's whole transcript is hidden by design,
   *  so inferring failure from emptiness accuses every fresh side chat of a
   *  load it never attempted). Only a read that found neither a page nor a
   *  thread sets this. */
  const transcriptLoadFailed = ref(false);
  /** The timeline the conversation view renders: a side chat hides its
   *  fork-imported transcript (reference-only context — the model sees it via
   *  the one-shot bootstrap, the user sees only the side chat's own turns), and
   *  a follow-up queued behind the running turn stays out until it promotes —
   *  the queue strip above the composer owns the waiting state, so the thread
   *  only ever shows turns that have actually started. `blocks` stays the full
   *  source of truth for busy/persistence/dock state. */
  const timelineBlocks = computed<ThreadBlock[]>(() => {
    // Queued prompts live in queuedTurnsRaw, never in blocks — except the one
    // race where send() pushed optimistically while idle and the backend then
    // queued it: that block is already in blocks.value when turn.queued lands,
    // so the row anchors to it via entry.blockId and it stays hidden here
    // until promotion moves it to the tail.
    const queuedBlockIds = queuedBlockIdsOf(readQueuedRows());
    return blocks.value.filter((b) => {
      if (b.role === "user" && queuedBlockIds.has(b.id)) return false;
      if (
        isSideChat.value &&
        // SAFETY: only fork imports carry a `source` tag; others read as undefined.
        (b as ThreadBlock & { source?: string }).source === "fork-import"
      )
        return false;
      return true;
    });
  });

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
    /** Where this conversation works, recorded when its worktree was built. */
    worktreePath?: string | null;
    /** What it asked for, which is how a worktree still being built is told from
     *  a thread that never wanted one. */
    envMode?: ThreadEnvMode;
    /** The branch a pending worktree was asked for, when the user named one.
     *  Re-staged so the next start carries the same request the store holds. */
    requestedBranch?: string | null;
  }): void {
    worktreePath.value = stored.worktreePath ?? null;
    envMode.value = stored.envMode ?? null;
    requestedBranch.value = stored.requestedBranch?.trim() ? stored.requestedBranch.trim() : null;
    // A pending thread rebuilds from its stored request even when the caller
    // never re-asks, but staging it here too keeps the start input explicit —
    // the stepper and the dispatcher then agree on what is being built, and a
    // reload that wiped the in-memory draft still sends the same branch.
    if (workspacePending.value && readStagedWorkspace() === undefined) {
      const branch = requestedBranch.value;
      storeStagedWorkspace(branch ? { mode: "worktree", branch } : { mode: "worktree" });
    }
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
    if (isEffortTier(stored.selection?.effort)) reasoning.value = stored.selection.effort;
    if (stored.selection?.serviceTier !== undefined) serviceTier.value = stored.selection.serviceTier;
    if (stored.selection?.contextWindow !== undefined) contextWindow.value = stored.selection.contextWindow;
    const storedMode = stored.selection?.mode;
    if (storedMode && MODES.some((m) => m === storedMode)) {
      // SAFETY: the membership test above guards the cast.
      mode.value = storedMode as InteractionMode;
    } else {
      const booted = bootMode(resolveCwd() ?? "");
      if (booted) {
        mode.value = booted;
      }
    }
    stageResume(stored.conversationId, provider.value ?? undefined, stored.resumeSessionAt);
    // A side chat hides its fork-imported transcript (reference-only context)
    // and wears the temporary look; an edit fork or a handoff is a
    // continuation — its copied history is real history shown in the timeline
    // — so only a non-continuation fork context marks the session. Assigned
    // authoritatively (not just set-true): the stored context is the durable
    // answer and overrules the renderer hint map, which may have filed this
    // id as a side chat before the transcript arrived.
    if (stored.forkContext) {
      forkContext.value = stored.forkContext;
      sideChat.value =
        stored.forkContext.forkKind !== "edit" && stored.forkContext.forkKind !== "handoff";
      sideChatSource.value = stored.forkContext.sourceThreadId;
      // The hint map is the side-chat affordance's synchronous read (claimStoredId
      // marks the session before the transcript arrives) — continuations file
      // nothing there, so a handoff never briefly wears the side-chat look.
      if (sideChat.value) rememberSideChatSource(stored.threadId, stored.forkContext.sourceThreadId);
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
      const older = adoptStoredBlocks(page.blocks.filter((b) => !known.has(b.id)));
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
    if (!rehydrateEnabled || !claimRehydrate()) return;
    try {
      // `latest` is metadata only — it just identifies the thread. The
      // transcript comes from the windowed first page (see PAGE_LIMIT): a very
      // long thread then ships only its newest window and pages the rest on
      // demand. Only if that windowed read is unavailable or comes back empty
      // do we pay for a full reconstruction, to tell "paging failed" apart
      // from "this thread genuinely has nothing yet".
      const meta = await api.history.latest(resolveCwd());
      if (!meta) return;
      const page =
        api.history.threadPage
          ? await api.history.threadPage(meta.threadId, { limit: PAGE_LIMIT }).catch(() => null)
          : null;
      let resolvedBlocks: StoredBlock[] | null = null;
      let nextCursor: string | null = null;
      if (page && page.blocks.length > 0) {
        resolvedBlocks = page.blocks;
        nextCursor = page.nextCursor;
      } else {
        const full = await api.history.thread(meta.threadId).catch(() => null);
        if (full && full.blocks.length > 0) resolvedBlocks = full.blocks;
      }
      if (resolvedBlocks && resolvedBlocks.length > 0) {
        threadId.value = meta.threadId;
        blocks.value = adoptStoredBlocks(resolvedBlocks);
        olderCursor.value = nextCursor;
        title.value = meta.title?.trim() || title.value;
        adoptStoredThread(meta);
        seedSpawnedChildren();
        seedCompactions();
        seedCheckpoints();
        // The queue rows survive crashes — rebuild the strip from the bridge.
        seedQueuedTurns(api);
        // A question replayed before this adopt was stashed orphan-side — fold
        // it now that the id is findable, so the modal survives the reload.
        for (const evt of takeOrphanUserInputs(meta.threadId)) reduce(evt);
        // Same race for tool approvals — fold stashed gates so the approval
        // modal survives the reload like the question modal above.
        for (const evt of takeOrphanApprovals(meta.threadId)) reduce(evt);
      }
    } catch {
      // History is a convenience — never block starting a session over it.
    }
  }

  return {
    blocks,
    forkContext,
    olderCursor,
    loadingOlder,
    olderError,
    hasOlder,
    transcriptLoadFailed,
    timelineBlocks,
    adoptStoredThread,
    loadOlder,
    rehydrate,
  };
}
