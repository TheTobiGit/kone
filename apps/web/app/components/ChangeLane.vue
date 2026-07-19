<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import type { ChangeItem } from "~/components/ChangesPanel.vue";

// One lane of the changes panel — a titled section ("Staged" / "Changed") over
// a responsive grid of ChangeCards, capped at two rows with the overflow packed
// into an unfoldable +N bundle. The lane owns its own grid measurement and fold
// state; ChangesPanel just hands it a slice of the working tree and a sweep
// action (Stage all / Unstage all) for that lane.

const props = withDefaults(
  defineProps<{
    title: string;
    /** Drives the sweep glyph + the lane's accent. */
    tone: "staged" | "changed";
    items: ChangeItem[];
    /** How many rows before overflow packs into the +N bundle. Two when this is
     *  the only lane; one when it's sharing the panel with the other lane. */
    rows?: number;
  }>(),
  { rows: 2 },
);

const emit = defineEmits<{
  /** The lane-level sweep (stage all / unstage all for this lane). */
  sweep: [];
  /** Discard the whole lane — only offered on the Changed (unstaged) lane. */
  discardLane: [];
}>();

const { cue } = useSound();
const total = computed(() => props.items.length);

// Cap at two rows exactly — read the column count back out of the rendered grid
// (auto-fill's actual tracks) rather than re-deriving it from a width formula.
const gridEl = ref<HTMLElement | null>(null);
const cols = ref(4);
function measureCols() {
  const el = gridEl.value;
  if (!el) return;
  const tracks = getComputedStyle(el).gridTemplateColumns;
  const n = tracks.split(" ").filter((t) => t && t !== "none").length;
  if (n > 0) cols.value = n;
}
useResizeObserver(gridEl, measureCols);
onMounted(measureCols);

const maxSlots = computed(() => cols.value * props.rows);
const hasOverflow = computed(() => total.value > maxSlots.value);

const expanded = ref(false);
const collapsed = computed(() => hasOverflow.value && !expanded.value);
function expand() {
  expanded.value = true;
  cue("toggle");
}
function collapse() {
  expanded.value = false;
  cue("toggle");
}

const visible = computed(() =>
  collapsed.value ? props.items.slice(0, maxSlots.value - 1) : props.items,
);
const overflow = computed(() =>
  collapsed.value ? total.value - (maxSlots.value - 1) : 0,
);

// Decorative fan for the +N bundle — four mini file cards splayed behind the
const g = "#d0cec9";
interface BundleCard {
  badge: string;
  bg: string;
  fg: string;
  size: number;
  lines: [number, string][];
  x: number;
  y: number;
  r: number;
  front?: boolean;
}
const bundleCards: BundleCard[] = [
  { badge: "TS", bg: "#3178c6", fg: "#fff", size: 7, lines: [[42, g], [30, "#10a56f"], [36, g]], x: 10, y: 4, r: -13 },
  { badge: "JS", bg: "#f7df1e", fg: "#1a1a1a", size: 7, lines: [[40, g], [28, "#e5484d"], [34, g]], x: 24, y: 0, r: -4 },
  { badge: "MD", bg: "#64748b", fg: "#fff", size: 7, lines: [[44, "#10a56f"], [32, "#10a56f"], [38, "#8fd9bd"]], x: 38, y: 0, r: 5 },
  { badge: "CSS", bg: "#1572b6", fg: "#fff", size: 6, lines: [[42, g], [30, g], [36, g]], x: 34, y: 6, r: 14, front: true },
];
</script>

<template>
  <section class="lane" :class="`lane--${tone}`">
    <header class="lane__head">
      <span class="lane__title">
        <span class="lane__name">{{ title }}</span>
        <span class="lane__count">{{ total }}</span>
      </span>
      <div class="lane__actions">
        <button type="button" class="lane__sweep" @click="emit('sweep')">
          <!-- Unstage all → minus · Stage all → plus (staging adds, so a plus). -->
          <svg v-if="tone === 'staged'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ tone === "staged" ? "Unstage all" : "Stage all" }}
        </button>
        <!-- Discard belongs to the unstaged lane — it never touches staged work. -->
        <HoldToConfirm
          v-if="tone === 'changed'"
          variant="lane-discard"
          title="Hold to discard all changed (unstaged) files"
          aria-label="Hold to discard all changed files"
          @confirm="emit('discardLane')"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M3 7v6h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Discard
        </HoldToConfirm>
      </div>
    </header>

    <div ref="gridEl" class="grid">
      <ChangeCard
        v-for="(c, i) in visible"
        :key="c.path"
        :style="{ '--i': i }"
        :name="c.name"
        :added="c.added"
        :removed="c.removed"
        :is-new="c.isNew"
        :deleted="c.deleted"
      />
      <button
        v-if="overflow > 0"
        type="button"
        class="bundle"
        :style="{ '--i': visible.length }"
        @click="expand"
      >
        <span class="bundle__inner">
          <span
            v-for="(card, i) in bundleCards"
            :key="i"
            class="bundle__card"
            :class="{ 'bundle__card--front': card.front }"
            :style="{ left: `${card.x}px`, top: `${card.y}px`, transform: `rotate(${card.r}deg)` }"
          >
            <span class="bundle__badge" :style="{ background: card.bg, color: card.fg, fontSize: `${card.size}px` }">
              {{ card.badge }}
            </span>
            <span class="bundle__lines">
              <i v-for="(ln, j) in card.lines" :key="j" :style="{ width: `${ln[0]}px`, background: ln[1] }" />
            </span>
          </span>
          <span class="bundle__label">
            <span class="bundle__count">+{{ overflow }}</span>
            <span class="bundle__word">more</span>
          </span>
        </span>
      </button>

      <button
        v-if="hasOverflow && expanded"
        type="button"
        class="fold"
        :style="{ '--i': visible.length }"
        @click="collapse"
      >
        <span class="fold__chevron">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="fold__label">Show less</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.lane {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

/* ── entrance ─────────────────────────────────────────────────────────────
   Lane head lifts in, then its tiles cascade in order — same cadence that
   drives the unfold when the bundle spills its hidden cards. */
@keyframes lane-head-in {
  from { opacity: 0; transform: translateY(9px); }
  to { opacity: 1; transform: none; }
}
@keyframes ch-tile-in {
  from { opacity: 0; transform: translateY(14px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.lane__head {
  animation: lane-head-in 480ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.grid > :deep(.card),
.bundle,
.fold {
  animation: ch-tile-in 460ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(90ms + var(--i, 0) * 48ms);
}
@media (prefers-reduced-motion: reduce) {
  .lane__head,
  .grid > :deep(.card),
  .bundle,
  .fold {
    animation: none;
  }
}

/* ── lane header ──────────────────────────────────────────────────────────── */
.lane__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-inline: 2px;
}
.lane__title {
  display: inline-flex;
  align-items: baseline; /* label + count share a baseline */
  gap: 7px;
  line-height: 1;
}
/* Actions surface only on lane hover (home reveals actions, never parks them). */
.lane__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.lane:hover .lane__actions {
  opacity: 1;
}
@media (hover: none) {
  .lane__actions { opacity: 1; }
}
.lane__name {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.2px;
  color: var(--ink-soft);
}
.lane__count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
/* Quiet sweep — a bare muted text action that only surfaces on lane hover
   (home reveals actions rather than parking buttons on the surface). */
.lane__sweep {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: 7px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease;
}
.lane__sweep:hover {
  color: var(--ink);
}

/* ── card grid ──────────────────────────────────────────────────────────── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 158px);
  justify-content: start;
  gap: 14px;
}

/* +N bundle: a fanned stack of real file cards, count pill overlapping the
   bottom edge (Paper "+9 more"). */
.bundle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 178px;
  cursor: pointer;
}
.bundle__inner {
  position: relative;
  width: 132px;
  height: 138px;
}
.bundle__card {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 80px;
  height: 100px;
  padding: 11px;
  border-radius: 10px;
  background-color: var(--sheet-bg, #fff);
  border: 1px solid rgb(161 161 170 / 0.16);
  box-shadow: #1e1b1814 0 4px 12px;
  transform-origin: top left;
}
.bundle__card--front { box-shadow: #1e1b1820 0 6px 16px; }
.bundle__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  font-family: var(--font-sans);
  font-weight: 700;
  line-height: 1;
}
.bundle__lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bundle__lines i {
  height: 3px;
  border-radius: 2px;
}
.bundle__label {
  position: absolute;
  left: 50%;
  top: 112px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding-inline: 10px;
  border-radius: 11px;
  background-color: #27272a;
  box-shadow: #1e1b1826 0 2px 6px;
}
.bundle__count {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: #fff;
}
.bundle__word {
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  color: #d4d4d8;
}

/* "Show less" tile — a quiet ghost matching the card footprint. */
.fold {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 178px;
  border-radius: 12px;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}
.fold:hover {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.fold__chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background-color: var(--hover);
  transition: background-color 0.16s ease;
}
.fold:hover .fold__chevron {
  background-color: color-mix(in srgb, currentColor 12%, transparent);
}
.fold__label {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
}

@media (prefers-color-scheme: dark) {
  .bundle__card { --sheet-bg: #17171a; border-color: rgb(255 255 255 / 0.08); }
  .lane--changed .lane__dot { background-color: #3f3f46; }
}
</style>
