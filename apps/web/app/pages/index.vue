<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import type { RecentProject } from "~/composables/useRecentProjects";

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
const pickerOpen = ref(false);
const cloneOpen = ref(false); // clone-from-github modal
const createOpen = ref(false); // create-new-project modal

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
function onOpenSession(target: { path: string; name: string; threadId: string }) {
  cue("open");
  openProject({ path: target.path, name: target.name }, target.threadId);
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

// ── the studio plane ─────────────────────────────────────────────────────────
// One layer over every page, mounted once for the life of the app. ⌘B summons it
// from wherever you are — a project page or the launcher — because the work it
// holds is not any one page's; a project's row keeps running whether or not its
// page is on screen.
const studioOpen = ref(false);
// The page under the plane, so a row's request for something the page owns (a
// file's diff, the branch picker) can be handed down to it.
const pageRef = ref<{ openFile: (p: string, r: DOMRect | null) => void; openBranch: () => void } | null>(null);

// Portal-to-portal handoff. The inbox paints over the plane, so the two
// directions stage differently — but neither ever shows the page between them,
// and both answer at once. Going up, the inbox fades in over the still-opaque
// plane, and the plane only leaves once the inbox is opaque. Going down, the
// plane appears instantly underneath (it drops its fade while covered) and the
// inbox fades out over it on the next frame, so visible progress starts in one
// frame rather than one fade.
// PORTAL_FADE_MS is the fade itself and the only place its length is stated: it
// drives the CSS fades through --portal-fade-ms, so the timer and the fade
// cannot drift. The upward handoff waits a frame past the fade so the plane
// only leaves once the inbox is fully opaque; waiting a shade long only
// leaves an invisible layer briefly, while firing early would flash the page.
const PORTAL_FADE_MS = 220;
const PORTAL_HANDOFF_MS = PORTAL_FADE_MS + 10;
let portalHandoff: ReturnType<typeof setTimeout> | null = null;
let portalRaf: ReturnType<typeof requestAnimationFrame> | null = null;
function cancelPortalHandoff() {
  if (portalHandoff !== null) {
    clearTimeout(portalHandoff);
    portalHandoff = null;
  }
  if (portalRaf !== null) {
    cancelAnimationFrame(portalRaf);
    portalRaf = null;
  }
}
// Any new portal intent abandons the previous switch, so its pending timer
// cannot carry through to the page after the user has already moved on.
function abandonPortalSwitch() {
  cancelPortalHandoff();
}
onBeforeUnmount(cancelPortalHandoff);

function summonStudio() {
  if (studioOpen.value && !inboxOpen.value) return;
  abandonPortalSwitch();
  cue("expand");
  if (inboxOpen.value) {
    // Instant underneath, fading inbox over it on the next frame: the plane
    // paints opaque while still covered, so the inbox fade composites over
    // work rather than over the page — and over a paint, not a timer.
    studioOpen.value = true;
    portalRaf = requestAnimationFrame(() => {
      portalRaf = null;
      inboxOpen.value = false;
    });
  } else {
    studioOpen.value = true;
  }
}

// A row asked for something the page owns. The plane has already stepped aside
// by the time these arrive, so they land on the page that was underneath all
// along — and are simply dropped when there is no project page to receive them.
function onStudioOpenFile(path: string, rect: DOMRect | null) {
  pageRef.value?.openFile(path, rect);
}
function onStudioOpenBranch() {
  pageRef.value?.openBranch();
}

const { matchesShortcut: matchesStudioHotkey } = useShortcuts();
function onStudioHotkey(e: KeyboardEvent) {
  if (!matchesStudioHotkey("open-studio", e)) return;
  // Not while a launcher modal owns the screen — the plane would cover it.
  if (pickerOpen.value || cloneOpen.value || createOpen.value) return;
  e.preventDefault();
  // While the inbox is up it is the frontmost thing, so the studio key means
  // "go to the studio" rather than toggling a plane nobody can see.
  if (studioOpen.value && !inboxOpen.value) {
    abandonPortalSwitch();
    studioOpen.value = false;
  } else summonStudio();
}
onMounted(() => window.addEventListener("keydown", onStudioHotkey));
onBeforeUnmount(() => window.removeEventListener("keydown", onStudioHotkey));

// ── the inbox ────────────────────────────────────────────────────────────────
// The studio's opposite number: the same work, ordered by what it wants from you
// rather than by where it lives. ⌘I summons it, and it deliberately never shares
// the screen with the work surface — summoning it sends the plane away, and
// leaving it returns you to the page underneath.
const inboxOpen = ref(false);

function summonInbox() {
  if (inboxOpen.value && !studioOpen.value) return;
  abandonPortalSwitch();
  cue("expand");
  if (studioOpen.value) {
    // The inbox fades in over the still-opaque plane; sending the plane away
    // once the inbox is opaque hides it underneath, out of sight.
    inboxOpen.value = true;
    portalHandoff = setTimeout(() => {
      studioOpen.value = false;
      portalHandoff = null;
    }, PORTAL_HANDOFF_MS);
  } else {
    inboxOpen.value = true;
  }
}

const { matchesShortcut: matchesInboxHotkey } = useShortcuts();
function onInboxHotkey(e: KeyboardEvent) {
  if (!matchesInboxHotkey("open-inbox", e)) return;
  // Not while a launcher modal owns the screen — the inbox would cover it.
  if (pickerOpen.value || cloneOpen.value || createOpen.value) return;
  e.preventDefault();
  // Dismissing mid-handoff (both flags up) lands back on the still-open plane
  // rather than letting the handoff carry through to the page.
  if (inboxOpen.value) {
    abandonPortalSwitch();
    inboxOpen.value = false;
  } else summonInbox();
}
onMounted(() => window.addEventListener("keydown", onInboxHotkey));
onBeforeUnmount(() => window.removeEventListener("keydown", onInboxHotkey));

// Escape closes one layer: the inbox while it is open, otherwise the plane's
// overview-then-close path answers. The plane is suspended while the inbox is
// up so one press never dismisses both. Leaving a portal by hand (Escape,
// close button) cancels the handoff first so dismissing the inbox mid-switch
// reveals the plane underneath instead of letting the pending timer carry
// through to the page.
function closeStudio() {
  abandonPortalSwitch();
  studioOpen.value = false;
}
function closeInbox() {
  abandonPortalSwitch();
  inboxOpen.value = false;
}
// ⌘, — the macOS "Preferences" shortcut — toggles the settings drawer, so the
// same keystroke opens and closes it (Escape also closes, via the drawer). The
// binding lives in the shortcuts registry (see useShortcuts), so a rebind in
// settings takes effect here automatically. We don't fight it while another
// overlay owns the screen.
const { matchesShortcut: matchesSettingsHotkey } = useShortcuts();
function onSettingsHotkey(e: KeyboardEvent) {
  if (!matchesSettingsHotkey("toggle-settings", e)) return;
  if (pickerOpen.value || cloneOpen.value || createOpen.value) return;
  e.preventDefault();
  cue("press");
  settingsOpen.value = !settingsOpen.value;
}
onMounted(() => window.addEventListener("keydown", onSettingsHotkey));
onBeforeUnmount(() => window.removeEventListener("keydown", onSettingsHotkey));

// The assistant's card is mounted only while it is up, the way every other
// modal on this page is: the shell's exit animation is played by the card
// itself, and a card that is never unmounted has no entrance left to play.
const { isOpen: assistantOpen, toggle: toggleAssistant } = useGlobalAssistant();
const { matchesShortcut: matchesAssistantHotkey } = useShortcuts();
function onAssistantHotkey(e: KeyboardEvent) {
  if (!matchesAssistantHotkey("open-assistant", e)) return;
  if (pickerOpen.value || cloneOpen.value || createOpen.value) return;
  e.preventDefault();
  cue("press");
  toggleAssistant();
}
onMounted(() => window.addEventListener("keydown", onAssistantHotkey));
onBeforeUnmount(() => window.removeEventListener("keydown", onAssistantHotkey));

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
</script>

<template>
  <div
    class="relative h-full min-h-screen overflow-hidden bg-sunken"
    :style="{ '--portal-fade-ms': `${PORTAL_FADE_MS}ms` }"
  >
    <!-- Settings panel, pinned to the left edge and revealed as the stage slides
         aside. It sits behind the stage (z-0) and shows through the gap. -->
    <SettingsDrawer :open="settingsOpen" @close="settingsOpen = false" />

    <!-- The launcher "stage": everything the user normally sees. When settings
         is open it slides straight right to uncover the panel — no scale, just a
         shift, the X account-drawer motion. -->
    <motion.div
      class="stage relative z-10 h-full min-h-screen overflow-hidden bg-ground"
      :style="{ willChange: 'transform' }"
      :class="settingsOpen ? 'rounded-[26px]' : ''"
      :animate="{ x: settingsOpen ? settingsWidth : 0 }"
      :transition="stageSpring"
    >
      <div class="relative h-full min-h-screen overflow-hidden" :class="settingsOpen ? 'rounded-[26px]' : ''">
        <ProjectView
          v-if="project"
          ref="pageRef"
          :key="project.path"
          :project="project"
          :studio-open="studioOpen"
          @close="project = null"
          @profile="onOpenProfile"
          @summon="summonStudio"
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
        <HomeEmpty v-else :pending="pending" @start="onStart" @settings="settingsOpen = true" />

        <!-- The studio plane, over whichever page is showing. Unkeyed and never
             unmounted: the pages above are keyed on their project path and go
             away on a switch, while the rows in here have to keep their turns
             folding and their terminals alive. -->
        <StudioAppStudio
          :open="studioOpen"
          :active-project="project"
          :suspended="inboxOpen"
          @summon="summonStudio"
          @close="closeStudio"
          @open-file="onStudioOpenFile"
          @open-branch="onStudioOpenBranch"
        />

        <!-- The inbox, over both the page and the plane. Mounted once alongside
             them for the same reason: whatever it comes to hold is not any one
             page's, and it has to survive a project switch. -->
        <InboxAppInbox :open="inboxOpen" @close="closeInbox" />
      </div>

      <!-- While open, tapping the shoved-aside stage closes the drawer (and
           blocks the launcher underneath from being clicked). -->
      <button
        v-if="settingsOpen"
        type="button"
        class="absolute inset-0 z-50 cursor-pointer"
        aria-label="Close settings"
        @click="settingsOpen = false"
      />
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

    <AssistantGlobalAssistantModal v-if="assistantOpen" />
  </div>
</template>
