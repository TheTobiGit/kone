<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import type { RecentProject } from "~/composables/useRecentProjects";
import IntentMenu from "~/components/intent/IntentMenu.vue";
import { resolveTop } from "~/utils/surfaceTop";
import {
  DEFAULT_TYPOGRAPHY_PREFS,
  MAX_INTERFACE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
} from "~/theme/typography";
import type { SurfaceId } from "~/utils/surfaceTop";
import { requestSearchJump } from "~/composables/useSearchJump";
import type { SearchJumpRequest } from "~/components/conversation/ConversationSearchModal.vue";

const project = useProject();
const { recents, forget, togglePin } = useRecentProjects();
const openProject = useOpenProject();
const { reveal } = useReveal();
const { reset: resetClone } = useGitClone();
const { reset: resetCreate } = useCreateProject();
const { cue } = useSound();

// Gate empty-vs-recent on mount so SSR and first client paint agree.
const mounted = ref(false);
onMounted(() => (mounted.value = true));
const showRecent = computed(() => mounted.value && recents.value.length > 0);

const pending = ref<"create" | "open" | "clone" | null>(null);
// The launcher modals (folder picker, clone, create) have no shared store,
// so the flags live here beside the resolveTop call that reads them. Children
// take the resulting surfaceTop as a prop and import only the SurfaceId type.
const pickerOpen = ref(false);
const cloneOpen = ref(false);
const createOpen = ref(false);
// The one shortcut gate: while a launcher modal owns the screen, no summon
// hotkey (studio, inbox, settings, assistant) may fire underneath it.
const isLauncherModalOpen = computed(
  () => pickerOpen.value || cloneOpen.value || createOpen.value,
);

function onStart(key: "create" | "open" | "clone") {
  if (pending.value) return;

  // Acknowledge the chosen way to begin — one soft press as the flow commits.
  cue("press");

  if (key === "open") {
    pending.value = "open";
    pickerOpen.value = true;
    return;
  }

  if (key === "clone") {
    pending.value = "clone";
    cloneOpen.value = true;
    return;
  }

  if (key === "create") {
    pending.value = "create";
    createOpen.value = true;
    return;
  }
}

function onPicked(folder: { path: string; name: string }) {
  pickerOpen.value = false;
  pending.value = null;
  openProject(folder);
}

function onOpenRecent(recent: RecentProject) {
  cue("open");
  openProject({ path: recent.path, name: recent.name });
}

// Opening a conversation from the cross-project sessions list: switch to its
// project and hand ProjectView the thread to resume once it mounts.
function onOpenSession(target: {
  path: string;
  name: string;
  threadId: string;
}) {
  cue("open");
  openProject({ path: target.path, name: target.name }, target.threadId);
}

// ── conversation search ─────────────────────────────────────────────────────
// The palette over every page: one query across all conversations, then a jump
// to the match. Navigation reuses the pending-thread path above — the studio
// row takes the request reactively whether its project is already open or is
// opening now — with the matched row parked in the jump state so the thread
// view can reveal it once its transcript lands.
const searchOpen = ref(false);

function onSearchJump(req: SearchJumpRequest) {
  if (req.blockId) requestSearchJump(req.threadId, req.blockId);
  openProject({ path: req.projectPath, name: req.projectName }, req.threadId);
}

// Pin/unpin is the one launcher toggle worth a sound — a discrete state flip.
function onTogglePin(path: string) {
  cue("toggle");
  togglePin(path);
}

function onRevealRecent(path: string) {
  void reveal(path);
}

function onPickerCancel() {
  pickerOpen.value = false;
  pending.value = null;
}

// ── clone from GitHub ────────────────────────────────────────────────────────
// The clone modal owns its whole flow now — the destination browser morphs into
// its own card, so there's no separate picker for the page to juggle. It only
// tells us when a clone finished (open it) or was cancelled.
function onCloned(folder: { path: string; name: string }) {
  cue("success");
  cloneOpen.value = false;
  pending.value = null;
  resetClone();
  openProject(folder);
}
function onCloneCancel() {
  cloneOpen.value = false;
  pending.value = null;
  resetClone();
}

// ── create a new project ─────────────────────────────────────────────────────
// Like the clone modal, the create modal owns its whole flow (the location
// browser morphs into its own card). It only tells us when a project was
// created (open it) or the flow was cancelled.
function onCreated(folder: { path: string; name: string }) {
  cue("success");
  createOpen.value = false;
  pending.value = null;
  resetCreate();
  openProject(folder);
}
function onCreateCancel() {
  createOpen.value = false;
  pending.value = null;
  resetCreate();
}

// The launcher slides aside to reveal the settings panel pinned to the left
// edge — the X account-drawer gesture. A straight translate, no scale: the page
// keeps its full size and just shifts right by the reveal width.
//
// That width isn't a constant: a settings pane that's a *page* (Providers)
// widens the panel, and the stage moves further to uncover it — so the same
// gesture reads as "step aside" for a list and "make room" for a page. The
// number comes from useSettingsSurface so the drawer and the stage can't drift.
//
// Only the translate rides the spring. The corner rounding snaps instead of
// animating: border-radius is a paint property, so easing it on a layer holding
// the whole launcher repaints that layer every frame — the slide would fight a
// full repaint to win each one. The radius is small and at the left edge, where
// the eye is already on the moving edge, so it reads as part of the gesture
// without the per-frame cost.
const stageSpring = {
  type: "spring",
  stiffness: 520,
  damping: 26,
  mass: 0.8,
} as const;

const {
  revealWidth: settingsWidth,
  openPane,
  isOpen: settingsOpen,
  closeDrawer,
  openDrawer,
} = useSettingsSurface();

function onOpenProfile() {
  cue("press");
  openDrawer("profile");
}

// ── portals: the studio plane and the inbox ─────────────────────────────────
// One layer over every page, each mounted once for the life of the app. ⌘B
// summons the studio from wherever you are — a project page or the launcher —
// because the work it holds is not any one page's; a project's row keeps
// running whether or not its page is on screen. ⌘I summons the inbox, the
// studio's opposite number: the same work ordered by what it wants from you,
// which deliberately never shares the screen with the work surface. The handoff
// between them (timers, mid-switch dismissal, the fade length the CSS reads)
// lives in usePortals; this page only binds its state and answers its keys.
//
// Leaving a portal by hand (Escape, close button) dismisses through the same
// path, so dismissing the inbox mid-switch reveals the plane underneath
// instead of letting the pending switch carry through to the page. A covered
// portal stays painted underneath but takes no keys and no focus, so one
// Escape never dismisses both.
const {
  studioOpen,
  activePortal,
  fadeStyle,
  summon,
  dismiss,
  toggleStudio,
  toggleInbox,
  toggleBench,
  portalState,
  pendingThreadJump,
  jumpToThread,
  clearThreadJump,
} = usePortals();
// Bound once so the template reads stable values instead of calling
// portalState on every render.
const studioState = computed(() => portalState("studio"));
const inboxState = computed(() => portalState("inbox"));
const benchState = computed(() => portalState("bench"));
// The page under the plane, so a row's request for something the page owns (a
// file's diff) can be handed down to it.
const pageRef = ref<{
  openFile: (p: string, r: DOMRect | null) => void;
} | null>(null);

// A row asked for something the page owns. The plane has already stepped aside
// by the time this arrives, so it lands on the page that was underneath all
// along — and is simply dropped when there is no project page to receive them.
function onStudioOpenFile(path: string, rect: DOMRect | null) {
  pageRef.value?.openFile(path, rect);
}

// The assistant's card is mounted only while it is up, the way every other
// modal on this page is: the shell's exit animation is played by the card
// itself, and a card that is never unmounted has no entrance left to play.
const { isOpen: assistantOpen, toggle: toggleAssistant } = useGlobalAssistant();

// ── intent menu: the right-click layer ─────────────────────────────────────
// One global menu instead of another surface. Signal gathering, timing and
// dispatch live in useIntentHost; this page only wires its launcher-modal
// flags and open flows, and renders the teleport below.
const intent = useIntentHost({
  project,
  activePortal,
  settingsOpen,
  pickerOpen,
  cloneOpen,
  createOpen,
  onStart,
  summon,
  dismiss,
  openProject,
  onOpenSession,
});

// ── viewport surface stack ─────────────────────────────────────────────────
// One verdict for which layer owns Escape, derived here because this page
// holds every flag it depends on. Each surface takes it as a prop and stays
// quiet unless named, so one press dismisses exactly the topmost layer.
const surfaceTop = computed<SurfaceId>(() =>
  resolveTop({
    launcherModal: isLauncherModalOpen.value,
    intentMenu: intent.isOpen.value,
    assistant: assistantOpen.value,
    bench: activePortal.value === "bench",
    inbox: activePortal.value === "inbox",
    studio: activePortal.value === "studio",
    settings: settingsOpen.value,
  }),
);

const { matchesShortcut } = useShortcuts();
const { prefs: typePrefs, setSize: setTypeSize } = useTypography();
// One listener for the four summon hotkeys, so the blocking rule is stated
// once: while a launcher modal owns the screen the plane, the inbox, the
// drawer and the assistant would all open underneath it, so none of them
// fires. Portals stay summonable while settings is revealed, and the studio
// key still means go-to-studio while the inbox is up (see toggleStudio).
function onSurfaceHotkey(e: KeyboardEvent) {
  if (matchesShortcut("search-conversations", e)) {
    if (isLauncherModalOpen.value) return;
    e.preventDefault();
    cue("press");
    searchOpen.value = !searchOpen.value;
    return;
  }
  // While the palette stands open it owns the keys — no portal summons, no
  // drawer toggles underneath it. Its own Escape is consumed by the card.
  if (searchOpen.value) return;
  if (matchesShortcut("open-studio", e)) {
    if (isLauncherModalOpen.value) return;
    e.preventDefault();
    toggleStudio();
    return;
  }
  if (matchesShortcut("open-inbox", e)) {
    if (isLauncherModalOpen.value) return;
    e.preventDefault();
    toggleInbox();
    return;
  }
  if (matchesShortcut("open-bench", e)) {
    if (isLauncherModalOpen.value) return;
    e.preventDefault();
    toggleBench();
    return;
  }
  // ⌘, — the macOS "Preferences" shortcut — toggles the settings drawer, so
  // the same keystroke opens and closes it (Escape walks it back via the
  // drawer). The binding lives in the shortcuts registry (see useShortcuts),
  // so a rebind in settings takes effect here automatically.
  if (matchesShortcut("toggle-settings", e)) {
    if (isLauncherModalOpen.value) return;
    e.preventDefault();
    cue("press");
    settingsOpen.value = !settingsOpen.value;
    return;
  }
  if (matchesShortcut("open-assistant", e)) {
    if (isLauncherModalOpen.value) return;
    e.preventDefault();
    cue("press");
    toggleAssistant();
    return;
  }
  // The interface scale, on the keys every app zooms with.
  const scale = matchesShortcut("zoom-in", e)
    ? typePrefs.value.sizeInterface + 1
    : matchesShortcut("zoom-out", e)
      ? typePrefs.value.sizeInterface - 1
      : matchesShortcut("zoom-reset", e)
        ? DEFAULT_TYPOGRAPHY_PREFS.sizeInterface
        : null;
  if (scale !== null) {
    e.preventDefault();
    const next = Math.min(MAX_INTERFACE_FONT_SIZE, Math.max(MIN_INTERFACE_FONT_SIZE, scale));
    if (next === typePrefs.value.sizeInterface) return;
    setTypeSize("interface", next);
    cue("select");
  }
}
onMounted(() => window.addEventListener("keydown", onSurfaceHotkey));
onBeforeUnmount(() => window.removeEventListener("keydown", onSurfaceHotkey));

// The desktop shell's own summon (tray / app menu). It is listened for here
// rather than inside the card because the card is not there to hear it when
// the assistant is away, which is precisely when it is being called for.
onMounted(() => {
  if (!import.meta.client) return;
  const onToggle = window.koneDesktop?.window?.onAssistantToggle;
  if (!onToggle) return;
  const unsub = onToggle(() => toggleAssistant());
  onBeforeUnmount(unsub);
});

// ── global attention bots ────────────────────────────────────────────────────
// Every parked thread in the app, one bot each, top-right over any surface.
// Picking one abandons whatever flow is up (a parked thread outranks picking a
// folder) and lands the inbox on that thread, where its ask answers inline.
// Declarative throughout: overlays fall as state, the orchestrator records the
// jump and summons the inbox, and the inbox routes it out of that state — no
// component ref, no method call across the tree.
function onAttentionOpen(projectPath: string, threadId: string) {
  pickerOpen.value = false;
  cloneOpen.value = false;
  createOpen.value = false;
  pending.value = null;
  if (assistantOpen.value) toggleAssistant();
  jumpToThread({ projectPath, threadId });
}
</script>

<template>
  <div
    class="relative h-full min-h-[var(--app-h)] overflow-hidden bg-sunken"
    :style="fadeStyle"
    @contextmenu="intent.open"
  >
    <!-- Settings panel, pinned to the left edge and revealed as the stage slides
         aside. It sits behind the stage (z-0) and shows through the gap. -->
    <SettingsDrawer
      :open="settingsOpen"
      :surface-top="surfaceTop"
      @close="settingsOpen = false"
    />

    <!-- The launcher "stage": everything the user normally sees. When settings
         is open it slides straight right to uncover the panel — no scale, just a
         shift, the X account-drawer motion. -->
    <motion.div
      class="stage relative z-10 h-full min-h-[var(--app-h)] overflow-hidden bg-ground"
      :style="{ willChange: 'transform' }"
      :class="settingsOpen ? 'rounded-[26px]' : ''"
      :animate="{ x: settingsOpen ? settingsWidth : 0 }"
      :transition="stageSpring"
    >
      <!-- Everything the drawer stands in front of. Inert while it is open, so
           the work underneath cannot be tabbed into, clicked or read out while
           it is only visible: the drawer is modal, and pointer, keyboard and
           screen reader all have to say so. The veil below is a sibling rather
           than a child for exactly this reason — it stays clickable. -->
      <div
        class="relative h-full min-h-[var(--app-h)] overflow-hidden"
        :class="settingsOpen ? 'rounded-[26px]' : ''"
        :inert="settingsOpen"
      >
        <ProjectView
          v-if="project"
          ref="pageRef"
          :key="project.path"
          :project="project"
          :studio-open="studioOpen"
          @close="project = null"
          @profile="onOpenProfile"
          @summon="() => summon('studio')"
        />
        <HomeRecent
          v-else-if="showRecent"
          :recents="recents"
          :pending="pending"
          @open="onOpenRecent"
          @start="onStart"
          @pin="onTogglePin"
          @reveal="onRevealRecent"
          @forget="forget"
          @open-session="onOpenSession"
          @settings="settingsOpen = true"
          @profile="onOpenProfile"
        />
        <HomeEmpty
          v-else
          :pending="pending"
          @start="onStart"
          @settings="settingsOpen = true"
        />

        <!-- The studio plane, over whichever page is showing. Unkeyed and never
             unmounted: the pages above are keyed on their project path and go
             away on a switch, while the rows in here have to keep their turns
             folding and their terminals alive. -->
        <StudioAppStudio
          :state="studioState"
          :surface-top="surfaceTop"
          :active-project="project"
          @summon="() => summon('studio')"
          @close="() => dismiss('studio')"
          @open-file="onStudioOpenFile"
        />

        <!-- The inbox, over both the page and the plane. Mounted once alongside
             them for the same reason: whatever it comes to hold is not any one
             page's, and it has to survive a project switch. -->
        <InboxAppInbox
          :state="inboxState"
          :surface-top="surfaceTop"
          :pending-jump="pendingThreadJump"
          @close="() => dismiss('inbox')"
          @jump-consumed="clearThreadJump"
        />

        <!-- The bench, over both. Mounted once like its siblings: the queue it
             holds belongs to a project, but the portal outlives any one page,
             and a job keeps running whether or not its project is on screen. -->
        <BenchAppBench
          :state="benchState"
          :surface-top="surfaceTop"
          @close="() => dismiss('bench')"
        />

      </div>

      <!-- While open, tapping the shoved-aside stage closes the drawer. It sits
           above everything the stage holds — the page (z-30), the studio plane
           (z-40), the pill stack and the inbox (z-45), the bench (z-46) — so a
           tap on the shoved-aside work dismisses the drawer instead of landing
           on the work underneath. A drawer that can only be left by keyboard is
           a trap: with an opaque portal up, this is the only pointer path back.
           The keyboard half of the same contract is the `inert` above, and the
           surface order in surfaceTop, which both put the drawer in front of
           every portal while it is open — a veil that ate pointer events while
           keys still reached the portal underneath was modal to the mouse and
           modeless to the keyboard. -->
      <button
        v-if="settingsOpen"
        type="button"
        class="absolute inset-0 z-[50] cursor-pointer"
        aria-label="Close settings"
        @click="settingsOpen = false"
      />

      <!-- Every parked thread's bot, top-right over whatever is showing, the
           veil included: a parked thread outranks every other flow, so tapping
           one still jumps straight to its thread. Outside the inert wrapper for
           that reason, but still inside the stage — the bots are `fixed` and the
           stage's transform is their containing block, so they slide with it. -->
      <AttentionGlobalBots @open="onAttentionOpen" />
    </motion.div>

    <UiFolderPickerModal
      v-if="pickerOpen"
      @select="onPicked"
      @cancel="onPickerCancel"
    />

    <UiGitHubCloneModal
      v-if="cloneOpen"
      @clone="onCloned"
      @cancel="onCloneCancel"
    />

    <ProjectCreateProjectModal
      v-if="createOpen"
      @create="onCreated"
      @cancel="onCreateCancel"
    />

    <AssistantGlobalAssistantModal
      v-if="assistantOpen"
      :surface-top="surfaceTop"
    />

    <!-- The conversation-search palette, over every page. Mounted only while
         up, the way the assistant card is: the shell plays its own exit and a
         card that is never unmounted has no entrance left to play. -->
    <ConversationSearchModal
      v-if="searchOpen"
      @jump="onSearchJump"
      @close="searchOpen = false"
    />

    <!-- The intent menu: teleported so the stage slide never re-anchors its
         fixed position, above every portal while it is up. -->
    <Teleport to="body">
      <IntentMenu
        v-if="intent.isOpen.value"
        :x="intent.x.value"
        :y="intent.y.value"
        :title="intent.title.value"
        :sections="intent.sections.value"
        :shown="intent.shown.value"
        :surface-top="surfaceTop"
        @pick="intent.pick"
        @close="intent.close"
      />
    </Teleport>

    <!-- Renderer-drawn window caption for frameless shells (win32/linux).
         Teleported for the same reason as the intent menu: `fixed` must stay
         window-anchored when the stage slides. Renders nothing on macOS/web. -->
    <Teleport to="body">
      <UiWindowCaption />
    </Teleport>
  </div>
</template>
