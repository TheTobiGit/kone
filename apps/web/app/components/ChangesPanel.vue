<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { CountUp } from "~/components/ui/count-up";

// The file-changes block that heads the project rail. Composes the adaptive
// controls change with the working tree) over a grid of ChangeCards that fills,
// wraps, then caps at two rows with the rest packed into a +N bundle ("File row
// — states"). When the tree is clean it collapses to a quiet empty state.
//
// The header actions are inert for now (no staging wired up yet).

export interface ChangeItem {
  name: string;
  added: number;
  removed: number;
  staged: boolean;
  isNew: boolean;
  deleted: boolean;
}

const props = defineProps<{
  /** false until the first git read resolves — suppresses the "No changes"
   *  empty state (and the whole block) so nothing flashes before the working
   *  tree is known; the header + cards then cascade in when data lands. */
  loading: boolean;
  branch: string | null;
  added: number;
  removed: number;
  changes: ChangeItem[];
}>();

const total = computed(() => props.changes.length);
const stagedCount = computed(() => props.changes.filter((c) => c.staged).length);

// unstaged → all-staged spectrum drives which primary action shows.
const allStaged = computed(() => total.value > 0 && stagedCount.value === total.value);
const noneStaged = computed(() => stagedCount.value === 0);

// Cap at two rows exactly. The grid is responsive (auto-fill), so how many
// cards make two rows depends on width. Rather than re-derive the column count
// from a width formula — which drifts a track off from what the browser's
// layout actually did at sub-pixel boundaries, spilling a third row — we read
// the truth back out of the rendered grid: count the tracks auto-fill produced.
const gridEl = ref<HTMLElement | null>(null);
const cols = ref(4); // sensible pre-hydration default (matches ~max-w-4xl)
function measureCols() {
  const el = gridEl.value;
  if (!el) return;
  const tracks = getComputedStyle(el).gridTemplateColumns;
  const n = tracks.split(" ").filter((t) => t && t !== "none").length;
  if (n > 0) cols.value = n;
}
useResizeObserver(gridEl, measureCols);
onMounted(measureCols);

// Two full rows' worth of slots. When everything fits we show it all; when it
// overflows we surrender the very last slot to the +N bundle, so "more" is
// always the final item and the grid never spills past two rows.
const maxSlots = computed(() => cols.value * 2);
const hasOverflow = computed(() => total.value > maxSlots.value);

// Clicking the bundle unfolds the full list; a "Show less" tile folds it back.
const { cue } = useSound();
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
  collapsed.value ? props.changes.slice(0, maxSlots.value - 1) : props.changes,
);
const overflow = computed(() =>
  collapsed.value ? total.value - (maxSlots.value - 1) : 0,
);

// One dot per file, coloured by what changed (not by staging — that's shown on
// the cards). Addition-dominant files read green, deletion-dominant red, and a
// "Changes header" dot row, which mixes green/red/grey by change shape.
type DotTone = "add" | "del" | "idle";
const dots = computed<DotTone[]>(() =>
  props.changes.map((c) => {
    if (c.deleted || c.removed > c.added) return "del";
    if (c.added > 0) return "add";
    return "idle";
  }),
);

// four realistic mini file cards (badge + three diff lines) splayed behind the
// overlapping pill. Line tones: grey #d0cec9, green #10a56f, red #e5484d,
// mint #8fd9bd.
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
  <!-- Hold until the first git read resolves — render nothing so the block
       simply arrives with the data, no "No changes" flash on the way in. -->
  <template v-if="loading" />

  <!-- Clean: quiet empty state. -->
  <div v-else-if="total === 0" class="empty">
    <div class="empty__glyph">
      <span class="empty__sheet empty__sheet--back" />
      <span class="empty__sheet empty__sheet--front" />
      <span class="empty__check">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            d="M20 6 9 17l-5-5"
            fill="none"
            stroke="#fff"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </div>
    <span class="empty__label">No changes</span>
    <span v-if="branch" class="empty__branch">
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" fill="none" />
        <circle cx="6" cy="18" r="3" fill="none" />
        <path d="M18 9a9 9 0 0 1-9 9" fill="none" />
      </svg>
      {{ branch }}
    </span>
  </div>

  <div v-else class="panel">
    <!-- Adaptive header: controls left, diffstat + progress right. -->
    <header class="ch">
      <div class="ch__actions">
        <button type="button" class="ch__btn ch__btn--primary">
          <svg v-if="allStaged" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2.4" />
            <line x1="3" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            <line x1="15" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ allStaged ? "Commit" : "Stage all" }}
        </button>
        <button type="button" class="ch__btn" :class="{ 'ch__btn--off': noneStaged }">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
          Unstage all
        </button>
        <button type="button" class="ch__btn ch__btn--ghost">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M3 7v6h6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Discard
        </button>
      </div>

      <span class="ch__meta">
        <span class="ch__diff">
          <span v-if="added > 0" class="ch__add"
            >+<CountUp :to="added" :duration="1.1"
          /></span>
          <span v-if="removed > 0" class="ch__del"
            >−<CountUp :to="removed" :duration="1.1"
          /></span>
        </span>
        <span class="ch__dots">
          <i
            v-for="(d, i) in dots"
            :key="i"
            class="ch__dot"
            :class="`ch__dot--${d}`"
            :style="{ '--i': i }"
          />
        </span>
      </span>
    </header>

    <!-- Card grid: responsive columns, capped at two rows + a bundle. -->
    <div ref="gridEl" class="grid">
      <ChangeCard
        v-for="(c, i) in visible"
        :key="c.name"
        :style="{ '--i': i }"
        :name="c.name"
        :added="c.added"
        :removed="c.removed"
        :staged="c.staged"
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
              <i
                v-for="(ln, j) in card.lines"
                :key="j"
                :style="{ width: `${ln[0]}px`, background: ln[1] }"
              />
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
            <path
              d="m6 15 6-6 6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="fold__label">Show less</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ── entrance ───────────────────────────────────────────────────────────────
   The block arrives when the git read lands (below the greeting, which is
   already settling): the header lifts in first, then the tiles cascade in
   order — each card, then the +N bundle, staggered by its position. The stagger
   also drives the unfold, so expanding the bundle spills the hidden cards in
   the same cadence. */
@keyframes ch-header-in {
  from {
    opacity: 0;
    transform: translateY(9px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes ch-tile-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.ch {
  animation: ch-header-in 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.grid > :deep(.card),
.bundle,
.fold {
  animation: ch-tile-in 480ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(120ms + var(--i, 0) * 52ms);
}

/* The per-file dots pop in one by one once the header has settled — the change
   set tallying itself, alongside the +/− totals counting up. */
@keyframes ch-dot-pop {
  from {
    opacity: 0;
    transform: scale(0.2);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.ch__dot {
  animation: ch-dot-pop 340ms cubic-bezier(0.34, 1.45, 0.64, 1) backwards;
  /* Cap the stagger tail so a large change set still finishes tallying quickly
     rather than trickling dots for seconds. */
  animation-delay: calc(240ms + min(var(--i, 0) * 46ms, 620ms));
}

@media (prefers-reduced-motion: reduce) {
  .ch,
  .ch__dot,
  .grid > :deep(.card),
  .bundle,
  .fold {
    animation: none;
  }
}

/* ── header ─────────────────────────────────────────────────────────────── */
.ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.ch__meta {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ch__diff {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ch__add {
  color: #059669;
}
.ch__del {
  color: #e11d48;
}
.ch__dots {
  display: flex;
  align-items: center;
  gap: 3px;
}
.ch__dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
}
.ch__dot--add {
  background-color: #059669;
}
.ch__dot--del {
  background-color: #e11d48;
}
.ch__dot--idle {
  background-color: #d4d4d8;
}

.ch__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.ch__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    opacity 0.16s ease;
}
.ch__btn:hover {
  background-color: var(--hover);
}
.ch__btn--primary {
  background-color: var(--ink);
  color: var(--ground);
}
.ch__btn--primary:hover {
  background-color: var(--ink);
  opacity: 0.88;
}
.ch__btn--ghost {
  font-weight: 400;
  color: var(--muted);
}
.ch__btn--off {
  opacity: 0.45;
  pointer-events: none;
}

/* ── card grid ──────────────────────────────────────────────────────────── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 158px);
  justify-content: start;
  gap: 12px;
}

/* +N bundle: a fanned stack of real file cards you'll be able to unpack,
   with the count pill overlapping the bottom edge (Paper "+9 more"). */
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
.bundle__card--front {
  box-shadow: #1e1b1820 0 6px 16px;
}
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

/* "Show less" tile — a quiet ghost matching the card footprint, no filled
   surface until hover, so folding back reads as the calm inverse of the fan. */
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
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
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

/* ── empty state ────────────────────────────────────────────────────────── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 0;
}
.empty__glyph {
  position: relative;
  width: 64px;
  height: 52px;
}
.empty__sheet {
  position: absolute;
  border-radius: 10px;
  background-color: var(--sheet-bg, #fff);
  box-shadow: #1e1b180f 0 4px 12px;
}
.empty__sheet--back {
  inset: 0 8px 8px 0;
  transform: rotate(-5deg);
  opacity: 0.6;
}
.empty__sheet--front {
  inset: 6px 0 0 8px;
}
.empty__check {
  position: absolute;
  top: -6px;
  right: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background-color: #10a56f;
  border: 2px solid var(--ground);
}
.empty__label {
  font-size: 13px;
  color: var(--muted);
}
.empty__branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  background-color: var(--hover);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
}
.empty__branch svg {
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (prefers-color-scheme: dark) {
  .bundle__card,
  .empty__sheet {
    --sheet-bg: #17171a;
  }
  .bundle__card {
    border-color: rgb(255 255 255 / 0.08);
  }
  .ch__dot--idle {
    background-color: #3f3f46;
  }
}
</style>
