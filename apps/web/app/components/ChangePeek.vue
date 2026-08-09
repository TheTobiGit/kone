<script setup lang="ts">
import { computed } from "vue";
import { useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import FileIcon from "~/components/FileIcon.vue";
import HoldToConfirm from "~/components/HoldToConfirm.vue";
import type { ChangeItem } from "~/types/change";

// The right-hand "peek" drawer that the +N bundle opens — the mirror of the
// settings panel. The project stage slides left (see ProjectView) to uncover
// this fixed strip pinned to the right edge; it lists *every* changed file as
// dense rows so a working tree too big for the two-row card grid stays fully
// scannable without growing the page. Pure presentation: the stage owns the
// slide, this just renders the list and hands actions (sweep / discard / open)
// back up. Picking a file hands its row rect up so the detail can grow out of
// it, and the stage slides back.

const props = withDefaults(
  defineProps<{
    open: boolean;
    changes: ChangeItem[];
  }>(),
  { open: false, changes: () => [] },
);

const emit = defineEmits<{
  close: [];
  openFile: [item: ChangeItem, rect: DOMRect];
  stageAll: [];
  unstageAll: [];
  discard: [];
}>();

const staged = computed(() => props.changes.filter((c) => c.staged));
const unstaged = computed(() => props.changes.filter((c) => !c.staged));
const added = computed(() => props.changes.reduce((a, c) => a + c.added, 0));
const removed = computed(() => props.changes.reduce((a, c) => a + c.removed, 0));

interface PeekGroup {
  key: string;
  label: string;
  items: ChangeItem[];
  /** The sweep verb for this group — staged sweeps back out, changed stages in. */
  sweep: "stage" | "unstage" | null;
  /** Discard only ever touches the unstaged group. */
  discard?: boolean;
}

const groups = computed<PeekGroup[]>(() => {
  const out: PeekGroup[] = [];
  if (staged.value.length)
    out.push({ key: "staged", label: "Staged", items: staged.value, sweep: "unstage" });
  if (unstaged.value.length)
    out.push({ key: "changed", label: "Changed", items: unstaged.value, sweep: "stage", discard: true });
  return out;
});

// Clicking a row hands up the row's viewport rect as the detail's grow origin —
// the same contract the change cards use.
function onRowClick(item: ChangeItem, e: MouseEvent | KeyboardEvent) {
  const el = (e.currentTarget as HTMLElement);
  emit("openFile", item, el.getBoundingClientRect());
}

// Esc closes the peek; ProjectView's own Esc handler walks the stack after this
// (detail → peek → switcher), so this is the peek's own share of it.
useEventListener(window, "keydown", (e) => {
  if (!props.open || e.key !== "Escape") return;
  e.preventDefault();
  emit("close");
});
</script>

<template>
  <aside
    class="peek"
    :class="{ 'peek--open': open }"
    role="dialog"
    aria-label="All changed files"
    :aria-hidden="!open"
  >
    <!-- Masthead: what the working tree holds, in one glance — count + diffstat.
         The close glyph mirrors the settings panel's corner return. -->
    <header class="peek__head">
      <div class="peek__title">
        <span class="peek__name">Changes</span>
        <span class="peek__count">{{ changes.length }}</span>
      </div>
      <span class="peek__diff">
        <span v-if="added > 0" class="peek__add">+{{ added }}</span>
        <span v-if="removed > 0" class="peek__del">−{{ removed }}</span>
      </span>
      <button
        type="button"
        class="peek__close"
        :aria-label="'Close changed files'"
        @click="emit('close')"
      >
        <HugeiconsIcon :icon="Cancel01Icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </header>

    <!-- The file list — one scroll region for the whole drawer, rows grouped by
         staging state. Dense mono rows: icon, path, and the ± diffstat. -->
    <div class="peek__scroll">
      <section v-for="group in groups" :key="group.key" class="peek__group">
        <div class="peek__group-head">
          <span class="peek__label">{{ group.label }}</span>
          <span class="peek__group-count">{{ group.items.length }}</span>
          <button
            v-if="group.sweep"
            type="button"
            class="peek__sweep"
            @click="group.sweep === 'stage' ? emit('stageAll') : emit('unstageAll')"
          >
            {{ group.sweep === "stage" ? "Stage all" : "Unstage all" }}
          </button>
          <HoldToConfirm
            v-if="group.discard"
            variant="lane-discard"
            title="Hold to discard all changed (unstaged) files"
            aria-label="Hold to discard all changed files"
            @confirm="emit('discard')"
          >
            Discard
          </HoldToConfirm>
        </div>

        <ul class="peek__list">
          <li
            v-for="(c, i) in group.items"
            :key="c.path"
            class="peek__row"
            :class="{ 'peek__row--in': open }"
            :style="{ '--i': i }"
            role="button"
            tabindex="0"
            @click="onRowClick(c, $event)"
            @keydown.enter.prevent="onRowClick(c, $event)"
            @keydown.space.prevent="onRowClick(c, $event)"
          >
            <FileIcon :path="c.path" :size="15" />
            <span class="peek__path" :class="{ 'peek__path--del': c.deleted }">{{ c.name }}</span>
            <span class="peek__stat">
              <span v-if="c.added > 0" class="peek__add">+{{ c.added }}</span>
              <span v-if="c.removed > 0" class="peek__del">−{{ c.removed }}</span>
              <span v-if="c.isNew && c.added === 0" class="peek__new">new</span>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.peek {
  position: fixed;
  inset: 0 0 0 auto; /* pinned to the right edge, full height */
  width: 360px;
  z-index: 0; /* the stage (z-1) covers it at rest; the stage's slide uncovers it */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Square and flush to the screen edge — the curve of this reveal lives on the
     sliding page (its edge facing the drawer), mirroring how the settings page
     carries the curve on the edge facing its drawer. */
  background-color: var(--sunken);
}

/* ── masthead ───────────────────────────────────────────────────────────── */
.peek__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 52px 24px 20px;
}
.peek__title {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  line-height: 1;
}
.peek__name {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.peek__count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.peek__diff {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.peek__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
}
.peek__close:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.peek__close:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
/* The masthead rises in with the drawer — a beat ahead of the rows. */
@keyframes peek-head-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.peek--open .peek__head {
  animation: peek-head-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* ── scroll region ──────────────────────────────────────────────────────── */
.peek__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 24px 28px;
  /* Thin quiet scrollbar, like the settings panel. */
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
}
.peek__scroll::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
.peek__scroll::-webkit-scrollbar-track {
  background: transparent;
}
.peek__scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 999px;
}
.peek__scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 26%, transparent);
}

/* ── groups ─────────────────────────────────────────────────────────────── */
.peek__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.peek__group + .peek__group {
  margin-top: 22px;
}
.peek__group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.peek__label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}
.peek__group-count {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.peek__sweep {
  margin-left: auto;
  padding: 3px 6px;
  border-radius: 7px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease;
}
.peek__sweep:hover {
  color: var(--ink);
}
.peek__sweep:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

/* ── rows ───────────────────────────────────────────────────────────────── */
.peek__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.peek__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  outline: none;
  opacity: 0;
  transition:
    background-color 0.14s ease,
    opacity 0.2s ease;
}
.peek__row:hover,
.peek__row:focus-visible {
  background-color: var(--hover);
}
.peek__row:focus-visible {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent);
}
/* Rows cascade in when the drawer opens — same cadence as the change lanes.
   `both` holds the final opacity so the rows stay visible once the entrance
   (and its delay) finish. */
@keyframes peek-row-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.peek__row--in {
  animation: peek-row-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: calc(min(var(--i, 0) * 22ms, 320ms));
}
.peek__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--ink-soft);
  transition: color 0.14s ease;
}
.peek__row:hover .peek__path {
  color: var(--ink);
}
.peek__path--del {
  text-decoration: line-through;
  color: var(--muted);
}
.peek__stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.peek__add { color: var(--diff-add); }
.peek__del { color: var(--diff-del); }
.peek__new {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.3px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .peek__row {
    opacity: 1;
    animation: none;
  }
}
</style>
