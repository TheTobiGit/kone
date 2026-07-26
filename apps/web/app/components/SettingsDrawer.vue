<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { VolumeHighIcon, VolumeMute01Icon } from "@hugeicons/core-free-icons";

// The settings / personalization panel, in the spirit of X's account drawer.
// It doesn't float over the launcher — it sits pinned to the left edge, and the
// launcher itself slides aside (see index.vue's stage) to reveal it. So this is
// just the panel surface; the reveal lives upstream. Controls settle at the
// bottom; sound is the first of them.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { muted, toggleMuted, cue } = useSound();

function onSoundToggle() {
  toggleMuted();
  // If we just switched sound back on, confirm it with a soft cue (a no-op the
  // other way, since cues stay silent while muted).
  cue("toggle");
}

function onKeydown(e: KeyboardEvent) {
  if (props.open && e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <aside
    class="fixed inset-y-0 left-0 z-0 flex w-[320px] max-w-[80vw] flex-col overflow-y-auto bg-sunken px-5 pt-16 pb-7"
    :aria-hidden="!open"
    role="dialog"
    aria-label="Settings and personalization"
  >
    <!-- Controls sit at the foot of the panel. Sound is the first. Only the
         switch itself toggles — the label and icon are inert. -->
    <div class="mt-auto flex items-center justify-between gap-4">
      <span class="flex items-center gap-3">
        <HugeiconsIcon
          :icon="muted ? VolumeMute01Icon : VolumeHighIcon"
          :size="17"
          :stroke-width="1.7"
          class="text-ink-soft"
          aria-hidden="true"
        />
        <span class="text-[15px] leading-tight text-ink">Interaction sounds</span>
      </span>

      <!-- Track + knob. On (audible) fills with ink; off rests quiet. -->
      <button
        type="button"
        role="switch"
        aria-label="Interaction sounds"
        :aria-checked="!muted"
        :tabindex="open ? 0 : -1"
        class="switch relative inline-flex h-[24px] w-[42px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none"
        :style="{
          backgroundColor: muted
            ? 'color-mix(in srgb, var(--ink) 14%, transparent)'
            : 'var(--ink)',
        }"
        @click="onSoundToggle"
      >
        <span
          class="knob absolute size-[20px] rounded-full bg-ground transition-transform duration-200 ease-out"
          :class="muted ? 'translate-x-[2px]' : 'translate-x-[20px]'"
        />
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* The knob rides the sunken surface; a hairline keeps it legible in both themes
   without a heavy shadow. */
.switch .knob {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
}
</style>
