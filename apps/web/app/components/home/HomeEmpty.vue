<script setup lang="ts">
import { computed } from "vue";
import { motion } from "motion-v";
import { useTheme } from "~/composables/useTheme";
import type { ActionKey } from "~/components/start/StartActions.vue";
import { ClosingPlasma } from "~/components/ui/closing-plasma";

// On white, the plasma's ridge veins read as a soft cloud; on near-black the
// same veins glow as high-contrast filaments. Sitting the layer back in dark
// mode lets it settle into the ground like it does in light.
const { scheme } = useTheme();
const plasmaOpacity = computed(() => (scheme.value === "dark" ? 0.5 : 1));

// First-run screen: no projects, no sessions yet — just three ways to begin.
// Key of the action currently in session (e.g. folder picker open), or null.
defineProps<{ pending?: ActionKey | null }>();
const emit = defineEmits<{ start: [key: ActionKey]; settings: [] }>();
</script>

<template>
  <main
    class="relative flex h-full min-h-screen flex-col overflow-hidden bg-ground px-16 pt-[52px]"
  >
    <h1 class="sr-only">Start a project</h1>

    <!-- Wordmark top-left, settings top-right — both on the page's inset row. -->
    <div class="relative z-10 flex items-center justify-between">
      <div>
        <HomeRotatingWordmark />
      </div>
      <div>
        <SettingsButton @open="emit('settings')" />
      </div>
    </div>

    <!-- Hero: the start options rest dead-center in the open space. -->
    <section class="relative z-10 flex flex-1 flex-col items-center justify-center">
      <motion.div
        :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }"
      >
        <StartActions :pending="pending" @start="emit('start', $event)" />
      </motion.div>
    </section>

    <!-- Ambient close: a warm plasma glow rises from the floor and dissolves
         into the ground, giving the empty screen depth without a hard edge.
         Purely decorative — never intercepts pointer events. -->
    <motion.div
      class="pointer-events-none absolute inset-x-0 bottom-0 h-[42vh] max-h-[380px] min-h-[220px]"
      style="
        mask-image: linear-gradient(to bottom, transparent, black 55%);
        -webkit-mask-image: linear-gradient(to bottom, transparent, black 55%);
      "
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :transition="{ duration: 1.4, delay: 0.2, ease: 'easeOut' }"
    >
      <ClosingPlasma
        class="size-full"
        :interactive="false"
        :speed="0.55"
        :turbulence="0.85"
        :grain="0.4"
        :sparkle="0.35"
        :opacity="plasmaOpacity"
      />
    </motion.div>
  </main>
</template>
