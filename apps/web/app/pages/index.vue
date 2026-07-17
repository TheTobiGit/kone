<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { usePreferredDark } from "@vueuse/core";
import type { RecentProject } from "~/composables/useRecentProjects";
import { ClickSpark } from "~/components/ui/click-spark";

// App Home. First-run (empty) state until a project has ever been opened; once
// the recents list has entries (persisted across quits) the home shows the
// populated launcher. Opening a project swaps to the opened-project view.
const project = useProject();
const { recents, remember, forget } = useRecentProjects();

// Recents live in localStorage, which is only readable on the client. Gate the
// empty-vs-populated choice on mount so SSR (nuxt dev) and the first client
// paint agree, then let it settle to the real state.
const mounted = ref(false);
onMounted(() => (mounted.value = true));
const showRecent = computed(() => mounted.value && recents.value.length > 0);

// Action currently in session — locks the row so only one runs at a time.
const pending = ref<"create" | "open" | "clone" | null>(null);
// Whether the in-app folder browser is open.
const pickerOpen = ref(false);

function onStart(key: "create" | "open" | "clone") {
  if (pending.value) return;

  if (key === "open") {
    // Custom in-app folder browser (not the native dialog).
    pending.value = "open";
    pickerOpen.value = true;
    return;
  }

  // Create / clone wiring lands with the desktop bridge.
  console.info(`[app-home] start: ${key}`);
}

function openProject(folder: { path: string; name: string }) {
  // Record (or bump) the project in recents before opening, so it survives the
  // next quit and heads the launcher grid on return.
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

function onPickerCancel() {
  pickerOpen.value = false;
  pending.value = null;
}

// Sparks read against the ground: white on dark, black on light.
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
      @forget="forget"
      @start="onStart"
    />
    <AppHomeEmpty v-else :pending="pending" @start="onStart" />

    <FolderPickerModal
      v-if="pickerOpen"
      @select="onPicked"
      @cancel="onPickerCancel"
    />
  </ClickSpark>
</template>
