<script setup lang="ts">
import { computed, ref } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { ClickSpark } from "~/components/ui/click-spark";

// App Home. First-run (empty) state until a project is opened; then it
// swaps to the opened-project view. Will branch across single / populated /
// many project states as data lands.
const project = useProject();
const { openFolder } = useDesktop();

// Action currently in session — locks the row so only one runs at a time.
const pending = ref<"create" | "open" | "clone" | null>(null);

async function onStart(key: "create" | "open" | "clone") {
  if (pending.value) return;

  if (key === "open") {
    pending.value = "open";
    try {
      const opened = await openFolder();
      if (opened) {
        project.value = opened;
      }
    } finally {
      pending.value = null;
    }
    return;
  }

  // Create / clone wiring lands with the desktop bridge.
  console.info(`[app-home] start: ${key}`);
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
  </ClickSpark>
</template>
