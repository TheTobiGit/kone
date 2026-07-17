<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { usePreferredDark } from "@vueuse/core";
import type { RecentProject } from "~/composables/useRecentProjects";
import { ClickSpark } from "~/components/ui/click-spark";

const project = useProject();
const { recents, remember, forget, togglePin } = useRecentProjects();
const { reveal } = useReveal();

// Gate empty-vs-recent on mount so SSR and first client paint agree.
const mounted = ref(false);
onMounted(() => (mounted.value = true));
const showRecent = computed(() => mounted.value && recents.value.length > 0);

const pending = ref<"create" | "open" | "clone" | null>(null);
const pickerOpen = ref(false);

function onStart(key: "create" | "open" | "clone") {
  if (pending.value) return;

  if (key === "open") {
    pending.value = "open";
    pickerOpen.value = true;
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
    <ProjectView
      v-if="project"
      :project="project"
      @close="project = null"
    />
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
  </ClickSpark>
</template>
