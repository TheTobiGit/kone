<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { onClickOutside, onKeyStroke } from "@vueuse/core";
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
import type { GitFileStatus } from "~/types/desktop";
import type { Project } from "~/composables/useProject";
import type { RecentProject } from "~/composables/useRecentProjects";
import CommitModal from "~/components/git-space/CommitModal.vue";

const props = defineProps<{
  project: Project;
  /** The studio plane is up. The page is behind an opaque layer then, so
   *  anything of ours that floats (the pill stack) has to stand down. */
  studioOpen: boolean;
}>();
const emit = defineEmits<{ close: []; profile: []; summon: [] }>();

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

// The signed-in user — name and avatar ride the far-right corner of the top
// row, mirroring the back arrow at the left. Resolved once (shared state); the
// chip only appears once a name comes back.
const { name, initial, image, avatarStyle, resolve: resolveProfile } = useProfile();

// The project's persisted agent threads, split into pinned + recent for the
// "recent conversations" block on the working-tree home. Reads real history from
// the store, not the live registry, so a thread that never ran this session is
// still listed.
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
// the in-memory agent registry — where it stays clickable and keeps feeding the
// pill stack. That registry belongs to this project's studio row, which lives on
// the plane above rather than in this page, so the list's actions are routed to
// it by project path: it forgets the thread there too (and refuses while the
// thread is still working) so a pill can't outlive the row it came from.
const rowRegistry = useStudioRowRegistry();
const row = () => rowRegistry.rowFor(props.project.path);

// Two views over the same page: the working tree ("overview") and the repository
// ("git"). The studio is no longer one of them — it is a layer over every page,
// summoned rather than switched to.
const surface = ref<"overview" | "git">("overview");

// The page publishes its conversation list so its row can correct it: archiving
// from a thread's column header has to drop the row from this list as well as
// stamp the store, and the row cannot be handed that function from up there.
const historyList = { archive: archiveSessionRow, remove: removeSessionRow };
rowRegistry.registerHistoryList(props.project.path, historyList);
onBeforeUnmount(() => rowRegistry.unregisterHistoryList(props.project.path, historyList));

onMounted(resolveProfile);

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
  cue("open");
  // A turn in flight would be torn down by the remount anyway — stop it cleanly
  // first so the provider isn't left mid-stream. Only the row knows whether one
  // is running, so it decides.
  row()?.interruptIfRunning();
  openProject({ path: p.path, name: p.name });
}

// ── Ctrl+Tab cycling ─────────────────────────────────────────────────────────
const { matchesShortcut } = useShortcuts();
const { cycling, cycleIndex, cycleEntries, cancelCycle } = useProjectCycle({
  project: props.project,
  cycleProjects,
  switchTo,
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
  if (surface.value === "git") {
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
  cue("open");
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
  { id: "overview", label: "Overview" },
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

// ── away-from-thread pills ───────────────────────────────────────────────────
// The signal that a turn finished while your eyes were somewhere else, so it
// belongs on the surface where no thread is on screen: this page. (On the plane
// every live thread is already a column, which is exactly when a pill would be
// noise.) The agent registry is project-scoped and module-held, so asking for it
// here hands back the very same registry the row uses — two call sites, one set
// of live sessions.
const pillAgent = useAgent({ provider: "codex", cwd: () => props.project.path });
// The shared clock the pills tick their elapsed times off. Pulled out of the
// registry because a plain object's refs don't unwrap in a template.
const { now: agentNow } = pillAgent;
const studioPlane = useStudioPlane();
const { pillThreads, onDismissThread, markSeen } = useThreadPills({
  agent: pillAgent,
  cue,
  // Every live thread is a column the moment this project's row is the one the
  // plane is showing — so none of them should also be a pill.
  threadsOnScreen: computed(
    () => props.studioOpen && studioPlane.focusedPath.value === props.project.path,
  ),
  // Pills belong to the working tree. The repository is its own world, and while
  // the plane is up this whole page is behind an opaque layer — a fixed pill
  // would float over it.
  pillsWelcome: computed(() => surface.value === "overview" && !props.studioOpen),
  blocked: computed(() => Boolean(activeFile.value)),
});

// Opening a pill takes the same path everything else does: the row puts the
// thread on screen, and the plane comes forward to show it.
function onOpenPill(threadId: string) {
  cue("press");
  // Mark its current turn seen so it won't linger once we step away — but only
  // if it has already settled. Marking a still-running turn seen would suppress
  // its completion pill if the user opens it and leaves before it finishes (the
  // settled-only watcher can't undo a premature seen).
  const t = pillAgent.threads.value.find((x) => x.threadId === threadId);
  if (t?.block) markSeen(threadId, t.block.turnId, t.block.state === "running");
  row()?.openThread(threadId);
  emit("summon");
}

// Picking a conversation out of the history list: the row opens it (dedupes
// against a pane it already has, live or dormant) and the plane comes forward.
function onOpenStoredSession(threadId: string) {
  row()?.openSession(threadId);
  emit("summon");
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
const commitModalOpen = ref(false);

function openBranchPicker() {
  branchPickerOpen.value = true;
}
function onBranchSwitched() {
  // The picker already awaited g.refresh() before it closed (so the new branch's
  // changes are already on screen) — just chime and dismiss.
  cue("toggle");
  branchPickerOpen.value = false;
}

// What the app above can ask of this page. Both are things a studio row can need
// and cannot own: the diff overlay and the branch picker belong to the project,
// not to a row of panes.
defineExpose({
  openFile: onOpenFileFromGit,
  openBranch: openBranchPicker,
});

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
// True while the open file is one of the working tree's changes — it then
// self-closes if that change leaves the tree. A file opened from outside the
// tree (a commit's file list, or a dock row whose edit is already committed)
// isn't tracked that way; it just stays open until it's closed.
const activeTracked = ref(false);
const activeFile = computed<ChangeItem | null>(() => {
  const path = activePath.value;
  if (!path) return null;
  const item = changeItems.value.find((c) => c.path === path);
  if (item) return item;
  // Opened from somewhere that isn't the working tree — a commit's file list, or
  // the agent's changes dock after the edit was committed. There's no diffstat to
  // carry, so the detail reads the file as it stands now.
  return {
    path,
    name: basename(path),
    added: 0,
    removed: 0,
    staged: false,
    isNew: false,
    deleted: false,
  };
});
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
// A tracked file leaving the working tree (discarded, or swept away by a commit)
// closes its detail — the change it was showing no longer exists.
watch(changeItems, (items) => {
  if (!activeTracked.value || !activePath.value) return;
  if (!items.some((c) => c.path === activePath.value)) {
    activeTracked.value = false;
    activePath.value = null;
  }
});
onBeforeUnmount(() => {
  lockPage(false);
});

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
  cue("expand");
  commitModalOpen.value = true;
}


// ── file detail ───────────────────────────────────────────────────────────────
// A file opened from the repository surface reuses the working tree's own detail
// overlay — one diff viewer for the whole app. It grows from the clicked row
// when the space hands us its rect, and from nothing when it can't.
// Opened from outside the working-tree lanes — a commit's file list, or the
// agent's changes dock. Tracked only when the path is in fact a live change.
function onOpenFileFromGit(path: string, rect: DOMRect | null) {
  cue("expand");
  originRect.value = rect;
  activeTracked.value = changeItems.value.some((c) => c.path === path);
  activePath.value = path;
}
function onOpenFile(item: ChangeItem, rect: DOMRect) {
  cue("expand");
  // Picked from the peek: slide the stage back and grow the detail from the row.
  peekOpen.value = false;
  originRect.value = rect;
  activeTracked.value = true;
  activePath.value = item.path;
}
// Opening the peek from a lane's +N bundle — the stage steps aside for the list.
function openPeek() {
  cue("expand");
  peekOpen.value = true;
}
function onCloseFile() {
  if (activePath.value) cue("collapse");
  activePath.value = null;
  activeTracked.value = false;
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
    cue("collapse");
    return;
  }
  // The branch picker owns its own Escape (it's a modal); nothing to do here.
  if (switcherOpen.value) switcherOpen.value = false;
});
// The peek belongs to the working-tree home; step it aside when the surface
// changes so a slid-aside stage never hangs over the studio or repository.
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
    :animate="{ x: peekOpen ? -402 : 0 }"
    :transition="peekSpring"
  >
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

    <!-- Titlebar: a full-width top row holding the three chrome controls. -->
    <header class="project-chrome">
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
          :aria-label="surface === 'git' ? 'Back to project' : 'Back to projects'"
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
        :class="{ 'project-nav--away': backIsAway }"
        :inert="backIsAway"
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
           chip, mirroring the back arrow across the page. The slot stays mounted
           so the box is stable; the chip itself still steps aside with the rest
           of the chrome. Only shown once a machine name resolves. -->
      <div class="project-avatar-slot">
        <Transition name="project-avatar">
          <button
            v-if="name && !backIsAway"
            type="button"
            class="project-avatar"
            :title="name"
            :aria-label="`Open profile — ${name}`"
            @click="emit('profile')"
          >
            <span class="project-avatar__chip" :style="avatarStyle">
              <template v-if="!image">{{ initial }}</template>
            </span>
          </button>
        </Transition>
      </div>
    </header>

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
        <div class="overview-header flex items-start justify-between gap-8">
          <!-- The greeting's project name doubles as a switcher trigger; the popover
               drops just beneath it, anchored to the name. -->
          <div ref="greetWrap" class="relative min-w-0 flex-1">
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
            <div v-if="switcherOpen" class="greet-pop">
              <ProjectPickerModal
                :current-path="project.path"
                @select="switchTo"
                @cancel="switcherOpen = false"
              />
            </div>
          </div>

          <!-- Inline folder companion for compact / laptop screens: settles in alongside
               the greeting so the physical folder and its actions remain present when
               the viewport is not wide enough for the corner dock. -->
          <div
            class="overview-folder-inline shrink-0"
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
                :scale="0.95"
                :hovered="folderHovered"
              />
            </div>

            <div
              class="folder-actions folder-actions--inline"
              :class="{ 'is-visible': folderHovered || branchPickerOpen }"
            >
              <button
                v-if="g.repo.value"
                type="button"
                class="folder-action"
                :class="{ 'is-active': branchPickerOpen }"
                aria-label="Switch branch"
                title="Switch branch"
                @click="openBranchPicker"
              >
                <HugeiconsIcon :icon="GitBranchIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                <span>Switch branch</span>
              </button>

              <button
                type="button"
                class="folder-action"
                aria-label="Reveal in Finder"
                title="Reveal in Finder"
                @click="onRevealProject"
              >
                <HugeiconsIcon :icon="AppleFinderIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                <span>Open in Finder</span>
              </button>
            </div>
          </div>
        </div>
        <GitSpaceChangesPanel
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
        <HomeRecentSessions
          :pinned="pinnedSessions"
          :recent="recentSessions"
          :loading="sessionsLoading"
          @open="onOpenStoredSession"
          @pin="togglePinnedSession"
          @archive="(id: string) => row()?.archiveSession(id)"
          @delete="(id: string) => row()?.removeSession(id)"
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

    <!-- A file's detail: it grows out of the clicked card (origin --ox/--oy) to
         fill the screen over everything else, then shrinks back on close. -->
    <Transition name="pop">
      <GitSpaceFileDetail
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

    <!-- Switch branch — the local-branch list in the same folder-picker shell. -->
    <ConversationBranchPickerModal
      v-if="branchPickerOpen"
      :project-path="project.path"
      :refresh="() => g.refresh()"
      @switched="onBranchSwitched"
      @cancel="branchPickerOpen = false"
    />

    <!-- Git Commit modal — 3-step progressive file select, AI generation & push -->
    <CommitModal
      v-if="commitModalOpen"
      :project-path="project.path"
      :branch="g.branch.value"
      :changes="changeItems"
      :refresh="() => g.refresh()"
      @close="commitModalOpen = false"
      @committed="() => { void g.refresh(); }"
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

  <!-- Away-from-thread status pills — the dynamic island. Perches bottom-right
       whenever a turn is still running (or has just settled) after you've left
       its conversation; names the conversation and what it's on — the current
       plan task when the thread has a checklist, else the live tool status — and
       reopens the thread on click. A sibling root for the same reason as the peek
       below: a fixed child of the sliding page would travel with it. -->
  <div v-if="pillThreads.length" class="pill-stack">
    <TurnStatusPill
      v-for="t in pillThreads"
      :key="t.key"
      :block="t.block"
      :thread-title="t.title"
      :brand="t.brand"
      :task="t.task"
      :now="agentNow"
      @open="onOpenPill(t.threadId)"
      @dismiss="onDismissThread(t.threadId, t.turnId)"
    />
  </div>

  <!-- The right-hand peek — a sibling root so it stays pinned to the viewport's
       right edge while `.project-main` slides left to uncover it (a fixed child
       of the translated stage would ride along with the slide). Sits below the
       stage (z-0) and steps aside for the file detail it opens. -->
  <GitSpaceChangePeek
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
/* ── Titlebar ─────────────────────────────────────────────────────────────── */
/* Full-width top band; the controls are absolutely placed within it. The band
   itself is pointer-transparent — it sits over the studio's own top-edge chrome
   (the strip's column index), and an empty 3.25rem bar was swallowing those
   clicks. Each control re-enables hits for itself. */
.project-chrome {
  position: absolute;
  inset: 0 0 auto;
  z-index: 40;
  height: 3.25rem;
  pointer-events: none;
}
.project-back-magnet,
.project-nav,
.project-avatar-slot {
  pointer-events: auto;
}
/* ── Back to launcher ─────────────────────────────────────────────────────── */
/* A quiet return glyph in the top-left corner — mirrors the folder's own perch
   in the bottom-left. Bare, no chrome; it rides the same magnet pull as the
   app's other buttons and brightens to full ink on hover. */
.project-back-magnet {
  position: absolute;
  top: 1.25rem;
  left: 2rem;
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
.project-avatar-slot {
  position: absolute;
  top: 1.25rem;
  right: 2rem;
  width: 30px;
  height: 30px;
}
.project-avatar {
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
  background-size: cover;
  background-position: center;
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
  position: absolute;
  top: 1.25rem;
  left: 50%;
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
/* The two surfaces (overview + git) are layers, not pages: both stay mounted for
   the project's lifetime and only one is visible at a time. Hiding is
   `visibility` (never display:none / v-if) so every layout box stays measurable
   while hidden. */
.project-main {
  height: 100vh;
  overflow: hidden;
  /* Above the peek (below this layer) so it covers the peek at rest; the slide
     below opens the gap it shows through. */
  position: relative;
  z-index: 30;
  /* The slide itself is the settings drawer's spring (driven by motion-v on
     <motion.main>); only the corner curve eases in CSS, alongside it. */
  transition: border-radius 0.4s cubic-bezier(0.22, 1, 0.36, 1);
  /* Project-home entrance cascade — read top → bottom, corner accents last.
     The fixed top row enters first as one beat: back arrow, centre nav and the
     profile chip all ride --proj-enter-back. Then the working tree reads in —
     greeting → changes → sessions — and finally the corner folder. Sessions
     hold until the history read resolves (no placeholder on this beat: a fast
     IPC would flash shimmer over the same slot the real rows should own), then
     inherit whatever of --proj-enter-sessions is still left. Child blocks
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
   (peek 420 − radius 18 = 402) so the rounded corners overlap only the panel's
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
/* The repository is the studio's peer on the centre nav, so it arrives the same
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
.folder-actions.is-visible,
.folder-actions:focus-within {
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

/* Inline companion for the project folder on compact / laptop screens.
   When the centered work column approaches the viewport boundary, the folder
   moves from the floating corner perch into the overview header next to the
   greeting, so its physical representation and actions stay accessible. */
.overview-folder-inline {
  display: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  animation: folder-inline-rise 0.4s cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: 120ms;
}

@keyframes folder-inline-rise {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.folder-actions--inline {
  flex-direction: row;
  align-items: center;
  gap: 14px;
  margin-top: 2px;
}

@media (max-width: 1440px) {
  .project-folder-row {
    display: none;
  }
  .overview-folder-inline {
    display: flex;
  }
}

@media (max-width: 860px) {
  .overview-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 20px;
  }
  .overview-folder-inline {
    align-items: flex-start;
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
  .sut-enter-active,
  .sut-leave-active {
    transition: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .archive-notice-enter-active,
  .archive-notice-leave-active {
    transition: none;
  }
}

.greet-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 40;
}
</style>
