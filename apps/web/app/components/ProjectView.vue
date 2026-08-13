<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, toRef, watch } from "vue";
import { onClickOutside, onKeyStroke, useDebounceFn, useEventListener, watchDebounced } from "@vueuse/core";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowTurnBackwardIcon,
  AppleFinderIcon,
  GitBranchIcon,
  InformationSquareIcon,
} from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import type { FolderFile } from "~/types/folder";
import type { ChangeItem } from "~/types/change";
import type {
  ApprovalDecision,
  ChatAttachment,
  GitFileStatus,
  InteractionMode,
  ProviderKind,
  UserInputAnswers,
} from "~/types/desktop";
import type { Project } from "~/composables/useProject";
import type { RecentProject } from "~/composables/useRecentProjects";
import { buildModelCatalog, effortForTier, familyForId, sessionBrand, EFFORT_META } from "~/utils/modelCatalog";
import type { BrandKey, EffortTier, ModelOption, PickerProvider } from "~/utils/modelCatalog";
import { SESSION_BRAND } from "~/types/session";
import { deriveActivePlan } from "~/utils/planTasks";
import { deriveChangedFiles } from "~/utils/changedFiles";
import {
  deriveActiveSubagents,
  deriveDelegates,
  SUBAGENT_OPEN_KEY,
  type DelegateRow,
} from "~/utils/subagentRuns";
import SubagentShell from "~/components/SubagentShell.vue";
import { useTerminal } from "~/composables/useTerminal";
import { useScratchpad } from "~/composables/useScratchpad";
import { createOrJoinSidechat } from "~/composables/useSideChats";

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ close: []; profile: [] }>();

// One reactive git model drives the whole page; every surface below reads from
// its derived counts, and the action handlers edit it in place so a change
// shows up everywhere at once.
const g = useProjectGit(toRef(props, "project"));
// The repository surface reads through its own funnel, but shares the working
// tree model above rather than opening a second watcher. Constructing it is free
// (it fetches nothing until the space is entered), so it can live here with `g`.
const space = useGitSpace(toRef(props, "project"), g);
const { cue } = useSound();
const { warm } = useHighlighter();

// The signed-in machine user — its initial rides the far-right corner of the
// top row as a profile chip, mirroring the back arrow at the left. Resolved
// once (shared state); the chip only appears once a name comes back.
const { displayName, initial, resolve: resolveUser } = useUser();

// ── the live agent session ────────────────────────────────────────────────────
// One provider session, scoped to this project. The composer feeds it turns and
// the thread renders them — the same normalized event stream drives both, so
// nothing here knows it's Codex underneath. In `nuxt dev` (no bridge) the
// composable streams a faithful mock so the whole flow is demoable in a browser.
const providers = useAgentProviders();
// The user's per-provider install settings — here just for the enable toggle,
// which decides whether a detected provider is offered in the picker rail.
const providerSettings = useProviderSettings();
// cwd is a getter so the session always boots in whatever project is active —
// paired with a per-project key on <ProjectView> so switching projects gives a
// fresh session rooted in the new directory.
// Provider is chosen in onMounted (below) from what's installed + last used;
// "codex" is just the pre-mount default the ref carries until then.
const agent = useAgent({ provider: "codex", cwd: () => props.project.path });
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
// ── the project board ──────────────────────────────────────────────────────
// The strip is a board of panes (threads, terminals, the scratchpad) on one
// substrate. useBoard owns the layout — pane order + focus — and wraps the
// three composables through thin adapters; the strip renders `panes` and every
// layout gesture below is a single board.* call. Sessions attach on open
// (dormancy lands later); adoption folds in the boot thread and any thread a
// pill later opens. `focusedId` is the single focus truth (no more mirroring
// agent.activeKey — focus pushes DOWN to the agent instead).
// The composer, ref'd here (ahead of its template mount) so board.dispatch can
// pre-fill it for the draft-thread intent. Its wake watcher lives further down.
const composerRef = ref<{ wake: () => Promise<void>; setDraft: (text: string) => Promise<void> } | null>(null);

// A pad pane briefly pulses its index dash after a thread → pad append.
const pulseScratchpadKey = ref<string | null>(null);

// The strip's overview (Exposé) mode, mirrored up as a single boolean so the fixed
// composer can step aside — a composer floating over the zoomed-out plane reads as a
// bug. This is the only thing outside the strip that needs to know; the mode itself
// lives entirely inside ThreadStrip.
const stripOverview = ref(false);

const board = useBoard({
  agent,
  terminal,
  scratchpad,
  // The two UI-only tails of a cross-pane action: flash the pad's index dash
  // after a capture, and pre-fill the composer for a draft thread.
  hooks: {
    pulsePad: (id) => pulsePadPane(id),
    setDraft: (text) => composerRef.value?.setDraft(text),
  },
});
const { panes, focusedId, focusedPane, blankThreadPane, attach } = board;

// ── board persistence ──────────────────────────────────────────────────────
// The layout (pane order, kinds, backend ids, widths, focus) is written to the
// store (or localStorage in nuxt dev) whenever its persisted shape changes —
// off `board.saveSignature`, a cheap string that never ticks on a streamed
// token. Saving only starts once `restore()`/`start()` has settled, so the boot
// adopt can't clobber a saved layout before we've read it. `restore()` itself
// runs in onMounted. A missing saved layout normalises to an empty desktop so
// restore() can evict useAgent's construction spawn instead of leaving a boot
// thread adopted on the strip.
const boardStore = useBoardPersistence(() => props.project.path);
const boardReady = ref(false);
/** Resolves once the async mount (provider detection → catalogs → board restore)
 *  has finished. Callers that must not act on the pre-mount boot session — the
 *  composer target sync and every send — await this instead of no-opping, which
 *  used to let a cold-start send run on the hardcoded `codex` default carrying a
 *  model restored from another provider. */
function whenBoardReady(): Promise<void> {
  if (boardReady.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(boardReady, (v) => {
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
const persistBoard = useDebounceFn(() => {
  if (boardReady.value) boardStore.save(board.serialize());
}, 400);
watch(board.saveSignature, () => {
  void persistBoard();
});
function setPaneWidth(id: string, width: number): void {
  board.setWidth(id, width);
}

// The composer only docks under a focused thread pane ON the board — never on
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

// ── bare-board chooser ───────────────────────────────────────────────────────
// The board is a desktop and its panes are windows: closing the last one leaves
// a bare desktop (zero panes), and nothing is respawned to fill it. That — and
// only that — gets the centered chooser (the same thread / terminal /
// scratchpad pick the seam menu offers), because there is no column to hang an
// affordance off.
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
const boardIsBare = computed(() => panes.value.length === 0);
const showChooser = computed(
  () => surface.value === "board" && boardIsBare.value && !chooserDismissed.value && !activeFile.value,
);
// Every time the desktop goes bare again, re-arm the chooser.
watch(boardIsBare, (bare) => {
  if (bare) chooserDismissed.value = false;
});

async function onChoosePane(kind: "thread" | "terminal" | "scratchpad"): Promise<void> {
  // Only ever reached from a bare desktop, so nothing is waiting to be revealed
  // — every kind opens a fresh pane.
  chooserDismissed.value = true;
  await board.open(kind);
  if (kind === "thread") void composerRef.value?.wake();
}

function focusPane(id: string): void {
  board.focus(id);
}
function shiftPaneFocus(delta: number): void {
  board.focusByOffset(delta);
}
function movePane(delta: number): void {
  if (focusedId.value) board.move(focusedId.value, delta);
}
function closePane(id: string): void {
  void board.close(id);
}
// Archiving a thread from its column header stamps the history row (and forgets
// the in-memory registry thread, same as the recent-list archive), then closes
// the now-empty column so it doesn't linger on the board pointing at a hidden row.
function archivePane(threadId: string, id: string): void {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return;
  }
  archiveSession(threadId);
  void board.close(id);
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
      const id = await board.open("thread", { threadId, near: sourcePaneId });
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
  void board.open(kind, { at: seamIndex + 1 });
}

// mod+shift+t / mod+shift+n open a terminal / the scratchpad beside the focused
// pane and focus it — the keyboard siblings of the seam insert picks.
function newTerminalPane(): void {
  void board.open("terminal");
}
function newScratchpadPane(): void {
  void board.open("scratchpad");
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
  void board.dispatch({ type: "capture-text", text, from: sourceKey });
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
// file rows and card height reflowed mid-flight and it read as broken. So a
// switch is treated as a context swap: fade the whole stack out (still showing
// the thread you're leaving), swap the data at the invisible midpoint, then fade
// the new thread's docks in. The reflow still runs — it's just hidden behind the
// fade. Streaming *within* a thread keeps updating the snapshot in place (no
// fade), so a live turn's docks still tick along.
const focusedKey = computed(() => focusedThread.value?.key ?? null);
const docksSwapping = ref(false);
let dockSwapTimer: ReturnType<typeof setTimeout> | undefined;

watchDebounced(
  [activePlanRaw, activeChangesRaw, activeSubagentsRaw, activeDelegatesRaw],
  () => {
    if (docksSwapping.value) return; // mid-swap: the timer owns the snapshot
    syncDockSnapshot();
  },
  { debounce: 100, maxWait: 200 },
);

watch(focusedKey, (key, prev) => {
  // First focus, or leaving / re-entering the board (null on either side): no
  // crossfade — snap so the docks are right the instant a thread takes focus.
  if (key === prev || prev == null || key == null) {
    syncDockSnapshot();
    return;
  }
  docksSwapping.value = true;
  clearTimeout(dockSwapTimer);
  dockSwapTimer = setTimeout(() => {
    syncDockSnapshot();
    docksSwapping.value = false;
  }, 165);
});
onBeforeUnmount(() => clearTimeout(dockSwapTimer));

// ── the open subagent shell ──────────────────────────────────────────────────
// Clicking a row in the Subagents dock (or the activity feed's subagent step)
// opens that delegate's EXPANDED shell — the zoom-in of the dock. The shell is
// keyed by identity (a run's stable `toolUseId`, a spawned thread's `threadId`)
// but derives the delegate itself fresh from the live block tree + spawn list,
// so a still-working child keeps streaming into the open shell instead of
// freezing on the snapshot the dock rows came from.
type ShellTarget = { kind: "run"; toolUseId: string } | { kind: "thread"; threadId: string };
const activeShell = ref<ShellTarget | null>(null);
const activeShellRun = computed(() => {
  const t = activeShell.value;
  if (t?.kind === "run") {
    return activeSubagentsRaw.value.runs.find((r) => r.toolUseId === t.toolUseId) ?? null;
  }
  return null;
});
const activeShellThread = computed(() => {
  const t = activeShell.value;
  if (t?.kind === "thread") {
    return (
      focusedThread.value?.spawnedChildren.value.find((c) => c.threadId === t.threadId) ?? null
    );
  }
  return null;
});
function onOpenShell(target: ShellTarget): void {
  cue("press");
  activeShell.value = target;
}
function onCloseShell(): void {
  activeShell.value = null;
}
// The approvals this shell's run is parked on — attributed upstream in useAgent
// when exactly one run was live as the ask landed (originToolUseId). Un-attributable
// asks (the parent's own, or a concurrent batch) stay with the main modal.
const shellApprovals = computed(() => {
  const run = activeShellRun.value;
  if (!run) return [];
  return (focusedThread.value?.pendingApprovals.value ?? []).filter(
    (a) => a.originToolUseId === run.toolUseId,
  );
});
// When the shell renders the pending approval inline, the main modal steps
// aside for that request — one ask, one place to answer it.
const shellSuppressesApproval = computed(() => {
  const p = focusedPendingApproval.value;
  return !!p && shellApprovals.value.some((a) => a.requestId === p.requestId);
});
function onDecideShellApproval(requestId: string, decision: ApprovalDecision): void {
  onRespondApproval(requestId, decision);
}
function onShellOpenThread(): void {
  const t = activeShell.value;
  if (t?.kind !== "thread") return;
  activeShell.value = null;
  void revealThread(t.threadId);
}
// Clicking a delegate row opens what that kind of delegate IS: a provider-native
// run opens its live transcript in the shell in place; a spawned thread is a
// real, persistent conversation — the shell shows its projection, and the
// shell's open-thread action reveals the thread itself (which loads its stored
// transcript and flips to the board).
function onOpenDelegate(row: DelegateRow): void {
  if (row.target.kind === "run") {
    onOpenShell({ kind: "run", toolUseId: row.target.toolUseId });
    return;
  }
  onOpenShell({ kind: "thread", threadId: row.target.threadId });
}
// A shell belongs to one thread; switching the focused column (or leaving the
// board) takes it away with the dock that opened it.
watch(focusedKey, () => {
  activeShell.value = null;
});
// A spawned thread that vanishes from the live list (never spawned, archived,
// swept) takes its shell with it.
watch(activeShellThread, (t) => {
  if (activeShell.value?.kind === "thread" && !t) activeShell.value = null;
});
// The activity feed's subagent step rows have no direct emit path up here, so
// the open handler rides provide/inject instead (see SUBAGENT_OPEN_KEY).
provide(SUBAGENT_OPEN_KEY, (toolUseId: string) => onOpenShell({ kind: "run", toolUseId }));

// The project's persisted agent threads, split into pinned + recent for the
// "recent conversations" block on the working-tree home. Reads real history on
const {
  pinned: pinnedSessions,
  recent: recentSessions,
  loading: sessionsLoading,
  togglePin: togglePinnedSession,
  archive: archiveSessionRow,
  remove: removeSessionRow,
} = useRecentSessions(() => props.project.path);

// Archiving/deleting a recent conversation drops it from the on-screen list and
// the store, but a thread that ran (or is running) this session also lives in
// the in-memory agent registry — where it keeps feeding the away-from-thread
// pill stack and stays clickable. Forget it there too so the pill can't outlive
// the row it came from.

/** A thread that must not be archived/deleted right now: a turn in flight, a
 *  parked approval/user-input, live spawned children. Forgetting it tears the
 *  session down mid-flight — killing the provider process and revoking its
 *  gateway token while children may still be running — so these paths refuse
 *  ever reaps idle sessions, never one with an active turn). */
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

/** Drop the board pane hosting a thread — the board hosts one pane per
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
  if (pane) void board.close(pane.id);
}

function archiveSession(threadId: string): void {
  if (sessionBusy(threadId)) {
    flashArchiveNotice(
      "This thread is still working — let it finish (or stop it) before archiving.",
    );
    return;
  }
  archiveSessionRow(threadId);
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
  removeSessionRow(threadId);
  void agent.forgetThread(threadId);
  closePaneHosting(threadId);
}

// Open a stored thread and reveal the chat the instant its transcript lands —
// the board owns the pane: open() dedupes (a thread already hosted — live or
// dormant — is focused, never duplicated), attaches and focuses the hosting
// pane, and only resolves after the transcript loads on the mint path. The old
// direct agent.openThread let the session be adopted as an unfocused column —
// the board flipped to a stale focus and the strip never scrolled to the new
// pane ("opened from nowhere"). Gating the surface flip on blocks still grows
// a populated thread (no flash of the empty state, no lingering on the
// working-tree home) with the chat-open entrance. Falls through to showing
// chat even on an empty/failed load.
async function revealThread(threadId: string): Promise<void> {
  const stop = watch(blocks, (b) => {
    if (b.length) {
      surface.value = "board";
      stop();
    }
  });
  try {
    await board.open("thread", { threadId });
  } finally {
    stop();
    surface.value = "board";
  }
}

// Bring a picked recent conversation on-screen and continue it under its own
// thread id. Best-effort on desktop; a no-op in browser dev (no live session).
function openSession(threadId: string): void {
  void revealThread(threadId);
}

// The catalog for each installed provider — its flat model list grouped into
// families with real efforts. The composer + picker drive everything off these;
// the raw id (which carries the effort) is what we send to the session.
const catalogs = ref<Partial<Record<ProviderKind, ModelOption[]>>>({});
// Mount seeds these from the disk snapshot so the picker is usable immediately;
// the live re-probe finishes a moment later and may correct a list (a CLI upgrade
// that added or dropped a model). Rebuild rather than leave the stale one on
// screen — the whole point of showing the snapshot early is that it converges.
watch(
  () => providers.modelCache.value,
  (raw) => {
    const next: Partial<Record<ProviderKind, ModelOption[]>> = {};
    for (const [provider, list] of Object.entries(raw)) {
      if (list?.length) next[provider as ProviderKind] = buildModelCatalog(list);
    }
    catalogs.value = { ...catalogs.value, ...next };
    // Reconcile the live pick. A refresh can drop the model the user is on (a
    // CLI upgrade retired it), and leaving a now-unknown id in place is exactly
    // the desync the desktop guards had to catch — clear it here so the composer
    // shows what will actually run. Mount does its own seeding, so only act once
    // the board is real.
    if (!boardReady.value) return;
    const current = agent.model.value;
    const options = catalogs.value[agent.provider.value] ?? [];
    if (!current || options.some((o) => o.efforts.some((e) => e.modelId === current))) return;
    const first = options[0];
    const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
    agent.setModel(eff ? eff.modelId : undefined);
  },
);
// The active provider's catalog feeds the composer's own model name + effort dial.
const modelOptions = computed(() => catalogs.value[agent.provider.value] ?? []);

// A model change on a provider that bakes model/effort at spawn (Claude,
// OpenCode, Antigravity — the effort rides the print `--model` label) can't
// apply to a running session — it needs a fresh one. Codex takes model/effort
// per turn, so it changes in place. Mirrors each adapter's `sessionModelSwitch`.
const RESTART_ON_MODEL_CHANGE = new Set<ProviderKind>(["claudeAgent", "opencode", "antigravity"]);
const PROVIDER_VENDOR: Record<ProviderKind, string> = { codex: "OpenAI", claudeAgent: "Anthropic", cursor: "Cursor", opencode: "OpenCode", droid: "Factory", antigravity: "Google" };
const PROVIDER_BRAND: Record<ProviderKind, BrandKey> = { codex: "codex", claudeAgent: "claude", cursor: "cursor", opencode: "opencode", droid: "droid", antigravity: "antigravity" };

// The provider + model + reasoning effort are remembered GLOBALLY — one app-wide
// "last used" choice that every project opens with (not per-project). The
// permission mode stays per-project (it's a per-repo trust decision).
const PROVIDER_KEY = "kone:provider";
const MODEL_KEY = "kone:model";
const REASONING_KEY = "kone:reasoning";
const MODE_KEY = `kone:mode:${props.project.path}`;
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
  return enabledReady.value.map((s) => {
    const models = (catalogs.value[s.provider] ?? []).filter((m) => visible(s.provider, m.key));
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

// Three views over the same page: the working tree ("overview"), the
// conversation ("board"), and the repository ("git"). Sending the first turn
// flips to the board; the corner glyphs move between overview and git.
const surface = ref<"overview" | "board" | "git">("overview");

/** Point agent.activeKey at the thread the composer is editing so setModel and
 *  friends land on the session the next send will use. No-ops until the board
 *  has restored — the immediate pre-mount sync used to miss the blank thread
 *  slot and sometimes left no live session at all after restore evicted the boot
 *  thread. */
let syncingComposerTarget: Promise<void> | null = null;
async function syncComposerTarget(): Promise<void> {
  if (syncingComposerTarget) return syncingComposerTarget;
  syncingComposerTarget = (async () => {
    // Wait rather than bail: bailing left agent.activeKey on the construction
    // boot session, so a send fired during the async mount ran on the pre-mount
    // `codex` default with whatever model localStorage restored.
    await whenBoardReady();
    if (focusedThread.value) {
      agent.focusThread(focusedThread.value.key);
      return;
    }
    if (surface.value !== "overview") return;

    let blank = blankThreadPane.value;
    // Same invariant as onSend: overview sends through the blank thread slot (or
    // mint one if the board has none yet). Materialise it here so model picks
    // aren't written to a boot session restore is about to evict.
    if (!blank) {
      await board.open("thread", { focus: false });
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
  () => surface.value === "board" && activePaneIsThread.value,
);
watch(
  [boardReady, composerVisible, focusedId, () => blankThreadPane.value?.session?.key],
  () => {
    if (boardReady.value && composerVisible.value) void syncComposerTarget();
  },
);

// A restored thread/terminal pane stays dormant while the overview is showing.
// Attach the focused pane (a terminal still waits until you look at it) and
// every stored thread once the board is revealed, so neighbouring columns
// show their transcripts instead of sitting on "Opening…".
watch(surface, (s, prev) => {
  if (s !== "board" || prev === "board") return;
  const id = focusedId.value;
  if (id) void board.attach(id);
  void board.wakeThreadPanes();
});

onMounted(resolveUser);
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
  // the stall between clicking a project and the board being usable. Kicked
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
  const savedBoardReady = boardStore.load();
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

  // Pick the provider to run: the last one used here (if still ready), else the
  // preferred order (Codex first for continuity), else whatever's ready.
  const saved = import.meta.client ? localStorage.getItem(PROVIDER_KEY) : null;
  const isReady = (p: string | null): p is ProviderKind =>
    Boolean(p) && readyProviders.some((s) => s.provider === p);
  const chosen: ProviderKind | undefined = isReady(saved)
    ? saved
    : readyProviders.find((s) => s.provider === "codex")?.provider
      ?? readyProviders.find((s) => s.provider === "opencode")?.provider
      ?? readyProviders[0]?.provider;
  // The scratchpad has to be hydrated before restore(), which eagerly attaches
  // the pad pane.
  await scratchpadReady;
  // Restore the persisted board on mount. A missing layout normalises to an empty
  // desktop so useAgent's construction spawn is evicted rather than adopted.
  const savedBoard = await savedBoardReady;
  const layout = savedBoard ?? { version: 1 as const, panes: [], focusedId: null };
  const knownThreadIds = await knownThreadIdsReady;
  // Land on the working-tree home unless we're resuming a specific thread.
  // Defer spawning the saved board's focused thread/terminal — openThread +
  // agent start on mount would queue behind that work and leave git + history
  // IPC stuck in the loading shell (greeting with no changes/sessions).
  await board.restore(layout, knownThreadIds, { deferHeavyAttach: !resume });
  if (resume) {
    // Launcher asked to resume a specific conversation. One open path for a
    // stored thread: board.open dedupes against live AND dormant panes (the
    // resume target is usually already restored as a pane — often the focused
    // one), focuses the hosting pane so the strip scrolls to it, or mints a
    // fresh pane bound to the id. The manual live/dormant check + split
    // focusThreadById/open call duplicated that logic and could leave the
    // board focused elsewhere. Either way we land on the board.
    await board.open("thread", { threadId: resume });
    surface.value = "board";
  }
  // Only now let layout changes persist — past this point the board reflects the
  // user's real arrangement, not the boot adopt.
  boardReady.value = true;
  await syncComposerTarget();

  // Seed provider/model/mode onto the composer target *after* restore + sync.
  // Doing this earlier wrote into the construction boot thread that restore often
  // evicts, which left overview model picks as no-ops until a board visit
  // attached a real session.
  if (!resume) {
    // The composer target exists by now (attach → newThreadAt) but is deferred —
    // no CLI has spawned, so setProvider here is the whole switch and the
    // restart below degrades to a re-defer. It stays because the target isn't
    // always blank: a restored board can hand us a live session, and there
    // setProvider only flips the ref while the running CLI keeps going, which is
    // how a Cursor model id used to ride a Codex session into the wrong adapter.
    const providerChanged = Boolean(chosen) && chosen !== agent.provider.value;
    if (chosen) agent.setProvider(chosen);

    // Validate unconditionally. This used to be gated behind `if (!model.value)`,
    // which skipped the catalog check whenever a model was already set — so a
    // model belonging to another provider (MODEL_KEY is global, not per-provider)
    // survived onto the chosen provider and reached its CLI verbatim.
    {
      const current = model.value;
      const owned = (id: string | null | undefined) =>
        Boolean(id) && modelOptions.value.some((o) => o.efforts.some((e) => e.modelId === id));
      const savedModel = import.meta.client ? localStorage.getItem(MODEL_KEY) : null;
      if (owned(current)) {
        // Already valid for this provider — leave the user's pick alone.
      } else if (owned(savedModel)) agent.setModel(savedModel!);
      else {
        const first = modelOptions.value[0];
        const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
        // No catalog to pick from (the provider's model probe failed or hasn't
        // landed) — clear rather than leave a foreign id in place. Keeping it was
        // how a Cursor `composer-*` id rode a Codex session all the way to the
        // CLI; undefined just means "provider default".
        agent.setModel(eff ? eff.modelId : undefined);
      }
    }
    if (import.meta.client) {
      const savedReasoning = localStorage.getItem(REASONING_KEY);
      if (savedReasoning && savedReasoning in EFFORT_META) {
        const fam = familyForId(modelOptions.value, model.value);
        const eff = effortForTier(fam, savedReasoning as EffortTier);
        if (eff) agent.setReasoning(eff.tier);
      }
    }
    if (import.meta.client) {
      const savedMode = localStorage.getItem(MODE_KEY);
      if (savedMode && (MODES as string[]).includes(savedMode)) {
        agent.setMode(savedMode as InteractionMode);
      }
    }
    // Re-spawn on the provider we actually settled on, mirroring what the model
    // picker does (applyModelEffort → restart when the provider changes). The
    // thread is blank at this point, so nothing is lost.
    if (providerChanged) await agent.restart();
  }
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

// Persist the permission mode per project.
watch(mode, (m) => {
  if (import.meta.client) localStorage.setItem(MODE_KEY, m);
});

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
  () => board.focusedId,
  () => {
    modelPickerOpen.value = false;
  },
);

// ── project switching ─────────────────────────────────────────────────────────
// The switcher opens from the greeting: click the folder+name to reveal the
// *other* recent projects as small live folders; picking one swaps the active
// project. Because <ProjectView> is keyed on project.path, setting it here
// remounts the page with a fresh git + agent session rooted in the new directory.
const { recents, byRecency } = useRecentProjects();
const openProject = useOpenProject();
const otherProjects = computed<RecentProject[]>(() =>
  recents.value.filter((p) => p.path !== props.project.path),
);
// The Ctrl+Tab cycle is an Alt+Tab-style toggle, so it ignores pins and uses a
// pure most-recently-used order: the project you were just on is always index 1,
// which is what makes a single tap flip between your two most-recent projects.
const cycleProjects = computed<RecentProject[]>(() =>
  byRecency.value.filter((p) => p.path !== props.project.path),
);

// The greeting popover — click-toggled, closes on Esc / outside click.
const switcherOpen = ref(false);
const greetWrap = ref<HTMLElement | null>(null);
onClickOutside(greetWrap, () => (switcherOpen.value = false));

function switchTo(p: RecentProject) {
  switcherOpen.value = false;
  if (p.path === props.project.path) return;
  cue("press");
  // A turn in flight would be torn down by the remount anyway — stop it cleanly
  // first so the provider isn't left mid-stream.
  if (busy.value) void agent.interrupt();
  openProject({ path: p.path, name: p.name });
}

// ── Ctrl+Tab cycling ─────────────────────────────────────────────────────────
// Hold Ctrl, tap Tab to step through the same recents list the greeting switcher
// shows (Shift+Tab steps backward); the project itself sits at index 0 so a
// light tap-and-release lands back on a no-op. Releasing Ctrl commits through
// the same switchTo the click path uses — same busy-interrupt, same cue.
type CycleEntry = { path: string; name: string; isSelf: boolean };
const cycling = ref(false);
const cycleIndex = ref(0);
const cycleEntries = ref<CycleEntry[]>([]);

function stepCycle(forward: boolean) {
  const n = cycleEntries.value.length;
  if (!n) return;
  cycleIndex.value = ((cycleIndex.value + (forward ? 1 : -1)) % n + n) % n;
}

function startCycle(forward: boolean) {
  const entries: CycleEntry[] = [
    { path: props.project.path, name: props.project.name, isSelf: true },
    ...cycleProjects.value.map((p) => ({ path: p.path, name: p.name, isSelf: false })),
  ];
  if (entries.length < 2) return; // nothing else to switch to — don't open the HUD for a no-op
  cycleEntries.value = entries;
  cycleIndex.value = 0;
  cycling.value = true;
  stepCycle(forward);
}

function commitCycle() {
  const chosen = cycleEntries.value[cycleIndex.value];
  cycling.value = false;
  cycleEntries.value = [];
  if (!chosen || chosen.isSelf) return;
  const p = cycleProjects.value.find((o) => o.path === chosen.path);
  if (p) switchTo(p);
}

function cancelCycle() {
  cycling.value = false;
  cycleEntries.value = [];
}

// The project cycler's bindings live in the shortcuts registry (see
// useShortcuts), so a rebind in settings flows through here automatically. The
// cycle is a hold-and-tap gesture like Alt+Tab, so we keep the bare-Tab +
// bare-Control keyup tests below; only the *modifier+Tab* opener consults the
// registry — Shift direction is read off the press itself.
const {
  matchesShortcut,
  matchesShortcut: matchesCycle,
  bindingModsFor,
  isMacPlatform,
} = useShortcuts();

function cycleBindingMods() {
  return bindingModsFor("cycle-projects");
}

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && cycling.value) {
    e.preventDefault();
    cancelCycle();
    return;
  }
  if (!matchesCycle("cycle-projects", e)) return;
  e.preventDefault();
  if (!cycling.value) startCycle(!e.shiftKey);
  else stepCycle(!e.shiftKey);
});
// Ctrl release commits — mirrors a held app-switcher, not a click-to-toggle menu.
useEventListener(window, "keyup", (e: KeyboardEvent) => {
  if (!cycling.value) return;
  // Commit when the modifier that opens the cycle is released. For a "mod"
  // binding that's Meta on macOS / Control elsewhere; for an explicit "ctrl"
  // binding it's Control. Releasing Shift alone (a cycle direction change, not
  // the commit modifier) must not commit.
  const bindingMods = cycleBindingMods();
  const releaseKey =
    bindingMods.includes("mod")
      ? isMacPlatform() ? "Meta" : "Control"
      : bindingMods.includes("ctrl")
        ? "Control"
        : null;
  if (releaseKey && e.key === releaseKey) commitCycle();
});
// If the window loses focus mid-hold (e.g. an OS-level app switch), abandon the
// cycle instead of leaving it stuck open with no keyup to close it.
useEventListener(window, "blur", () => {
  if (cycling.value) cancelCycle();
});

// mod+b opens the board surface from the working-tree home — the strip is always
// mounted but hidden on overview, so this is a pure surface flip with no new
// panes. Only fires while overview is showing so mod+b in a scratchpad still
// bolds; once you're on the board the chord is a no-op.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("open-board", e)) return;
  if (surface.value !== "overview" || activeFile.value) return;
  e.preventDefault();
  cue("press");
  surface.value = "board";
});

// Ctrl+N (mod+n) starts a fresh, empty thread — the keyboard way to begin a
// conversation from the working-tree home now that the composer lives on the
// board. It flips to the board surface so the user lands in the blank thread,
// and prunes the idle previous thread when it never ran a live turn.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-thread", e)) return;
  e.preventDefault();
  void board.open("thread");
  surface.value = "board";
});

// mod+shift+t opens a terminal column on the strip and focuses it, flipping to
// the board surface (where the strip lives) so the new shell is on screen.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-terminal", e)) return;
  e.preventDefault();
  surface.value = "board";
  void newTerminalPane();
});

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-scratchpad", e)) return;
  e.preventDefault();
  surface.value = "board";
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
  void board.dispatch({ type: "capture-text", text, from: sourceKey });
});

// Play a scripted demo conversation so the whole thread UI (thinking, tools
// with output, streaming text, a no-content thought, the settled footer) can be
// reviewed on demand without driving a real agent turn. The binding lives in
// the shortcuts registry so it can be rebound in settings.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("play-demo", e)) return;
  e.preventDefault();
  surface.value = "board";
  agent.demo();
});

// "All projects" backs out to the launcher — the same exit the folder's close
// gives, so the switcher and the back control agree.
function toLauncher() {
  switcherOpen.value = false;
  emit("close");
}

// The corner back arrow steps out one layer at a time: from the conversation or
// the repository it returns to the project's working tree (both stay put); from
// there it leaves for the launcher. It's away whenever a surface draws its own
// return glyph — the file detail, a commit, a pull request — so it never has to
// answer for a layer it can't see.
function onBack() {
  if (surface.value === "board" || surface.value === "git") {
    surface.value = "overview";
    return;
  }
  toLauncher();
}
const backIsAway = computed(() => Boolean(activeFile.value) || gitDepth.value > 0);

// ── the repository surface ────────────────────────────────────────────────────
// Mounted on first entry and kept for the project's lifetime: its lists (history
// pages, branches, pull requests) are worth holding on to across a step back to
// the working tree, but none of it should cost anything on project open.
const gitMounted = ref(false);
/** How deep into a commit or pull request the space is; those views draw their
 *  own return glyph, so the corner arrow gets out of their way. */
const gitDepth = ref(0);
function openGitSpace() {
  if (!g.repo.value) return;
  cue("press");
  gitMounted.value = true;
  surface.value = "git";
  void space.load();
}

// ── the centre nav ──────────────────────────────────────────────────────────
// The one row the back arrow and the profile chip already bookend gains a middle:
// a name per space this project has — its working tree, and the repository
// underneath. It rides the same fixed top line and steps out of the way (like
// the back arrow) whenever a sub-surface draws its own chrome.
const NAV = [
  { id: "overview", label: "Project" },
  { id: "git", label: "Git" },
] as const;
const navIndex = computed(() => NAV.findIndex((n) => n.id === surface.value));
function goSurface(target: (typeof NAV)[number]["id"]) {
  if (target === surface.value) return;
  if (target === "git") {
    openGitSpace();
    return;
  }
  cue("press");
  surface.value = target;
}

// Hovering the corner folder fans its peeking papers up out of the pocket.
const folderHovered = ref(false);
const { reveal } = useReveal();
function onRevealProject() {
  void reveal(props.project.path);
}

// ── switch branch ─────────────────────────────────────────────────────────────
// The corner folder's other action (git projects only): move the working tree to
// another local branch. The trigger opens the branch picker in the same scrim +
// elastic-card shell the folder/model pickers use; the picker checks the branch
// out itself and awaits g.refresh() (passed below) before it leaves, so the new
// branch's changes are already folded into the greeting, the changes header and
// the folder by the time it reports `switched`.
const branchPickerOpen = ref(false);

function openBranchPicker() {
  branchPickerOpen.value = true;
}
function onBranchSwitched() {
  // The picker already awaited g.refresh() before it closed (so the new branch's
  // changes are already on screen) — just chime and dismiss.
  cue("toggle");
  branchPickerOpen.value = false;
}
// The full picker and the composer's inline effort cycle both know the exact
// tier they picked — set it directly rather than relying on the model watcher,
// which only re-fires when the *modelId* changes and stays silent when cycling
// effort within a family (every rung there shares one modelId).
//
// A pick can also switch providers (Codex → Claude): those are separate CLIs
// with no shared session, so the change is applied and the session restarted on
// the new engine. A same-provider model change on a spawn-fixed provider (Claude)
// also needs a restart — its model/effort are baked when the SDK process spawns.
// Codex changes ride the next turn in-session, no restart.
type ModelPick = { provider: ProviderKind; modelId: string; tier: EffortTier; fastMode: boolean; contextWindow?: string };

/** Persist the active thread's committed picker selection — model, effort,
 *  service tier, context window — so a reopened thread restores exactly what
 *  the picker showed (useAgent's adoptStoredThread reads it back). Fire-and-
 *  forget; the store no-ops when the thread row doesn't exist yet (a blank
 *  thread mints its conversation id on first send; its selection lands then).
 *  The bridge is store-owned; guarded at runtime for browser dev. */
function persistThreadSelection(): void {
  if (!import.meta.client) return;
  const threadId = agent.threadId.value;
  if (!threadId) return;
  // The bridge is store-owned; guarded at runtime for browser dev (no bridge).
  void window.koneDesktop?.agent?.setThreadSelection?.(threadId, {
    model: agent.model.value,
    effort: agent.reasoning.value,
    serviceTier: agent.serviceTier.value,
    contextWindow: agent.contextWindow.value,
  })
    .catch(() => {
      // best-effort persistence — a failed write never disturbs the picker.
    });
}

async function applyModelEffort(picked: ModelPick) {
  await syncComposerTarget();
  const providerChanged = picked.provider !== agent.provider.value;
  const modelChanged = picked.modelId !== model.value;
  if (providerChanged) agent.setProvider(picked.provider);
  agent.setModel(picked.modelId);
  agent.setReasoning(picked.tier);
  const fam = familyForId(catalogs.value[picked.provider] ?? [], picked.modelId);
  agent.setServiceTier(picked.fastMode ? fam?.fastTier?.id : undefined);
  // Honor the picker's context-window choice when the family offers one (it's
  // the auto-compact window, applied per turn — no restart). setModel above may
  // have re-seeded it via the model watcher; this pins the user's explicit pick.
  if (fam?.contextWindows?.length) {
    agent.setContextWindow(
      picked.contextWindow ?? fam.contextWindows.find((w) => w.isDefault)?.id ?? fam.contextWindows[0]!.id,
    );
  }

  // Persist the (global) provider whenever it changes — model + reasoning ride
  // along via their own watchers.
  if (import.meta.client && providerChanged) localStorage.setItem(PROVIDER_KEY, picked.provider);

  const needsRestart = providerChanged || (RESTART_ON_MODEL_CHANGE.has(picked.provider) && modelChanged);
  if (needsRestart) {
    // A turn in flight is torn down by the restart — stop it cleanly first.
    if (busy.value) await agent.interrupt();
    await agent.restart();
  }
  // Persist after any restart: a provider switch re-mints the thread id, and
  // the selection must be recorded against the id the thread now carries.
  persistThreadSelection();
}
function onModelSelect(picked: ModelPick) {
  void applyModelEffort(picked);
  modelPickerOpen.value = false;
  cue("toggle");
}
// The composer's inline fast-mode toggle acts on the CURRENT model only — it
// doesn't change modelId/tier, just whether that model's real "fast" tier is
// applied on the next turn.
const fastActive = computed(() => Boolean(serviceTier.value));
function onUpdateFastMode(on: boolean) {
  void syncComposerTarget().then(() => {
    const fam = familyForId(modelOptions.value, model.value);
    agent.setServiceTier(on ? fam?.fastTier?.id : undefined);
    persistThreadSelection();
  });
}
function onComposerModelId(id: string) {
  void syncComposerTarget().then(() => {
    agent.setModel(id);
    persistThreadSelection();
  });
}
function onComposerReasoning(tier: EffortTier) {
  void syncComposerTarget().then(() => {
    agent.setReasoning(tier);
    persistThreadSelection();
  });
}
function onComposerContextWindow(id: string) {
  void syncComposerTarget().then(() => agent.setContextWindow(id));
}
function onComposerMode(next: InteractionMode) {
  void syncComposerTarget().then(() => agent.setMode(next));
}

async function onSend(text: string, files?: File[]) {
  // The composer only docks under a focused thread pane on the board, so the
  // send target is that focused thread. Settle it first: never send on top of
  // the pre-mount boot session — it carries the hardcoded `codex` default and
  // rehydrates the project's LAST stored thread on its first start(), which
  // silently replaces the composer's provider/model and resumes a foreign
  // conversation id. Settling the target first is what makes the model shown
  // in the composer the model that actually runs.
  await syncComposerTarget();
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

// Last path segment, tolerant of a trailing slash (a directory entry) so it
// never yields an empty name.
function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function isNew(status: GitFileStatus): boolean {
  return status === "added" || status === "untracked";
}

const changeItems = computed<ChangeItem[]>(() =>
  g.changes.value.map((c) => ({
    path: c.path,
    name: basename(c.path),
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    staged: c.staged,
    isNew: isNew(c.status),
    deleted: c.status === "deleted",
  })),
);

// The file whose detail is open, tracked by path so it survives a staging flip
// (the item is re-derived from live data). It self-closes when the file leaves
// the working tree — discarded, or swept away by a commit.
const activePath = ref<string | null>(null);
// The clicked card's viewport rect — the detail grows out of it.
const originRect = ref<DOMRect | null>(null);
const activeFile = computed(
  () => changeItems.value.find((c) => c.path === activePath.value) ?? null,
);
// The right-hand "peek" drawer — opened by a lane's +N bundle. The stage slides
// left to uncover it (the same spring the settings drawer's stage rides, so the
// two reveals share a feel); picking a file closes it and opens that file's
// detail instead, so the full-screen detail always owns the viewport when it's
// up. The slide stops just short of the panel's width so the page's rounded
// corners overlap the panel's own padding — the arc then reads against the
// panel's sunken surface instead of the page's ground.
const peekOpen = ref(false);
const peekSpring = {
  type: "spring",
  stiffness: 520,
  damping: 26,
  mass: 0.8,
} as const;
// Self-close when the file leaves the tree; lock the page while the overlay is
// up so only the file's own body scrolls.
function lockPage(locked: boolean) {
  if (import.meta.client) {
    document.documentElement.style.overflow = locked ? "hidden" : "";
  }
}
watch(activeFile, (f) => {
  if (activePath.value && !f) activePath.value = null;
  lockPage(Boolean(f));
});
onBeforeUnmount(() => {
  lockPage(false);
  // Flush the layout past the debounce — a project switch or window close must
  // not drop the last few gestures.
  if (boardReady.value) boardStore.flush(board.serialize());
});
// A hard window close (quit) skips onBeforeUnmount, so persist on beforeunload too.
useEventListener(window, "beforeunload", () => {
  if (boardReady.value) boardStore.flush(board.serialize());
});
// pagehide covers the bfcache / webview teardown paths where beforeunload can
// be skipped — same synchronous write-through of the last layout.
useEventListener(window, "pagehide", () => {
  if (boardReady.value) boardStore.flush(board.serialize());
});
// beforeunload is unreliable on macOS app-hide / Space switches and never fires
// when the OS suspends the renderer. So also flush — synchronously, past the
// 400ms debounce — the moment the window loses focus or the tab is hidden. Both
// are cheap idempotent writes of the same serialized layout, so firing them
// often (and alongside beforeunload) is harmless; missing the last gesture isn't.
function flushBoard(): void {
  if (boardReady.value) boardStore.flush(board.serialize());
}
useEventListener(window, "blur", flushBoard);
useEventListener(document, "visibilitychange", () => {
  if (document.visibilityState === "hidden") flushBoard();
});

// Wake the composer when a blank thread becomes active in chat — new thread,
// seam insert, or closing the last column all land here. Watching activeKey (not
// a bare empty-blocks check) so closing the orb on an empty thread stays closed.
// (composerRef itself is declared up by the board so board.dispatch can pre-fill
// the composer for the draft-thread intent.)
watch(
  [surface, focusedId, blocks, busy, activePaneIsThread],
  () => {
    if (surface.value !== "board" || activeFile.value || !activePaneIsThread.value) return;
    if (blocks.value.length === 0 && !busy.value) {
      void composerRef.value?.wake();
    }
  },
);

// ── away-from-thread status pills ────────────────────────────────────────────────
// A project can have several threads live at once. Any thread whose live (or
// just-settled) turn is off-screen rides a dynamic-island pill in the corner —
// stacked, one per thread. A running thread always shows while you're away; a
// finished reply waits there until you open it, at which point it's "seen" and
// steps aside. The thread you're actually viewing in chat never pills.

// The turn you've last seen for each thread (recorded while it's on-screen in
// chat) — a settled reply you've already read won't re-pill after you leave.
const seenTurns = ref<Record<string, string>>({});
watch(
  // A cheap per-thread signature — id + current turn id + state — not a deep
  // walk of every thread's whole block tree. This watcher only cares whether a
  // turn changed identity or settled, and that's all this string tracks; a deep
  // watch re-ran it on every streamed token for no gain. (E1)
  [surface, () => agent.threads.value.map((t) => `${t.threadId}:${t.block?.turnId ?? ""}:${t.block?.state ?? ""}`).join("|")],
  () => {
    if (surface.value !== "board") return;
    // The strip puts EVERY live thread on screen, not just one, so every thread
    // is "seen" while it's up — otherwise stepping back to the working-tree home
    // would raise a pill for each column you'd been watching all along.
    //
    // Only mark a turn seen once it's settled. Marking it seen the instant its
    // running block appears means a reply that finishes *after* the user steps
    // away never re-pills (its turnId never changes), so the completion goes
    // unannounced. Waiting for the settled state keeps the on-screen case honest
    // (it settles under the user's eyes) while still pilling an away-completion.
    const seen = { ...seenTurns.value };
    let touched = false;
    for (const t of agent.threads.value) {
      if (t.block && t.block.state !== "running" && seen[t.threadId] !== t.block.turnId) {
        seen[t.threadId] = t.block.turnId;
        touched = true;
      }
    }
    if (touched) seenTurns.value = seen;
  },
);

// Pills the user has waved away, per thread → the turn they dismissed. Unlike
// `seenTurns` this also silences a *running* turn: you've said you don't want to
// be told about this one. The thread's next turn mints a new id, so a dismissal
// never permanently mutes a conversation.
const dismissedTurns = ref<Record<string, string>>({});

function onDismissThread(threadId: string, turnId: string) {
  cue("press");
  dismissedTurns.value = { ...dismissedTurns.value, [threadId]: turnId };
  seenTurns.value = { ...seenTurns.value, [threadId]: turnId };
}

// The pill stack: off-screen threads with a live-or-unseen turn, oldest first so
// the newest sits closest to the corner. Behind the file-detail overlay they all
// step aside, returning the moment it closes.
const pillThreads = computed(() => {
  if (activeFile.value) return [];
  // On the strip every live thread is already a column you can see, so a pill
  // would only duplicate it — a thread working off the edge of the viewport
  // announces itself by pulsing its dash in the strip's column indicator
  // instead. Pills are for the working-tree home, where no thread is on screen —
  // and the repository surface is its own world, so they step aside there too.
  if (surface.value !== "overview") return [];
  return agent.threads.value
    .filter((t) => {
      if (!t.everRan || !t.block) return false;
      if (dismissedTurns.value[t.threadId] === t.block.turnId) return false;
      const running = t.block.state === "running";
      const unseen = seenTurns.value[t.threadId] !== t.block.turnId;
      return running || unseen;
    })
    .map((t) => ({
      key: t.key,
      threadId: t.threadId,
      title: t.title,
      brand: sessionBrand(t.provider, SESSION_BRAND[t.provider] ?? "generic", t.model),
      block: t.block,
      turnId: t.block?.turnId ?? "",
      task: t.task,
    }))
    .sort((a, b) => (a.block?.at ?? 0) - (b.block?.at ?? 0));
});

function onOpenThread(threadId: string) {
  cue("press");
  // The pill's thread is usually already a pane (adopted while it ran); focus it.
  // If it was evicted since, open a fresh pane bound to its id — board.open's
  // thread adapter reloads its transcript through agent.openThread.
  const existing = panes.value.find(
    (p) => p.kind === "thread" && p.session?.threadId.value === threadId,
  );
  if (existing) board.focus(existing.id);
  else void board.open("thread", { threadId });
  // Mark its current turn seen so it won't linger as a pill once we step away —
  // but only if it's already settled. Marking a still-running turn seen would
  // suppress its completion pill if the user opens the pill and leaves before it
  // finishes (the settled-only watcher can't undo a premature seen). While it's
  // running and on screen the watcher marks it seen the moment it settles.
  const t = agent.threads.value.find((x) => x.threadId === threadId);
  if (t?.block && t.block.state !== "running") {
    seenTurns.value = { ...seenTurns.value, [threadId]: t.block.turnId };
  }
  surface.value = "board";
}

// Preload the highlighter grammars for the file types in this project's changes
// (plus the engine + themes) the moment they're known — so the first file the
// user opens paints instantly, with no on-demand load.
watch(
  changeItems,
  (items) => {
    if (items.length) void warm(items.map((c) => c.path));
  },
  { immediate: true },
);

const folderFiles = computed<FolderFile[]>(() =>
  g.changes.value.slice(0, 3).map((c) => ({
    change: c.status === "deleted" ? "deleted" : isNew(c.status) ? "new" : "edit",
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    name: c.path,
  })),
);

// ── action handlers — mutate the model, then sound the gesture ────────────────
function onStageAll() {
  cue("toggle");
  g.stageAll();
}
function onUnstageAll() {
  cue("toggle");
  g.unstageAll();
}
// Discard is hold-to-confirm (HoldToConfirm) in the Changed lane — by the time
// this fires the user has held through the confirm, so no modal interrupts.
// (ChangesPanel already sounds the gesture.)
function onDiscardPaths(paths: string[]) {
  g.discardPaths(paths);
}
// Discard from the peek covers every unstaged change — the same scope as the
// Changed lane's own discard, just reachable from the all-files drawer.
function onPeekDiscard() {
  onDiscardPaths(changeItems.value.filter((c) => !c.staged).map((c) => c.path));
}
function onCommit() {
  cue("success");
  g.commit();
}

// ── file detail ───────────────────────────────────────────────────────────────
// A file opened from the repository surface reuses the working tree's own detail
// overlay — one diff viewer for the whole app. It grows from the clicked row
// when the space hands us its rect, and from nothing when it can't.
function onOpenFileFromGit(path: string, rect: DOMRect | null) {
  cue("press");
  originRect.value = rect;
  activePath.value = path;
}
function onOpenFile(item: ChangeItem, rect: DOMRect) {
  cue("press");
  // Picked from the peek: slide the stage back and grow the detail from the row.
  peekOpen.value = false;
  originRect.value = rect;
  activePath.value = item.path;
}
// Opening the peek from a lane's +N bundle — the stage steps aside for the list.
function openPeek() {
  cue("press");
  peekOpen.value = true;
}
function onCloseFile() {
  activePath.value = null;
}
// Esc backs out of whatever is frontmost: the detail view, then the peek, then
// an open switcher. (The peek also owns its own Esc — this is the same step.)
onKeyStroke("Escape", () => {
  if (activePath.value) {
    onCloseFile();
    return;
  }
  if (peekOpen.value) {
    peekOpen.value = false;
    cue("toggle");
    return;
  }
  // The branch picker owns its own Escape (it's a modal); nothing to do here.
  if (switcherOpen.value) switcherOpen.value = false;
});
// The peek belongs to the working-tree home; step it aside when the surface
// changes so a slid-aside stage never hangs over the board or repository.
watch(surface, (s) => {
  if (s !== "overview") peekOpen.value = false;
});
function onStageFile(path: string) {
  cue("toggle");
  g.stagePaths([path]);
}
function onUnstageFile(path: string) {
  cue("toggle");
  g.unstagePaths([path]);
}
// Discarding from the detail closes it — the file's gone; the auto-close watcher
// also covers it, but clearing here avoids a frame of stale content.
function onDiscardFile(path: string) {
  cue("press");
  g.discardPaths([path]);
  activePath.value = null;
}
</script>

<template>
    <motion.main
    class="project-main relative bg-ground"
    :class="{ 'project-main--peek': peekOpen }"
    :animate="{ x: peekOpen ? -342 : 0 }"
    :transition="peekSpring"
  >
  <!-- Transient archive-refusal notice — a thread that is still working can't
       be archived/deleted, and the row not disappearing needs an explanation.
       Rendered above every surface (board + overview both archive) until it
       auto-dismisses. -->
  <Transition name="archive-notice">
    <div v-if="archiveNotice" class="archive-notice" role="status">
      <HugeiconsIcon :icon="InformationSquareIcon" :size="15" :stroke-width="2" aria-hidden="true" />
      <span>{{ archiveNotice }}</span>
    </div>
  </Transition>

  <!-- While the peek is open, tapping the shoved-aside stage closes it (and
       blocks the working tree underneath from being clicked) — the same
       gesture as the settings drawer on the launcher. The file detail never
       rides this overlay: picking a file closes the peek first. -->
  <button
    v-if="peekOpen && !activeFile"
    type="button"
    class="peek-dismiss absolute inset-0 z-50 cursor-pointer"
    aria-label="Close changed files"
    @click="peekOpen = false"
  />

    <!-- Back to the launcher — a bare return glyph in the corner, on the same
         magnet-pull the app's other buttons ride, lighting up to the accent
         on hover. It steps aside for any surface that draws its own: the
         file-detail overlay covers it, and a commit or pull request — which puts
         the same glyph beside its own title — fades it out rather than stand as
         a second, identical arrow across the page from the first. -->
    <Magnet
      class="project-back-magnet"
      inner-class="w-fit"
      :padding="12"
      :magnet-strength="9"
      :disabled="backIsAway"
      active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
      inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
    >
      <motion.button
        type="button"
        class="project-back"
        :inert="backIsAway"
        :aria-label="
          surface === 'board' || surface === 'git' ? 'Back to project' : 'Back to projects'
        "
        :initial="{ opacity: 0, x: -6 }"
        :animate="gitDepth > 0 ? { opacity: 0, x: -6 } : { opacity: 1, x: 0 }"
        :transition="{ duration: 0.3 }"
        @click="onBack"
      >
        <HugeiconsIcon
          class="back-glyph"
          :icon="ArrowTurnBackwardIcon"
          :size="18"
          :stroke-width="2"
          aria-hidden="true"
        />
      </motion.button>
    </Magnet>

    <!-- The centre of that same top row: the two layers, named. A borderless
         rail with one soft pill that slides between them (arithmetic, not
         measurement — the segments are equal-width). It steps aside with the back
         arrow whenever a sub-surface draws its own chrome. Git is dimmed and
         unclickable when the project isn't a repository. -->
    <nav
      class="project-nav"
      :class="{ 'project-nav--away': backIsAway || surface === 'board' }"
      :inert="backIsAway || surface === 'board'"
      aria-label="Project sections"
    >
      <i class="project-nav__mark" :style="{ '--at': navIndex }" aria-hidden="true" />
      <button
        v-for="n in NAV"
        :key="n.id"
        type="button"
        class="project-nav__row"
        :class="{ 'project-nav__row--on': surface === n.id }"
        :disabled="n.id === 'git' && !g.repo.value"
        :aria-current="surface === n.id ? 'page' : undefined"
        @click="goSurface(n.id)"
      >
        {{ n.label }}
      </button>
    </nav>

    <!-- The far-right end of that same top row: the signed-in user's profile
         chip, mirroring the back arrow across the page. It rides the same fixed
         top line and steps aside with the rest of the chrome whenever a
         sub-surface takes over. Only shown once a machine name resolves — when
         nobody's signed in there's nothing to draw. -->
    <Transition name="project-avatar">
      <button
        v-if="displayName && !backIsAway && surface !== 'board'"
        type="button"
        class="project-avatar"
        :title="displayName"
        :aria-label="`Open profile — ${displayName}`"
        @click="emit('profile')"
      >
        <span class="project-avatar__chip">{{ initial }}</span>
      </button>
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
      class="surface-layer surface-layer--board"
      :class="{ 'surface-layer--hidden': surface !== 'board' }"
      :inert="surface !== 'board' || Boolean(activeFile)"
      :aria-hidden="surface !== 'board' ? 'true' : undefined"
    >
      <ThreadStrip
        :panes="panes"
        :focused-id="focusedId ?? ''"
        :now="agentNow"
        :pulse-key="pulseScratchpadKey"
        :inert="Boolean(activeFile)"
        :visible="surface === 'board'"
        :chooser="showChooser"
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
    <SelectionActions
      v-if="surface === 'board' && !activeFile && focusedThread"
      :focused-pane-id="focusedId ?? ''"
      @dispatch="board.dispatch"
    />

    <!-- OVERVIEW · the working-tree home. The page holds the viewport — greeting
         + changes stay fixed and only the conversation listing scrolls. Also a
         permanently-mounted layer (hidden with `visibility`); while the detail
         overlay is open the page behind is inert — no tab stops, no
         screen-reader reach; the overlay owns focus. -->
    <div
      class="surface-layer surface-layer--overview"
      :class="{ 'surface-layer--hidden': surface !== 'overview' }"
      :inert="surface !== 'overview' || Boolean(activeFile)"
      :aria-hidden="surface !== 'overview' ? 'true' : undefined"
    >
      <div class="flex h-full min-h-0 w-full max-w-4xl flex-col gap-11">
      <!-- Greeting + changes stay put at the top; only the conversation listing
           below scrolls, so the page itself never moves. -->
      <div class="flex shrink-0 flex-col gap-11">
        <!-- The greeting's project name doubles as a switcher trigger; the popover
             drops just beneath it, anchored to the name. -->
        <div ref="greetWrap" class="relative w-fit">
          <HomeGreeting
            :project-name="project.name"
            :loading="!g.loaded.value"
            :repo="g.repo.value"
            :has-commits="g.hasCommits.value"
            :branch="g.branch.value"
            :clean="g.clean.value"
            :added="g.added.value"
            :removed="g.removed.value"
            :file-count="g.fileCount.value"
            :staged="g.stagedCount.value"
            :ahead="g.ahead.value"
            :behind="g.behind.value"
            switchable
            @switch="switcherOpen = !switcherOpen"
            @profile="emit('profile')"
          />
          <AnimatePresence>
            <ProjectSwitcher
              v-if="switcherOpen"
              class="greet-switcher"
              :projects="otherProjects"
              @switch="switchTo"
              @all="toLauncher"
            />
          </AnimatePresence>
        </div>
        <ChangesPanel
          :loading="!g.loaded.value"
          :repo="g.repo.value"
          :branch="g.branch.value"
          :added="g.added.value"
          :removed="g.removed.value"
          :changes="changeItems"
          @stage-all="onStageAll"
          @unstage-all="onUnstageAll"
          @commit="onCommit"
          @discard-paths="onDiscardPaths"
          @open="onOpenFile"
          @peek="openPeek"
        />
      </div>
      <!-- Recent conversations — the project's pinned + recent agent threads,
           each a vendor mark + title, meta line, and token tally. This is the
           one scroll region on the working-tree home; its PINNED / RECENT labels
           stick as the rows scroll under them. -->
      <div class="work-sessions min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6">
        <RecentSessions
          :pinned="pinnedSessions"
          :recent="recentSessions"
          :loading="sessionsLoading"
          @open="openSession"
          @pin="togglePinnedSession"
          @archive="archiveSession"
          @delete="removeSession"
        />
      </div>
      </div>
    </div>

    <!-- GIT · the repository. Unlike the other two layers this one is mounted on
         first entry rather than on project open — nothing in it belongs on the
         critical path — but once mounted it stays, so a paged history and a
         loaded pull-request list survive a step back to the working tree. -->
    <div
      v-if="gitMounted"
      class="surface-layer surface-layer--git"
      :class="{ 'surface-layer--hidden': surface !== 'git' }"
      :inert="surface !== 'git' || Boolean(activeFile)"
      :aria-hidden="surface !== 'git' ? 'true' : undefined"
    >
      <GitSpace
        :project="project"
        :space="space"
        :git="g"
        :visible="surface === 'git'"
        @open-file="onOpenFileFromGit"
        @detail-depth="gitDepth = $event"
      />
    </div>

    <!-- The folder settles into the corner last — rising into place with a soft
         spring, the physical grace note after the greeting, changes, and
         sessions have landed. (Home only — it steps aside once the conversation
         takes over.) -->
    <motion.div
      v-if="surface === 'overview'"
      class="project-folder-row absolute bottom-10 left-10 flex flex-col-reverse items-center gap-6"
      :inert="Boolean(activeFile)"
      :initial="{ opacity: 0, y: 44, scale: 0.94 }"
      :animate="{ opacity: 1, y: 0, scale: 1 }"
      :transition="{ type: 'spring', stiffness: 260, damping: 24, mass: 0.9, delay: 0.33 }"
      @mouseenter="folderHovered = true"
      @mouseleave="folderHovered = false"
    >
      <div class="project-folder">
        <ProjectFolder
          :name="project.name"
          :repo="g.repo.value"
          :branch="g.branch.value"
          :added="g.added.value"
          :removed="g.removed.value"
          :files="folderFiles"
          :scale="1.15"
          :hovered="folderHovered"
        />
      </div>

      <div class="folder-actions" :class="{ 'is-visible': folderHovered || branchPickerOpen }">
        <button
          v-if="g.repo.value"
          type="button"
          class="folder-action"
          :class="{ 'is-active': branchPickerOpen }"
          aria-label="Switch branch"
          title="Switch branch"
          @click="openBranchPicker"
        >
          <HugeiconsIcon :icon="GitBranchIcon" :size="15" :stroke-width="1.7" aria-hidden="true" />
          <span>Switch branch</span>
        </button>

        <button
          type="button"
          class="folder-action"
          aria-label="Reveal in Finder"
          title="Reveal in Finder"
          @click="onRevealProject"
        >
          <HugeiconsIcon :icon="AppleFinderIcon" :size="15" :stroke-width="1.7" aria-hidden="true" />
          <span>Open in Finder</span>
        </button>
      </div>
    </motion.div>

    <!-- The agent composer docks dead-centre at the bottom of the BOARD, under
         a focused thread pane — dormant until you wake it, then it stretches
         into the input. It stays docked to the viewport while the column behind
         scrolls. It no longer appears on the working-tree home: that page is the
         project's dashboard, and conversation starts on the board (mod+b, mod+n,
         or opening a session). Entering the strip's overview takes it away; fade
         rather than cut, so it doesn't blink out from under the cursor while the
         board behind it is still gliding back. -->
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="!focusedPendingUserInput && !focusedPendingApproval && surface === 'board' && activePaneIsThread && !showChooser && !stripOverview"
        class="pointer-events-none fixed inset-x-0 bottom-8 z-30 flex justify-center"
        :inert="Boolean(activeFile)"
      >
        <AgentComposer
          ref="composerRef"
          :project-path="project.path"
          :project-name="project.name"
          :branch="g.branch.value ?? undefined"
          :branch-switchable="(focusedThread?.blocks.value.length ?? 0) === 0"
          :thread-name="focusedThread?.title.value"
          :busy="busy"
          :queued="queuedTurns"
          :picking="modelPickerOpen"
          :models="modelOptions"
          :model-id="model"
          :reasoning="reasoning"
          :mode="mode"
          :fast-mode="fastActive"
          :context-window="contextWindow"
          @send="onSend"
          @steer="onSteer"
          @remove-queued="onRemoveQueued"
          @interrupt="onInterrupt"
          @update:model-id="onComposerModelId"
          @update:reasoning="onComposerReasoning"
          @update:mode="onComposerMode"
          @update:fast-mode="onUpdateFastMode"
          @update:context-window="onComposerContextWindow"
          @open-models="modelPickerOpen = true"
          @open-branch="openBranchPicker"
        />
      </div>
    </Transition>

    <!-- Mid-turn question: while the agent is asking, the composer's orb/input
         gives way to this modal in the same spot, in the picker-family shell.
         Answering resolves the parked tool call and the turn continues. -->
    <UserInputModal
      v-if="focusedPendingUserInput"
      :request-id="focusedPendingUserInput.requestId"
      :questions="focusedPendingUserInput.questions"
      @answer="onAnswerUserInput"
      @cancel="onCancelUserInput"
    />

    <!-- Tool approval: the turn is parked on the agent wanting to run something
         (a command, a file change, a permission grant) in a restrictive mode.
         The composer steps aside for this decision in the same spot — unless the
         subagent shell is already showing the very same ask inline, in which
         case the shell IS the answer spot and this modal steps aside. -->
    <ApprovalModal
      v-if="focusedPendingApproval && !shellSuppressesApproval"
      :request-id="focusedPendingApproval.requestId"
      :approval="focusedPendingApproval.approval"
      :queue="focusedThread?.pendingApprovals.value"
      @decide="onRespondApproval"
    />

    <!-- Subagents dock — the nested runs the agent delegated to this turn. It's
         a taller, wider panel than the Changes/Tasks cards, so it lives in the
         bottom-LEFT corner (free on the board — the folder only perches there on
         home) instead of crowding the right-hand stack. It steps aside while
         its shell is open — the shell is the zoom-in of this same dock. -->
    <div
      v-if="surface === 'board' && !activeFile && focusedThread && !activeShell"
      class="sub-dock-corner"
      :class="{ 'sub-dock-corner--swapping': docksSwapping }"
    >
      <AnimatePresence :initial="false">
        <AgentSubagentDock
          v-if="activeDelegates.rows.length"
          key="agent-subagents-dock"
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
    <div
      v-if="surface === 'board' && !activeFile && focusedThread"
      class="dock-stack"
      :class="{
        'dock-stack--lifted': pillThreads.length > 0,
        'dock-stack--swapping': docksSwapping,
      }"
    >
      <AnimatePresence :initial="false">
        <ChangedFilesList
          v-if="activeChanges.files.length"
          key="agent-changes-dock"
          :files="activeChanges.files"
          :total-added="activeChanges.totalAdded"
          :total-removed="activeChanges.totalRemoved"
          :streaming="activeChanges.streaming"
        />
      </AnimatePresence>
      <AnimatePresence :initial="false">
        <PlanTaskList
          v-if="activePlan"
          key="agent-plan-dock"
          :tasks="activePlan.tasks"
          :streaming="activePlan.streaming"
        />
      </AnimatePresence>
    </div>

    <!-- Away-from-thread status pill — the dynamic island. Perches bottom-right
         whenever a turn is still running after you've left its conversation;
         names the conversation and what it's on — the current plan task when the
         thread has a checklist ("Wiring the pill stack", 2/5), else the live tool
         status ("Reading example.vue") — and reopens the thread on click. -->
    <div v-if="pillThreads.length" class="pill-stack">
      <TurnStatusPill
        v-for="t in pillThreads"
        :key="t.key"
        :block="t.block"
        :thread-title="t.title"
        :brand="t.brand"
        :task="t.task"
        :now="agentNow"
        @open="onOpenThread(t.threadId)"
        @dismiss="onDismissThread(t.threadId, t.turnId)"
      />
    </div>

    <!-- A file's detail: it grows out of the clicked card (origin --ox/--oy) to
         fill the screen over everything else, then shrinks back on close. -->
    <Transition name="pop">
      <FileDetail
        v-if="activeFile"
        :file="activeFile"
        :repo-path="project.path"
        :origin="originRect"
        @close="onCloseFile"
        @stage="onStageFile"
        @unstage="onUnstageFile"
        @discard="onDiscardFile"
      />
    </Transition>

    <!-- A subagent's expanded shell: clicked from the Subagents dock (or the
         activity feed's subagent step), the shell rises over the board — the
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

    <!-- Switch branch — the local-branch list in the same folder-picker shell. -->
    <BranchPickerModal
      v-if="branchPickerOpen"
      :project-path="project.path"
      :refresh="() => g.refresh()"
      @switched="onBranchSwitched"
      @cancel="branchPickerOpen = false"
    />

    <!-- Ctrl+Tab HUD — only up while Ctrl is held, gone the instant it's released. -->
    <AnimatePresence>
      <ProjectCycleSwitcher
        v-if="cycling"
        :entries="cycleEntries"
        :selected-index="cycleIndex"
      />
    </AnimatePresence>
  </motion.main>

  <!-- The right-hand peek — a sibling root so it stays pinned to the viewport's
       right edge while `.project-main` slides left to uncover it (a fixed child
       of the translated stage would ride along with the slide). Sits below the
       stage (z-0) and steps aside for the file detail it opens. -->
  <ChangePeek
    :open="peekOpen"
    :changes="changeItems"
    :inert="!peekOpen || activeFile || surface !== 'overview'"
    @close="peekOpen = false"
    @open-file="onOpenFile"
    @stage-all="onStageAll"
    @unstage-all="onUnstageAll"
    @discard="onPeekDiscard"
  />
</template>

<style scoped>
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
    bottom 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.15s ease,
    transform 0.15s ease;
}
.dock-stack--lifted {
  bottom: 5.25rem;
}
/* Thread switch: the whole stack fades/settles out so the data swap and its row
   reflow happen while invisible, then the new thread's docks fade back in. */
.dock-stack--swapping,
.sub-dock-corner--swapping {
  opacity: 0;
  transform: translateY(6px) scale(0.985);
  pointer-events: none;
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

/* ── Away-from-thread pill stack ──────────────────────────────────────────── */
/* Fixed to the bottom-right corner; each running/settled off-screen thread gets
   its own dynamic-island pill, newest nearest the corner, older ones stacking
   upward. The container ignores pointer events so the gaps between pills never
   swallow clicks — only the pills themselves are interactive. */
.pill-stack {
  position: fixed;
  right: 2rem;
  bottom: 2rem;
  z-index: 45;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}

/* ── Back to launcher ─────────────────────────────────────────────────────── */
/* A quiet return glyph in the top-left corner — mirrors the folder's own perch
   in the bottom-left. Bare, no chrome; it rides the same magnet pull as the
   app's other buttons and brightens to full ink on hover. */
.project-back-magnet {
  position: fixed;
  top: 1.25rem;
  left: 2rem;
  z-index: 40;
}
.project-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  opacity: 0.7;
  cursor: pointer;
  transition:
    opacity 0.18s ease,
    color 0.25s ease;
}
.project-back:hover,
.project-back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
/* Turn the return arrow upside down, then mirror it left-to-right. */
.back-glyph {
  transform: rotate(180deg) scaleX(-1);
}

/* ── The corner profile chip ──────────────────────────────────────────────── */
/* Pinned to the same fixed top line as the back arrow, mirrored to the right
   edge. Borderless like the rest of the app: just the signed-in user's initial
   on an ink dot, matching the Home greeting's avatar chip. */
.project-avatar {
  position: fixed;
  top: 1.25rem;
  right: 2rem;
  z-index: 40;
  display: inline-flex;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.project-avatar:focus-visible {
  outline: none;
}
.project-avatar__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 13px;
  line-height: 1;
  user-select: none;
  transition:
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.3s ease;
}
.project-avatar:focus-visible .project-avatar__chip {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 2px;
}
.project-avatar:hover .project-avatar__chip {
  transform: scale(1.06);
}
/* Fades and lifts away with the rest of the top chrome. */
.project-avatar-enter-active,
.project-avatar-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.project-avatar-enter-from,
.project-avatar-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* ── The centre nav ───────────────────────────────────────────────────────── */
/* Pinned to the same fixed top line as the two corner buttons, held at centre.
   Borderless like the rest of the app: the only mark of selection is one soft
   ink-tinted pill sliding between two equal segments. */
.project-nav {
  position: fixed;
  top: 1.25rem;
  left: 50%;
  z-index: 40;
  display: inline-flex;
  transform: translateX(-50%);
  transition:
    opacity 0.3s ease,
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  /* The top row is one gesture: the nav drops into its perch on the same beat
     as the back arrow and the profile chip (--proj-enter-back), settling from
     a hair above. Its --away state rides the same transform family, so the
     entrance animation and the step-aside never fight. */
  animation: nav-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: var(--proj-enter-back, 0ms);
}
@keyframes nav-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}
.project-nav--away {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
  pointer-events: none;
}
/* One pill, arithmetic not measurement: each segment is a fixed 84px, so the
   pill just steps by index — it can never fall out of step on a resize. */
.project-nav__mark {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 0;
  width: 84px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  transform: translateX(calc(var(--at, 0) * 84px));
  transition: transform 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
}
.project-nav__row {
  position: relative;
  z-index: 1;
  width: 84px;
  padding: 7px 0;
  border-radius: 999px;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  text-align: center;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.25s ease;
}
.project-nav__row:not(.project-nav__row--on):not(:disabled):hover {
  color: var(--ink-soft);
}
.project-nav__row:focus-visible {
  outline: none;
  color: var(--ink);
}
.project-nav__row--on {
  color: var(--ink);
}
.project-nav__row:disabled {
  opacity: 0.4;
  cursor: default;
}
@media (prefers-reduced-motion: reduce) {
  .project-nav,
  .project-nav__mark {
    transition: none;
  }
  .project-nav {
    animation: none;
  }
}

/* ── Surfaces ─────────────────────────────────────────────────────────────── */
/* The two surfaces (overview + board) are layers, not pages: both stay mounted
   for the project's lifetime and only one is visible at a time. Hiding is
   `visibility` (never display:none / v-if) so every layout box — and thus
   xterm's fit() and the rail's clientWidth — stays valid while hidden. */
.project-main {
  height: 100vh;
  overflow: hidden;
  /* Sits above the peek (the sibling pinned to the right edge) so it fully
     covers it at rest; the slide below opens the gap it shows through. */
  position: relative;
  z-index: 1;
  /* The slide itself is the settings drawer's spring (driven by motion-v on
     <motion.main>); only the corner curve eases in CSS, alongside it. */
  transition: border-radius 0.4s cubic-bezier(0.22, 1, 0.36, 1);
  /* Project-home entrance cascade — read top → bottom, corner accents last.
     The fixed top row enters first as one beat: back arrow, centre nav and the
     profile chip all ride --proj-enter-back. Then the working tree reads in —
     greeting → changes → sessions, where the sessions slot is held by the
     RECENT skeleton until the first history read lands (its shimmer rows
     inherit this same var) — and finally the corner folder. Child blocks
     inherit these via --proj-enter-* and layer their own internal stagger on
     top. Defined on the mount root (not a per-surface class) so the docked
     composer keeps its delay regardless of which surface owns the viewport. */
   --proj-enter-back: 0ms;
   --proj-enter-greet: 30ms;
   --proj-enter-changes: 130ms;
   --proj-enter-sessions: 230ms;
   --proj-enter-composer: 330ms;
   --proj-enter-folder: 400ms;
}
/* The peek reveal — the slide is the settings drawer's spring (driven inline by
   motion-v), the corner curve lives on the page: its right edge (the one facing
   the peek) arcs inward, mirroring the settings page carrying the curve on the
   edge facing its drawer. The slide stops just short of the peek's full width
   (peek 360 − radius 18 = 342) so the rounded corners overlap only the panel's
   own left padding — the arc then reads against the panel's sunken surface
   instead of the page's ground (a flush slide shows --ground through the
   corners, hiding the curve), while the rows themselves stay fully visible. */
.project-main--peek {
  border-radius: 0 18px 18px 0;
}
@media (prefers-reduced-motion: reduce) {
  .project-main--peek {
    transition: none;
  }
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
.surface-layer--board {
  align-items: stretch;
}
/* The repository owns its own inner padding and scroll regions, so the layer
   just hands it the viewport. */
.surface-layer--git {
  align-items: stretch;
}
.surface-layer--overview {
  align-items: flex-start;
  /* No bottom inset — the composer no longer docks on the working-tree home,
     so the listing's smoke mask can fade rows all the way to the viewport's
     bottom edge instead of stranding them above a reserved band. */
  padding: 6rem 4rem 0;
}
.surface-layer--hidden {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
/* Arriving at the board — the whole strip eases up into place with kone's house
   easing (the same the change cards use), ported verbatim from the old
   `.chat-open` Transition. Only the arrival animates: the hidden state carries
   no transition, so leaving snaps (matching the old chat-open-leave display:none
   that avoided a flash of the overview over the still-present board). */
.surface-layer--board:not(.surface-layer--hidden) {
  transition:
    opacity 0.42s ease,
    transform 0.46s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: 50% 22%;
  will-change: opacity, transform;
}
.surface-layer--board.surface-layer--hidden {
  transform: translateY(10px) scale(0.985);
}
@media (prefers-reduced-motion: reduce) {
  .surface-layer--board:not(.surface-layer--hidden) {
    transition-duration: 0.01s;
  }
  .surface-layer--board.surface-layer--hidden {
    transform: none;
  }
}

/* The repository is the board's peer on the centre nav, so it arrives the same
   way — the whole space easing up into place on entry, snapping back on leave
   (same hidden state carries no transition). */
.surface-layer--git:not(.surface-layer--hidden) {
  transition:
    opacity 0.42s ease,
    transform 0.46s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: 50% 22%;
  will-change: opacity, transform;
}
.surface-layer--git.surface-layer--hidden {
  transform: translateY(10px) scale(0.985);
}
@media (prefers-reduced-motion: reduce) {
  .surface-layer--git:not(.surface-layer--hidden) {
    transition-duration: 0.01s;
  }
  .surface-layer--git.surface-layer--hidden {
    transform: none;
  }
}

/* The one scroll region on the working-tree home. Its bottom edge fades into a
   soft smoke mask so rows dissolve rather than clipping at a hard line, and the
   scrollbar stays out of sight — the same treatment as the conversation thread
   and the launcher's session list. */
.work-sessions {
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(
    to bottom,
    #000 calc(100% - 44px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    #000 calc(100% - 44px),
    transparent 100%
  );
}
.work-sessions::-webkit-scrollbar {
  width: 0;
  height: 0;
}
/* The greeting's switcher drops just beneath the name trigger. */
.greet-switcher {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 40;
}

/* The folder reads as touchable: on hover it lifts a hair and warms its
   cursor while its papers fan up out of the pocket (driven by :hovered). */
.project-folder {
  cursor: pointer;
}
/* The whole folder lifts a hair on hover. Targets the plain inner .folder root
   (not the motion.div wrapper, whose transform is driven inline by motion). */
.project-folder :deep(.folder) {
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.project-folder:hover :deep(.folder) {
  transform: translateY(-3px);
}

/* Actions above the folder: quiet, plain text + icon (no pill/fill), stacked
   and surfaced only while the folder is hovered (or a menu it owns is open). */
.folder-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  /* Paint above the fanning papers, which are absolutely positioned inside the
     folder and would otherwise overlap the buttons. */
  position: relative;
  z-index: 1;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.folder-actions.is-visible {
  opacity: 1;
  pointer-events: auto;
}
.folder-action {
  display: flex;
  cursor: pointer;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  transition: color 0.2s ease;
}
.folder-action:hover,
.folder-action.is-active {
  color: var(--ink);
}

/* Once the centered work column reaches the folder's footprint, remove the
   decorative folder + its actions so they cannot overlap actionable page
   content. */
@media (max-width: 1440px) {
  .project-folder-row {
    display: none;
  }
}

/* The detail grows out of the clicked card and settles — a small overshoot reads
   as a "pop". Origin comes from --ox/--oy (the card's centre), set inline on the
   overlay root. On close it runs in reverse, shrinking back into the card. */
@keyframes pop-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
  to { opacity: 1; transform: scale(1); }
}
.pop-enter-active {
  animation: pop-grow 0.46s cubic-bezier(0.34, 1.3, 0.64, 1);
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.pop-leave-active {
  animation: pop-grow 0.26s cubic-bezier(0.4, 0, 0.9, 1) reverse;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
/* The subagent transcript panel settles in as a centred card over the board —
   a soft rise rather than the file detail's explosive grow. */
.sut-enter-active,
.sut-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.sut-enter-from,
.sut-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.985);
}
@media (prefers-reduced-motion: reduce) {
  .pop-enter-active,
  .pop-leave-active {
    animation-duration: 0.01s;
  }
  .sut-enter-active,
  .sut-leave-active {
    transition: none;
  }
}

/* The archive-refusal notice — a floating pill over every surface, so it works
   from the board (column header archive) and the overview (recent rows). House
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
@media (prefers-reduced-motion: reduce) {
  .archive-notice-enter-active,
  .archive-notice-leave-active {
    transition: none;
  }
}

</style>
