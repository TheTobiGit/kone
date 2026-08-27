<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useDebounceFn, useEventListener, watchDebounced } from "@vueuse/core";
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
import { buildModelCatalog, effortForTier, familyForId, sessionBrand, EFFORT_META } from "~/utils/modelCatalog";
import type { BrandKey, EffortTier, ModelOption, PickerProvider } from "~/utils/modelCatalog";
import {
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
} from "~/utils/modelPicker";
import type { ModelPick } from "~/composables/useModelCommit";
import { SESSION_BRAND } from "~/types/session";
import { childApprovalsInbox, type ThreadAttentionKind } from "~/composables/useAgent";
import { deriveActivePlan } from "~/utils/planTasks";
import { deriveChangedFiles } from "~/utils/changedFiles";
import { deriveActiveSubagents, deriveDelegates, type DelegateRow } from "~/utils/subagentRuns";
import SubagentShell from "~/components/conversation/SubagentShell.vue";
import { useTerminal } from "~/composables/useTerminal";
import { useScratchpad } from "~/composables/useScratchpad";
import { createOrJoinSidechat, getSideChatSource } from "~/composables/sideChats";
import { agentForThread } from "~/utils/agents";
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
}>();

const emit = defineEmits<{
  /** Bring the row forward. Everything that starts work — the first turn, a new
   *  thread, a terminal, opening a pill's thread — asks for this rather than
   *  reaching for the surface it happens to be sharing the window with. */
  summon: [];
  /** Pick a branch. The row's composer offers it, but the picker belongs to the
   *  repository surface — the row has no business owning a checkout. */
  openBranch: [];
  /** Show a file's detail. It covers the whole stage, so the surface that owns the
   *  stage opens it; the row only knows which file was clicked and from where. */
  openFile: [path: string, rect: DOMRect | null];
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
// SAFETY: Local storage values are cast to ProviderKind | null and validated via fallback
const initialProvider: ProviderKind =
  (import.meta.client
    ? (localStorage.getItem(DEFAULT_PROVIDER_KEY) as ProviderKind | null) ??
      (localStorage.getItem(PROVIDER_KEY) as ProviderKind | null)
    : null) ?? "codex";
const agent = useAgent({
  provider: initialProvider in PROVIDER_VENDOR ? initialProvider : "codex",
  cwd: () => props.project.path,
});
// A conversation the launcher asked us to resume on open (see onMounted).
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
// Whether the composer is expanded into its input. A narrow window leaves the
// centred card and the corner docks sharing the same strip of screen, so an open
// composer rides above them — while the resting orb stays under them, where the
// docks are the thing you're reading.
const composerOpen = ref(false);

// A pad pane briefly pulses its index dash after a thread → pad append.
const pulseScratchpadKey = ref<string | null>(null);

// The strip's overview (Exposé) mode, mirrored up as a single boolean so the fixed
// composer can step aside — a composer floating over the zoomed-out plane reads as a
// bug. This is the only thing outside the strip that needs to know; the mode itself
// lives entirely inside ThreadStrip.
const stripOverview = ref(false);

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
function archivePane(threadId: string, id: string): void {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return;
  }
  archiveSession(threadId);
  void studio.close(id);
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

// The two corner docks (Tasks + Changes) plus the Subagents dock derive from the
// whole block list, so they'd otherwise re-run their derive on every streamed
// token of a live turn. Nothing here is time-critical, so the docks read a
// snapshot that we refresh at most ~10×/s rather than the live computed. (E2)
const activePlanRaw = computed(() =>
  deriveActivePlan(focusedThread.value?.blocks.value ?? []),
);
const activeChangesRaw = computed(() =>
  deriveChangedFiles(focusedThread.value?.blocks.value ?? []),
);
const activeSubagentsRaw = computed(() =>
  deriveActiveSubagents(focusedThread.value?.blocks.value ?? []),
);
const activeDelegatesRaw = computed(() =>
  deriveDelegates(
    focusedThread.value?.blocks.value ?? [],
    focusedThread.value?.spawnedChildren.value ?? [],
  ),
);

// What the docks actually render — a debounced snapshot of the four derives.
const activePlan = shallowRef(activePlanRaw.value);
const activeChanges = shallowRef(activeChangesRaw.value);
const activeSubagents = shallowRef(activeSubagentsRaw.value);
const activeDelegates = shallowRef(activeDelegatesRaw.value);
function syncDockSnapshot(): void {
  activePlan.value = activePlanRaw.value;
  activeChanges.value = activeChangesRaw.value;
  activeSubagents.value = activeSubagentsRaw.value;
  activeDelegates.value = activeDelegatesRaw.value;
}

// Switching threads used to morph one thread's docks into another's *in place* —
// file rows and card height reflowed mid-flight under a flat container fade, and
// it read as broken. So a switch is now a hard swap: each dock is keyed to the
// focused thread, so leaving a thread unmounts its docks (each plays its own
// scale+fade exit) and the new thread's docks mount fresh (playing their enter).
// The snapshot swaps synchronously with the key, so the newly-mounted docks carry
// the right data from their first frame. Streaming *within* a thread keeps the
// same key, so a live turn's docks tick along in place (no remount).
const focusedKey = computed(() => focusedThread.value?.key ?? null);

watchDebounced(
  [activePlanRaw, activeChangesRaw, activeSubagentsRaw, activeDelegatesRaw],
  () => syncDockSnapshot(),
  { debounce: 100, maxWait: 200 },
);

watch(focusedKey, () => syncDockSnapshot());

// ── the open subagent shell ──────────────────────────────────────────────────
// Which delegate's expanded transcript is on screen. The two actions the shell
// can't perform itself are handed down: an approval still goes through this
// surface's one approval path, and revealing a spawned thread is a studio
// operation, not the shell's.
const {
  activeShell,
  activeShellRun,
  activeShellThread,
  shellApprovals,
  shellSuppressesApproval,
  onOpenShell,
  onCloseShell,
  onDecideShellApproval,
  onShellOpenThread,
  onOpenDelegate,
} = useSubagentShell({
  subagents: activeSubagentsRaw,
  focusedThread,
  focusedPendingApproval,
  focusedKey,
  respondApproval: (requestId, decision) => onRespondApproval(requestId, decision),
  revealThread: (threadId) => void revealThread(threadId),
  cue,
});

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
 *  (live session) and a dormant one (anchor remembers the id). */
function closePaneHosting(threadId: string): void {
  const pane = panes.value.find(
    (p) =>
      p.kind === "thread" &&
      ((p.session && p.session.threadId.value === threadId) ||
        (p.entry.anchor.kind === "thread" && p.entry.anchor.threadId === threadId)),
  );
  if (pane) void studio.close(pane.id);
}

function archiveSession(threadId: string): void {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return;
  }
  rowRegistry.historyFor(registryPath).archive(threadId);
  void agent.forgetThread(threadId);
  closePaneHosting(threadId);
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
} = useAgentRoster();

// When an outside surface (such as the agent detail page in settings) requests
// a new conversation with a specific agent, bring the studio forward, spawn a
// fresh blank thread if the focused one is non-blank or busy, and wake the
// composer.
watch(pendingThreadAgent, async (agentId) => {
  if (!agentId) return;
  pendingThreadAgent.value = null;
  emit("summon");
  if (!threadIsBlank.value || busy.value) {
    await studio.open("thread");
  }
  await nextTick();
  void composerRef.value?.wake();
});

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
    if (!props.visible) return;

    let blank = blankThreadPane.value;
    // Same invariant as onSend: with nothing focused the send goes through the
    // blank thread slot (or mints one if the row has none yet). Materialise it
    // here so model picks aren't written to a boot session restore is about to
    // evict.
    if (!blank) {
      await studio.open("thread", { focus: false });
      blank = blankThreadPane.value;
    }
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
  const configuredModel = localStorage.getItem(DEFAULT_MODEL_KEY);
  const lastUsedModel = localStorage.getItem(MODEL_KEY);
  const savedModel = configuredModel ?? lastUsedModel;
  if (owned(savedModel)) {
    agent.setModel(savedModel!);
  } else if (owned(current)) {
    // Already valid for this provider — leave it.
  } else {
    const first = modelOptions.value[0];
    const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
    agent.setModel(eff ? eff.modelId : undefined);
  }

  const savedReasoning =
    localStorage.getItem(DEFAULT_REASONING_KEY) ?? localStorage.getItem(REASONING_KEY);
  if (savedReasoning && savedReasoning in EFFORT_META) {
    const fam = familyForId(modelOptions.value, model.value);
    // SAFETY: EFFORT_META satisfies Record<EffortTier, EffortMeta>, so the
    // `in` guard above proves savedReasoning is an EffortTier.
    const eff = effortForTier(fam, savedReasoning as EffortTier);
    if (eff) agent.setReasoning(eff.tier);
  }

  // Per-project mode wins; before this project has one, the app-wide default.
  const savedMode = localStorage.getItem(MODE_KEY) ?? localStorage.getItem(DEFAULT_MODE_KEY);
  if (savedMode && MODES.some((m) => m.id === savedMode)) {
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
  // mount; it is also namespaced to this project's path, so a request that ever
  // leaks past its mount cannot resume inside another project.
  const requestedThread = pendingThread.value;
  pendingThread.value = null;
  const resume =
    requestedThread && requestedThread.path === props.project.path
      ? requestedThread.threadId
      : null;

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
  if (resume) {
    // Launcher asked to resume a specific conversation. One open path for a
    // stored thread: studio.open dedupes against live AND dormant panes (the
    // resume target is usually already restored as a pane — often the focused
    // one), focuses the hosting pane so the strip scrolls to it, or mints a
    // fresh pane bound to the id. The manual live/dormant check + split
    // focusThreadById/open call duplicated that logic and could leave the
    // studio focused elsewhere. Either way we land on the studio.
    await studio.open("thread", { threadId: resume });
    emit("summon");
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
  if (!resume) seedBootDefaults();
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
    if (import.meta.client && id) localStorage.setItem(MODEL_KEY, id);
  },
  { immediate: true },
);

// Persist the reasoning effort globally (app-wide last-used), like the model id.
watch(reasoning, (tier) => {
  if (import.meta.client) localStorage.setItem(REASONING_KEY, tier);
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

// ── new columns from the keyboard ─────────────────────────────────────────────
// Ctrl+N (mod+n) starts a fresh, empty thread — the keyboard way to begin a
// conversation from the working-tree home now that the composer lives on the
// studio. It flips to that surface so the user lands in the blank thread,
// and prunes the idle previous thread when it never ran a live turn.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-thread", e)) return;
  e.preventDefault();
  void studio.open("thread");
  emit("summon");
});

// mod+shift+t opens a terminal column on the strip and focuses it, flipping to
// the studio surface (where the strip lives) so the new shell is on screen.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-terminal", e)) return;
  e.preventDefault();
  emit("summon");
  void newTerminalPane();
});

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-scratchpad", e)) return;
  e.preventDefault();
  emit("summon");
  void newScratchpadPane();
});

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("send-selection-to-scratchpad", e)) return;
  e.preventDefault();
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!text || text.length <= 2) return;
  const sourceKey = focusedId.value;
  if (!sourceKey) return;
  if (!panes.value.some((p) => p.id === sourceKey && p.kind === "thread")) return;
  void studio.dispatch({ type: "capture-text", text, from: sourceKey });
});

// Play a scripted demo conversation so the whole thread UI (thinking, tools
// with output, streaming text, a no-content thought, the settled footer) can be
// reviewed on demand without driving a real agent turn. The binding lives in
// the shortcuts registry so it can be rebound in settings.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("play-demo", e)) return;
  e.preventDefault();
  emit("summon");
  agent.demo();
});

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
watch(pickedForProject, async () => {
  if (!studioReady.value || busy.value || !threadIsBlank.value) return;
  await syncComposerTarget();
  let providerChanged = false;
  if (!providerAllowed(agent.provider.value)) {
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
    const first = modelOptions.value[0];
    const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
    agent.setModel(eff ? eff.modelId : undefined);
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
/** Steer the composer draft into the RUNNING turn — same shape as onSend
 *  (settle the composer target, persist picked files, hand the turn to the
 *  service), but routed through the steer channel: no new turn boundary, the
 *  provider consumes the nudge when it builds its next request. */
async function onSteer(text: string, files?: File[]) {
  await syncComposerTarget();
  // No agent to settle here: a steer only exists inside a running turn, and the
  // send that started that turn already settled the thread.
  let attachments: ChatAttachment[] | undefined;
  if (files?.length) {
    const results = await Promise.allSettled(files.map((f) => agent.uploadAttachment(f)));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (ok.length) attachments = ok;
  }
  void agent.steerTurn(text, attachments);
}
/** Drop one durably queued follow-up (the composer chips' ✕). The backend
 *  emits turn.queued-cancelled; the chip clears on that event. */
function onRemoveQueued(queueId: string) {
  void agent.cancelQueuedTurn(queueId);
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
// ── blocked-thread attention ─────────────────────────────────────────────────
// The one signal that overrides the surface gate above: a thread parked on a
// person. Two sources feed it — resident threads waiting on a permission or a
// question, and spawned children parked on their own gate (headless here, so
// they never had a summary). A blocked thread is never dismissed and, unlike the
// completion pills, never hidden by the surface you're on — the moment you stop
// staring at it is exactly when an unanswered prompt would otherwise vanish.
const attentionThreads = computed<
  { key: string; threadId: string; title: string; brand: BrandKey; kind: ThreadAttentionKind; detail?: string }[]
>(() => {
  if (props.blocked) return []; // the file overlay owns the whole screen
  const out: { key: string; threadId: string; title: string; brand: BrandKey; kind: ThreadAttentionKind; detail?: string }[] = [];
  for (const t of agent.threads.value) {
    if (!t.attention) continue;
    // On the studio the focused thread shows its gate inline in the composer, so
    // a corner pill would only echo it. Anywhere else — the working tree, the
    // repository surface — no conversation is on screen, so even the active
    // thread's gate has to be surfaced here or it's invisible.
    if (props.visible && t.isActive) continue;
    out.push({
      key: t.key,
      threadId: t.threadId,
      title: t.title,
      brand: sessionBrand(t.provider, SESSION_BRAND[t.provider] ?? "generic", t.model),
      kind: t.attention.kind,
      detail: t.attention.detail,
    });
  }
  for (const [childId, pending] of childApprovalsInbox.value) {
    out.push({
      key: `spawn:${childId}`,
      threadId: childId,
      title: "Spawned thread",
      brand: "generic",
      kind: "parked-spawn",
      detail: pending.approval.title,
    });
  }
  return out;
});

// When each wait was first seen — a fresh one wears the pastille (`notify`); once
// it's sat unanswered past this, the orb escalates to the "!" (`exclaim`). A
// view-side freshness timer (the same shape as seenTurns): seeded when a key
// appears, dropped when it clears, never persisted.
const STALE_AFTER_MS = 30_000;
const attentionSince = ref<Record<string, number>>({});
watch(
  () => attentionThreads.value.map((a) => a.key).join("|"),
  () => {
    const now = Date.now();
    const live = new Set(attentionThreads.value.map((a) => a.key));
    const next = { ...attentionSince.value };
    let touched = false;
    for (const key of live) {
      if (next[key] === undefined) {
        next[key] = now;
        touched = true;
      }
    }
    for (const key of Object.keys(next)) {
      if (!live.has(key)) {
        delete next[key];
        touched = true;
      }
    }
    if (touched) attentionSince.value = next;
  },
  { immediate: true },
);
function attentionOrb(key: string): "notify" | "exclaim" {
  const since = attentionSince.value[key];
  if (since === undefined) return "notify";
  return agentNow.value - since > STALE_AFTER_MS ? "exclaim" : "notify";
}

// The beacon's items — the away-thread asks, each with its own freshness orb
// folded in so the beacon can escalate as a whole and each bloomed row can show
// its own state.
// The centre-bottom is already spoken for — by the composer, or by the focused
// thread's own ask cue — whenever a thread column is focused and the row is the
// surface on screen. There the beacon lifts to float just above that dock;
// elsewhere it takes the true bottom-centre.
const centerDockActive = computed(
  () => props.visible && activePaneIsThread.value && !stripOverview.value,
);

// The focused thread's own ask answers in place — it raises its shell (the
// question / approval modal) straight over the composer, the way it always has.
// The bloub is NOT for the thread you're looking at; it's the away-signal below,
// for the threads that park while your eyes are elsewhere. When a modal owns the
// centre-bottom the beacon steps aside for it. Only the row's own modals can be
// there now: the plane is opaque and above every page, so a page's sheet can
// never be on screen at the same time as this row.
const centerModalOpen = computed(
  () =>
    !!focusedPendingUserInput.value ||
    (!!focusedPendingApproval.value && !shellSuppressesApproval.value) ||
    modelPickerOpen.value,
);

const attentionBeaconItems = computed(() =>
  attentionThreads.value.map((a) => ({ ...a, orbState: attentionOrb(a.key) })),
);
// The centre-bottom is already spoken for — by the composer, or by the focused
// thread's own ask cue — whenever a thread column is focused on the studio. There
// the beacon lifts to float just above that dock; elsewhere (overview, repo

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
const rowApi: StudioRowApi = {
  openSession,
  revealThread,
  archiveSession,
  removeSession,
  sessionBusy,
  openThread: onOpenThread,
  newThread: () => void studio.open("thread"),
  openTerminal: newTerminalPane,
  openScratchpad: newScratchpadPane,
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
    <div v-if="archiveNotice" class="archive-notice" role="status">
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
      :class="{ 'surface-layer--hidden': !visible }"
      :inert="!visible || blocked"
      :aria-hidden="!visible ? 'true' : undefined"
    >
      <ThreadStrip
        :panes="panes"
        :focused-id="focusedId ?? ''"
        :now="agentNow"
        :pulse-key="pulseScratchpadKey"
        :inert="blocked"
        :visible="visible"
        :chooser="showChooser"
        :repo="project.name"
        :project-path="project.path"
        :branch="branch ?? undefined"
        :origin="origin"
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
        @update:overview="stripOverview = $event"
      />
    </div>
    <ConversationSelectionActions
      v-if="visible && !blocked && focusedThread"
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
        v-if="!focusedPendingUserInput && !focusedPendingApproval && visible && activePaneIsThread && !showChooser && !stripOverview"
        class="composer-dock pointer-events-none fixed inset-x-0 bottom-8 flex justify-center"
        :class="{ 'composer-dock--open': composerOpen }"
        :inert="blocked"
      >
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
          @send="onSend"
          @steer="onSteer"
          @remove-queued="onRemoveQueued"
          @interrupt="onInterrupt"
          @update:agent-id="onAgentPick"
          @update:model-id="onComposerModelId"
          @update:reasoning="onComposerReasoning"
          @update:mode="onComposerMode"
          @update:fast-mode="onUpdateFastMode"
          @update:context-window="onComposerContextWindow"
          @open-models="modelSwitchable && (modelPickerOpen = true)"
          @open-branch="emit('openBranch')"
          @update:open="composerOpen = $event"
        />
      </div>
    </Transition>

    <!-- Mid-turn question on the focused thread: it raises straight over the
         composer in the picker-family shell. Answering resolves the parked tool
         call and the turn continues. This is the in-thread path — the away
         signal is the centre-bottom beacon, not this. -->
    <UiUserInputModal
      v-if="focusedPendingUserInput"
      :request-id="focusedPendingUserInput.requestId"
      :questions="focusedPendingUserInput.questions"
      @answer="onAnswerUserInput"
      @cancel="onCancelUserInput"
    />

    <!-- Tool approval on the focused thread: the turn is parked on the agent
         wanting to run something in a restrictive mode. The subagent shell, when
         it's already showing this same ask inline, is the answer spot instead —
         and then this modal stays down. -->
    <AgentApprovalModal
      v-if="focusedPendingApproval && !shellSuppressesApproval"
      :request-id="focusedPendingApproval.requestId"
      :approval="focusedPendingApproval.approval"
      :queue="focusedThread?.pendingApprovals.value"
      @decide="onRespondApproval"
    />

    <!-- Subagents dock — the nested runs the agent delegated to this turn. It's
         a taller, wider panel than the Changes/Tasks cards, so it lives in the
         bottom-LEFT corner (free on the studio — the folder only perches there on
         home) instead of crowding the right-hand stack. It steps aside while
         its shell is open — the shell is the zoom-in of this same dock. -->
    <div
      v-if="visible && !blocked && focusedThread && !activeShell && !stripOverview"
      class="sub-dock-corner"
    >
      <AnimatePresence :initial="false" mode="wait">
        <AgentSubagentDock
          v-if="activeDelegates.rows.length"
          :key="`agent-subagents-dock-${focusedKey}`"
          :rows="activeDelegates.rows"
          :streaming="activeDelegates.streaming"
          @open="onOpenDelegate"
          @stop-subagent="(toolUseId) => void agent.stopSubagent(toolUseId)"
        />
      </AnimatePresence>
    </div>

    <!-- Corner dock stack — the agent's live side-panels in the folder-picker
         shell, bottom-right while a turn runs. Changes (files touched this
         thread) rides above Tasks (the model's TodoWrite checklist); the column
         lifts clear of the away-from-thread pill when one is perched below. -->
    <div v-if="visible && !blocked && focusedThread && !stripOverview" class="dock-stack">
      <AnimatePresence :initial="false" mode="wait">
        <GitSpaceChangedFilesList
          v-if="activeChanges.files.length"
          :key="`agent-changes-dock-${focusedKey}`"
          :files="activeChanges.files"
          :total-added="activeChanges.totalAdded"
          :total-removed="activeChanges.totalRemoved"
          :streaming="activeChanges.streaming"
          :repo-path="project.path"
          @open-file="(path: string, rect: DOMRect | null) => emit('openFile', path, rect)"
        />
      </AnimatePresence>
      <AnimatePresence :initial="false" mode="wait">
        <PlanTaskList
          v-if="activePlan"
          :key="`agent-plan-dock-${focusedKey}`"
          :tasks="activePlan.tasks"
          :streaming="activePlan.streaming"
        />
      </AnimatePresence>
    </div>

    <!-- Needs-a-human beacon: a big bloub at the bottom-centre for every OTHER
         thread parked on you. It lifts above the composer/cue when a thread
         column is focused, and takes the true centre elsewhere. Hover or click
         blooms the parked threads; picking one jumps to it. -->
    <div
      class="attn-beacon"
      :class="{ 'attn-beacon--lifted': centerDockActive }"
    >
      <AnimatePresence :initial="true">
        <AttentionBeacon
          v-if="attentionBeaconItems.length && !centerModalOpen"
          :items="attentionBeaconItems"
          @open="onOpenThread"
        />
      </AnimatePresence>
    </div>

    <!-- A subagent's expanded shell: clicked from the Subagents dock (or the
         activity feed's subagent step), the shell rises over the studio — the
         delegate's identity + live status in the header, its live activity
         filling the body, and any approval it parked on answerable inline. It
         tracks the live delegate by identity, so a working child keeps
         streaming into it. -->
    <Transition name="sut">
      <SubagentShell
        v-if="activeShell"
        :kind="activeShell.kind"
        :run="activeShellRun"
        :thread="activeShellThread"
        :approvals="shellApprovals"
        @close="onCloseShell"
        @open-thread="onShellOpenThread"
        @decide-approval="onDecideShellApproval"
        @stop-subagent="(toolUseId) => void agent.stopSubagent(toolUseId)"
      />
    </Transition>

    <!-- The full providers → models → effort picker, in the folder-picker shell. -->
    <ModelPickerModal
      v-if="modelPickerOpen"
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
  z-index: 30;
}

.composer-dock--open {
  z-index: 46;
}


/* ── Corner dock stack ────────────────────────────────────────────────────── */
/* Fixed to the bottom-right corner, holding the agent's live side-panels
   (Changes above Tasks) as a single column so the two folder-picker cards stack
   cleanly instead of fighting for the corner. The container ignores pointer
   events; each card re-enables them for itself. Lifts to clear the pill when an
   away-from-thread pill is perched below. */
.dock-stack {
  position: fixed;
  right: 2rem;
  bottom: 2rem;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  pointer-events: none;
  transform-origin: 100% 100%;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
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


/* The attention beacon rides the bottom-centre — the app's action locus. It's
   pointer-transparent across its gaps; the orb/pills re-enable their own hits.
   When a thread column owns the composer/cue at the very bottom, the beacon
   lifts clear of it. */
.attn-beacon {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 2rem;
  z-index: 46;
  display: flex;
  justify-content: center;
  pointer-events: none;
  transition: bottom 0.42s cubic-bezier(0.22, 1, 0.36, 1);
}

.attn-beacon--lifted {
  bottom: 7.5rem;
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

/* The subagent shell rises over the row rather than sliding — it is a step INTO
   a delegate, not a neighbouring surface. */
.sut-enter-active,
.sut-leave-active {
  transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sut-enter-from,
.sut-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}
</style>
