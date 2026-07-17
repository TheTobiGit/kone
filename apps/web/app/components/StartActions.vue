<script setup lang="ts">
import { Magnet } from "~/components/ui/magnet";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  PlusSignIcon,
  FolderOpenIcon,
  GithubIcon,
} from "@hugeicons/core-free-icons";

// The three ways to begin a project — shared by the first-run home (centered as
// the hero) and the populated home (a single unit that flows after the project
// grid). Kept together as one column in both places.
const actions = [
  { key: "create", label: "Create a new project", icon: PlusSignIcon },
  { key: "open", label: "Open from local folder", icon: FolderOpenIcon },
  { key: "clone", label: "Clone from GitHub", icon: GithubIcon },
] as const;

export type ActionKey = (typeof actions)[number]["key"];

// Key of the action currently in session (e.g. folder picker open), or null.
defineProps<{ pending?: ActionKey | null }>();
const emit = defineEmits<{ start: [key: ActionKey] }>();
</script>

<template>
  <div class="flex w-fit flex-col gap-1">
    <!-- Each row leans gently toward the cursor as it approaches, then eases
         back — a soft magnetic pull, not a bouncy magnet. Disabled while any
         action is pending so a loading row stays put. -->
    <Magnet
      v-for="action in actions"
      :key="action.key"
      class="w-fit"
      inner-class="w-fit"
      :padding="12"
      :magnet-strength="9"
      :disabled="!!pending"
      active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
      inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
    >
      <StartAction
        :label="action.label"
        :loading="pending === action.key"
        :disabled="!!pending && pending !== action.key"
        @select="emit('start', action.key)"
      >
        <template #icon>
          <HugeiconsIcon
            :icon="action.icon"
            :size="18"
            :stroke-width="1.7"
            class="shrink-0 text-ink"
          />
        </template>
      </StartAction>
    </Magnet>
  </div>
</template>
