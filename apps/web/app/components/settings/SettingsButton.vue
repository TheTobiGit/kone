<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Settings02Icon } from "@hugeicons/core-free-icons";

// Opens the settings / personalization drawer. Sits among the launcher's
// header controls; the panel it summons lives in SettingsDrawer.
const emit = defineEmits<{ open: [] }>();
const { cue } = useSound();

function onClick() {
  cue("press");
  emit("open");
}
</script>

<template>
  <button
    type="button"
    aria-label="Settings and personalization"
    title="Settings"
    class="flex size-9 cursor-pointer items-center justify-center rounded-[11px] text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none"
    @click="onClick"
  >
    <HugeiconsIcon
      :icon="Settings02Icon"
      :size="16"
      :stroke-width="1.8"
      aria-hidden="true"
    />
  </button>
</template>
