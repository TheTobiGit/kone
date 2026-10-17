<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

// What a section looks like while a slow read is still on its way: not grey
// bars but the section's own plan, drawn in dotted guides over a dot grid.
//
// The grey skeleton is right for local reads that land in a beat. A read that
// goes over the network (GitHub, mostly) can take a second or two, and for that
// long a breathing block says nothing. The plan says what's coming and exactly
// where it will sit: every guide is the same size and in the same place as the
// thing it stands for, so when the data lands the real rows resolve into the
// lines rather than pushing them aside.
//
// The section leaves the plan on screen while its rows resolve, then lets it
// fade, so the two overlap for a moment — that overlap is the whole effect.

const props = withDefaults(
  defineProps<{
    /** `list` is the main column's rows; `side` is the side column's drawings. */
    part?: "list" | "side";
    rows?: number;
    /** What is being read, for the caption and for screen readers. */
    what?: string;
  }>(),
  { part: "list", rows: 5, what: "data" },
);

// Fixed, uneven widths, cycled by row, so the plan never twitches on a
// re-render and never reads as a table.
const TITLE = [72, 54, 66, 48, 80, 60, 63, 51];
const META = [44, 58, 38, 52, 47, 61, 41, 55];
function title(i: number): string {
  return `${TITLE[i % TITLE.length]}%`;
}
function meta(i: number): string {
  return `${META[i % META.length]}%`;
}

// A quiet clock in the corner: the plan is a read in progress, and the time it
// has taken is the one honest thing to say about it.
const elapsed = ref("0.0");
let started = 0;
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (props.part !== "list") return;
  started = performance.now();
  timer = setInterval(() => {
    elapsed.value = ((performance.now() - started) / 1000).toFixed(1);
  }, 100);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="gbp" :class="`gbp--${part}`" role="status" :aria-label="`Loading ${what}`">
    <template v-if="part === 'list'">
      <div class="gbp__caption" aria-hidden="true">
        <span>{{ what }}</span>
        <span class="gbp__fill" />
        <span>t+{{ elapsed }}s</span>
      </div>

      <div class="gbp__frame" aria-hidden="true">
        <i class="gbp__corner gbp__corner--tl" />
        <i class="gbp__corner gbp__corner--tr" />
        <i class="gbp__corner gbp__corner--bl" />
        <i class="gbp__corner gbp__corner--br" />

        <div class="gbp__label">
          <i class="gbp__rule" style="width: 64px; --d: 0" />
        </div>

        <div v-for="i in rows" :key="i" class="gbp__row" :style="{ '--d': i }">
          <i class="gbp__ring" />
          <span class="gbp__body">
            <span class="gbp__line gbp__line--title">
              <i class="gbp__rule" :style="{ width: title(i - 1) }" />
            </span>
            <span class="gbp__line gbp__line--meta">
              <i class="gbp__rule gbp__rule--soft" :style="{ width: meta(i - 1) }" />
            </span>
          </span>
          <span class="gbp__right">
            <i class="gbp__ring gbp__ring--sm" />
            <i class="gbp__rule gbp__rule--size" />
          </span>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="gbp__box gbp__box--search" style="--d: 0" aria-hidden="true" />

      <div class="gbp__block" aria-hidden="true">
        <i class="gbp__rule" style="width: 46%; --d: 1" />
        <div class="gbp__big" style="--d: 2">
          <i class="gbp__box gbp__box--num" />
          <i class="gbp__rule gbp__rule--soft" style="width: 52%" />
        </div>
        <div class="gbp__box gbp__box--stack" style="--d: 3" />
        <div v-for="n in 3" :key="n" class="gbp__key" :style="{ '--d': 3 + n }">
          <i class="gbp__ring gbp__ring--dot" />
          <i class="gbp__rule gbp__rule--soft" :style="{ width: `${[48, 36, 42][n - 1]}%` }" />
          <span class="gbp__fill" />
          <i class="gbp__rule gbp__rule--soft" style="width: 12px" />
        </div>
      </div>

      <div class="gbp__block" aria-hidden="true">
        <i class="gbp__rule" style="width: 34%; --d: 7" />
        <div v-for="n in 3" :key="n" class="gbp__key" :style="{ '--d': 7 + n }">
          <i class="gbp__ring gbp__ring--face" />
          <i class="gbp__rule gbp__rule--soft" style="width: 56px" />
          <i class="gbp__rule gbp__rule--track" />
          <i class="gbp__rule gbp__rule--soft" style="width: 10px" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The guides are ink at a whisper: present enough to read as a plan, never
   enough to read as content. */
.gbp {
  --gbp-ink: color-mix(in srgb, var(--ink) 30%, transparent);
  --gbp-soft: color-mix(in srgb, var(--ink) 18%, transparent);
  --gbp-dot: color-mix(in srgb, var(--ink) 9%, transparent);
  position: relative;
  /* Held back like the grey skeleton: a read that beats the hold never draws
     a plan at all. */
  animation: gbp-appear var(--gs-t-small, 220ms) var(--gs-ease, ease) var(--gs-hold, 140ms) backwards;
}
@keyframes gbp-appear {
  from {
    opacity: 0;
  }
}

/* ── the grid the plan is drawn on ────────────────────────────────────────── */
.gbp--list::before,
.gbp--side::before {
  content: "";
  position: absolute;
  inset: -18px -24px;
  background-image: radial-gradient(circle, var(--gbp-dot) 1px, transparent 1.2px);
  background-size: 12px 12px;
  /* The grid dissolves at its edges instead of ending on a line. */
  mask-image: radial-gradient(ellipse at center, #000 45%, transparent 78%);
  pointer-events: none;
}

.gbp__fill {
  flex: 1 1 auto;
}
.gbp__caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  display: flex;
  padding-bottom: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--ink) 38%, transparent);
  font-variant-numeric: tabular-nums;
}

/* ── the frame: a selection box's corners, not a border ───────────────────── */
.gbp__frame {
  position: relative;
}
.gbp__corner {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 0 solid var(--gbp-ink);
}
.gbp__corner--tl {
  top: -6px;
  left: -16px;
  border-top-width: 1px;
  border-left-width: 1px;
}
.gbp__corner--tr {
  top: -6px;
  right: -16px;
  border-top-width: 1px;
  border-right-width: 1px;
}
.gbp__corner--bl {
  bottom: -6px;
  left: -16px;
  border-bottom-width: 1px;
  border-left-width: 1px;
}
.gbp__corner--br {
  bottom: -6px;
  right: -16px;
  border-bottom-width: 1px;
  border-right-width: 1px;
}

/* ── rules: a dotted line with a cap at each end ──────────────────────────── */
.gbp__rule {
  position: relative;
  display: block;
  flex-shrink: 0;
  height: 1px;
  background-image: linear-gradient(to right, var(--gbp-ink) 50%, transparent 50%);
  background-size: 4px 1px;
  transform-origin: left center;
  /* Drawn in, top to bottom, like a plan being traced. */
  animation: gbp-draw 520ms var(--gs-ease, ease) backwards;
  animation-delay: calc(var(--gs-hold, 140ms) + min(var(--d, 0), 12) * 55ms);
}
.gbp__rule::before,
.gbp__rule::after {
  content: "";
  position: absolute;
  top: -1px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background-color: var(--gbp-ink);
}
.gbp__rule::before {
  left: -1px;
}
.gbp__rule::after {
  right: -1px;
}
.gbp__rule--soft {
  background-image: linear-gradient(to right, var(--gbp-soft) 50%, transparent 50%);
}
.gbp__rule--soft::before,
.gbp__rule--soft::after {
  background-color: var(--gbp-soft);
}
@keyframes gbp-draw {
  from {
    transform: scaleX(0);
  }
}

.gbp__ring {
  display: block;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px dashed var(--gbp-ink);
  animation: gbp-ring 420ms var(--gs-ease, ease) backwards;
  animation-delay: calc(var(--gs-hold, 140ms) + min(var(--d, 0), 12) * 55ms);
}
@keyframes gbp-ring {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
}

/* ── the list: each row the size of the row it stands for ─────────────────── */
.gbp__label {
  display: flex;
  align-items: center;
  height: 17px;
  margin-bottom: 12px;
}
.gbp__row {
  display: flex;
  align-items: center;
  gap: 14px;
  /* The real row's own padding and margin, so it lands on these lines. */
  margin-inline: -10px;
  padding: 11px 10px;
}
.gbp__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
}
.gbp__line {
  display: flex;
  align-items: center;
}
.gbp__line--title {
  height: 18px;
}
.gbp__line--meta {
  height: 16px;
}
.gbp__right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}
.gbp__ring--sm {
  width: 20px;
  height: 20px;
}
.gbp__rule--size {
  width: 40px;
}

/* ── the side column ──────────────────────────────────────────────────────── */
.gbp--side {
  display: flex;
  flex-direction: column;
  gap: 36px;
}
.gbp__box {
  display: block;
  border: 1px dashed var(--gbp-ink);
  border-radius: 9px;
  animation: gbp-ring 420ms var(--gs-ease, ease) backwards;
  animation-delay: calc(var(--gs-hold, 140ms) + min(var(--d, 0), 12) * 55ms);
}
.gbp__box--search {
  height: 34px;
}
.gbp__block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.gbp__big {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gbp__box--num {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  animation: none;
}
.gbp__box--stack {
  height: 10px;
  border-radius: 3px;
}
.gbp__key {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 20px;
}
.gbp__ring--dot {
  width: 8px;
  height: 8px;
}
.gbp__ring--face {
  width: 18px;
  height: 18px;
}
.gbp__rule--track {
  flex: 1 1 auto;
}

/* The plan sits still once drawn and breathes, very slightly, so a long wait
   still reads as a wait and not as a finished page. */
.gbp__frame,
.gbp--side .gbp__block {
  animation: gbp-breathe var(--gs-t-breathe, 1700ms) ease-in-out 1s infinite;
}
@keyframes gbp-breathe {
  50% {
    opacity: 0.6;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* The drawing, the breathing and the clock's motion go; the hold-back stays,
     so a fast read still never flashes a plan. */
  .gbp {
    animation: gbp-appear 1ms linear var(--gs-hold, 140ms) backwards;
  }
  .gbp__rule,
  .gbp__ring,
  .gbp__box,
  .gbp__frame,
  .gbp--side .gbp__block {
    animation: none;
  }
}
</style>
