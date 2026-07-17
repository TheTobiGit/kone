<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { usePreferredDark } from "@vueuse/core";
import type { RecentProject } from "~/composables/useRecentProjects";
import { ClickSpark } from "~/components/ui/click-spark";

const project = useProject();
const { recents, remember, forget, togglePin } = useRecentProjects();
const { reveal } = useReveal();
const { reset: resetClone } = useGitClone();

// Gate empty-vs-recent on mount so SSR and first client paint agree.
const mounted = ref(false);
onMounted(() => (mounted.value = true));
const showRecent = computed(() => mounted.value && recents.value.length > 0);

const pending = ref<"create" | "open" | "clone" | null>(null);
const pickerOpen = ref(false); // open-a-project browser
const cloneOpen = ref(false); // clone-from-github modal

function onStart(key: "create" | "open" | "clone") {
  if (pending.value) return;

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

  console.info(`[app-home] start: ${key}`);
}

function openProject(folder: { path: string; name: string }) {
  remember(folder);
  project.value = folder;
}

function onPicked(folder: { path: string; name: string }) {
  pickerOpen.value = false;
  pending.value = null;
  openProject(folder);
}

function onOpenRecent(recent: RecentProject) {
  openProject({ path: recent.path, name: recent.name });
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

const isDark = usePreferredDark();
const sparkColor = computed(() => (isDark.value ? "#ffffff" : "#000000"));
</script>

<template>
  <ClickSpark
    class="h-full min-h-screen"
    :spark-color="sparkColor"
    :spark-count="10"
    :spark-radius="18"
    :duration="480"
  >
    <ProjectView v-if="project" :project="project" @close="project = null" />
    <AppHomeRecent
      v-else-if="showRecent"
      :recents="recents"
      :pending="pending"
      @open="onOpenRecent"
      @start="onStart"
      @pin="togglePin"
      @reveal="onRevealRecent"
      @forget="forget"
    />
    <AppHomeEmpty v-else :pending="pending" @start="onStart" />

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
  </ClickSpark>
</template>
