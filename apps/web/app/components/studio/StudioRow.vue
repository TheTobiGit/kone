<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { InformationSquareIcon } from "@hugeicons/core-free-icons";
import type {
  AgentModelRef,
  ApprovalDecision,
  ChatAttachment,
  InteractionMode,
  ProviderKind,
  UserInputAnswers,
} from "~/types/desktop";
import type { Project } from "~/composables/useProject";
import type { GitRemote } from "~/types/desktop";
import { buildModelCatalog, effortForTier, familyForId, EFFORT_META } from "~/utils/modelCatalog";
import type { EffortTier, ModelOption, PickerProvider } from "~/utils/modelCatalog";
import {
  bootMode,
  bootModel,
  bootProvider,
  bootReasoning,
  DEFAULT_MODE_KEY,
  DEFAULT_MODEL_KEY,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_REASONING_KEY,
  MODEL_KEY,
  modeKey,
  PROVIDER_BRAND,
  PROVIDER_KEY,
  PROVIDER_VENDOR,
  REASONING_KEY,
  setLastUsedModel,
} from "~/utils/modelPicker";
import type { ModelPick } from "~/composables/useModelCommit";
import { setInlineThread, type QueuedTurnEntry } from "~/composables/useAgent";
import ThreadDockStack from "~/components/thread/ThreadDockStack.vue";
import { useDockSnapshot } from "~/composables/useDockSnapshot";
import { useTerminal } from "~/composables/useTerminal";
import { useScratchpad } from "~/composables/useScratchpad";
import { createOrJoinSidechat, getSideChatSource } from "~/composables/sideChats";
import { agentForThread } from "~/utils/agents";
import { compactPropsForSession } from "~/utils/compactAvailability";
import { usePendingThread } from "~/composables/useProject";
import { useStudioRowRegistry, type StudioRowApi } from "~/composables/useStudioRowRegistry";

// One project's row of the studio: its panes side by side, the composer docked
// under the focused one, and every corner dock, modal and pill that belongs to a
// conversation rather than to a repository.
//
// The row owns the whole agent stack for its project — the session registry, the
// terminals, the scratchpad, the layout — so it stays mounted while you look at
// something else. That is the point: a turn keeps folding, a PTY keeps running,
// and coming back is a reveal rather than a reload.
//
// What it does NOT own is where it sits or what is over it. Whether the row is
// on screen, whether a file detail covers it, and whether the surface it shares
// the window with wants pills are all decided upstream and arrive as props — so
// the row can be revealed by a keystroke, by a project switch, or (later) by
// travelling down the plane's vertical axis, without knowing which happened.
const props = defineProps<{
  project: Project;
  /** The row is the surface on screen. Drives pane attachment (a dormant pane
   *  wakes when its row is revealed, not when it is restored) and every gate
   *  that asks "is a conversation actually visible right now". */
  visible: boolean;
  /** Something is over the row. Docks and the chooser step aside and return when
   *  it closes. Nothing page-owned can be: a file detail or a branch picker
   *  belongs to the page under the plane, so asking for one dismisses the plane
   *  first. This is here for an overlay the plane itself raises. */
  blocked: boolean;
  /** The row's repository, for the strip's column chrome. Passed in rather than
   *  read here: the working tree is watched once, by the surface that owns it. */
  branch: string | null;
  origin: GitRemote | null;
  /** Studio-wide 2D overview mode. */
  overview?: boolean;
}>();

const emit = defineEmits<{
  /** Bring the row forward. Everything that starts work — the first turn, a new
   *  thread, a terminal, opening a pill's thread — asks for this rather than
   *  reaching for the surface it happens to be sharing the window with. */
  summon: [];
  openBranch: [];
  /** Pick a branch. The row's composer offers it, but the picker belongs to the
   *  repository surface — the row has no business owning a checkout. */
  openFile: [path: string, rect: DOMRect | null];
  /** A pane was selected in overview mode — parent plane focuses and zooms in. */
  selectPane: [paneId: string];
  /** Request studio overview toggle. */
  toggleOverview: [];
}>();

const { cue } = useSound();
const { matchesShortcut } = useShortcuts();

// The path this row was built for, captured once: the plane keys each row on its
// path so it cannot change under the row, and reading it at teardown would risk
// unregistering an entry that a remounted row had already claimed. Both the
// registry publish at the foot of this file and the history stamps above use it.
const registryPath = props.project.path;
const rowRegistry = useStudioRowRegistry();

const providers = useAgentProviders();
// The user's per-provider install settings — here just for the enable toggle,
// which decides whether a detected provider is offered in the picker rail.
const providerSettings = useProviderSettings();
// cwd is a getter so the session always boots in whatever project is active —
// paired with a per-project key on <ProjectView> so switching projects gives a
// fresh session rooted in the new directory.
const agent = useAgent({
  provider: bootProvider(),
  cwd: () => props.project.path,
  mode: bootMode(props.project.path) ?? undefined,
});
// A conversation the launcher asked us to resume on open. Consumption is
// reactive (see the resume block below), not mount-only: this row usually
// mounted long before the click.
const pendingThread = usePendingThread();
const {
  blocks,
  busy,
  queuedTurns,
  model,
  mode,
  reasoning,
  serviceTier,
  contextWindow,
  now: agentNow,
  // The active thread's title / error aren't projected here any more: each strip
  // column renders its own from its own session.
} = agent;

const terminal = useTerminal({ cwd: () => props.project.path });
const scratchpad = useScratchpad({ projectPath: () => props.project.path });
// ── the studio row ─────────────────────────────────────────────────────────
// The strip is this project's row of the studio: its panes (threads, terminals,
// the scratchpad) side by side on one substrate. useStudio owns the row's
// layout — pane order + focus — and wraps the
// three composables through thin adapters; the strip renders `panes` and every
// layout gesture below is a single studio.* call. Sessions attach on open
// (dormancy lands later); adoption folds in the boot thread and any thread a
// pill later opens. `focusedId` is the single focus truth (no more mirroring
// agent.activeKey — focus pushes DOWN to the agent instead).
// The composer, ref'd here (ahead of its template mount) so studio.dispatch can
// pre-fill it for the draft-thread intent. Its wake watcher lives further down.
const composerRef = ref<{ wake: () => Promise<void>; setDraft: (text: string) => Promise<void> } | null>(null);
const composerOpen = ref(false);

// A pad pane briefly pulses its index dash after a thread → pad append.
const pulseScratchpadKey = ref<string | null>(null);

const isOverview = computed(() => Boolean(props.overview));

const studio = useStudio({
  agent,
  terminal,
  scratchpad,
  projectPath: () => props.project.path,
  // The two UI-only tails of a cross-pane action: flash the pad's index dash
  // after a capture, and pre-fill the composer for a draft thread.
  hooks: {
    pulsePad: (id) => pulsePadPane(id),
    setDraft: (text) => composerRef.value?.setDraft(text),
  },
});
const { panes, focusedId, focusedPane, blankThreadPane, attach } = studio;

// ── studio persistence ──────────────────────────────────────────────────────
// The layout (pane order, kinds, backend ids, widths, focus) is written to the
// store (or localStorage in nuxt dev) whenever its persisted shape changes —
// off `studio.saveSignature`, a cheap string that never ticks on a streamed
// token. Saving only starts once `restore()`/`start()` has settled, so the boot
// adopt can't clobber a saved layout before we've read it. `restore()` itself
// runs in onMounted. A missing saved layout normalises to an empty desktop so
// restore() can evict useAgent's construction spawn instead of leaving a boot
// thread adopted on the strip.
const studioStore = useStudioPersistence(() => props.project.path);
const studioReady = ref(false);
/** Resolves once the async mount (provider detection → catalogs → studio restore)
 *  has finished. Callers that must not act on the pre-mount boot session — the
 *  composer target sync and every send — await this instead of no-opping, which
 *  used to let a cold-start send run on the hardcoded `codex` default carrying a
 *  model restored from another provider. */
function whenStudioReady(): Promise<void> {
  if (studioReady.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(studioReady, (v) => {
      if (!v) return;
      stop();
      resolve();
    });
  });
}

// ── launcher resume ─────────────────────────────────────────────────────────
// Clicking a recent conversation sets a global resume request and switches to
// its project — but this row usually mounted long before that click (the plane
// renders every persisted row at app start), so mount-only consumption dropped
// the request and the click landed on the project page with the thread never
// opened. Consumption is therefore reactive: the request is taken whenever it
// names this project, whether it arrives before, during, or after this row's
// own mount. Taking is path-namespaced — a request for another project is left
// for its row — and each take nulls the state synchronously, so mount, watcher
// and post-restore check can never open it twice.
function takeResume(): string | null {
  const req = pendingThread.value;
  if (!req || req.path !== props.project.path) return null;
  pendingThread.value = null;
  return req.threadId;
}
async function resumeThread(threadId: string): Promise<void> {
  // One open path for a stored thread: studio.open dedupes against live AND
  // dormant panes (the resume target is usually already restored as a pane —
  // often the focused one), focuses the hosting pane so the strip scrolls to
  // it, or mints a fresh pane bound to the id. Either way we land on the
  // studio.
  await studio.open("thread", { threadId });
  emit("summon");
}
watch(pendingThread, () => {
  // A request that lands mid-restore is picked up after it (see onMounted);
  // anything later is taken and opened as soon as it arrives. takeResume
  // above is the single consumption primitive — path-namespaced and
  // sync-nulling — so this never re-checks the path or nulls the state itself.
  if (!studioReady.value) return;
  const threadId = takeResume();
  if (!threadId) return;
  void resumeThread(threadId);
});

// The project's persisted thread ids (metadata only) — restore() checks stored
// panes against these so a blank thread that was saved with its client id, but
// never became a real conversation, doesn't come back as an empty column. Undefined
// when there's no desktop bridge (nuxt dev), which tells restore to skip the filter.
async function loadKnownThreadIds(
  projectPath: string,
): Promise<ReadonlySet<string> | undefined> {
  const api = import.meta.client ? window.koneDesktop?.agent?.history : undefined;
  if (!api) return undefined;
  try {
    const metas = await api.list(projectPath);
    return new Set(metas.map((m) => m.threadId));
  } catch {
    return undefined;
  }
}
const persistRow = useDebounceFn(() => {
  if (studioReady.value) studioStore.saveRow(studio.serialize());
}, 400);
watch(studio.saveSignature, () => {
  void persistRow();
});
function setPaneWidth(id: string, width: number): void {
  studio.setWidth(id, width);
}
function setPaneZen(id: string, zen: boolean): void {
  studio.setZen(id, zen);
}

// The composer only docks under a focused thread pane ON the studio — never on
// the working-tree overview. Model/mode/reasoning must ride the session that
// will actually receive the next turn: the focused thread column. agent.activeKey
// can still point at a background thread while a terminal column is focused, so
// we re-project before any composer edit and keep activeKey aligned with that
// target.
const focusedThread = computed(() =>
  focusedPane.value?.kind === "thread" ? focusedPane.value.session : null,
);
const focusedPendingUserInput = computed(
  () => focusedThread.value?.pendingUserInput.value ?? null,
);
const focusedPendingApproval = computed(
  () => focusedThread.value?.pendingApproval.value ?? null,
);
const activePaneIsThread = computed(() => focusedThread.value !== null);
/** Nothing has been asked of this thread yet, so the choices that fix its shape
 *  for good — which branch it works on, which agent works it — are still open.
 *  The first block is the point of no return for both. */
const threadIsBlank = computed(() => (focusedThread.value?.blocks.value.length ?? 0) === 0);
// Why the focused thread's provider can't take a turn, or null. Drives both the
// banner and the composer's refusal, so the two can never disagree.
const sendBlockedReason = computed(() => focusedThread.value?.sendBlockedReason.value ?? null);
const sendBlockedStatus = computed(() => {
  const provider = focusedThread.value?.provider.value;
  return provider ? (providers.byProvider(provider).value ?? null) : null;
});
const recheckingProviders = ref(false);
async function recheckProviders(): Promise<void> {
  if (recheckingProviders.value) return;
  recheckingProviders.value = true;
  try {
    await providers.refresh();
  } finally {
    recheckingProviders.value = false;
  }
}

// The composer's `/compact` row — the strip columns' shared rule, read off the
// focused thread. A blank thread has no user turn worth compacting, so the row
// stays hidden until the conversation starts.
const focusedCompact = computed(() =>
  compactPropsForSession(focusedThread.value, providers.statuses.value),
);
const focusedCompactable = computed(
  () =>
    !threadIsBlank.value &&
    Boolean(focusedCompact.value.onCompact) &&
    focusedCompact.value.compactState === "available",
);

// The composer's `/compact` emit — the strip button's call, so the two agree.
// Guards mirror the button: a busy or already-compacting thread consumes
// silently, never calls.
function onComposerCompact(_focus: string): void {
  if (!focusedCompact.value.onCompact || focusedCompact.value.compactState !== "available") return;
  focusedCompact.value.onCompact();
}

// The composer's `/new` row — the same call the shortcut and the registry
// publish, so every way of starting over lands in the same place: open (or
// reveal the singleton blank) and wake the composer under it. No busy guard —
// a running turn keeps its column while the fresh one focuses, the way the
// shortcut behaves mid-turn.
function onComposerNewThread(): void {
  void newThreadPane();
}

// ── empty-row chooser ────────────────────────────────────────────────────────
// A row's panes are its windows: closing the last one empties the row (zero
// panes), and nothing is respawned to fill it. That — and only that — gets the
// centered chooser (the same thread / terminal / scratchpad pick the seam menu
// offers), because there is no column left to hang an affordance off.
//
// A lone *blank thread* is not that case. It's the fresh-project boot state, and
// it already is a usable column: the empty thread with its composer. So we show
// it plainly and let the strip's trailing seam pill add a terminal or a
// scratchpad beside it — with "New thread" greyed there, since the blank column
// standing right next to the pill IS the new thread.
//
// `chooserDismissed` only covers the async gap between a pick and its pane
// landing, so the chooser doesn't flash back mid-open.
const chooserDismissed = ref(false);
const rowIsBare = computed(() => panes.value.length === 0);
const showChooser = computed(
  () => props.visible && rowIsBare.value && !chooserDismissed.value && !props.blocked,
);
// Every time the row empties again, re-arm the chooser.
watch(rowIsBare, (bare) => {
  if (bare) chooserDismissed.value = false;
});

async function onChoosePane(kind: "thread" | "terminal" | "scratchpad"): Promise<void> {
  // Only ever reached from a bare desktop, so nothing is waiting to be revealed
  // — every kind opens a fresh pane.
  chooserDismissed.value = true;
  await studio.open(kind);
  if (kind === "thread") void composerRef.value?.wake();
}

function focusPane(id: string): void {
  studio.focus(id);
}
function shiftPaneFocus(delta: number): void {
  studio.focusByOffset(delta);
}
function movePane(delta: number): void {
  if (focusedId.value) studio.move(focusedId.value, delta);
}
function closePane(id: string): void {
  void studio.close(id);
}
// Archiving a thread from its column header stamps the history row (and forgets
// the in-memory registry thread, same as the recent-list archive), then closes
// the now-empty column so it doesn't linger on the studio pointing at a hidden row.
async function archivePane(threadId: string, id: string): Promise<void> {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return;
  }
  // Single close path: archiveSession closes the named pane once the store has
  // taken the archive, and closes nothing on a refusal — which is what leaves
  // the column standing to be explained.
  await archiveSession(threadId, { onlyId: id });
}
// The per-host-thread side-chat creator (the thread column's "add panel"
// button): fork a side chat off the source thread and open it as a column
// beside it. The child is a normal thread pane — full composer, resumable,
// archivable — wearing the temporary look. In-flight joins are deduped by
// createOrJoinSidechat; the first send rides the imported-transcript bootstrap.
function openSideChat(paneId: string): void {
  const pane = panes.value.find((p) => p.id === paneId);
  if (pane?.kind !== "thread" || !pane.session) return;
  const sourceThreadId = pane.session.threadId.value;
  const sourcePaneId = pane.id;
  void (async () => {
    try {
      const { threadId } = await createOrJoinSidechat({
        sourceThreadId,
        sendPrompt: () => {},
        onPromptError: () => {},
      });
      const id = await studio.open("thread", {
        threadId,
        near: sourcePaneId,
        sideChatSource: sourceThreadId,
      });
      if (id) void composerRef.value?.wake();
    } catch (err) {
      // Creation is best-effort: a missing source thread or an idempotency
      // conflict surfaces as a silent no-op — the column simply doesn't open.
      console.warn("[sidechat] could not open side chat:", err);
    }
  })();
}
function insertPane(seamIndex: number, kind: "thread" | "terminal" | "scratchpad"): void {
  // Seam `i` sits after pane `i`; a pick inserts to its right.
  void studio.open(kind, { at: seamIndex + 1 });
}

// mod+shift+t / mod+shift+n open a terminal / the scratchpad beside the focused
// pane and focus it — the keyboard siblings of the seam insert picks.
function newTerminalPane(): void {
  void studio.open("terminal");
}
function newScratchpadPane(): void {
  void studio.open("scratchpad");
}

function pulsePadPane(id: string): void {
  pulseScratchpadKey.value = id;
  window.setTimeout(() => {
    if (pulseScratchpadKey.value === id) pulseScratchpadKey.value = null;
  }, 800);
}

// A per-response "add to scratchpad" (the thread's own capture affordance) is
// the capture-text intent, same path the selection bubble takes.
function captureToScratchpad(text: string, sourceKey: string): void {
  void studio.dispatch({ type: "capture-text", text, from: sourceKey });
}

// Derives and snapshot for active plan, touched files, and subagent delegates.
const {
  activePlan,
  activeChanges,
  activeDelegates,
  sync: syncDockSnapshot,
} = useDockSnapshot(
  computed(() => focusedThread.value?.blocks.value ?? []),
  computed(() => focusedThread.value?.spawnedChildren.value ?? []),
);

// Switching threads used to morph one thread's docks into another's *in place* —
// file rows and card height reflowed mid-flight under a flat container fade, and
// it read as broken. So a switch is now a hard swap: each dock is keyed to the
// focused thread, so leaving a thread unmounts its docks (each plays its own
// scale+fade exit) and the new thread's docks mount fresh (playing their enter).
// The snapshot swaps synchronously with the key, so the newly-mounted docks carry
// the right data from their first frame. Streaming *within* a thread keeps the
// same key, so a live turn's docks tick along in place (no remount).
const focusedKey = computed(() => focusedThread.value?.key ?? null);

watch(focusedKey, () => syncDockSnapshot());

/** A thread that must not be archived/deleted right now: a turn in flight, a
 *  parked approval/user-input, live spawned children. Forgetting it tears the
 *  session down mid-flight — killing the provider process and revoking its
 *  gateway token while children may still be running — so these paths refuse
 *  instead, the same way the registry's own eviction refuses (it only ever reaps
 *  idle sessions, never one with an active turn). */
function sessionBusy(threadId: string): boolean {
  const s = agent.sessions.value.find((x) => x.threadId.value === threadId);
  if (!s) return false;
  return (
    s.busy.value ||
    Boolean(s.pendingUserInput.value) ||
    s.pendingApprovals.value.length > 0 ||
    s.spawnedChildren.value.some((c) => !c.terminal)
  );
}

/** Transient archive-refusal notice — auto-dismisses, like the composer's own
 *  chip notice. No toast system exists yet; this is the smallest surface that
 *  explains why the row didn't disappear. */
const archiveNotice = ref("");
let archiveNoticeTimer: number | undefined;
function flashArchiveNotice(message: string): void {
  archiveNotice.value = message;
  window.clearTimeout(archiveNoticeTimer);
  archiveNoticeTimer = window.setTimeout(() => (archiveNotice.value = ""), 3800);
}

/** Drop the studio pane hosting a thread — the studio hosts one pane per
 *  conversation, and forgetting the session behind a pane would otherwise
 *  leave the column lingering dormant pointing at a hidden row (reconcile
 *  keeps entries whose session vanished). Works for both an attached pane
 *  (live session) and a dormant one (anchor remembers the id). When the caller
 *  names the exact pane (archiving from its own column header), only that pane
 *  is closed while it is still mounted — a missing named pane closes nothing,
 *  never the first match for the thread. The first match is only for callers
 *  that did not name a pane. */
function closePaneHosting(threadId: string, options?: { onlyId?: string }): void {
  const onlyId = options?.onlyId;
  if (onlyId !== undefined) {
    if (panes.value.some((p) => p.id === onlyId)) {
      void studio.close(onlyId);
    }
    return;
  }
  const pane = panes.value.find(
    (p) =>
      p.kind === "thread" &&
      ((p.session && p.session.threadId.value === threadId) ||
        (p.entry.anchor.kind === "thread" && p.entry.anchor.threadId === threadId)),
  );
  if (pane) void studio.close(pane.id);
}

/** Archive a thread and take its column with it — but only once the store has
 *  said yes.
 *
 *  `sessionBusy` is this row's own view, and it only sees what this row hosts. A
 *  spawned descendant working under a thread whose parent looks idle is invisible
 *  from here, and the store refuses that archive at write time. Forgetting the
 *  session and closing the pane ahead of the answer would spend the refusal on
 *  the column anyway: a thread still very much alive, with nothing left on
 *  screen pointing at it. */
async function archiveSession(threadId: string, options?: { onlyId?: string }): Promise<boolean> {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return false;
  }
  const archived = await rowRegistry.historyFor(registryPath).archive(threadId);
  if (!archived) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return false;
  }
  void agent.forgetThread(threadId);
  closePaneHosting(threadId, options);
  return true;
}
function removeSession(threadId: string): void {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before deleting.",
    );
    return;
  }
  rowRegistry.historyFor(registryPath).remove(threadId);
  void agent.forgetThread(threadId);
  closePaneHosting(threadId);
}

// Open a stored thread and reveal the chat the instant its transcript lands —
// the studio owns the pane: open() dedupes (a thread already hosted — live or
// dormant — is focused, never duplicated), attaches and focuses the hosting
// pane, and only resolves after the transcript loads on the mint path. The old
// direct agent.openThread let the session be adopted as an unfocused column —
// the studio flipped to a stale focus and the strip never scrolled to the new
// pane ("opened from nowhere"). Gating the surface flip on blocks still grows
// a populated thread (no flash of the empty state, no lingering on the
// working-tree home) with the chat-open entrance. Falls through to showing
// chat even on an empty/failed load.
async function revealThread(threadId: string): Promise<void> {
  const stop = watch(blocks, (b) => {
    if (b.length) {
      emit("summon");
      stop();
    }
  });
  try {
    await studio.open("thread", { threadId });
  } finally {
    stop();
    emit("summon");
  }
}

// Bring a picked recent conversation on-screen and continue it under its own
// thread id. Best-effort on desktop; a no-op in browser dev (no live session).
function openSession(threadId: string): void {
  void revealThread(threadId);
}

// A thread started outside the studio — the inbox — that belongs to this
// project. It joins the row at the right edge, unfocused and with no summon:
// what was asked for is a thread, not a trip to the plane, so the column is
// simply waiting the next time you travel here. Deliberately not revealThread,
// which exists to take you to a pane.
//
// It waits for the mount to settle first. restore() replaces the row's entries
// wholesale, and the save debounce ignores anything before it lands — a pane
// opened into that window would be wiped by the restore and never written down.
async function adoptThreadPane(threadId: string): Promise<void> {
  await whenStudioReady();
  await studio.open("thread", {
    threadId,
    focus: false,
    at: studio.entries.value.length,
  });
}

// ── who answers ──────────────────────────────────────────────────────────────
// Two different facts, deliberately kept apart. The app-wide *selection* is who
// your next new thread will go to, and it is yours to change whenever you like.
// A thread's *agent* is who is working it, and that is settled once, on its first
// send, and never revised — one agent per thread, so the transcript above a turn
// is always the work of whoever the thread names.
//
// Which is why picking only moves the selection: on a blank thread the selection
// is what the composer shows, and there is nothing durable to write against yet.
//
// null all the way through means a guest: no agent named, so the thread keeps the
// name and face rolled from its own id.
const {
  team: agents,
  selected: pickedAgent,
  pendingThreadAgent,
  selectAgent,
  settleThreadAgent,
  isOnTeam,
} = useAgentRoster(() => props.project.path);

// When an outside surface (such as the agent detail page in settings) requests
// a new conversation with a specific agent, bring the studio forward, spawn a
// fresh blank thread if the focused one is non-blank or busy, and wake the
// composer.
watch(
  pendingThreadAgent,
  async (req) => {
    if (!req) return;
    const targetPath = req.projectPath;
    if (targetPath && targetPath !== props.project.path) return;
    pendingThreadAgent.value = null;
    emit("summon");
    if (!threadIsBlank.value || busy.value) {
      await studio.open("thread");
    }
    await nextTick();
    void composerRef.value?.wake();
  },
  { immediate: true },
);

// The composer answers as somebody on this project's team — that is what a team
// is for. The selection is app-wide, so it can be carrying an agent who is a
// teammate on another project and a stranger here; here that reads as a guest,
// rather than quietly working a project it was never added to. On-team members
// pass straight through, so nothing changes for the project they belong to.
const pickedForProject = computed(() =>
  pickedAgent.value && isOnTeam(pickedAgent.value.id) ? pickedAgent.value : undefined,
);

const focusedIsSideChat = computed(() => {
  const currentId = focusedThread.value?.threadId.value;
  return Boolean(focusedThread.value?.isSideChat?.value || (currentId && getSideChatSource(currentId)));
});

const composerAgentId = computed(() => {
  const currentId = focusedThread.value?.threadId.value;
  if (!currentId) return pickedForProject.value?.id ?? null;
  if (focusedIsSideChat.value) {
    return agentForThread(currentId)?.id ?? null;
  }
  return pickedForProject.value?.id ?? null;
});

function onAgentPick(id: string | null) {
  selectAgent(id);
}

// The selected agent's pinned model gates what the pickers may offer. No model
// is unrestricted — every provider and every model stays open. A pinned model
// is a hard pin: only its provider is offered, and only that one model within
// it, so the composer can only answer there.
const capModel = computed<AgentModelRef | null>(() => pickedForProject.value?.capabilities.model ?? null);
function providerAllowed(p: ProviderKind): boolean {
  return capModel.value === null || capModel.value.provider === p;
}
function modelAllowed(provider: ProviderKind, key: string): boolean {
  const pinned = capModel.value;
  return pinned === null || (pinned.provider === provider && pinned.model === key);
}

// The catalog for each installed provider — its flat model list grouped into
// families with real efforts. The composer + picker drive everything off these;
// the raw id (which carries the effort) is what we send to the session.
const catalogs = ref<Partial<Record<ProviderKind, ModelOption[]>>>({});

// The active provider's catalog feeds the composer's own model name + effort
// dial, narrowed to the models the selected agent may run. A disallowed current
// model is moved off by the self-heal watcher above, which reads this list.
const modelOptions = computed(() => {
  const provider = agent.provider.value;
  return (catalogs.value[provider] ?? []).filter((m) => modelAllowed(provider, m.key));
});

// Mount seeds these from the disk snapshot so the picker is usable immediately;
// the live re-probe finishes a moment later and may correct a list (a CLI upgrade
// that added or dropped a model). Rebuild rather than leave the stale one on
// screen — the whole point of showing the snapshot early is that it converges.
watch(
  () => providers.modelCache.value,
  (raw) => {
    const next: Partial<Record<ProviderKind, ModelOption[]>> = {};
    for (const [provider, list] of Object.entries(raw)) {
      if (list?.length) {
        // SAFETY: raw is Partial<Record<ProviderKind, ModelOption[]>>, so
        // every key Object.entries yields is a ProviderKind.
        next[provider as ProviderKind] = buildModelCatalog(list);
      }
    }
    catalogs.value = { ...catalogs.value, ...next };
    // Reconcile the live pick. A refresh can drop the model the user is on (a
    // CLI upgrade retired it), and leaving a now-unknown id in place is exactly
    // the desync the desktop guards had to catch — clear it here so the composer
    // shows what will actually run. Mount does its own seeding, so only act once
    // the studio is real.
    if (!studioReady.value) return;
    const current = agent.model.value;
    // modelOptions, not the raw catalog: a refresh must heal onto a model the
    // selected agent is allowed, never restore one its allowlist rules out.
    const options = modelOptions.value;
    if (!current || options.some((o) => o.efforts.some((e) => e.modelId === current))) return;
    const first = options[0];
    const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
    agent.setModel(eff ? eff.modelId : undefined);
  },
  { immediate: true },
);

const MODE_KEY = modeKey(props.project.path);
const MODES: InteractionMode[] = ["ask", "accept-edits", "full-access"];

// Ready providers the user hasn't switched off in settings. The enable toggle is
// a pure picker-rail filter (it never tears down a running session), so both the
// rail and the boot pick read this rather than `providers.ready` directly.
const enabledReady = computed(() =>
  providers.ready.value.filter((s) => providerSettings.isEnabled(s.provider)),
);

// The provider rail the model picker shows — one ready, enabled provider per
// catalog. Each catalog is filtered through the same model-visibility rule the
// providers pane's per-model toggles write, so hiding a model there drops it here.
const pickerProviders = computed<PickerProvider[]>(() => {
  const visible = providerSettings.modelVisiblePredicate.value;
  return enabledReady.value
    .filter((s) => providerAllowed(s.provider))
    .map((s) => {
      const models = (catalogs.value[s.provider] ?? []).filter(
        (m) => visible(s.provider, m.key) && modelAllowed(s.provider, m.key),
      );
      return {
        id: s.provider,
        label: s.label,
        sub: `${PROVIDER_VENDOR[s.provider]} · ${models.length} model${models.length === 1 ? "" : "s"}`,
        brand: PROVIDER_BRAND[s.provider],
        ready: s.readiness === "ready",
        models,
      };
    });
});

// Is there anything to pick? A pinned agent narrows the picker to its one model,
// and per-model visibility toggles can do the same, and a picker holding a single
// row is a dead end — so the composer's model slot becomes a label instead.
const modelSwitchable = computed(
  () => pickerProviders.value.reduce((n, p) => n + p.models.length, 0) > 1,
);

/** Point agent.activeKey at the thread the composer is editing so setModel and
 *  friends land on the session the next send will use. No-ops until the row has
 *  restored — the immediate pre-mount sync used to miss the blank thread slot and
 *  sometimes left no live session at all after restore evicted the boot thread. */
let syncingComposerTarget: Promise<void> | null = null;
async function syncComposerTarget(): Promise<void> {
  if (syncingComposerTarget) return syncingComposerTarget;
  syncingComposerTarget = (async () => {
    // Wait rather than bail: bailing left agent.activeKey on the construction
    // boot session, so a send fired during the async mount ran on the pre-mount
    // `codex` default with whatever model localStorage restored.
    await whenStudioReady();
    if (focusedThread.value) {
      agent.focusThread(focusedThread.value.key);
      return;
    }
    const focusedEntry = panes.value.find((p) => p.id === focusedId.value);
    if (focusedEntry?.kind === "thread") {
      if (props.visible) {
        await attach(focusedEntry.id);
        const sk = focusedPane.value?.session?.key;
        if (sk) agent.focusThread(sk);
      }
      return;
    }
    if (!props.visible) return;

    const blank = blankThreadPane.value;
    if (!blank) return;
    if (!blank.session) await attach(blank.id);
    const sk = blankThreadPane.value?.session?.key;
    if (sk) agent.focusThread(sk);
  })().finally(() => {
    syncingComposerTarget = null;
  });
  return syncingComposerTarget;
}

const composerVisible = computed(
  () => props.visible && activePaneIsThread.value,
);
watch(
  [studioReady, composerVisible, focusedId, () => blankThreadPane.value?.session?.key],
  () => {
    if (studioReady.value && composerVisible.value) void syncComposerTarget();
  },
);

// A restored thread/terminal pane stays dormant while the overview is showing.
// Attach the focused pane (a terminal still waits until you look at it) and
// every stored thread once the studio is revealed, so neighbouring columns
// show their transcripts instead of sitting on "Opening…".
watch(
  () => props.visible,
  (shown, was) => {
  if (!shown || was) return;
  const id = focusedId.value;
  if (id) void studio.attach(id);
  void studio.wakeThreadPanes();
  },
);
// ── chat defaults ──────────────────────────────────────────────────────────
// The provider/model/effort/approval a *fresh* thread opens on. Read from the
// Studio-pane keys first, then the app's last-used keys. This is the one place
// that resolves them because it's the one place with readiness + the per-
// provider catalog in hand: the picker only ever offered a ready provider, but
// readiness can lag a cold boot, so a stored default is still validated here
// before it's applied. Returns whether the provider changed — a blank thread
// then needs a re-spawn to land on the right CLI.
function applyChatDefaults(): boolean {
  if (!import.meta.client) return false;
  const readyProviders = enabledReady.value;

  const savedProvider =
    localStorage.getItem(DEFAULT_PROVIDER_KEY) ?? localStorage.getItem(PROVIDER_KEY);
  const isReady = (p: string | null): p is ProviderKind =>
    Boolean(p) && readyProviders.some((s) => s.provider === p);
  const chosen: ProviderKind | undefined = isReady(savedProvider)
    ? savedProvider
    : readyProviders.find((s) => s.provider === "codex")?.provider ??
      readyProviders.find((s) => s.provider === "opencode")?.provider ??
      readyProviders[0]?.provider;

  const providerChanged = Boolean(chosen) && chosen !== agent.provider.value;
  if (chosen) agent.setProvider(chosen);

  // Model — validate against the (now current) provider's catalog. A stored id
  // from another provider is dropped rather than ridden onto the wrong CLI.
  const current = model.value;
  const owned = (id: string | null | undefined) =>
    Boolean(id) &&
    modelOptions.value.some(
      (o) => o.key === id || o.efforts.some((e) => e.modelId === id),
    );
  const savedModel = bootModel();
  if (owned(savedModel)) {
    agent.setModel(savedModel!);
  } else if (owned(current)) {
    // Already valid for this provider — leave it.
  } else {
    const first = modelOptions.value[0];
    const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
    agent.setModel(eff ? eff.modelId : undefined);
  }

  const savedReasoning = bootReasoning();
  if (savedReasoning && savedReasoning in EFFORT_META) {
    const fam = familyForId(modelOptions.value, model.value);
    const eff = effortForTier(fam, savedReasoning);
    if (eff) agent.setReasoning(eff.tier);
  }

  // Per-project mode wins; before this project has one, the app-wide default.
  const savedMode = localStorage.getItem(MODE_KEY) ?? localStorage.getItem(DEFAULT_MODE_KEY);
  if (savedMode && MODES.some((m) => m === savedMode)) {
    // SAFETY: the MODES.some check passes only for an exact InteractionMode member.
    agent.setMode(savedMode as InteractionMode);
  }

  return providerChanged;
}

/** Has the user pinned a default in the Studio pane? New threads only override
 *  their inherited settings when one is set — otherwise inheritance stands. */
function hasConfiguredDefault(): boolean {
  if (!import.meta.client) return false;
  return Boolean(
    localStorage.getItem(DEFAULT_PROVIDER_KEY) || localStorage.getItem(DEFAULT_MODEL_KEY),
  );
}

// The provider a configured default names, or null when none is set. Its
// readiness is the gate the boot seed waits on: applyChatDefaults only ever
// commits to a *ready* provider, so committing before this one's CLI reports in
// would silently fall back to a faster one (codex) and open the thread on the
// wrong model.
function configuredDefaultProvider(): ProviderKind | null {
  if (!import.meta.client) return null;
  const p = localStorage.getItem(DEFAULT_PROVIDER_KEY);
  // SAFETY: Invariant verified by checking membership in PROVIDER_VENDOR dictionary
  return p && p in PROVIDER_VENDOR ? (p as ProviderKind) : null;
}
function defaultProviderReady(): boolean {
  const want = configuredDefaultProvider();
  return !want || enabledReady.value.some((s) => s.provider === want);
}

// Keys of blank threads already settled onto the configured default (or that had
// none to settle). Once a key is in here a deliberate in-composer switch on that
// blank sticks — the seeders never re-touch it.
const settledThreadKeys = new Set<string>();

/** Seed one blank thread's provider/model/effort/mode from the configured
 *  default, once. Only seals the key when the agent actually lands on the
 *  default's provider: while that provider's CLI is still coming up
 *  applyChatDefaults falls back, so we leave the key unsealed and let a later
 *  readiness tick finish the job. A no-op the moment the thread stops being
 *  blank, so it can never overwrite a conversation that's begun. */
function seedBlankThread(key: string): void {
  if (settledThreadKeys.has(key)) return;
  if (!threadIsBlank.value) {
    settledThreadKeys.add(key);
    return;
  }
  const providerChanged = applyChatDefaults();
  const wantProvider = configuredDefaultProvider();
  if (defaultProviderReady() && (!wantProvider || agent.provider.value === wantProvider)) {
    settledThreadKeys.add(key);
  }
  if (providerChanged) void agent.restart();
}

// A fresh thread inherits its neighbour's model (useAgent.inheritSettings), which
// never consults the configured default — so a new conversation would open on
// whatever ran last, not on what the user chose in the Studio pane. Seed each
// blank thread the first time it becomes the composer's target; the enabledReady
// dependency also re-fires this once the default's provider finishes coming up,
// which is what rescues a cold boot where codex reports ready before claude.
watch(
  [() => blankThreadPane.value?.session?.key, enabledReady],
  async () => {
    const key = blankThreadPane.value?.session?.key;
    if (!key || !studioReady.value || !composerVisible.value) return;
    if (!threadIsBlank.value) return;
    await syncComposerTarget();
    seedBlankThread(key);
  },
);

// Boot seeding runs whether or not the row is the visible surface — a cold boot
// usually lands on the working-tree home, not the studio — so it acts on the
// agent's own refs rather than through the composer-target sync the new-thread
// watch uses. Like seedBlankThread it commits only once the default's provider
// reports ready, and the enabledReady watch retries it on each readiness tick
// until then: the fix for a cold boot where codex is ready before claude.
let bootDefaultsSettled = false;
function seedBootDefaults(): void {
  if (bootDefaultsSettled || !studioReady.value) return;
  if (!activePaneIsThread.value && !blankThreadPane.value) return;
  if (!threadIsBlank.value) {
    bootDefaultsSettled = true;
    return;
  }
  const providerChanged = applyChatDefaults();
  const wantProvider = configuredDefaultProvider();
  if (defaultProviderReady() && (!wantProvider || agent.provider.value === wantProvider)) {
    const bootKey = blankThreadPane.value?.session?.key;
    if (bootKey) settledThreadKeys.add(bootKey);
    bootDefaultsSettled = true;
  }
  if (providerChanged) void agent.restart();
}
watch(enabledReady, () => seedBootDefaults());

onMounted(async () => {
  // Consume a launcher resume request the instant the mount starts. Reading it
  // after the async provider/catalog work left it sitting in the global state
  // for the whole mount — and if that mount was torn down mid-chain (the user
  // backs out during the probe), the stale request survived to fire on a later,
  // unrelated open of the same project. Consuming up front scopes it to this
  // mount. takeResume is the single consumption primitive — path-namespaced
  // and sync-nulling — so a request for another project is left for its row
  // instead of being wiped here.
  const resume = takeResume();

  // Everything the mount needs is fetched up front and in parallel. These six
  // loads are independent of each other but each costs an IPC round-trip, and
  // awaiting them in a chain made entering a project cost the *sum* — which is
  // the stall between clicking a project and the studio being usable. Kicked
  // together here, then awaited at the point each one is actually needed.
  //
  // Providers + models are warmed at app open (agent-warmup plugin). prepare()
  // resolves as soon as the main process's disk snapshot of the last known
  // providers/catalogs is in hand — no CLI spawn — with the live re-probe running
  // behind it, so entering a project doesn't wait on a `codex app-server`
  // handshake. Only a first-ever launch (nothing cached) actually waits.
  //
  // None of these reject (each swallows its own failure and resolves to a
  // fallback), so holding them unawaited can't strand a rejection.
  const surfaceReady = Promise.all([
    providers.prepare(),
    // Persisted install settings, so the enable filter (and any binary paths)
    // are in hand before we pick a provider to boot.
    providerSettings.load(),
  ]);
  const scratchpadReady = scratchpad.hydrate();
  const savedRowReady = studioStore.loadRow();
  // The set of thread ids that actually have a stored conversation. restore()
  // uses it to drop phantom thread panes — blank slates that were persisted with
  // their client-minted id and would otherwise return as empty columns. No
  // bridge (nuxt dev) → undefined, and restore keeps ids unfiltered.
  const knownThreadIdsReady = loadKnownThreadIds(props.project.path);

  await surfaceReady;
  // Only offer providers the user hasn't switched off — the boot pick and the
  // rail draw from the same enabled set.
  const readyProviders = enabledReady.value;
  await Promise.all(
    readyProviders.map(async (s) => {
      const raw = await providers.models(s.provider);
      catalogs.value = { ...catalogs.value, [s.provider]: buildModelCatalog(raw) };
    }),
  );

  // The scratchpad has to be hydrated before restore(), which eagerly attaches
  // the pad pane.
  await scratchpadReady;
  // Restore the persisted studio on mount. A missing layout normalises to an empty
  // desktop so useAgent's construction spawn is evicted rather than adopted.
  const savedRow = await savedRowReady;
  const row = savedRow ?? { projectPath: props.project.path, panes: [], focusedId: null };
  const knownThreadIds = await knownThreadIdsReady;
  // Land on the working-tree home unless we're resuming a specific thread.
  // Defer spawning the saved studio's focused thread/terminal — openThread +
  // agent start on mount would queue behind that work and leave git + history
  // IPC stuck in the loading shell (greeting with no changes/sessions).
  await studio.restore(row, knownThreadIds, { deferHeavyAttach: !resume });
  // A request that arrived while the restore above was in flight belongs to
  // this mount too — the watcher stands down until studioReady, so drain it
  // here alongside the mount-start take. Both go through takeResume (sync
  // null before the async open), and both are opened in arrival order rather
  // than short-circuited: dropping the second would strand it in the global
  // state with nothing left to pick it up.
  let resumed = false;
  if (resume) {
    // Launcher asked to resume a specific conversation.
    await resumeThread(resume);
    resumed = true;
  }
  const late = takeResume();
  if (late && late !== resume) {
    await resumeThread(late);
    resumed = true;
  }
  // Only now let layout changes persist — past this point the studio reflects the
  // user's real arrangement, not the boot adopt.
  studioReady.value = true;
  await syncComposerTarget();

  // Seed provider/model/effort/mode onto the composer target *after* restore +
  // sync. Doing this earlier wrote into the construction boot thread that restore
  // often evicts, which left overview model picks as no-ops until a studio visit
  // attached a real session. applyChatDefaults validates against the settled
  // provider's catalog (a foreign model id is dropped, not ridden onto the wrong
  // CLI) and reports whether the provider moved — a blank thread then re-spawns
  // to land on the right one. The target isn't always blank (a restored studio
  // can hand us a live session); there setProvider only flips the ref while the
  // running CLI keeps going.
  if (!resumed) seedBootDefaults();
});

// Derive the effort tier for the current model id and ride it along on each
// turn — Codex maps it to its own reasoning-effort turn param. Also persist
// the choice per project.
watch(
  model,
  (id) => {
    const fam = familyForId(modelOptions.value, id);
    const eff = effortForTier(fam, reasoning.value);
    if (eff) agent.setReasoning(eff.tier);
    // Seed the context window so the applied auto-compact budget matches what the
    // composer shows: keep the current choice if the new family still offers it,
    // else fall back to that family's default (Claude models default to 200k);
    // clear it for a single-window model (Haiku).
    const windows = fam?.contextWindows;
    const keep = windows?.find((w) => w.id === contextWindow.value);
    agent.setContextWindow(
      windows?.length
        ? keep?.id ?? windows.find((w) => w.isDefault)?.id ?? windows[0]!.id
        : undefined,
    );
    if (import.meta.client && id && !capModel.value) {
      setLastUsedModel({
        provider: agent.provider.value,
        modelId: id,
        tier: reasoning.value,
      });
    }
  },
  { immediate: true },
);

// Persist the reasoning effort globally (app-wide last-used), like the model id.
watch(reasoning, (tier) => {
  if (import.meta.client && !capModel.value) {
    setLastUsedModel({
      provider: agent.provider.value,
      modelId: model.value,
      tier,
    });
  }
});

// The full providers→models→effort picker (opened from the composer's model
// name). It applies a raw model id, exactly like the composer's inline paths.
const modelPickerOpen = ref(false);
watch(modelPickerOpen, (open) => {
  if (open) void syncComposerTarget();
});
// Clear transient thread chrome when focus leaves — model picker today, any future
// overlay someone adds should land here too so it can't strand over a terminal.
watch(
  () => studio.focusedId,
  () => {
    modelPickerOpen.value = false;
  },
);



// ── committing a model pick ──────────────────────────────────────────────────
// One path for "which model runs the next turn", whether the answer came from
// the full picker, the composer's inline slots, or the fast-mode toggle. The
// picker modal's own open/closed state stays here — it's UI, not policy.
const {
  persistThreadSelection,
  applyModelEffort,
  fastActive,
  onUpdateFastMode,
  onComposerModelId,
  onComposerReasoning,
  onComposerContextWindow,
  onComposerMode: commitComposerMode,
} = useModelCommit({
  agent,
  catalogs,
  modelOptions,
  syncTarget: syncComposerTarget,
});

// A mode change from the composer is the one thing that establishes this
// project's own permission mode. Persisting it here — rather than off a reactive
// watch on `mode` — is what keeps MODE_KEY a record of the user's deliberate
// choice: the reactive watch also fired for the construction-default and for
// every cross-thread mode switch, writing a value the boot seed then read back
// as if the project already had a mode, which shadowed the app-wide default.
function onComposerMode(next: InteractionMode): void {
  commitComposerMode(next);
  if (import.meta.client) localStorage.setItem(MODE_KEY, next);
}

function onModelSelect(picked: ModelPick) {
  void applyModelEffort(picked);
  modelPickerOpen.value = false;
  cue("toggle");
}


// Make a pin actually hold for the next send, not just narrow the picker. When
// the selection moves to an agent whose allowlist rules out the provider or
// model the composer currently shows, snap onto an allowed one — the same
// seeding boot does, so a provider-pinned agent answers on its provider without
// the user reopening the picker. Only a blank thread is touched: a settled
// thread keeps the agent it was sent to, so the selection has no say over it,
// and this never tears down a running turn.
watch(pickedForProject, async (nextAgent, prevAgent) => {
  if (!studioReady.value || busy.value || !threadIsBlank.value) return;
  await syncComposerTarget();
  let providerChanged = false;
  const pinned = capModel.value;
  if (pinned) {
    if (agent.provider.value !== pinned.provider) {
      agent.setProvider(pinned.provider);
      providerChanged = true;
    }
  } else if (prevAgent?.capabilities?.model) {
    // Switched from a pinned agent back to an unpinned agent on a blank thread — restore general last-used
    const bootP = bootProvider();
    if (agent.provider.value !== bootP) {
      agent.setProvider(bootP);
      providerChanged = true;
    }
  } else if (!providerAllowed(agent.provider.value)) {
    const next = enabledReady.value.find((s) => providerAllowed(s.provider));
    if (next && next.provider !== agent.provider.value) {
      agent.setProvider(next.provider);
      providerChanged = true;
    }
  }
  // modelOptions reflects the (possibly just-switched) provider narrowed to the
  // allowed models, so a model that fell outside the allowlist reads as unowned.
  const current = agent.model.value;
  const owned = Boolean(current) && modelOptions.value.some((o) => o.efforts.some((e) => e.modelId === current));
  if (!owned) {
    const desired = pinned?.model ?? bootModel();
    const desiredOwned = Boolean(desired) && modelOptions.value.some((o) => o.efforts.some((e) => e.modelId === desired));
    if (desiredOwned) {
      agent.setModel(desired!);
    } else {
      const first = modelOptions.value[0];
      const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
      agent.setModel(eff ? eff.modelId : undefined);
    }
  }
  if (providerChanged) await agent.restart();
  persistThreadSelection();
});

async function onSend(text: string, files?: File[]) {
  // The composer only docks under a focused thread pane on the studio, so the
  // send target is that focused thread. Settle it first: never send on top of
  // the pre-mount boot session — it carries the hardcoded `codex` default and
  // rehydrates the project's LAST stored thread on its first start(), which
  // silently replaces the composer's provider/model and resumes a foreign
  // conversation id. Settling the target first is what makes the model shown
  // in the composer the model that actually runs.
  await syncComposerTarget();
  // Now that the target is settled it has a durable id, so who is working it can
  // be recorded against it — this is the moment the thread acquires a face. Every
  // send runs this and only the first one lands: the record is write-once, so a
  // second message can't hand the thread to whoever is selected by then.
  const currentId = focusedThread.value?.threadId.value;
  if (focusedIsSideChat.value && currentId) {
    const sourceId = focusedThread.value?.sideChatSource?.value ?? getSideChatSource(currentId);
    const sourceAgent = sourceId ? agentForThread(sourceId) : undefined;
    settleThreadAgent(currentId, sourceAgent?.id ?? null);
  } else {
    settleThreadAgent(currentId, pickedForProject.value?.id ?? null);
  }
  // Persist any picked files first — now that the thread is settled, uploads are
  // scoped to the right one. Each resolves to bytes-free metadata the turn
  // carries; a failed upload is dropped rather than sinking the whole send.
  let attachments: ChatAttachment[] | undefined;
  if (files?.length) {
    const results = await Promise.allSettled(files.map((f) => agent.uploadAttachment(f)));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (ok.length) attachments = ok;
  }
  void agent.send(text, attachments);
}
/** Drop one durably queued follow-up (the composer strip's ✕). The backend
 *  emits turn.queued-cancelled; the strip clears on that event. */
function onRemoveQueued(queueId: string) {
  void agent.cancelQueuedTurn(queueId);
}
async function onSendNow(entry: QueuedTurnEntry) {
  await agent.sendQueuedEntryNow(entry);
}
function onInterrupt() {
  void agent.interrupt();
}

// Answer the agent's live question — hands the picked/typed answers back to the
// adapter, which resolves the parked tool call and lets the turn continue.
function onAnswerUserInput(requestId: string, answers: UserInputAnswers) {
  void focusedThread.value?.respondUserInput(requestId, answers);
}
// Dismiss the question — an empty answer, which the adapter treats as declined.
function onCancelUserInput(requestId: string) {
  void focusedThread.value?.respondUserInput(requestId, {});
}
// Decide a parked tool approval — hands the decision back to the adapter, which
// resolves the parked provider request and lets the turn continue.
function onRespondApproval(requestId: string, decision: ApprovalDecision) {
  void focusedThread.value?.respondApproval(requestId, decision);
}

// Persist the row's layout past the 400ms debounce on every teardown path, so a
// project switch, a window close or a hard quit can't drop the last few gestures.
// beforeunload is unreliable on macOS app-hide / Space switches and never fires
// when the OS suspends the renderer; pagehide covers the bfcache / webview
// teardown where beforeunload is skipped; blur and visibilitychange catch the
// rest. All of them are cheap idempotent writes of the same serialized layout, so
// firing them often is harmless — missing the last gesture isn't.
function flushStudio(): void {
  if (studioReady.value) studioStore.flushRow(studio.serialize());
}
onBeforeUnmount(flushStudio);
useEventListener(window, "beforeunload", flushStudio);
useEventListener(window, "pagehide", flushStudio);
useEventListener(window, "blur", flushStudio);
useEventListener(document, "visibilitychange", () => {
  if (document.visibilityState === "hidden") flushStudio();
});

// Wake the composer when a blank thread becomes active in chat — new thread,
// seam insert, or closing the last column all land here. Watching activeKey (not
// a bare empty-blocks check) so closing the orb on an empty thread stays closed.
// (composerRef itself is declared up by the studio so studio.dispatch can pre-fill
// so they are decided in one place.
// ── on-screen thread reporting ─────────────────────────────────────────────
// The global bots skip whatever is already in front of the user: this row's
// focused thread answers its ask inline in its column. Report it while this
// row is the visible surface (not overview, no overlay); null the moment it
// stops being shown — the parked ask stays live in the registry, so its bot
// appears top-right.
watch(
  () =>
    props.visible && !props.overview && !props.blocked
      ? (focusedThread.value?.threadId.value || null)
      : null,
  (threadId) => setInlineThread(props.project.path, threadId),
  { immediate: true },
);

function onOpenThread(threadId: string) {
  cue("press");
  // The pill's thread is usually already a pane (adopted while it ran); focus it.
  // If it was evicted since, open a fresh pane bound to its id — studio.open's
  // thread adapter reloads its transcript through agent.openThread.
  const existing = panes.value.find(
    (p) => p.kind === "thread" && p.session?.threadId.value === threadId,
  );
  if (existing) studio.focus(existing.id);
  else void studio.open("thread", { threadId });
  emit("summon");
}

// What the surfaces around the row can ask of it. Everything here is an
// operation on the live agent registry, which only the row holds — the project's
// own history list is upstream and needs these to keep the two in step.
// What the row offers the rest of the app. Exposed for a parent that holds a
// ref, and published to the registry for everything that can't — the project
// page's conversation list is under the plane now, not inside the row's parent.
async function newThreadPane(): Promise<void> {
  await studio.open("thread");
  await nextTick();
  void composerRef.value?.wake();
  emit("summon");
}

function playDemo(): void {
  emit("summon");
  agent.demo();
}

function captureText(text: string): void {
  const sourceKey = focusedId.value;
  if (!sourceKey) return;
  if (!panes.value.some((p) => p.id === sourceKey && p.kind === "thread")) return;
  void studio.dispatch({ type: "capture-text", text, from: sourceKey });
}

const rowApi: StudioRowApi = {
  openSession,
  revealThread,
  archiveSession,
  removeSession,
  sessionBusy,
  openThread: onOpenThread,
  adoptThread: (threadId) => void adoptThreadPane(threadId),
  dismissThread: (threadId) => closePaneHosting(threadId),
  newThread: () => void newThreadPane(),
  openTerminal: newTerminalPane,
  openScratchpad: newScratchpadPane,
  playDemo,
  captureText,
  focusPane,
  shiftPaneFocus,
  flush: flushStudio,
  /** Stop a turn in flight, cleanly, before something tears the row down anyway
   *  (a project switch remounts it). A no-op when nothing is running. */
  interruptIfRunning: () => {
    if (busy.value) void agent.interrupt();
  },
};

defineExpose(rowApi);

rowRegistry.register(registryPath, rowApi);
onBeforeUnmount(() => rowRegistry.unregister(registryPath, rowApi));
</script>

<template>
  <!-- Transient archive-refusal notice — a thread that is still working can't
       be archived/deleted, and the row not disappearing needs an explanation.
       Rendered above every surface (studio + overview both archive) until it
       auto-dismisses. -->
  <Transition name="archive-notice">
    <div v-if="archiveNotice && !isOverview" class="archive-notice" role="status">
      <HugeiconsIcon :icon="InformationSquareIcon" :size="15" :stroke-width="2" aria-hidden="true" />
      <span>{{ archiveNotice }}</span>
    </div>
  </Transition>
    <!-- BOARD · the thread strip. Every live thread in this project is a column
         on one horizontally scrollable rail (niri-style scrollable tiling), the
         focused one held at centre with its neighbours peeking in. The page
         itself never scrolls — each column scrolls its own turns, and each
         carries its own title bar, so there's no single sticky title any more.
         The layer stays mounted for the project's lifetime (its panes and their
         sessions/scroll positions survive a step back to the overview); it's
         hidden with `visibility`, not `v-if`, so xterm's fit() and the rail's
         width measurements never see a zero-width box. -->
    <div
      class="surface-layer surface-layer--studio"
      :class="{ 'surface-layer--hidden': !visible && !overview }"
      :inert="(!visible && !overview) || blocked"
      :aria-hidden="(!visible && !overview) ? 'true' : undefined"
    >
      <ThreadStrip
        :panes="panes"
        :focused-id="focusedId ?? ''"
        :now="agentNow"
        :pulse-key="pulseScratchpadKey"
        :inert="blocked"
        :visible="visible || overview"
        :chooser="showChooser"
        :repo="project.name"
        :project-path="project.path"
        :branch="branch ?? undefined"
        :origin="origin"
        :overview="overview"
        @choose="onChoosePane"
        @focus="focusPane"
        @shift="shiftPaneFocus"
        @move="movePane"
        @close="closePane"
        @archive="archivePane"
        @side-chat="openSideChat"
        @insert-column="insertPane"
        @terminal-write="terminal.write"
        @terminal-resize="terminal.resize"
        @terminal-restart="terminal.restart"
        @to-scratchpad="captureToScratchpad"
        @scratchpad-flush="() => scratchpad.flush()"
        @width="setPaneWidth"
        @zen="setPaneZen"
        @toggle-overview="emit('toggleOverview')"
        @select-column="(id) => emit('selectPane', id)"
      >
        <!-- Focused thread's ask, inside its own column: the scrim dims only
             that thread and the card lands bottom-centre over the composer's
             spot (pb-8 matches the dock). Answering resolves the parked tool
             call and the turn continues. This is the in-thread path — the away
             signal is the centre-bottom beacon, not this. -->
        <template #focused-overlay>
          <ThreadInteractionOverlay
            :user-input="focusedPendingUserInput"
            :approval="focusedPendingApproval"
            :approval-queue="focusedThread?.pendingApprovals.value"
            :suppressed="isOverview"
            @answer="onAnswerUserInput"
            @cancel="onCancelUserInput"
            @decide="onRespondApproval"
          />
        </template>
      </ThreadStrip>
    </div>
    <ConversationSelectionActions
      v-if="visible && !blocked && focusedThread && !isOverview"
      :focused-pane-id="focusedId ?? ''"
      @dispatch="studio.dispatch"
    />

    <!-- The agent composer docks dead-centre at the bottom of the BOARD, under
         a focused thread pane — dormant until you wake it, then it stretches
         into the input. It stays docked to the viewport while the column behind
         scrolls. It no longer appears on the working-tree home: that page is the
         project's dashboard, and conversation starts on the studio (mod+b, mod+n,
         or opening a session). Entering the strip's overview takes it away; fade
         rather than cut, so it doesn't blink out from under the cursor while the
         studio behind it is still gliding back. -->
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-to-class="opacity-0"
      @after-leave="composerOpen = false"
    >
      <div
        v-if="!focusedPendingUserInput && !focusedPendingApproval && visible && activePaneIsThread && !showChooser && !isOverview"
        class="composer-dock pointer-events-none fixed inset-x-0 bottom-8 flex flex-col items-center"
        :class="{ 'composer-dock--open': composerOpen }"
        :inert="blocked"
      >
        <ProviderHealthBanner
          class="pointer-events-auto mb-2 w-[min(100%-32px,680px)]"
          :status="sendBlockedStatus"
          :reason="sendBlockedReason"
          :checking="recheckingProviders"
          @recheck="recheckProviders"
        />
        <!-- Corner / above-composer dock stack (Tasks + Changes) -->
        <Transition
          enter-active-class="transition-opacity duration-150 ease-out"
          enter-from-class="opacity-0"
          leave-active-class="transition-opacity duration-150 ease-in"
          leave-to-class="opacity-0"
        >
          <ThreadDockStack
            v-if="visible && !blocked && focusedThread"
            :composer-open="composerOpen"
            :changes="activeChanges"
            :plan="activePlan"
            :project-path="project.path"
            :thread-key="focusedKey"
            position-mode="fixed"
            @open-file="(path, rect) => emit('openFile', path, rect)"
          />
        </Transition>
        <AgentComposer
          ref="composerRef"
          :project-path="project.path"
          :project-name="project.name"
          :branch="branch ?? undefined"
          :branch-switchable="threadIsBlank && !focusedIsSideChat"
          :thread-name="focusedThread?.title.value"
          :thread-id="focusedThread?.threadId.value"
          :busy="busy"
          :queued="queuedTurns"
          :picking="modelPickerOpen"
          :agents="agents"
          :agent-id="composerAgentId"
          :agent-switchable="threadIsBlank && !focusedIsSideChat"
          :models="modelOptions"
          :model-switchable="modelSwitchable"
          :model-id="model"
          :reasoning="reasoning"
          :mode="mode"
          :fast-mode="fastActive"
          :context-window="contextWindow"
          :blocked-reason="sendBlockedReason"
          :compactable="focusedCompactable"
          :creatable="blankThreadPane === null"
          @send="onSend"
          @remove-queued="onRemoveQueued"
          @reorder-queued="agent.reorderQueuedTurns($event)"
          @send-now="onSendNow"
          @interrupt="onInterrupt"
          @update:agent-id="onAgentPick"
          @update:model-id="onComposerModelId"
          @update:reasoning="onComposerReasoning"
          @update:mode="onComposerMode"
          @update:fast-mode="onUpdateFastMode"
          @update:context-window="onComposerContextWindow"
          @open-models="modelSwitchable && (modelPickerOpen = true)"
          @open-branch="emit('openBranch')"
          @compact="onComposerCompact"
          @new-thread="onComposerNewThread"
          @update:open="composerOpen = $event"
        />
      </div>
    </Transition>

    <!-- Subagents dock — the nested runs the agent delegated to this turn. It's
         a taller, wider panel than the Changes/Tasks cards, so it lives in the
         bottom-LEFT corner (free on the studio — the folder only perches there on
         home) instead of crowding the right-hand stack. -->
    <Transition
      enter-active-class="transition-opacity duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="visible && !blocked && focusedThread && !isOverview"
        data-agent-dock
        class="sub-dock-corner"
      >
        <AnimatePresence :initial="false" mode="wait">
          <AgentSubagentDock
            v-if="activeDelegates.rows.length"
            :key="`agent-subagents-dock-${focusedKey}`"
            :rows="activeDelegates.rows"
            :streaming="activeDelegates.streaming"
            @stop-subagent="(toolUseId) => void agent.stopSubagent(toolUseId)"
          />
        </AnimatePresence>
      </div>
    </Transition>

    <!-- The full providers → models → effort picker, in the folder-picker shell. -->
    <ModelPickerModal
      v-if="modelPickerOpen && !isOverview"
      :providers="pickerProviders"
      :active-provider="agent.provider.value"
      :model-id="model"
      :reasoning="reasoning"
      :fast-mode="fastActive"
      :context-window="contextWindow"
      @select="onModelSelect"
      @apply="applyModelEffort"
      @cancel="modelPickerOpen = false"
    />
</template>

<style scoped>
/* ── Composer dock ────────────────────────────────────────────────────────── */
/* Centred at the bottom of the studio. At rest it sits below the corner docks (46
   > 40/45 only once it opens): the resting orb is small and out of their way, and
   the docks are what you're reading. Open, the card is the thing being typed
   into, so it takes the higher layer and the docks pass underneath — the two
   stop competing for the same strip once the window is too narrow to hold both
   side by side. Stays under a file detail (50), which covers the studio whole. */
.composer-dock {
  z-index: 40;
}

.composer-dock--open {
  z-index: 46;
}


/* ── Subagents dock (bottom-left) ─────────────────────────────────────────── */
/* The nested-run panel lives in the opposite corner from the Changes/Tasks
   stack: it's the widest of the three and grows downward as more subagents
   spawn, so the right-hand column stays uncrowded. The container ignores
   pointer events; the card re-enables them for itself. */
.sub-dock-corner {
  position: fixed;
  left: 2rem;
  bottom: 2rem;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  pointer-events: none;
  transform-origin: 0 100%;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}


/* Each layer holds the viewport and centres its content, exactly as the old
   is-work / is-chat `<main>` did — that shaping now lives on the layer so the
   hidden one never disturbs the visible one. */
.surface-layer {
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  overflow: hidden;
}

.surface-layer--studio {
  align-items: stretch;
}

.surface-layer--hidden {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}

/* Arriving at the studio — the whole strip eases up into place with kone's house
   easing (the same the change cards use), ported verbatim from the old
   `.chat-open` Transition. Only the arrival animates: the hidden state carries
   no transition, so leaving snaps (matching the old chat-open-leave display:none
   that avoided a flash of the overview over the still-present studio). */
.surface-layer--studio:not(.surface-layer--hidden) {
  transition:
    opacity 0.42s ease,
    transform 0.46s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: 50% 22%;
  will-change: opacity, transform;
}

.surface-layer--studio.surface-layer--hidden {
  transform: translateY(10px) scale(0.985);
}


/* The archive-refusal notice — a floating pill over every surface, so it works
   from the studio (column header archive) and the overview (recent rows). House
   tokens: sunken surface, hairline, muted ink, the amber used for warnings. */
.archive-notice {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 120;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(520px, calc(100vw - 48px));
  padding: 9px 14px;
  border-radius: 999px;
  background: var(--sunken);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
  color: var(--ink-soft);
  font-size: 12.5px;
  line-height: 1.4;
}

.archive-notice :deep(svg) {
  flex: none;
  color: var(--warn);
}

.archive-notice-enter-active,
.archive-notice-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.archive-notice-enter-from,
.archive-notice-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}

</style>
