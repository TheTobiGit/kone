<script setup lang="ts">
import { computed, ref } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { ClickSpark } from "~/components/ui/click-spark";

// App Home. First-run (empty) state until a project is opened; then it
// swaps to the opened-project view. Will branch across single / populated /
// many project states as data lands.
const project = useProject();

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

function onPicked(folder: { path: string; name: string }) {
  pickerOpen.value = false;
  pending.value = null;
  project.value = folder;
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
    <AppHomeEmpty v-else :pending="pending" @start="onStart" />

    <FolderPickerModal
      v-if="pickerOpen"
      @select="onPicked"
      @cancel="onPickerCancel"
    />
  </ClickSpark>
</template>
