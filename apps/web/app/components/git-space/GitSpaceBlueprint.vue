<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

// What a list looks like while a slow read is still on its way: not grey bars
// but the list's own plan, drawn in dotted guides over a dot grid.
//
// The grey skeleton is right for local reads that land in a beat. A read that
// goes over the network (GitHub, mostly) can take a second or two, and for that
// long a breathing block says nothing.
//
// A list of text can't be predicted the way a fixed card can: nobody knows how
// long a title is until it arrives. What is known is the grid the text will sit
// on. So the plan draws only that: the columns and what each one holds, the
// baselines every title and every line of detail will rest on, and the marks
// whose size never changes (a checks ring, a reviewer's face, a size bar). The
// text itself resolves onto those baselines when it lands.

const props = withDefaults(
  defineProps<{
    rows?: number;
    /** What is being read, for the caption and for screen readers. */
    what?: string;
    /** The columns, left to right: the mark, the text, then the right end. */
    columns?: { mark: string; text: string; right: string[] };
  }>(),
  {
    rows: 5,
    what: "data",
    columns: () => ({ mark: "checks", text: "title · number", right: ["review", "size"] }),
  },
);

// A quiet clock in the corner: the plan is a read in progress, and the time it
// has taken is the one honest thing to say about it.
const elapsed = ref("0.0");
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  const started = performance.now();
  timer = setInterval(() => {
    elapsed.value = ((performance.now() - started) / 1000).toFixed(1);
  }, 100);
});
onBeforeUnmount(() => clearInterval(timer));

defineExpose({ rows: props.rows });
</script>

<template>
  <div class="gbp" role="status" :aria-label="`Loading ${what}`">
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

      <!-- The column edges run the frame's full height, the way a layout grid
           does: where the text starts and where the right end begins. -->
      <i class="gbp__guide gbp__guide--text" />
      <i class="gbp__guide gbp__guide--right" />

      <!-- Sits where the first group's label will, at its height, so the
           rows below line up with the rows that replace them. -->
      <div class="gbp__cols">
        <span class="gbp__col gbp__col--mark">{{ columns.mark }}</span>
        <span class="gbp__col gbp__col--text">{{ columns.text }}</span>
        <span class="gbp__col gbp__col--right">
          <span v-for="c in columns.right" :key="c">{{ c }}</span>
        </span>
      </div>

      <div v-for="i in rows" :key="i" class="gbp__row" :style="{ '--d': i }">
        <i class="gbp__ring" />
        <span class="gbp__body">
          <span class="gbp__line gbp__line--title">
            <i class="gbp__base" />
            <span class="gbp__num">#–––</span>
          </span>
          <span class="gbp__line gbp__line--meta">
            <i class="gbp__dot" />
            <i class="gbp__base gbp__base--soft" />
          </span>
        </span>
        <span class="gbp__right">
          <i class="gbp__ring gbp__ring--sm" />
          <i class="gbp__base gbp__base--size" />
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The guides are ink at a whisper: present enough to read as a plan, never
   enough to read as content. */
.gbp {
  --gbp-ink: color-mix(in srgb, var(--ink) 30%, transparent);
  --gbp-soft: color-mix(in srgb, var(--ink) 16%, transparent);
  --gbp-dot: color-mix(in srgb, var(--ink) 9%, transparent);
  --gbp-label: color-mix(in srgb, var(--ink) 40%, transparent);
  /* Where the text starts in a row (the mark's width plus the gap) and how
     wide the right end is (a face, the gap, a size bar). */
  --gbp-text: 38px;
  --gbp-right: 76px;
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
.gbp::before {
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
  color: var(--gbp-label);
  font-variant-numeric: tabular-nums;
}

/* ── the frame: a selection box's corners, not a border ───────────────────── */
.gbp__frame {
  position: relative;
  animation: gbp-breathe var(--gs-t-breathe, 1700ms) ease-in-out 1.2s infinite;
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

.gbp__guide {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 1px;
  background-image: linear-gradient(to bottom, var(--gbp-soft) 50%, transparent 50%);
  background-size: 1px 4px;
  transform-origin: top center;
  animation: gbp-drop 700ms var(--gs-ease, ease) var(--gs-hold, 140ms) backwards;
}
.gbp__guide--text {
  left: calc(var(--gbp-text) - 7px);
}
.gbp__guide--right {
  right: calc(var(--gbp-right) + 8px);
}
@keyframes gbp-drop {
  from {
    transform: scaleY(0);
  }
}

/* ── the column heads ─────────────────────────────────────────────────────── */
.gbp__cols {
  display: flex;
  align-items: center;
  height: 17px;
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--gbp-label);
  white-space: nowrap;
  animation: gbp-appear 400ms var(--gs-ease, ease) var(--gs-hold, 140ms) backwards;
}
.gbp__col--mark {
  width: var(--gbp-text);
  flex-shrink: 0;
}
.gbp__col--text {
  flex: 1 1 auto;
}
.gbp__col--right {
  display: flex;
  justify-content: space-between;
  width: var(--gbp-right);
  flex-shrink: 0;
}

/* ── a row: the real row's own box, so the text lands on these lines ──────── */
.gbp__row {
  display: flex;
  align-items: center;
  gap: 14px;
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
/* Each line is the height of the text it stands for, and its rule sits on
   that text's baseline rather than through its middle. */
.gbp__line {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding-bottom: 3px;
}
.gbp__line--title {
  height: 18px;
}
.gbp__line--meta {
  height: 14px;
}

/* A baseline: dotted, capped, and drawn in left to right, row by row. */
.gbp__base {
  position: relative;
  display: block;
  flex: 1 1 auto;
  height: 1px;
  background-image: linear-gradient(to right, var(--gbp-ink) 50%, transparent 50%);
  background-size: 4px 1px;
  transform-origin: left center;
  animation: gbp-draw 560ms var(--gs-ease, ease) backwards;
  animation-delay: calc(var(--gs-hold, 140ms) + 120ms + min(var(--d, 0), 12) * 60ms);
}
.gbp__base::before,
.gbp__base::after {
  content: "";
  position: absolute;
  top: -1px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background-color: var(--gbp-ink);
}
.gbp__base::before {
  left: -1px;
}
.gbp__base::after {
  right: -1px;
}
.gbp__base--soft {
  background-image: linear-gradient(to right, var(--gbp-soft) 50%, transparent 50%);
}
.gbp__base--soft::before,
.gbp__base--soft::after {
  background-color: var(--gbp-soft);
}
.gbp__base--size {
  flex: 0 0 40px;
}
@keyframes gbp-draw {
  from {
    transform: scaleX(0);
  }
}

/* The number is the one part of a title whose shape is known: a hash and a
   few digits, waiting. */
.gbp__num {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--gbp-label);
  transform: translateY(4px);
  animation: gbp-appear 400ms var(--gs-ease, ease) backwards;
  animation-delay: calc(var(--gs-hold, 140ms) + 400ms + min(var(--d, 0), 12) * 60ms);
}
.gbp__dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  margin-bottom: -2px;
  border-radius: 50%;
  border: 1px dashed var(--gbp-ink);
}

.gbp__ring {
  display: block;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px dashed var(--gbp-ink);
  animation: gbp-ring 420ms var(--gs-ease, ease) backwards;
  animation-delay: calc(var(--gs-hold, 140ms) + min(var(--d, 0), 12) * 60ms);
}
.gbp__ring--sm {
  width: 20px;
  height: 20px;
}
@keyframes gbp-ring {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
}
.gbp__right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

/* Once drawn the plan breathes, very slightly, so a long wait still reads as
   a wait and not as a finished page. */
@keyframes gbp-breathe {
  50% {
    opacity: 0.6;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* The drawing and the breathing go; the hold-back stays, so a fast read
     still never flashes a plan. */
  .gbp {
    animation: gbp-appear 1ms linear var(--gs-hold, 140ms) backwards;
  }
  .gbp__frame,
  .gbp__guide,
  .gbp__cols,
  .gbp__base,
  .gbp__num,
  .gbp__ring {
    animation: none;
  }
}
</style>
