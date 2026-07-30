<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { onClickOutside, onKeyStroke, useEventListener } from "@vueuse/core";
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
  pendingUserInput,
  now: agentNow,
  // The active thread's title / error aren't projected here any more: each strip
  // column renders its own from its own session.
} = agent;

const terminal = useTerminal({ cwd: () => props.project.path });

// ── Unified strip columns ────────────────────────────────────────────────────
// The thread strip can hold both agent threads and terminal sessions. We merge
// them into a single ordered list based on a local registry of column keys.
const columnKeys = ref<string[]>([]);

// Seed the initial column array with the agent's first thread.
watch(
  () => agent.sessions.value.map(s => s.key),
  (agentKeys) => {
    // Sync new agent threads into our unified list
    for (const k of agentKeys) {
      if (!columnKeys.value.includes(k)) {
        columnKeys.value.push(k);
      }
    }
  },
  { immediate: true, deep: true }
);

watch(
  () => terminal.sessions.value.map(s => s.key),
  (termKeys) => {
    // Sync new terminal sessions into our unified list
    for (const k of termKeys) {
      if (!columnKeys.value.includes(k)) {
        columnKeys.value.push(k);
      }
    }
  },
  { deep: true }
);

export type StripColumn = 
  | { type: "thread"; key: string; session: ReturnType<typeof useAgent>["sessions"]["value"][number] }
  | { type: "terminal"; key: string; session: ReturnType<typeof useTerminal>["sessions"]["value"][number] };

const columns = computed<StripColumn[]>(() => {
  return columnKeys.value.map(key => {
    const thread = agent.sessions.value.find(s => s.key === key);
    if (thread) return { type: "thread", key, session: thread } as const;
    const term = terminal.sessions.value.find(s => s.key === key);
    if (term) return { type: "terminal", key, session: term } as const;
    return null;
  }).filter((x): x is StripColumn => x !== null);
});

// The globally focused column key. If it drops out, we fall back.
const activeColumnKey = ref<string>("");

watch(
  () => agent.activeKey.value,
  (k) => { if (k) activeColumnKey.value = k; },
  { immediate: true }
);

function focusColumn(key: string) {
  if (columns.value.some(c => c.key === key)) {
    activeColumnKey.value = key;
    // Sync down to agent so its active projection is correct
    if (agent.sessions.value.some(s => s.key === key)) {
      agent.focusThread(key);
    }
  }
}

function shiftColumnFocus(delta: number) {
  const i = columns.value.findIndex(c => c.key === activeColumnKey.value);
  if (i === -1) return;
  const next = columns.value[Math.min(columns.value.length - 1, Math.max(0, i + delta))];
  if (next) focusColumn(next.key);
}

function moveColumn(delta: number) {
  const list = [...columnKeys.value];
  const i = list.findIndex(k => k === activeColumnKey.value);
  if (i === -1) return;
  const j = Math.min(list.length - 1, Math.max(0, i + delta));
  if (i === j) return;
  const [k] = list.splice(i, 1);
  if (!k) return;
  list.splice(j, 0, k);
  columnKeys.value = list;
}

async function closeColumn(key: string) {
  const i = columns.value.findIndex(c => c.key === key);
  const col = columns.value[i];
  if (!col) return;
  
  if (key === activeColumnKey.value) {
    const neighbour = columns.value[i + 1] ?? columns.value[i - 1];
    if (neighbour) {
      focusColumn(neighbour.key);
    } else {
      // If we close the last column, spawn a new thread to replace it
      await agent.newThread();
      const nextKey = agent.activeKey.value;
      if (!columnKeys.value.includes(nextKey)) columnKeys.value.push(nextKey);
      focusColumn(nextKey);
    }
  }
  
  columnKeys.value = columnKeys.value.filter(k => k !== key);
  
  if (col.type === "thread") {
    await agent.closeThread(key);
  } else {
    await terminal.close(key);
  }
}

async function insertColumn(seamIndex: number, kind: "thread" | "terminal") {
  if (kind === "thread") {
    // Spawn the thread in the agent registry
    await agent.newThreadAt(seamIndex + 1); // +1 because we insert to the right of the seam
    const freshKey = agent.activeKey.value;
    
    // Position it in our unified list
    const list = [...columnKeys.value];
    // Remove it from the end where the watch() placed it
    const cleanList = list.filter(k => k !== freshKey);
    cleanList.splice(seamIndex + 1, 0, freshKey);
    columnKeys.value = cleanList;
    focusColumn(freshKey);
  } else {
    const freshKey = await terminal.spawn();
    const list = [...columnKeys.value];
    // Remove it from the end where the watch() placed it
    const cleanList = list.filter(k => k !== freshKey);
    cleanList.splice(seamIndex + 1, 0, freshKey);
    columnKeys.value = cleanList;
    focusColumn(freshKey);
  }
}

/** Open a terminal column just to the right of the focused column (or at the
 *  end) and focus it — the keyboard-shortcut entry point, sibling of the seam
 *  insert menu's terminal pick. */
async function newTerminalColumn() {
  const activeIndex = columnKeys.value.findIndex(k => k === activeColumnKey.value);
  const freshKey = await terminal.spawn();
  // The terminal.sessions watch appends the fresh key at the end; pull it out
  // and drop it beside the active column instead.
  const list = columnKeys.value.filter(k => k !== freshKey);
  const insertAt = activeIndex >= 0 ? activeIndex + 1 : list.length;
  list.splice(insertAt, 0, freshKey);
  columnKeys.value = list;
  focusColumn(freshKey);
}

const activePlan = computed(() => deriveActivePlan(blocks.value));
// The files the agent has created/edited/removed this thread — the corner
// Changes dock's list, a sibling of the Tasks dock in the same shell.
const activeChanges = computed(() => deriveChangedFiles(blocks.value));

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
// gating the view flip on that grows a populated thread (no flash of the empty
// state, no lingering on the working-tree home) with the chat-open entrance.
// Falls through to showing chat even on an empty/failed load.
async function revealThread(threadId: string): Promise<void> {
  const stop = watch(blocks, (b) => {
    if (b.length) {
      view.value = "chat";
      stop();
    }
  });
  try {
    await agent.openThread(threadId);
  } finally {
    stop();
    view.value = "chat";
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
const RESTART_ON_MODEL_CHANGE = new Set<ProviderKind>(["claudeAgent"]);
const PROVIDER_VENDOR: Record<ProviderKind, string> = { codex: "OpenAI", claudeAgent: "Anthropic" };
const PROVIDER_BRAND: Record<ProviderKind, BrandKey> = { codex: "codex", claudeAgent: "claude" };

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
const view = ref<"work" | "chat">("work");

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
    : readyProviders.find((s) => s.provider === "codex")?.provider ?? readyProviders[0]?.provider;
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
  if (resume) {
    pendingThread.value = null;
    await revealThread(resume);
  } else {
    await agent.start();
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

// Ctrl+N (mod+n) starts a fresh, empty thread — mirroring the composer's own
// "send from the working-tree home" path. It flips the view straight to chat so
// the user lands in the blank thread, and prunes the idle previous thread when
// it never ran a live turn.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-thread", e)) return;
  e.preventDefault();
  void agent.newThread();
  view.value = "chat";
});

// mod+shift+t opens a terminal column on the strip and focuses it, flipping to
// the chat view (where the strip lives) so the new shell is on screen.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("new-terminal", e)) return;
  e.preventDefault();
  view.value = "chat";
  void newTerminalColumn();
});

// Play a scripted demo conversation so the whole thread UI (thinking, tools
// with output, streaming text, a no-content thought, the settled footer) can be
// reviewed on demand without driving a real agent turn. The binding lives in
// the shortcuts registry so it can be rebound in settings.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!matchesShortcut("play-demo", e)) return;
  e.preventDefault();
  view.value = "chat";
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
  if (view.value === "chat") {
    view.value = "work";
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
  // Sending from the working-tree home (no thread in view) begins a fresh
  // conversation rather than continuing the last-opened one — the session boots
  // rehydrated with the project's latest thread, so without this a first send
  // would silently append to that old transcript.
  if (view.value === "work") await agent.newThread();
  view.value = "chat";
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
  void agent.respondUserInput(requestId, answers);
}
// Dismiss the question — an empty answer, which the adapter treats as declined.
function onCancelUserInput(requestId: string) {
  void agent.respondUserInput(requestId, {});
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
onBeforeUnmount(() => lockPage(false));

// Wake the composer when a blank thread becomes active in chat — new thread,
// seam insert, or closing the last column all land here. Watching activeKey (not
// a bare empty-blocks check) so closing the orb on an empty thread stays closed.
const composerRef = ref<{ wake: () => Promise<void> } | null>(null);
watch(
  [view, () => agent.activeKey.value, blocks, busy],
  () => {
    if (view.value !== "chat" || activeFile.value) return;
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
  [view, () => agent.threads.value],
  () => {
    if (view.value !== "chat") return;
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
  { deep: true },
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
  if (view.value === "chat") return [];
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
  agent.setActiveThread(threadId);
  // Mark its current turn seen so it won't linger as a pill once we step away —
  // but only if it's already settled. Marking a still-running turn seen would
  // suppress its completion pill if the user opens the pill and leaves before it
  // finishes (the settled-only watcher can't undo a premature seen). While it's
  // running and on screen the watcher marks it seen the moment it settles.
  const t = agent.threads.value.find((x) => x.threadId === threadId);
  if (t?.block && t.block.state !== "running") {
    seenTurns.value = { ...seenTurns.value, [threadId]: t.block.turnId };
  }
  view.value = "chat";
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
// Esc backs out of whatever's frontmost: the detail view, then an open switcher.
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
  <main
    class="relative flex justify-center bg-ground"
    :class="view === 'chat' ? 'is-chat' : 'is-work'"
  >
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
        :aria-label="view === 'chat' ? 'Back to project' : 'Back to projects'"
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

    <!-- CHAT · the thread strip. Every live thread in this project is a column on
         one horizontally scrollable rail (niri-style scrollable tiling), the
         focused one held at centre with its neighbours peeking in. The page
         itself never scrolls — each column scrolls its own turns, and each
         carries its own title bar, so there's no single sticky title any more. -->
    <Transition name="chat-open" appear>
      <ThreadStrip
        v-if="view === 'chat'"
        :columns="columns"
        :active-key="activeColumnKey"
        :now="agentNow"
        :inert="Boolean(activeFile)"
        @focus="focusColumn"
        @shift="shiftColumnFocus"
        @move="moveColumn"
        @close="closeColumn"
        @insert-column="insertColumn"
        @terminal-write="terminal.write"
        @terminal-resize="terminal.resize"
      />
    </Transition>

    <!-- WORK · the working-tree home. The page holds the viewport — greeting +
         changes stay fixed and only the conversation listing scrolls.
         While the detail overlay is open the page behind is inert — no tab
         stops, no screen-reader reach; the overlay owns focus. -->
    <div v-if="view === 'work'" class="flex h-full min-h-0 w-full max-w-4xl flex-col gap-11" :inert="Boolean(activeFile)">
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

    <!-- The folder settles into the corner last — rising into place with a soft
         spring, the physical grace note after the greeting, changes, sessions,
         and composer have landed. (Home only — it steps aside once the
         conversation takes over.) -->
    <motion.div
      v-if="view !== 'chat'"
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
         viewport while the page behind scrolls. -->
    <div
      v-if="!pendingUserInput"
      class="pointer-events-none fixed inset-x-0 bottom-8 z-30 flex justify-center"
      :inert="Boolean(activeFile)"
    >
      <AgentComposer
        ref="composerRef"
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

    <!-- Mid-turn question: while the agent is asking, the composer's orb/input
         gives way to this modal in the same spot, in the picker-family shell.
         Answering resolves the parked tool call and the turn continues. -->
    <UserInputModal
      v-if="pendingUserInput"
      :request-id="pendingUserInput.requestId"
      :questions="pendingUserInput.questions"
      @answer="onAnswerUserInput"
      @cancel="onCancelUserInput"
    />

    <!-- Corner dock stack — the agent's live side-panels in the folder-picker
         shell, bottom-right while a turn runs. Changes (files touched this
         thread) rides above Tasks (the model's TodoWrite checklist); the column
         lifts clear of the away-from-thread pill when one is perched below. -->
    <div
      v-if="view === 'chat' && !activeFile"
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

/* ── Page modes ───────────────────────────────────────────────────────────── */
/* Both modes hold the viewport and scroll a region inside themselves — the
   conversation scrolls the thread; the working-tree home keeps the greeting +
   changes fixed and scrolls only the conversation listing beneath them. */
.is-work {
  height: 100vh;
  align-items: flex-start;
  overflow: hidden;
  /* Bottom inset clears the docked composer orb. Trimmed from the old
     full-page-scroll value (14rem) — now that only the listing scrolls, that
     much reserved space stranded the fade cutoff high above the composer. */
  padding: 6rem 4rem 8rem;
  /* Project-home entrance cascade — read top → bottom, corner accents last.
     Child blocks (greeting, changes, sessions, composer) inherit these via
     --proj-enter-* and layer their own internal stagger on top. */
  --proj-enter-back: 50ms;
  --proj-enter-greet: 120ms;
  --proj-enter-changes: 340ms;
  --proj-enter-sessions: 580ms;
  --proj-enter-composer: 760ms;
  --proj-enter-folder: 920ms;
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
.is-chat {
  height: 100vh;
  align-items: stretch;
  overflow: hidden;
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

/* Arriving at a conversation — the whole thread eases up into place with kone's
   house entrance easing (the same the change cards use), so opening a thread
   (from recents, the launcher, or a fresh send) reads as a smooth page-open even
   though the settled transcript inside carries no motion of its own. Leaving is
   instant — the working-tree home takes its place with no cross-fade. */
.chat-open-enter-active {
  transition:
    opacity 0.42s ease,
    transform 0.46s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: 50% 22%;
  will-change: opacity, transform;
}
.chat-open-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}
/* Only the arrival animates. On the way out the chat vanishes at once rather than
   lingering in the DOM beside the incoming working-tree view — that overlap was a
   flash of the left-aligned home content over the still-present full-width chat. */
.chat-open-leave-active {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .chat-open-enter-active {
    transition-duration: 0.01s;
  }
  .chat-open-enter-from {
    transform: none;
  }
}
</style>
