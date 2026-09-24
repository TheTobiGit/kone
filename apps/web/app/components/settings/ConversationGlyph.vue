<script setup lang="ts">
import type { ResponseGlyph } from "~/utils/responseDisplay";

// A thumbnail of one Conversation choice, drawn in the thread's own shapes: a
// dot and a bar is a step row, a run of dots is a folded batch's strip, a long
// bar is a line of text, a pill is the "Worked for…" fold. Each option's glyph
// differs from its siblings only where the choice does, so a column of them reads
// as a comparison before a word of it is read.
//
// `live` plays the glyph's one motion — the row that opens, the words that
// arrive, the turn that folds — for the option under the pointer or the one
// that's set. The preview beside the options is the real thing; this is the
// gist, at a glance.

defineProps<{
  kind: ResponseGlyph;
  /** The option that's set — the only glyph in the column wearing the accent. */
  on?: boolean;
  live?: boolean;
}>();
</script>

<template>
  <span class="cg" :class="[`cg--${kind}`, { 'cg--on': on, 'cg--live': live }]" aria-hidden="true">
    <!-- Tool calls ─────────────────────────────────────────────────────────── -->
    <template v-if="kind === 'tools-expanded'">
      <span class="cg__row"><i class="cg__dot" /><i class="cg__bar cg__bar--step" style="--w: 70%" /></span>
      <span class="cg__row"><i class="cg__dot" /><i class="cg__bar cg__bar--step" style="--w: 55%" /></span>
      <span class="cg__row cg__row--new"><i class="cg__dot" /><i class="cg__bar cg__bar--step" style="--w: 78%" /></span>
    </template>
    <template v-else-if="kind === 'tools-fold-as-it-goes'">
      <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /><i class="cg__chip" /></span>
      <i class="cg__bar cg__bar--text" style="--w: 88%" />
      <span class="cg__row cg__row--new"><i class="cg__dot" /><i class="cg__bar cg__bar--step" style="--w: 62%" /></span>
    </template>
    <template v-else-if="kind === 'tools-folded'">
      <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /><i class="cg__chip" /></span>
      <i class="cg__bar cg__bar--text" style="--w: 88%" />
      <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip cg__chip--new" /></span>
    </template>
    <template v-else-if="kind === 'tools-hidden'">
      <span class="cg__status"><i class="cg__pulse" /><i class="cg__bar cg__bar--status" style="--w: 58%" /></span>
    </template>

    <!-- Updates ────────────────────────────────────────────────────────────── -->
    <template v-else-if="kind === 'updates-show'">
      <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /></span>
      <i class="cg__bar cg__bar--text cg__bar--said" style="--w: 80%" />
      <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /></span>
      <i class="cg__bar cg__bar--text" style="--w: 92%" />
    </template>
    <template v-else-if="kind === 'updates-hide'">
      <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /><i class="cg__chip" /><i class="cg__chip" /></span>
      <i class="cg__bar cg__bar--text cg__bar--reply" style="--w: 92%" />
      <i class="cg__bar cg__bar--text cg__bar--reply" style="--w: 60%" />
    </template>

    <!-- Text ───────────────────────────────────────────────────────────────── -->
    <template v-else-if="kind === 'text-stream'">
      <i class="cg__bar cg__bar--text" style="--w: 92%" />
      <span class="cg__typing"><i class="cg__bar cg__bar--text cg__bar--grow" style="--w: 64%" /><i class="cg__caret" /></span>
    </template>
    <template v-else-if="kind === 'text-whole'">
      <span class="cg__block">
        <i class="cg__bar cg__bar--text" style="--w: 92%" />
        <i class="cg__bar cg__bar--text" style="--w: 80%" />
        <i class="cg__bar cg__bar--text" style="--w: 46%" />
      </span>
    </template>

    <!-- Done, work hidden ─────────────────────────────────────────────────── -->
    <template v-else-if="kind === 'done-hidden'">
      <span class="cg__fold">
        <span class="cg__folded">
          <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /></span>
          <i class="cg__bar cg__bar--text cg__bar--dim" style="--w: 74%" />
          <span class="cg__strip"><i class="cg__chip" /><i class="cg__chip" /></span>
        </span>
        <i class="cg__pill" />
      </span>
      <i class="cg__bar cg__bar--text" style="--w: 90%" />
    </template>
  </span>
</template>

<style scoped>
/* A small sheet of paper: the thread's ground, a hairline edge, and the marks
   laid on it in the thread's rhythm. Everything is ink at low strength, so the
   accent on the selected option's glyph is the only colour in the column. */
.cg {
  --cg-ink: color-mix(in srgb, var(--ink) 22%, transparent);
  --cg-ink-strong: color-mix(in srgb, var(--ink) 38%, transparent);
  --cg-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 100%;
  height: 56px;
  padding: 8px 10px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
  flex-shrink: 0;
  overflow: hidden;
  transition:
    background-color 220ms ease,
    box-shadow 220ms ease;
}
.cg--on {
  --cg-ink-strong: color-mix(in srgb, var(--accent) 70%, transparent);
  background-color: color-mix(in srgb, var(--accent) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}

.cg i {
  display: block;
  flex-shrink: 0;
}
.cg__row,
.cg__strip,
.cg__status,
.cg__typing {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cg__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background-color: var(--cg-ink-strong);
}
.cg__bar {
  width: var(--w);
  height: 3px;
  border-radius: 2px;
  background-color: var(--cg-ink);
}
.cg__row .cg__bar,
.cg__status .cg__bar {
  width: calc(var(--w) - 9px);
}
.cg__bar--text {
  height: 4px;
  background-color: var(--cg-ink-strong);
  opacity: 0.8;
}
.cg__bar--dim {
  opacity: 0.4;
}
.cg__chip {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background-color: var(--cg-ink-strong);
  opacity: 0.75;
}
.cg__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--cg-ink-strong);
}
.cg__caret {
  width: 1.5px;
  height: 8px;
  border-radius: 1px;
  background-color: var(--cg-ink-strong);
}
.cg__block {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* The "Worked for…" fold: the work above it squeezed shut, the pill that
   stands for it left behind. */
.cg__fold {
  position: relative;
  display: flex;
  flex-direction: column;
}
.cg__folded {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
  max-height: 0;
  opacity: 0;
}
.cg__pill {
  width: 26px;
  height: 6px;
  border-radius: 3px;
  background-color: var(--cg-ink-strong);
  opacity: 0.55;
}

/* ── the one motion each glyph plays while live ─────────────────────────── */
/* Expanded / as it goes: the newest step row opens in. */
.cg--live .cg__row--new {
  animation: cg-row 2.4s var(--cg-ease) infinite;
}
@keyframes cg-row {
  0%,
  12% {
    opacity: 0;
    transform: translateY(3px);
  }
  30%,
  100% {
    opacity: 1;
    transform: none;
  }
}
/* As it goes: the batch above folds into its strip as the next one opens —
   carried by the new row; the strip is already folded. Folded: the newest chip
   joins the strip. */
.cg--live .cg__chip--new {
  animation: cg-chip 2.4s var(--cg-ease) infinite;
}
@keyframes cg-chip {
  0%,
  20% {
    opacity: 0;
    transform: scale(0.4);
  }
  40%,
  100% {
    opacity: 0.75;
    transform: none;
  }
}
/* Updates shown: the line said along the way arrives between the batches.
   Hidden: only the reply lands, after the work. */
.cg--live .cg__bar--said,
.cg--live .cg__bar--reply {
  animation: cg-land 2.4s var(--cg-ease) infinite;
}
/* Hidden: the status line breathes. */
.cg--live .cg__pulse {
  animation: cg-breathe 1.6s ease-in-out infinite;
}
@keyframes cg-breathe {
  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}
/* Stream: the line grows word by word behind a caret. */
.cg--live .cg__bar--grow {
  animation: cg-grow 2.4s steps(6, end) infinite;
}
.cg--live .cg__caret {
  animation: cg-blink 0.8s steps(1, end) infinite;
}
@keyframes cg-grow {
  from {
    width: 0;
  }
  70%,
  to {
    width: var(--w);
  }
}
@keyframes cg-blink {
  50% {
    opacity: 0;
  }
}
/* Whole: the message lands in one piece. */
.cg--live .cg__block {
  animation: cg-land 2.4s var(--cg-ease) infinite;
}
@keyframes cg-land {
  0%,
  30% {
    opacity: 0;
    transform: translateY(3px);
  }
  45%,
  100% {
    opacity: 1;
    transform: none;
  }
}
/* Done with the work hidden: it shows, then squeezes shut into its pill. */
.cg--live .cg__folded {
  animation: cg-fold 3s var(--cg-ease) infinite;
}
@keyframes cg-fold {
  0%,
  35% {
    max-height: 40px;
    opacity: 1;
    margin-bottom: 4px;
  }
  60%,
  100% {
    max-height: 0;
    opacity: 0;
    margin-bottom: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cg--live * {
    animation: none !important;
  }
}
</style>
