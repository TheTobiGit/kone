<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { onClickOutside, onKeyStroke, refDebounced, useDebounceFn, useEventListener } from "@vueuse/core";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowTurnBackwardIcon,
  AppleFinderIcon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import type { FolderFile } from "~/types/folder";
import type { ChangeItem } from "~/types/change";
import type {
  ChatAttachment,
  GitFileStatus,
  InteractionMode,
  ProviderKind,
  UserInputAnswers,
} from "~/types/desktop";
import type { Project } from "~/composables/useProject";
import type { RecentProject } from "~/composables/useRecentProjects";
import { buildModelCatalog, effortForTier, familyForId, EFFORT_META } from "~/utils/modelCatalog";
import type { BrandKey, EffortTier, ModelOption, PickerProvider } from "~/utils/modelCatalog";
import { SESSION_BRAND } from "~/types/session";
import { deriveActivePlan } from "~/utils/planTasks";
import { deriveChangedFiles } from "~/utils/changedFiles";
import { useTerminal } from "~/composables/useTerminal";
import { useScratchpad } from "~/composables/useScratchpad";

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ close: [] }>();

// One reactive git model drives the whole page; every surface below reads from
// its derived counts, and the action handlers edit it in place so a change
// shows up everywhere at once.
const g = useProjectGit(toRef(props, "project"));
const { cue } = useSound();
const { warm } = useHighlighter();

// ── the live agent session ────────────────────────────────────────────────────
// One provider session, scoped to this project. The composer feeds it turns and
// the thread renders them — the same normalized event stream drives both, so
// nothing here knows it's Codex underneath. In `nuxt dev` (no bridge) the
// composable streams a faithful mock so the whole flow is demoable in a browser.
const providers = useAgentProviders();
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
const { panes, focusedId, focusedPane } = board;

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

// The composer only docks under a focused thread pane. agent.activeKey deliberately
// keeps pointing at the last thread while you work in a terminal (background turns
// keep streaming) — chrome derives from the focused pane's session, not the
// projection. showChooser suppresses the composer on a bare desktop.
const focusedThread = computed(() =>
  focusedPane.value?.kind === "thread" ? focusedPane.value.session : null,
);
const focusedPendingUserInput = computed(
  () => focusedThread.value?.pendingUserInput.value ?? null,
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

// The two corner docks (Tasks + Changes) derive from the whole block list, so
// they'd otherwise re-run deriveActivePlan / deriveChangedFiles on every streamed
// token of a live turn. Neither drives anything time-critical — a ~100ms lag on
// the dock is imperceptible — so debounce the derived value: the raw computeds
// stay reactive, but the docks read a ref that settles at most ~10×/s. (E2)
const activePlanRaw = computed(() =>
  deriveActivePlan(focusedThread.value?.blocks.value ?? []),
);
const activePlan = refDebounced(activePlanRaw, 100);
const activeChangesRaw = computed(() =>
  deriveChangedFiles(focusedThread.value?.blocks.value ?? []),
);
const activeChanges = refDebounced(activeChangesRaw, 100);

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
function archiveSession(threadId: string): void {
  archiveSessionRow(threadId);
  void agent.forgetThread(threadId);
}
function removeSession(threadId: string): void {
  removeSessionRow(threadId);
  void agent.forgetThread(threadId);
}

// Open a stored thread and reveal the chat the instant its transcript lands —
// openThread sets the blocks before the session subprocess finishes spawning, so
// gating the surface flip on that grows a populated thread (no flash of the empty
// state, no lingering on the working-tree home) with the chat-open entrance.
// Falls through to showing chat even on an empty/failed load.
async function revealThread(threadId: string): Promise<void> {
  const stop = watch(blocks, (b) => {
    if (b.length) {
      surface.value = "board";
      stop();
    }
  });
  try {
    await agent.openThread(threadId);
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
// The active provider's catalog feeds the composer's own model name + effort dial.
const modelOptions = computed(() => catalogs.value[agent.provider.value] ?? []);

// A model change on a provider that bakes model/effort at spawn (Claude) can't
// apply to a running session — it needs a fresh one. Codex takes model/effort
// per turn, so it changes in place. Mirrors each adapter's `sessionModelSwitch`.
const RESTART_ON_MODEL_CHANGE = new Set<ProviderKind>(["claudeAgent", "opencode"]);
const PROVIDER_VENDOR: Record<ProviderKind, string> = { codex: "OpenAI", claudeAgent: "Anthropic", opencode: "OpenCode" };
const PROVIDER_BRAND: Record<ProviderKind, BrandKey> = { codex: "codex", claudeAgent: "claude", opencode: "opencode" };

// The provider + model + reasoning effort are remembered GLOBALLY — one app-wide
// "last used" choice that every project opens with (not per-project). The
// permission mode stays per-project (it's a per-repo trust decision).
const PROVIDER_KEY = "kone:provider";
const MODEL_KEY = "kone:model";
const REASONING_KEY = "kone:reasoning";
const MODE_KEY = `kone:mode:${props.project.path}`;
const MODES: InteractionMode[] = ["ask", "accept-edits", "full-access"];

// The provider rail the model picker shows — one ready provider per catalog.
const pickerProviders = computed<PickerProvider[]>(() =>
  providers.ready.value.map((s) => ({
    id: s.provider,
    label: s.label,
    sub: `${PROVIDER_VENDOR[s.provider]} · ${catalogs.value[s.provider]?.length ?? 0} models`,
    brand: PROVIDER_BRAND[s.provider],
    ready: s.readiness === "ready",
    models: catalogs.value[s.provider] ?? [],
  })),
);

// Two views over the same page: the working tree ("work") and the conversation
// ("chat"). Sending the first turn flips to chat. (A way back to the working
// tree will land later — the thread never clears, so it's safe to leave for now.)
const surface = ref<"overview" | "board">("overview");

onMounted(async () => {
  // Providers + models are warmed at app open (agent-warmup plugin); this awaits
  // that in-flight run (deduped — no second probe) or returns instantly if done,
  // then reads the cached lists. Build a catalog for every ready provider.
  await providers.prepare();
  const readyProviders = providers.ready.value;
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
  if (chosen) agent.setProvider(chosen);

  // Pick a default model within the chosen provider (restoring the saved one when
  // it's still in that provider's catalog).
  if (!model.value) {
    const savedModel = import.meta.client ? localStorage.getItem(MODEL_KEY) : null;
    const inCatalog = modelOptions.value.some((o) => o.efforts.some((e) => e.modelId === savedModel));
    if (savedModel && inCatalog) agent.setModel(savedModel);
    else {
      const first = modelOptions.value[0];
      const eff = first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0];
      if (eff) agent.setModel(eff.modelId);
    }
  }
  // Restore the app-wide last-used reasoning effort, clamped to what the active
  // model's family actually offers (effortForTier falls back to the family
  // default otherwise). The model watcher re-derives effort from reasoning.value,
  // so seeding it here makes the restored tier stick.
  if (import.meta.client) {
    const savedReasoning = localStorage.getItem(REASONING_KEY);
    if (savedReasoning && savedReasoning in EFFORT_META) {
      const fam = familyForId(modelOptions.value, model.value);
      const eff = effortForTier(fam, savedReasoning as EffortTier);
      if (eff) agent.setReasoning(eff.tier);
    }
  }
  // Restore the last permission mode for this project.
  if (import.meta.client) {
    const savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode && (MODES as string[]).includes(savedMode)) {
      agent.setMode(savedMode as InteractionMode);
    }
  }
  // If the launcher asked to resume a specific conversation (a click on the App
  // Home "recent sessions" list), open THAT thread directly and drop into chat —
  // don't rehydrate + spawn the project's latest thread first only to tear it
  // straight down. openThread loads the picked thread and spawns a single
  // session for it; the plain-open path still lands on the project home.
  // Consume the request so a later re-open of this project behaves normally.
  const resume = pendingThread.value;
  await scratchpad.hydrate();
  // Restore the persisted board on mount. A missing layout normalises to an empty
  // desktop so useAgent's construction spawn is evicted rather than adopted.
  const savedBoard = await boardStore.load();
  const layout = savedBoard ?? { version: 1 as const, panes: [], focusedId: null };
  // The set of thread ids that actually have a stored conversation. restore()
  // uses it to drop phantom thread panes — blank slates that were persisted with
  // their client-minted id and would otherwise return as empty columns. No
  // bridge (nuxt dev) → undefined, and restore keeps ids unfiltered.
  const knownThreadIds = await loadKnownThreadIds(props.project.path);
  await board.restore(layout, knownThreadIds);
  if (resume) {
    // Launcher asked to resume a specific conversation. It's often already on the
    // restored board (as a live or dormant thread pane) — focus it there, which
    // attaches a dormant one on the way in. If the board doesn't know it at all,
    // open a fresh pane bound to its id. Either way we land on the board.
    pendingThread.value = null;
    const onBoard = panes.value.some(
      (p) =>
        p.kind === "thread" &&
        (p.session?.threadId.value === resume ||
          (p.entry.anchor.kind === "thread" && p.entry.anchor.threadId === resume)),
    );
    if (onBoard) board.focusThreadById(resume);
    else await board.open("thread", { threadId: resume });
    surface.value = "board";
  }
  // Only now let layout changes persist — past this point the board reflects the
  // user's real arrangement, not the boot adopt.
  boardReady.value = true;
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

// Ctrl+N (mod+n) starts a fresh, empty thread — mirroring the composer's own
// "send from the working-tree home" path. It flips to the board surface so
// the user lands in the blank thread, and prunes the idle previous thread when
// it never ran a live turn.
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

// The corner back arrow steps out one layer at a time: from the conversation it
// returns to the project's working tree (the thread stays put); from there it
// leaves for the launcher.
function onBack() {
  if (surface.value === "board") {
    surface.value = "overview";
    return;
  }
  toLauncher();
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
async function applyModelEffort(picked: ModelPick) {
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
  const fam = familyForId(modelOptions.value, model.value);
  agent.setServiceTier(on ? fam?.fastTier?.id : undefined);
}

async function onSend(text: string, files?: File[]) {
  // Sending from the overview (no thread focused) begins a fresh
  // conversation rather than continuing the last-opened one — the session boots
  // rehydrated with the project's latest thread, so without this a first send
  // would silently append to that old transcript.
  if (surface.value === "overview") await board.open("thread");
  surface.value = "board";
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
  if (boardReady.value) boardStore.save(board.serialize());
});
// A hard window close (quit) skips onBeforeUnmount, so persist on beforeunload too.
useEventListener(window, "beforeunload", () => {
  if (boardReady.value) boardStore.save(board.serialize());
});
// beforeunload is unreliable on macOS app-hide / Space switches and never fires
// when the OS suspends the renderer. So also flush — synchronously, past the
// 400ms debounce — the moment the window loses focus or the tab is hidden. Both
// are cheap idempotent writes of the same serialized layout, so firing them
// often (and alongside beforeunload) is harmless; missing the last gesture isn't.
function flushBoard(): void {
  if (boardReady.value) boardStore.save(board.serialize());
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
  // instead. Pills are for the working-tree home, where no thread is on screen.
  if (surface.value === "board") return [];
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
      brand: SESSION_BRAND[t.provider] ?? "generic",
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
function onCommit() {
  cue("success");
  g.commit();
}

// ── file detail ───────────────────────────────────────────────────────────────
function onOpenFile(item: ChangeItem, rect: DOMRect) {
  cue("press");
  originRect.value = rect;
  activePath.value = item.path;
}
function onCloseFile() {
  activePath.value = null;
}
// Esc backs out of whatever is frontmost: the detail view, then an open switcher.
onKeyStroke("Escape", () => {
  if (activePath.value) {
    onCloseFile();
    return;
  }
  // The branch picker owns its own Escape (it's a modal); nothing to do here.
  if (switcherOpen.value) switcherOpen.value = false;
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
  <main class="project-main relative bg-ground">
    <!-- Back to the launcher — a bare return glyph in the corner, on the same
         magnet-pull the app's other buttons ride, lighting up to the accent
         on hover. It steps aside only for the file-detail overlay. -->
    <Magnet
      class="project-back-magnet"
      inner-class="w-fit"
      :padding="12"
      :magnet-strength="9"
      :disabled="Boolean(activeFile)"
      active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
      inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
    >
      <motion.button
        type="button"
        class="project-back"
        :inert="Boolean(activeFile)"
        :aria-label="surface === 'board' ? 'Back to project' : 'Back to projects'"
        :initial="{ opacity: 0, x: -6 }"
        :animate="{ opacity: 1, x: 0 }"
        :transition="{ duration: 0.4, delay: 0.05 }"
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
        @insert-column="insertPane"
        @terminal-write="terminal.write"
        @terminal-resize="terminal.resize"
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
        />
      </div>
      <!-- Recent conversations — the project's pinned + recent agent threads,
           each a vendor mark + title, meta line, and token tally. This is the
           one scroll region on the working-tree home; its PINNED / RECENT labels
           stick as the rows scroll under them. -->
      <div class="work-sessions min-h-0 flex-1 overflow-y-auto pb-6">
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

    <!-- The folder settles into the corner last — rising into place with a soft
         spring, the physical grace note after the greeting, changes, sessions,
         and composer have landed. (Home only — it steps aside once the
         conversation takes over.) -->
    <motion.div
      v-if="surface !== 'board'"
      class="project-folder-row absolute bottom-10 left-10 flex items-center gap-4"
      :inert="Boolean(activeFile)"
      :initial="{ opacity: 0, y: 44, scale: 0.94 }"
      :animate="{ opacity: 1, y: 0, scale: 1 }"
      :transition="{ type: 'spring', stiffness: 210, damping: 22, mass: 0.9, delay: 0.92 }"
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

    <!-- The agent composer floats dead-centre at the bottom — dormant until you
         wake it, then it stretches into the input. It stays docked to the
         viewport while the page behind scrolls. Entering the strip's overview takes
         it away; fade rather than cut, so it doesn't blink out from under the cursor
         while the board behind it is still gliding back. -->
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="!focusedPendingUserInput && activePaneIsThread && !showChooser && !stripOverview"
        class="pointer-events-none fixed inset-x-0 bottom-8 z-30 flex justify-center"
        :inert="Boolean(activeFile)"
      >
        <AgentComposer
          ref="composerRef"
          :project-path="project.path"
          :busy="busy"
          :picking="modelPickerOpen"
          :models="modelOptions"
          :model-id="model"
          :reasoning="reasoning"
          :mode="mode"
          :fast-mode="fastActive"
          :context-window="contextWindow"
          @send="onSend"
          @interrupt="onInterrupt"
          @update:model-id="agent.setModel"
          @update:reasoning="agent.setReasoning"
          @update:mode="agent.setMode"
          @update:fast-mode="onUpdateFastMode"
          @update:context-window="agent.setContextWindow"
          @open-models="modelPickerOpen = true"
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

    <!-- Corner dock stack — the agent's live side-panels in the folder-picker
         shell, bottom-right while a turn runs. Changes (files touched this
         thread) rides above Tasks (the model's TodoWrite checklist); the column
         lifts clear of the away-from-thread pill when one is perched below. -->
    <div
      v-if="surface === 'board' && !activeFile && focusedThread"
      class="dock-stack"
      :class="{ 'dock-stack--lifted': pillThreads.length > 0 }"
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
  </main>
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
  transition: bottom 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.dock-stack--lifted {
  bottom: 5.25rem;
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
  top: 2rem;
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

/* ── Surfaces ─────────────────────────────────────────────────────────────── */
/* The two surfaces (overview + board) are layers, not pages: both stay mounted
   for the project's lifetime and only one is visible at a time. Hiding is
   `visibility` (never display:none / v-if) so every layout box — and thus
   xterm's fit() and the rail's clientWidth — stays valid while hidden. */
.project-main {
  height: 100vh;
  overflow: hidden;
  /* Project-home entrance cascade — read top → bottom, corner accents last.
     Child blocks (greeting, changes, sessions, composer) inherit these via
     --proj-enter-* and layer their own internal stagger on top. Defined on the
     mount root (not a per-surface class) so the docked composer keeps its delay
     regardless of which surface owns the viewport. */
  --proj-enter-back: 50ms;
  --proj-enter-greet: 120ms;
  --proj-enter-changes: 340ms;
  --proj-enter-sessions: 580ms;
  --proj-enter-composer: 760ms;
  --proj-enter-folder: 920ms;
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
.surface-layer--overview {
  align-items: flex-start;
  /* Bottom inset clears the docked composer orb. Trimmed from the old
     full-page-scroll value (14rem) — now that only the listing scrolls, that
     much reserved space stranded the fade cutoff high above the composer. */
  padding: 6rem 4rem 8rem;
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

/* The one scroll region on the working-tree home. Its bottom edge fades into a
   soft smoke mask so rows dissolve toward the docked composer rather than
   clipping at a hard line, and the scrollbar stays out of sight — the same
   treatment as the conversation thread and the launcher's session list. */
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

/* Actions beside the folder: quiet, plain text + icon (no pill/fill), stacked
   and surfaced only while the folder is hovered (or a menu it owns is open). */
.folder-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
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
@media (prefers-reduced-motion: reduce) {
  .pop-enter-active,
  .pop-leave-active {
    animation-duration: 0.01s;
  }
}

</style>
