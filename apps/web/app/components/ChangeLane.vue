<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useResizeObserver, useStorage } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { ChangeItem } from "~/types/change";
import { Magnet } from "~/components/ui/magnet";

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
  /** Open a single file's detail view, with the clicked card's rect (grow origin). */
  open: [item: ChangeItem, rect: DOMRect];
  /** The +N bundle was clicked — open the all-files peek instead of growing
   *  the lane past the page. */
  peek: [];
}>();

const { cue } = useSound();

// The whole section can fold to its header — collapsing clears the cards so the
// sessions below come up; expanding restores the grid exactly as it was, the +N
// overflow bundle still in place. Defaults open so nothing changes at rest.
//
// The fold is a layout choice, not a derived git fact: leaving the working-tree
// home (or a lane unmounting when its slice goes empty) must not reopen it. One
// boolean per project per lane, written as it's toggled.
const project = useProject();
const expanded = useStorage(
  `kone.changes.expanded:${props.tone}:${project.value?.path ?? ""}`,
  true,
  undefined,
  { initOnMounted: true },
);
function toggle(): void {
  expanded.value = !expanded.value;
  cue("toggle");
}

const total = computed(() => props.items.length);

// Cap at two rows exactly — read the column count back out of the rendered grid
// (auto-fill's actual tracks) rather than re-deriving it from a width formula.
const gridEl = ref<HTMLElement | null>(null);
const cols = ref(4);
// Only the width drives the auto-fill column count — skip the computed-style
// read when the observer fires on a height-only change (the fold animates the
// lane's height frame by frame).
let lastWidth = 0;
function measureCols() {
  const el = gridEl.value;
  if (!el) return;
  const w = el.clientWidth;
  if (w === lastWidth) return;
  lastWidth = w;
  const tracks = getComputedStyle(el).gridTemplateColumns;
  const n = tracks.split(" ").filter((t) => t && t !== "none").length;
  if (n > 0) cols.value = n;
}
useResizeObserver(gridEl, measureCols);
onMounted(measureCols);

const maxSlots = computed(() => cols.value * props.rows);
const hasOverflow = computed(() => total.value > maxSlots.value);

// The lane is always capped at `rows` exactly: overflow never unfolds in place
// (that would grow the working-tree page past the viewport). The +N bundle
// opens the all-files peek instead — and it occupies the *last slot of the
// final row*, so the cards above it fill exactly `rows` rows and the bundle
// sits where the next card would have gone.
const visible = computed(() =>
  hasOverflow.value
    ? props.items.slice(0, Math.max(0, maxSlots.value - 1))
    : props.items,
);
const overflow = computed(() => total.value - visible.value.length);

// Decorative fan for the +N bundle — mini file cards splayed behind the count pill.
const g = "var(--faint)";
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
  { badge: "TS", bg: "#3178c6", fg: "#fff", size: 7, lines: [[42, g], [30, "var(--diff-add)"], [36, g]], x: 10, y: 4, r: -13 },
  { badge: "JS", bg: "#f7df1e", fg: "#1a1a1a", size: 7, lines: [[40, g], [28, "var(--diff-del)"], [34, g]], x: 24, y: 0, r: -4 },
  { badge: "MD", bg: "#64748b", fg: "#fff", size: 7, lines: [[44, "var(--diff-add)"], [32, "var(--diff-add)"], [38, "color-mix(in srgb, var(--diff-add) 60%, var(--raised-high))"]], x: 38, y: 0, r: 5 },
  { badge: "CSS", bg: "#1572b6", fg: "#fff", size: 6, lines: [[42, g], [30, g], [36, g]], x: 34, y: 6, r: 14, front: true },
];
</script>

<template>
  <section class="lane" :class="`lane--${tone}`">
    <header class="lane__head">
      <div class="lane__lead">
        <button
          type="button"
          class="lane__toggle"
          :aria-expanded="expanded"
          :aria-controls="`lane-body-${tone}`"
          @click="toggle"
        >
          <HugeiconsIcon
            class="lane__chev"
            :class="{ 'lane__chev--open': expanded }"
            :icon="ArrowRight01Icon"
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span class="lane__title">
            <span class="lane__name">{{ title }}</span>
            <span class="lane__count">{{ total }}</span>
          </span>
        </button>
        <!-- The right-hand peek, one click away — the same list the +N bundle
             opens, reachable even when every file fits the two-row grid. -->
        <button
          v-if="tone === 'changed'"
          type="button"
          class="lane__view"
          title="Show all changed files in the side panel"
          @click="emit('peek')"
        >
          View changes
        </button>
      </div>
      <!-- Actions reveal on hover, just left of the stat cluster the panel
           slots into the far right of this row. -->
      <div class="lane__tail">
        <div class="lane__actions">
          <Magnet
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
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
          </Magnet>
          <!-- Discard belongs to the unstaged lane — it never touches staged work. -->
          <Magnet
            v-if="tone === 'changed'"
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <HoldToConfirm
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
          </Magnet>
        </div>
        <!-- The far-right stat cluster (+/− tally and per-file dots) — the panel
             slots it here so it keeps company with the tree-wide summary. -->
        <slot name="stat" />
      </div>
    </header>

    <div
      :id="`lane-body-${tone}`"
      class="lane__body"
      :class="{ 'lane__body--open': expanded }"
    >
      <div class="lane__body-inner">
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
            @open="(rect) => emit('open', c, rect)"
          />
          <button
            v-if="overflow > 0"
            type="button"
            class="bundle"
            :style="{ '--i': visible.length }"
            @click="emit('peek')"
          >
            <span class="bundle__inner">
              <span
                v-for="(card, i) in bundleCards"
                :key="i"
                class="bundle__card"
                :class="{ 'bundle__card--front': card.front }"
                :style="{ left: `${card.x}px`, top: `${card.y}px`, '--r': `${card.r}deg` }"
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
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.lane {
  display: flex;
  flex-direction: column;
}
/* The fold gap lives on the open body (see .lane__body--open), so a collapsed
   lane leaves no phantom space between header and the folded grid. Both the row
   track AND the fold gap ease together so the header never detaches from the
   content behind it — the sessions below ride the same tween. */
.lane__body {
  display: grid;
  grid-template-rows: 0fr;
  transition:
    grid-template-rows 340ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-top 340ms cubic-bezier(0.22, 1, 0.36, 1);
}
.lane__body--open {
  margin-top: 15px;
  grid-template-rows: 1fr;
}
/* The inner pane fades (and eases down 6px) as the track opens, so the cards
   breathe in rather than being unmasked by a moving clip edge. */
.lane__body-inner {
  overflow: hidden;
  min-height: 0;
  opacity: 0;
  transform: translateY(-6px);
  transition:
    opacity 240ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 340ms cubic-bezier(0.22, 1, 0.36, 1);
}
.lane__body--open .lane__body-inner {
  opacity: 1;
  transform: translateY(0);
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
  animation: lane-head-in 320ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--proj-enter-changes, 0ms) + 80ms + var(--lane-i, 0) * 60ms);
}
.grid > :deep(.card),
.bundle {
  animation: ch-tile-in 300ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--proj-enter-changes, 0ms) + 130ms + var(--lane-i, 0) * 60ms + var(--i, 0) * 30ms);
}
@media (prefers-reduced-motion: reduce) {
  .lane__head,
  .grid > :deep(.card),
  .bundle {
    animation: none;
  }
  .lane__chev,
  .lane__body,
  .lane__body-inner {
    transition: none;
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
/* Title, +/− stat and the peek opener ride together on the left; the lane's
   sweep/discard actions hold the right edge. */
.lane__lead {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
/* Actions first (hover-revealed), then the stat cluster the panel slots in —
   so the +/− tally and dots hold the far right while the actions appear just
   left of them. */
.lane__tail {
  display: inline-flex;
  align-items: center;
  gap: 14px;
}
/* Quiet text action, in the lane's own vocabulary — muted at rest, ink on
   hover, like the sweep. */
.lane__view {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 7px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease;
}
.lane__view:hover {
  color: var(--ink);
}
.lane__view:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
.lane__title {
  display: inline-flex;
  align-items: baseline; /* label + count share a baseline */
  gap: 7px;
  line-height: 1;
}
/* The fold toggle — the section's title row is a button so the whole lane folds
   to its header. Chevron points right when collapsed, down when open, the same
   fold vocabulary as the corner docks. */
.lane__toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 0.16s ease;
}
.lane__toggle:hover .lane__name,
.lane__toggle:focus-visible .lane__name {
  color: var(--ink);
}
.lane__toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
.lane__chev {
  flex-shrink: 0;
  color: var(--faint);
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.lane__chev--open {
  transform: rotate(90deg);
}
/* Actions surface only on lane hover (home reveals actions, never parks them). */
.lane__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.lane:hover .lane__actions,
/* Keyboard: reveal the actions when focus enters the lane, so they're never
   tabbed into while invisible. */
.lane:focus-within .lane__actions {
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
.lane__sweep:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

/* ── card grid ──────────────────────────────────────────────────────────── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 158px);
  justify-content: start;
  gap: 14px;
}

/* +N bundle: a fanned stack of real file cards, count pill overlapping the
   bottom edge. */
.bundle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 178px;
  border-radius: 12px;
  cursor: pointer;
  /* Hovering fans the papers open — the rotation factor fans out from a
     shared bottom pivot (where the count pill rests) so the stack "opens up"
     instead of lifting as a block. */
  --fan: 1;
  transition: --fan 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
.bundle:hover {
  --fan: 1.7;
}
.bundle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 28%, transparent);
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
  background-color: var(--raised-high);
  border: 1px solid var(--line-soft);
  box-shadow: color-mix(in srgb, var(--ink) 3%, transparent) 0 1px 4px;
  /* Pivot at the bottom of each paper, where the fan meets the pill, so the
     tops spread apart as the bundle fans open on hover. */
  transform-origin: 50% 100%;
  transform: rotate(calc(var(--r) * var(--fan)));
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
.bundle__card--front { box-shadow: color-mix(in srgb, var(--ink) 5%, transparent) 0 2px 6px; }
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
  background-color: var(--ink);
  box-shadow: color-mix(in srgb, var(--ink) 16%, transparent) 0 2px 6px;
}
.bundle__count {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--ground);
}
.bundle__word {
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  color: color-mix(in srgb, var(--ground) 78%, transparent);
}
</style>
