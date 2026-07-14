<script setup lang="ts">
import { motion } from "motion-v";
import IconPlus from "./icons/IconPlus.vue";
import IconFolder from "./icons/IconFolder.vue";
import IconGitHub from "./icons/IconGitHub.vue";

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
    class="flex h-full min-h-screen flex-col bg-ground px-16 pt-[52px]"
  >
    <HomeHeader />

    <!-- Hero: the start options rest dead-center in the open space. -->
    <section class="flex flex-1 flex-col items-center justify-center">
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
  </main>
</template>
