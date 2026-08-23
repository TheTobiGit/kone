<script setup lang="ts">
import { Magnet } from "~/components/ui/magnet";
import PlusSign from "~/components/icons/animated/PlusSign.vue";
import FolderOpen from "~/components/icons/animated/FolderOpen.vue";
import Github from "~/components/icons/animated/Github.vue";
import type { AnimatedIconHandle } from "~/components/icons/animated/useIconAnimation";

// The three ways to begin a project — shared by the first-run home (centered as
// the hero) and the populated home (a single unit that flows after the project
// grid). Kept together as one column in both places.
const actions = [
  { key: "create", label: "Create a new project", icon: PlusSign },
  { key: "open", label: "Open from local folder", icon: FolderOpen },
  { key: "clone", label: "Clone from GitHub", icon: Github },
] as const;

export type ActionKey = (typeof actions)[number]["key"];

// Key of the action currently in session (e.g. folder picker open), or null.
defineProps<{ pending?: ActionKey | null }>();
const emit = defineEmits<{ start: [key: ActionKey] }>();

// The whole row is the hover target, not the tiny glyph — so the icon replays
// its gesture (plus pops, folder opens, github nudges) when the action is hovered.
const iconHandles = new Map<ActionKey, AnimatedIconHandle>();
function setIcon(key: ActionKey, el: unknown): void {
  if (el)
    // SAFETY: the :ref sits on one of this app's animated icon components,
    // which defineExpose exactly startAnimation/stopAnimation — AnimatedIconHandle.
    iconHandles.set(key, el as AnimatedIconHandle);
  else iconHandles.delete(key);
}
function playIcon(key: ActionKey): void {
  iconHandles.get(key)?.startAnimation();
}
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
        @mouseenter="playIcon(action.key)"
        @select="emit('start', action.key)"
      >
        <template #icon>
          <component
            :is="action.icon"
            :ref="(el) => setIcon(action.key, el)"
            :size="18"
            :stroke-width="1.7"
            trigger="manual"
            class="shrink-0 text-ink"
          />
        </template>
      </StartAction>
    </Magnet>
  </div>
</template>
