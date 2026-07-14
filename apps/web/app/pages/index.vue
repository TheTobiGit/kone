<script setup lang="ts">
import { computed } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { ClickSpark } from "~/components/ui/click-spark";

// App Home. Currently first-run (empty) state; will branch across
// single / populated / many project states as data lands.
function onStart(key: string) {
  // Wiring for project creation/open/clone lands with the desktop bridge.
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
    <AppHomeEmpty @start="onStart" />
  </ClickSpark>
</template>
