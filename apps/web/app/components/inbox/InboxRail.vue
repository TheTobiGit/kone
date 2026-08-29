<script setup lang="ts">
// The inbox's view rail: which list you are looking at.
//
// It stands on the ground rather than inside the list panel, because it does
// not belong to the list — it decides which list there is. Sitting outside also
// keeps it still: the panes beside it resize and swap their contents, and the
// rail stays exactly where the hand last found it.
//
// The views are places, not filters. The archive is disjoint from the live list
// at the SQL level, not a subset of it being sieved in the renderer, so nothing
// here narrows anything — it swaps which list is on screen.

import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon, CheckmarkCircle02Icon, InboxIcon } from "@hugeicons/core-free-icons";
import type { InboxViewId } from "~/types/inbox";

// Ordered by distance from your attention: what is still asking, what you have
// answered for, and what you have put away for good.
const VIEWS = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "done", label: "Done", icon: CheckmarkCircle02Icon },
  { id: "archived", label: "Archived", icon: Archive02Icon },
] as const satisfies ReadonlyArray<{ id: InboxViewId; label: string; icon: unknown }>;

const view = defineModel<InboxViewId>({ required: true });
</script>

<template>
  <nav class="rail" aria-label="Inbox views">
    <button
      v-for="v in VIEWS"
      :key="v.id"
      type="button"
      class="rail__tab"
      :class="{ 'rail__tab--on': view === v.id }"
      :aria-label="v.label"
      :aria-current="view === v.id ? 'page' : undefined"
      :title="v.label"
      @click="view = v.id"
    >
      <HugeiconsIcon :icon="v.icon" :size="18" :stroke-width="1.8" aria-hidden="true" />
    </button>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding-top: 4px;
}

.rail__tab {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  color: var(--faint);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}
.rail__tab:hover {
  color: var(--muted);
  background: var(--hover);
}
.rail__tab--on,
.rail__tab--on:hover {
  color: var(--accent);
  background: var(--accent-wash);
}

@media (prefers-reduced-motion: reduce) {
  .rail__tab {
    transition-duration: 0.01s;
  }
}
</style>
