<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { GitForkIcon } from "@hugeicons/core-free-icons";
import { workspaceMark, type WorkspaceFacts } from "~/utils/threadWorkspace";

// "This conversation works in a directory of its own."
//
// Renders nothing for a thread in its project's checkout, which is most of
// them: the mark is meaningful because it is rare, and a badge on every row
// would say nothing. That is also why it is small and muted rather than
// coloured — a worktree is a place a thread lives, not a state to be alarmed by.
//
// The basename is what shows; the full path is the tooltip. A path inline is
// unreadable at a glance and pushes the rest of the line out.
//
// Sized and coloured from whatever encloses it, so it can sit inside the inbox
// row's mono chip and inside the composer tray without either being told about
// the other.

const props = defineProps<WorkspaceFacts>();

const mark = computed(() => workspaceMark(props));
</script>

<template>
  <span v-if="mark" class="wm" :class="{ 'wm--pending': mark.pending }" :title="mark.title">
    <HugeiconsIcon :icon="GitForkIcon" :size="10" :stroke-width="2" aria-hidden="true" />
    <span class="wm__name">{{ mark.label }}</span>
  </span>
</template>

<style scoped>
.wm {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.wm svg {
  flex: none;
}
.wm__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Nothing exists to open yet, so it reads as a statement rather than a place. */
.wm--pending {
  opacity: 0.7;
  font-style: italic;
}
</style>
