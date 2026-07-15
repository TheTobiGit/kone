<script setup lang="ts">
import { motion } from "motion-v";
import IconPlus from "./icons/IconPlus.vue";
import IconFolder from "./icons/IconFolder.vue";
import IconGitHub from "./icons/IconGitHub.vue";
import { ClosingPlasma } from "~/components/ui/closing-plasma";

// First-run screen: no projects, no sessions yet — just three ways to begin.
const actions = [
  { key: "create", label: "Create a new project", icon: IconPlus },
  { key: "open", label: "Open from local folder", icon: IconFolder },
  { key: "clone", label: "Clone from GitHub", icon: IconGitHub },
] as const;

type ActionKey = (typeof actions)[number]["key"];

// Key of the action currently in session (e.g. folder picker open), or null.
defineProps<{ pending?: ActionKey | null }>();
const emit = defineEmits<{ start: [key: ActionKey] }>();
</script>

<template>
  <main
    class="relative flex h-full min-h-screen flex-col overflow-hidden bg-ground px-16 pt-[52px]"
  >
    <!-- Hero: the start options rest dead-center in the open space. -->
    <section class="relative z-10 flex flex-1 flex-col items-center justify-center">
      <motion.div
        class="flex w-fit flex-col gap-1"
        :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }"
      >
        <StartAction
          v-for="action in actions"
          :key="action.key"
          :label="action.label"
          :loading="pending === action.key"
          :disabled="!!pending && pending !== action.key"
          @select="emit('start', action.key)"
        >
          <template #icon>
            <component :is="action.icon" />
          </template>
        </StartAction>
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
        light-color-a="#f6f5f3"
        light-color-b="#efe4dc"
        light-color-c="#e4c1af"
        dark-color-a="#070708"
        dark-color-b="#15100d"
        dark-color-c="#9a5238"
      />
    </motion.div>
  </main>
</template>
