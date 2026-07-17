<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { VolumeHighIcon, VolumeMute01Icon } from "@hugeicons/core-free-icons";

// Discreet mute switch for the launcher's interaction sounds. Sits among the
// header controls; the preference (and the toggle) live in useSound.
const { muted, toggleMuted } = useSound();
</script>

<template>
  <button
    type="button"
    :aria-label="muted ? 'Unmute sounds' : 'Mute sounds'"
    :aria-pressed="muted"
    :title="muted ? 'Unmute sounds' : 'Mute sounds'"
    class="flex size-9 cursor-pointer items-center justify-center rounded-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
    @click="toggleMuted"
  >
    <HugeiconsIcon
      :icon="muted ? VolumeMute01Icon : VolumeHighIcon"
      :size="15"
      :stroke-width="1.8"
      aria-hidden="true"
    />
  </button>
</template>
