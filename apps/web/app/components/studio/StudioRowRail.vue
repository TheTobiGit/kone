<script setup lang="ts">
// The plane's vertical index, bottom-left. One dash per row, longest and darkest
// on the row you are standing in.
//
// It is an index, not a switcher: at rest it reads as a few tick marks, so it
// tells you how deep the plane is and where you are in it without asking to be
// read. Names stay visible rather than appearing on hover — the rows are
// projects, and which project you are looking at is not a detail to go hunting
// for. Clicking a row is a shortcut, not the primary gesture; the keyboard is.

import { computed } from "vue";
import type { PlaneRow } from "~/composables/useStudioPlane";

const props = defineProps<{
  rows: PlaneRow[];
  focusedPath: string | null;
}>();

const emit = defineEmits<{ focus: [projectPath: string] }>();

// A single row is the whole plane, so there is no axis to index — showing one
// lonely dash would just be furniture.
const shown = computed(() => (props.rows.length > 1 ? props.rows : []));
</script>

<template>
  <nav v-if="shown.length" class="rail" aria-label="Studio rows">
    <button
      v-for="row in shown"
      :key="row.projectPath"
      type="button"
      class="rail__row"
      :data-focused="row.projectPath === focusedPath"
      :aria-current="row.projectPath === focusedPath ? 'true' : undefined"
      @click="emit('focus', row.projectPath)"
    >
      <span class="rail__dash" aria-hidden="true" />
      <span class="rail__name">{{ row.name }}</span>
    </button>
  </nav>
</template>

<style scoped>
.rail {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 5;
  padding: 20px 24px 22px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.rail__row {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--faint);
  cursor: pointer;
  transition: color 0.18s ease;
}

.rail__dash {
  display: block;
  width: 18px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
  transition:
    width 0.22s ease,
    height 0.22s ease;
}

.rail__row:hover {
  color: var(--muted);
}

.rail__row[data-focused="true"] {
  color: var(--ink);
}

/* Length carries the state as much as weight does, so the focused row still
   reads as focused for anyone who can't separate the two greys. */
.rail__row[data-focused="true"] .rail__dash {
  width: 30px;
  height: 2px;
}

.rail__name {
  font-size: 12.5px;
}

@media (prefers-reduced-motion: reduce) {
  .rail__row,
  .rail__dash {
    transition: none;
  }
}
</style>
