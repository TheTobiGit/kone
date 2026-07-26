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
  GitFileStatus,
  InteractionMode,
  ProviderKind,
} from "~/types/desktop";
import type { Project } from "~/composables/useProject";
import type { RecentProject } from "~/composables/useRecentProjects";
import { buildModelCatalog, effortForTier, familyForId } from "~/utils/modelCatalog";
import type { BrandKey, EffortTier, ModelOption, PickerProvider } from "~/utils/modelCatalog";

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
const { blocks, busy, model, mode, reasoning, serviceTier, now: agentNow, error: agentError } = agent;

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

// Remember the last provider + model + permission mode per project across quits.
const PROVIDER_KEY = `kone:provider:${props.project.path}`;
const MODEL_KEY = `kone:model:${props.project.path}`;
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
  // Restore the last permission mode for this project.
  if (import.meta.client) {
    const savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode && (MODES as string[]).includes(savedMode)) {
      agent.setMode(savedMode as InteractionMode);
    }
  }
  await agent.start();
});

// Derive the effort tier for the current model id and ride it along on each
// turn — Codex maps it to its own reasoning-effort turn param. Also persist
// the choice per project.
watch(
  model,
  (id) => {
    const eff = effortForTier(familyForId(modelOptions.value, id), reasoning.value);
    if (eff) agent.setReasoning(eff.tier);
    if (import.meta.client && id) localStorage.setItem(MODEL_KEY, id);
  },
  { immediate: true },
);

// Persist the permission mode per project.
watch(mode, (m) => {
  if (import.meta.client) localStorage.setItem(MODE_KEY, m);
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

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && cycling.value) {
    e.preventDefault();
    cancelCycle();
    return;
  }
  if (e.key !== "Tab" || !e.ctrlKey) return;
  e.preventDefault();
  if (!cycling.value) startCycle(!e.shiftKey);
  else stepCycle(!e.shiftKey);
});
// Ctrl release commits — mirrors a held app-switcher, not a click-to-toggle menu.
useEventListener(window, "keyup", (e: KeyboardEvent) => {
  if (cycling.value && e.key === "Control") commitCycle();
});
// If the window loses focus mid-hold (e.g. an OS-level app switch), abandon the
// cycle instead of leaving it stuck open with no keyup to close it.
useEventListener(window, "blur", () => {
  if (cycling.value) cancelCycle();
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
type ModelPick = { provider: ProviderKind; modelId: string; tier: EffortTier; fastMode: boolean };
async function applyModelEffort(picked: ModelPick) {
  const providerChanged = picked.provider !== agent.provider.value;
  const modelChanged = picked.modelId !== model.value;
  if (providerChanged) agent.setProvider(picked.provider);
  agent.setModel(picked.modelId);
  agent.setReasoning(picked.tier);
  const fam = familyForId(catalogs.value[picked.provider] ?? [], picked.modelId);
  agent.setServiceTier(picked.fastMode ? fam?.fastTier?.id : undefined);

  const needsRestart = providerChanged || (RESTART_ON_MODEL_CHANGE.has(picked.provider) && modelChanged);
  if (needsRestart) {
    if (import.meta.client && providerChanged) localStorage.setItem(PROVIDER_KEY, picked.provider);
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

function onSend(text: string) {
  view.value = "chat";
  void agent.send(text);
}
function onInterrupt() {
  void agent.interrupt();
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
        :transition="{ duration: 0.4, delay: 0.2 }"
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

    <!-- CHAT · the page itself never scrolls — only the thread does, fading into
         a soft smoke mask at the top and just above the docked composer, the
         same easing as the file-preview body. -->
    <div
      v-if="view === 'chat'"
      class="chat-scroll selectable"
      :inert="Boolean(activeFile)"
    >
      <ConversationThread
        :blocks="blocks"
        :now="agentNow"
        :session-error="agentError"
      />
    </div>

    <!-- WORK · the working-tree home, page scrolls normally.
         While the detail overlay is open the page behind is inert — no tab
         stops, no screen-reader reach; the overlay owns focus. -->
    <div v-else class="flex w-full max-w-4xl flex-col gap-11" :inert="Boolean(activeFile)">
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

    <!-- The folder settles into the corner last — rising into place with a soft
         spring, the physical grace note after the greeting + changes land.
         (Home only — it steps aside once the conversation takes over.) -->
    <motion.div
      v-if="view !== 'chat'"
      class="project-folder-row absolute bottom-10 left-10 flex items-center gap-4"
      :inert="Boolean(activeFile)"
      :initial="{ opacity: 0, y: 44, scale: 0.94 }"
      :animate="{ opacity: 1, y: 0, scale: 1 }"
      :transition="{ type: 'spring', stiffness: 210, damping: 22, mass: 0.9, delay: 0.55 }"
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
      class="pointer-events-none fixed inset-x-0 bottom-8 z-30 flex justify-center"
      :inert="Boolean(activeFile)"
    >
      <AgentComposer
        :busy="busy"
        :picking="modelPickerOpen"
        :models="modelOptions"
        :model-id="model"
        :reasoning="reasoning"
        :mode="mode"
        :fast-mode="fastActive"
        @send="onSend"
        @interrupt="onInterrupt"
        @update:model-id="agent.setModel"
        @update:reasoning="agent.setReasoning"
        @update:mode="agent.setMode"
        @update:fast-mode="onUpdateFastMode"
        @open-models="modelPickerOpen = true"
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
/* Home scrolls the page normally; the conversation locks the page and scrolls
   the thread inside itself (like the rest of the app). */
.is-work {
  min-height: 100vh;
  align-items: flex-start;
  padding: 6rem 4rem 14rem;
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

/* The one scroll region in chat mode. Its content fades into a soft smoke mask
   at the top and just above the docked composer, so turns scroll into and out
   of view rather than clipping at a hard edge. */
.chat-scroll {
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 92px 2rem 208px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 76px,
    #000 calc(100% - 176px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 76px,
    #000 calc(100% - 176px),
    transparent 100%
  );
  scrollbar-width: none;
}
.chat-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
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
