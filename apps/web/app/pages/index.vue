<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { motion } from "motion-v";
import type { RecentProject } from "~/composables/useRecentProjects";
import { ClickSpark } from "~/components/ui/click-spark";

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
const pickerOpen = ref(false); // open-a-project browser
const cloneOpen = ref(false); // clone-from-github modal
const createOpen = ref(false); // create-new-project modal
const settingsOpen = ref(false); // settings / personalization drawer

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
  cue("press");
  openProject({ path: recent.path, name: recent.name });
}

// Opening a conversation from the cross-project sessions list: switch to its
// project and hand ProjectView the thread to resume once it mounts.
function onOpenSession(target: { path: string; name: string; threadId: string }) {
  cue("press");
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

const isDark = usePreferredDark();
const sparkColor = computed(() => (isDark.value ? "#ffffff" : "#000000"));

// The launcher slides aside to reveal the settings panel pinned to the left
// edge — the X account-drawer gesture. A straight translate, no scale: the page
// keeps its full size and just shifts right by the reveal width.
//
// That width isn't a constant: a settings pane that's a *page* (Providers)
// widens the panel, and the stage moves further to uncover it — so the same
// gesture reads as "step aside" for a list and "make room" for a page. The
// number comes from useSettingsSurface so the drawer and the stage can't drift.
const stageSpring = {
  type: "spring",
  stiffness: 520,
  damping: 26,
  mass: 0.8,
} as const;

const { revealWidth: settingsWidth, openPane } = useSettingsSurface();

function onOpenProfile() {
  cue("press");
  settingsOpen.value = true;
  openPane("profile");
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
</script>

<template>
  <ClickSpark
    class="relative h-full min-h-screen overflow-hidden bg-sunken"
    :spark-color="sparkColor"
    :spark-count="10"
    :spark-radius="18"
    :duration="480"
  >
    <!-- Settings panel, pinned to the left edge and revealed as the stage slides
         aside. It sits behind the stage (z-0) and shows through the gap. -->
    <SettingsDrawer :open="settingsOpen" @close="settingsOpen = false" />

    <!-- The launcher "stage": everything the user normally sees. When settings
         is open it slides straight right to uncover the panel — no scale, just a
         shift, the X account-drawer motion. -->
    <motion.div
      class="stage relative z-10 h-full min-h-screen bg-ground"
      :style="{ willChange: 'transform' }"
      :animate="{
        x: settingsOpen ? settingsWidth : 0,
        borderRadius: settingsOpen ? 26 : 0,
      }"
      :transition="stageSpring"
    >
      <div class="h-full min-h-screen overflow-hidden" :class="settingsOpen ? 'rounded-[26px]' : ''">
        <ProjectView
          v-if="project"
          :key="project.path"
          :project="project"
          @close="project = null"
          @profile="onOpenProfile"
        />
        <AppHomeRecent
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
        <AppHomeEmpty v-else :pending="pending" @start="onStart" @settings="settingsOpen = true" />
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

    <FolderPickerModal
      v-if="pickerOpen"
      @select="onPicked"
      @cancel="onPickerCancel"
    />

    <GitHubCloneModal
      v-if="cloneOpen"
      @clone="onCloned"
      @cancel="onCloneCancel"
    />

    <CreateProjectModal
      v-if="createOpen"
      @create="onCreated"
      @cancel="onCreateCancel"
    />
  </ClickSpark>
</template>
