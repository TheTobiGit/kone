<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon } from "@hugeicons/core-free-icons";
import type { GitChange, GitFileStatus } from "~/types/desktop";
import {
  CHANGE_KINDS,
  areaOf,
  churnOf,
  nameOf,
  sideOf,
  type ChangeSide,
} from "~/utils/changeLanguage";

// The working tree's side column: the change list read at once. How much of it
// is staged, what kinds of change it is, where it lives, and which files carry
// the most work. Every drawing is also a filter, but the filters belong to the
// list: this only says which one was picked, and the list decides what that
// hides.

const props = defineProps<{
  changes: GitChange[];
  kindFilter: GitFileStatus | null;
  areaFilter: string | null;
  stageFilter: ChangeSide | null;
}>();

const emit = defineEmits<{
  pickKind: [id: GitFileStatus];
  pickArea: [area: string];
  pickStage: [side: ChangeSide];
  open: [change: GitChange, origin: DOMRect | null];
}>();

const query = defineModel<string>("query", { required: true });

function openRow(e: MouseEvent, change: GitChange) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", change, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

const staged = computed(() => props.changes.filter((c) => sideOf(c) === "staged"));
const partly = computed(() => props.changes.filter((c) => sideOf(c) === "partly"));
const unstaged = computed(() => props.changes.filter((c) => sideOf(c) === "unstaged"));
const conflicts = computed(() => props.changes.filter((c) => c.status === "conflicted").length);

/** The kinds of change, commonest first but keeping the legend's order on ties. */
const kinds = computed(() => {
  const by = new Map<GitFileStatus, number>();
  for (const c of props.changes) by.set(c.status, (by.get(c.status) ?? 0) + 1);
  return CHANGE_KINDS.map((k) => ({ ...k, count: by.get(k.id) ?? 0 }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count);
});

/** The work's home folders: first two path segments, root files as "root". */
const AREAS_SHOWN = 6;
const areas = computed(() => {
  const by = new Map<string, number>();
  for (const c of props.changes) {
    const area = areaOf(c.path);
    by.set(area, (by.get(area) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area))
    .slice(0, AREAS_SHOWN);
});
const areaPeak = computed(() => Math.max(1, ...areas.value.map((a) => a.count)));

/** The files carrying the most work, by lines touched. */
const CHANGES_SHOWN = 5;
const biggest = computed(() =>
  props.changes
    .map((change) => ({ change, churn: churnOf(change) }))
    .filter((c) => c.churn > 0)
    .sort((a, b) => b.churn - a.churn || a.change.path.localeCompare(b.change.path))
    .slice(0, CHANGES_SHOWN),
);
const biggestPeak = computed(() => Math.max(1, ...biggest.value.map((c) => c.churn)));

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <aside class="gscs">
    <label class="gscs__search gscs__block" style="--i: 0">
      <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        placeholder="Find a file"
        aria-label="Find a file"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <div class="gscs__block" style="--i: 1">
      <div class="gscs__label">
        <span class="gscs__label-name">The tree</span>
      </div>
      <div class="gscs__big">
        <span class="gscs__big-num">{{ staged.length }}</span>
        <span class="gscs__big-of">of {{ changes.length }} fully staged</span>
      </div>
      <div class="gscs__stack" role="presentation">
        <i
          v-if="staged.length"
          class="gscs__stack-seg gscs__stack-seg--staged"
          :class="{ 'gscs__stack-seg--dim': stageFilter && stageFilter !== 'staged' }"
          :style="{ flexGrow: staged.length }"
        />
        <i
          v-if="partly.length"
          class="gscs__stack-seg gscs__stack-seg--partly"
          :class="{ 'gscs__stack-seg--dim': stageFilter && stageFilter !== 'partly' }"
          :style="{ flexGrow: partly.length }"
        />
        <i
          v-if="unstaged.length"
          class="gscs__stack-seg gscs__stack-seg--unstaged"
          :class="{ 'gscs__stack-seg--dim': stageFilter && stageFilter !== 'unstaged' }"
          :style="{ flexGrow: unstaged.length }"
        />
      </div>
      <div class="gscs__legend">
        <button
          v-if="staged.length"
          type="button"
          class="gscs__key"
          :class="{ 'gscs__key--on': stageFilter === 'staged', 'gscs__key--dim': stageFilter && stageFilter !== 'staged' }"
          :aria-pressed="stageFilter === 'staged'"
          @click="emit('pickStage', 'staged')"
        >
          <i class="gscs__key-dot gscs__key-dot--staged" />
          <span class="gscs__key-name">Staged</span>
          <span class="gscs__key-count">{{ staged.length }}</span>
        </button>
        <button
          v-if="partly.length"
          type="button"
          class="gscs__key"
          :class="{ 'gscs__key--on': stageFilter === 'partly', 'gscs__key--dim': stageFilter && stageFilter !== 'partly' }"
          :aria-pressed="stageFilter === 'partly'"
          @click="emit('pickStage', 'partly')"
        >
          <i class="gscs__key-dot gscs__key-dot--partly" />
          <span class="gscs__key-name">Partly staged</span>
          <span class="gscs__key-count">{{ partly.length }}</span>
        </button>
        <button
          v-if="unstaged.length"
          type="button"
          class="gscs__key"
          :class="{ 'gscs__key--on': stageFilter === 'unstaged', 'gscs__key--dim': stageFilter && stageFilter !== 'unstaged' }"
          :aria-pressed="stageFilter === 'unstaged'"
          @click="emit('pickStage', 'unstaged')"
        >
          <i class="gscs__key-dot gscs__key-dot--unstaged" />
          <span class="gscs__key-name">Not staged</span>
          <span class="gscs__key-count">{{ unstaged.length }}</span>
        </button>
      </div>
      <p class="gscs__sub" :class="{ 'gscs__sub--bad': conflicts }">
        <template v-if="conflicts">
          <b>{{ plural(conflicts, "file") }}</b>{{ " " }}in conflict. Resolve before committing.
        </template>
        <template v-else-if="partly.length">
          <b>{{ partly.length }}</b> {{ partly.length === 1 ? "file is" : "files are" }} partly staged.
        </template>
        <template v-else-if="staged.length && unstaged.length">
          <b>{{ staged.length }}</b> staged, {{ unstaged.length }} still in the working tree.
        </template>
        <template v-else-if="staged.length">Everything is staged.</template>
        <template v-else>Stage a file to start the commit.</template>
      </p>
    </div>

    <div v-if="kinds.length > 1" class="gscs__block" style="--i: 2">
      <div class="gscs__label">
        <span class="gscs__label-name">Kinds of change</span>
      </div>
      <div class="gscs__stack" role="presentation">
        <i
          v-for="k in kinds"
          :key="k.id"
          class="gscs__stack-seg"
          :class="{ 'gscs__stack-seg--dim': kindFilter && kindFilter !== k.id }"
          :style="{ flexGrow: k.count, background: k.color }"
        />
      </div>
      <div class="gscs__legend">
        <button
          v-for="k in kinds"
          :key="k.id"
          type="button"
          class="gscs__key"
          :class="{ 'gscs__key--on': kindFilter === k.id, 'gscs__key--dim': kindFilter && kindFilter !== k.id }"
          :aria-pressed="kindFilter === k.id"
          @click="emit('pickKind', k.id)"
        >
          <i class="gscs__key-dot" :style="{ background: k.color }" />
          <span class="gscs__key-name">{{ k.label }}</span>
          <span class="gscs__key-count">{{ k.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="areas.length" class="gscs__block" style="--i: 3">
      <div class="gscs__label">
        <span class="gscs__label-name">Where it is</span>
      </div>
      <div class="gscs__bars">
        <button
          v-for="(a, n) in areas"
          :key="a.area"
          type="button"
          class="gscs__bar"
          :class="{ 'gscs__bar--on': areaFilter === a.area, 'gscs__bar--dim': areaFilter && areaFilter !== a.area }"
          :style="{ '--n': n }"
          :title="a.area"
          :aria-pressed="areaFilter === a.area"
          @click="emit('pickArea', a.area)"
        >
          <span class="gscs__bar-name">{{ a.area }}</span>
          <span class="gscs__bar-track">
            <i class="gscs__bar-fill" :style="{ width: `${(a.count / areaPeak) * 100}%` }" />
          </span>
          <span class="gscs__key-count">{{ a.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="biggest.length" class="gscs__block" style="--i: 4">
      <div class="gscs__label">
        <span class="gscs__label-name">Biggest changes</span>
      </div>
      <div class="gscs__bars">
        <button
          v-for="(b, n) in biggest"
          :key="b.change.path"
          type="button"
          class="gscs__bar gscs__bar--file"
          :style="{ '--n': n }"
          :title="b.change.path"
          :aria-label="`${b.change.path}, ${b.churn} lines touched`"
          aria-haspopup="dialog"
          @click="openRow($event, b.change)"
        >
          <span class="gscs__bar-name">{{ nameOf(b.change.path) }}</span>
          <span class="gscs__bar-track">
            <i class="gscs__bar-fill" :style="{ width: `${(b.churn / biggestPeak) * 100}%` }" />
          </span>
          <span class="gscs__key-count">{{ b.churn }}</span>
        </button>
      </div>
      <p class="gscs__sub">
        <b>{{ nameOf(biggest[0].change.path) }}</b>{{ " " }}leads at
        {{ biggest[0].churn }} lines touched.
      </p>
    </div>
  </aside>
</template>

<style scoped>
/* The side column holds still while the list scrolls past it. */
.gscs {
  position: sticky;
  top: 6rem;
  display: flex;
  flex-direction: column;
  gap: 36px;
  min-width: 0;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
.gscs__block {
  animation: gscs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
@keyframes gscs-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes gscs-grow {
  from {
    transform: scaleX(0);
  }
}

/* ── labels ───────────────────────────────────────────────────────────────── */
.gscs__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.gscs__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gscs__key-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.gscs__sub {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.gscs__sub b {
  font-weight: 500;
  color: var(--ink);
}
.gscs__sub--bad b {
  color: var(--warn);
}

/* ── search ───────────────────────────────────────────────────────────────── */
.gscs__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--ink-soft);
  background-color: var(--hover);
  cursor: text;
}
.gscs__search input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  background: none;
  border: 0;
  outline: none;
}
.gscs__search input::placeholder {
  color: var(--ink-soft);
  opacity: 0.75;
}
.gscs__search:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* ── the tree ─────────────────────────────────────────────────────────────── */
.gscs__big {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.gscs__big-num {
  font-family: var(--font-mono);
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.gscs__big-of {
  font-size: 13px;
  color: var(--ink-soft);
}
.gscs__stack {
  display: flex;
  gap: 2px;
  height: 10px;
  transform-origin: left center;
  animation: gscs-grow 640ms var(--gs-ease) backwards;
  animation-delay: 260ms;
}
.gscs__stack-seg {
  flex-basis: 0;
  min-width: 3px;
  border-radius: 3px;
  transition: opacity var(--gs-t-small) var(--gs-ease);
}
/* No remote to speak of here — the two halves are simply where the work is. */
.gscs__stack-seg--staged,
.gscs__key-dot--staged {
  background-color: var(--accent-2);
}
/* Work on both sides of the index is neither one state nor the other, so it
   is drawn as its own hatch rather than a shade of either neighbour. */
.gscs__stack-seg--partly {
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 72%, transparent) 0 3px,
    color-mix(in srgb, var(--accent) 28%, transparent) 3px 6px
  );
}
.gscs__key-dot--partly {
  background-color: var(--accent);
}
.gscs__stack-seg--unstaged {
  background-color: color-mix(in srgb, var(--ink) 26%, transparent);
}
.gscs__stack-seg--dim {
  opacity: 0.25;
}
.gscs__legend {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
}
.gscs__key,
.gscs__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 6px;
  margin-inline: -6px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) ease,
    opacity var(--gs-t-small) ease;
}
.gscs__key:hover,
.gscs__key--on,
.gscs__bar:hover,
.gscs__bar--on {
  background-color: var(--hover);
}
.gscs__key--dim,
.gscs__bar--dim {
  opacity: 0.45;
}
.gscs__key-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.gscs__key-dot--unstaged {
  background-color: color-mix(in srgb, var(--ink) 26%, transparent);
}
.gscs__key-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink-soft);
}

/* ── bars ─────────────────────────────────────────────────────────────────── */
.gscs__bars {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gscs__bar-name {
  width: 108px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.gscs__bar-track {
  flex: 1 1 auto;
  height: 6px;
}
.gscs__bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: left center;
  animation: gscs-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(300ms + var(--n, 0) * 60ms);
}
.gscs__key:focus-visible,
.gscs__bar:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

@media (max-width: 1180px) {
  .gscs {
    position: static;
    order: -1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .gscs__block,
  .gscs__stack,
  .gscs__bar-fill {
    animation: none;
  }
}
</style>
