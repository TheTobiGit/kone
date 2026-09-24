<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

// The settings root's row marks: one small drawn picture per section, in place
// of a stock icon. Each is a line drawing that sits quiet in the list and acts
// out what its section does when its row is under the pointer or focused. The
// keyboard types, the strip scrolls a column into centre, the gauge sweeps. So
// hovering down the list previews each section before you open it.
//
// Two motions, both CSS:
//   · intro — the strokes draw themselves in once, as the row enters (the drawer
//     remounts the list on every open, so this replays per open);
//   · live  — a loop that runs only while `live` is set.
// All of it stops under prefers-reduced-motion.

export type SettingsGlyphKind =
  | "shortcuts"
  | "strip"
  | "conversation"
  | "appearance"
  | "typography"
  | "agents"
  | "subagents"
  | "workspace"
  | "providers"
  | "skills"
  | "usage"
  | "limits";

defineProps<{ kind: SettingsGlyphKind; live?: boolean }>();

// Once the intro has played, the drawing is pinned in its finished state. Without
// this, a live loop that borrows a stroke's animation would, on ending, hand it
// back to the intro, which would start over and blank the stroke for its delay.
const settled = ref(false);
let settle: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  settle = setTimeout(() => (settled.value = true), 1800);
});
onBeforeUnmount(() => clearTimeout(settle));
</script>

<template>
  <span class="sg" :class="[`sg--${kind}`, { 'sg--live': live, 'sg--settled': settled }]" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <!-- Keyboard: the keys light in a typing run, the spacebar dips. -->
      <template v-if="kind === 'shortcuts'">
        <rect class="d" x="2.5" y="6" width="19" height="12.5" rx="3" pathLength="1" />
        <circle class="key" cx="7" cy="10.2" r="0.9" style="--k: 0" />
        <circle class="key" cx="10.3" cy="10.2" r="0.9" style="--k: 1" />
        <circle class="key" cx="13.7" cy="10.2" r="0.9" style="--k: 2" />
        <circle class="key" cx="17" cy="10.2" r="0.9" style="--k: 3" />
        <path class="d space" d="M8 14.6h8" pathLength="1" />
      </template>

      <!-- Thread strip: three columns scroll under a fixed centre frame. -->
      <template v-else-if="kind === 'strip'">
        <g class="cols">
          <rect x="-4" y="8" width="5" height="8" rx="1.4" />
          <rect x="3" y="8" width="5" height="8" rx="1.4" />
          <rect x="9.5" y="7" width="5" height="10" rx="1.4" />
          <rect x="16" y="8" width="5" height="8" rx="1.4" />
          <rect x="23" y="8" width="5" height="8" rx="1.4" />
        </g>
        <path class="d frame" d="M8 4.5H7a1 1 0 0 0-1 1M16 4.5h1a1 1 0 0 1 1 1M8 19.5H7a1 1 0 0 1-1-1M16 19.5h1a1 1 0 0 0 1-1" pathLength="1" />
      </template>

      <!-- Conversation: a bubble with a reply being typed into it. -->
      <template v-else-if="kind === 'conversation'">
        <path
          class="d"
          d="M5.5 4.5h13a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16.5h-1A2.5 2.5 0 0 1 3 14V7a2.5 2.5 0 0 1 2.5-2.5z"
          pathLength="1"
        />
        <circle class="dot" cx="8.5" cy="10.5" r="1" style="--k: 0" />
        <circle class="dot" cx="12" cy="10.5" r="1" style="--k: 1" />
        <circle class="dot" cx="15.5" cy="10.5" r="1" style="--k: 2" />
      </template>

      <!-- Appearance: day turns to night. The disc rolls, the rays breathe. -->
      <template v-else-if="kind === 'appearance'">
        <g class="rays">
          <path d="M12 2.2v1.6M12 20.2v1.6M2.2 12h1.6M20.2 12h1.6M5 5l1.1 1.1M17.9 17.9 19 19M5 19l1.1-1.1M17.9 6.1 19 5" />
        </g>
        <g class="disc">
          <circle class="d" cx="12" cy="12" r="5.2" pathLength="1" />
          <path class="half" d="M12 6.8a5.2 5.2 0 0 1 0 10.4z" stroke="none" />
        </g>
      </template>

      <!-- Typography: an A that writes itself, and a caret beside it. -->
      <template v-else-if="kind === 'typography'">
        <path class="d a" d="M4 19 9.5 5 15 19" pathLength="1" />
        <path class="d cross" d="M6.2 14h6.6" pathLength="1" />
        <path class="caret" d="M19 6v13" />
      </template>

      <!-- Agents: two figures, taking turns to speak up. -->
      <template v-else-if="kind === 'agents'">
        <g class="fig back">
          <circle cx="16.5" cy="8.5" r="2.4" />
          <path d="M13.2 18.5a3.4 3.4 0 0 1 6.8 0" />
        </g>
        <g class="fig front">
          <circle class="d" cx="9" cy="8" r="3" pathLength="1" />
          <path class="d" d="M4 19a5 5 0 0 1 10 0" pathLength="1" />
        </g>
      </template>

      <!-- Sub-agents: a parent hands work down; the children appear in turn. -->
      <template v-else-if="kind === 'subagents'">
        <circle class="d" cx="12" cy="5.5" r="2.3" pathLength="1" />
        <path class="wire" d="M12 7.8v4.2M12 12H6v3.5M12 12h6v3.5M12 12v3.5" pathLength="1" />
        <circle class="kid" cx="6" cy="18" r="1.9" style="--k: 0" />
        <circle class="kid" cx="12" cy="18" r="1.9" style="--k: 1" />
        <circle class="kid" cx="18" cy="18" r="1.9" style="--k: 2" />
      </template>

      <!-- Workspace: a window of panes that rebalance their widths. -->
      <template v-else-if="kind === 'workspace'">
        <rect class="d" x="3" y="4.5" width="18" height="15" rx="2.5" pathLength="1" />
        <path class="div div-a" d="M9 4.5v15" />
        <path class="div div-b" d="M15 4.5v15" />
        <rect class="pane" x="9" y="4.5" width="6" height="15" stroke="none" />
      </template>

      <!-- Providers: a chip whose pins carry a signal round, core pulsing. -->
      <template v-else-if="kind === 'providers'">
        <rect class="d" x="6.5" y="6.5" width="11" height="11" rx="2.2" pathLength="1" />
        <rect class="core" x="9.6" y="9.6" width="4.8" height="4.8" rx="1" stroke="none" />
        <path class="pin" d="M9.5 3v2.5M14.5 3v2.5" style="--k: 0" />
        <path class="pin" d="M21 9.5h-2.5M21 14.5h-2.5" style="--k: 1" />
        <path class="pin" d="M14.5 21v-2.5M9.5 21v-2.5" style="--k: 2" />
        <path class="pin" d="M3 14.5h2.5M3 9.5h2.5" style="--k: 3" />
      </template>

      <!-- Skills: three blocks set, the fourth slots in and clicks home. -->
      <template v-else-if="kind === 'skills'">
        <rect class="d" x="4" y="4" width="7" height="7" rx="1.8" pathLength="1" />
        <rect class="d" x="13" y="4" width="7" height="7" rx="1.8" pathLength="1" />
        <rect class="d" x="4" y="13" width="7" height="7" rx="1.8" pathLength="1" />
        <rect class="slot" x="13" y="13" width="7" height="7" rx="1.8" />
        <rect class="piece" x="13" y="13" width="7" height="7" rx="1.8" />
      </template>

      <!-- Usage: bars rising and settling on a baseline. -->
      <template v-else-if="kind === 'usage'">
        <path class="d" d="M3.5 20h17" pathLength="1" />
        <rect class="bar" x="5" y="11" width="2.6" height="7" rx="1" style="--k: 0" />
        <rect class="bar" x="9.4" y="6" width="2.6" height="12" rx="1" style="--k: 1" />
        <rect class="bar" x="13.8" y="9" width="2.6" height="9" rx="1" style="--k: 2" />
        <rect class="bar" x="18.2" y="13" width="2.6" height="5" rx="1" style="--k: 3" />
      </template>

      <!-- Limits: a gauge whose needle sweeps and the reading fills behind it. -->
      <template v-else-if="kind === 'limits'">
        <path class="d" d="M4 17a8 8 0 0 1 16 0" pathLength="1" />
        <path class="fill" d="M4 17a8 8 0 0 1 16 0" pathLength="1" />
        <path class="needle" d="M12 17 12 10.5" />
        <circle cx="12" cy="17" r="1.3" fill="currentColor" stroke="none" />
      </template>
    </svg>
  </span>
</template>

<style scoped>
/* The tile: a small square of paper under the drawing, ink at low strength.
   The live row fills it with the accent wash and the drawing takes the accent,
   so the one row you're about to open is the only colour in the list. */
.sg {
  --sg-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --sg-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 9px;
  color: var(--ink-soft);
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent);
  transition:
    color 220ms ease,
    background-color 220ms ease,
    box-shadow 220ms ease,
    transform 380ms var(--sg-spring);
}
.sg--live {
  color: var(--accent);
  background-color: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
  transform: rotate(-6deg) scale(1.06);
}
svg {
  overflow: visible;
}
svg * {
  transform-box: fill-box;
  transform-origin: center;
}

/* ── intro: strokes draw themselves in ─────────────────────────────────────── */
.d {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: sg-draw 700ms var(--sg-ease) calc(var(--row-delay, 0ms) + 120ms) forwards;
}
@keyframes sg-draw {
  to {
    stroke-dashoffset: 0;
  }
}

/* ── shortcuts ─────────────────────────────────────────────────────────────── */
.key {
  fill: currentColor;
  stroke: none;
}
.sg--live .key {
  animation: sg-key 1.1s ease-in-out calc(var(--k) * 140ms) infinite;
}
@keyframes sg-key {
  0%, 60%, 100% { transform: scale(1); opacity: 1; }
  25% { transform: scale(0.45); opacity: 0.5; }
}
.sg--live .space {
  animation:
    sg-draw 0s forwards,
    sg-space 1.1s ease-in-out 560ms infinite;
}
@keyframes sg-space {
  0%, 70%, 100% { transform: translateY(0); }
  82% { transform: translateY(1.2px); }
}

/* ── strip ─────────────────────────────────────────────────────────────────── */
.cols rect {
  stroke-width: 1.4;
}
.cols {
  transform-box: view-box;
  transform-origin: 12px 12px;
}
.sg--live .cols {
  animation: sg-scroll 2.4s var(--sg-ease) infinite;
}
@keyframes sg-scroll {
  0%, 12% { transform: translateX(0); }
  38%, 55% { transform: translateX(-6.5px); }
  80%, 100% { transform: translateX(0); }
}
.frame {
  stroke: var(--accent);
  stroke-width: 1.4;
}

/* ── conversation ──────────────────────────────────────────────────────────── */
.dot {
  fill: currentColor;
  stroke: none;
}
.sg--live .dot {
  animation: sg-hop 0.9s ease-in-out calc(var(--k) * 120ms) infinite;
}
@keyframes sg-hop {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-1.8px); }
}

/* ── appearance ────────────────────────────────────────────────────────────── */
.half {
  fill: currentColor;
}
.disc {
  transform-box: view-box;
  transform-origin: 12px 12px;
  transition: transform 700ms var(--sg-spring);
}
.sg--live .disc {
  transform: rotate(180deg);
}
.rays {
  transform-box: view-box;
  transform-origin: 12px 12px;
  opacity: 0.7;
  transition: opacity 300ms ease;
}
.sg--live .rays {
  opacity: 1;
  animation: sg-rays 2.8s ease-in-out infinite;
}
@keyframes sg-rays {
  0%, 100% { transform: rotate(0) scale(1); }
  50% { transform: rotate(22deg) scale(0.86); }
}

/* ── typography ────────────────────────────────────────────────────────────── */
.caret {
  stroke: var(--accent);
  opacity: 0;
}
.sg--live .caret {
  animation: sg-blink 0.9s steps(1) infinite;
}
@keyframes sg-blink {
  0% { opacity: 1; }
  50% { opacity: 0; }
}
.sg--live .a,
.sg--live .cross {
  animation: sg-rewrite 2.2s var(--sg-ease) infinite;
}
.sg--live .cross {
  animation-delay: 180ms;
}
@keyframes sg-rewrite {
  0% { stroke-dashoffset: 0; }
  30% { stroke-dashoffset: 1; }
  70%, 100% { stroke-dashoffset: 0; }
}

/* ── agents ────────────────────────────────────────────────────────────────── */
.back {
  opacity: 0.55;
}
.sg--live .front {
  animation: sg-bob 1.6s ease-in-out infinite;
}
.sg--live .back {
  animation: sg-bob 1.6s ease-in-out 800ms infinite;
}
@keyframes sg-bob {
  0%, 100% { transform: translateY(0); }
  40% { transform: translateY(-1.6px); }
}

/* ── subagents ─────────────────────────────────────────────────────────────── */
.wire {
  stroke-width: 1.3;
  opacity: 0.75;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: sg-draw 600ms var(--sg-ease) calc(var(--row-delay, 0ms) + 380ms) forwards;
}
.kid {
  fill: currentColor;
  stroke: none;
  transform: scale(0);
  animation: sg-pop 420ms var(--sg-spring) calc(var(--row-delay, 0ms) + 600ms + var(--k) * 90ms) forwards;
}
@keyframes sg-pop {
  to { transform: scale(1); }
}
.sg--live .wire {
  animation: sg-rewire 2.1s var(--sg-ease) infinite;
}
@keyframes sg-rewire {
  0% { stroke-dashoffset: 1; }
  35%, 100% { stroke-dashoffset: 0; }
}
.sg--live .kid {
  animation: sg-spawn 2.1s var(--sg-spring) calc(500ms + var(--k) * 110ms) infinite;
}
@keyframes sg-spawn {
  0% { transform: scale(0); }
  20%, 85% { transform: scale(1); }
  100% { transform: scale(0); }
}

/* ── workspace ─────────────────────────────────────────────────────────────── */
.div {
  stroke-width: 1.4;
  transition: transform 600ms var(--sg-spring);
}
.pane {
  fill: currentColor;
  opacity: 0.16;
  transform-box: view-box;
  transform-origin: 12px 12px;
  transition: transform 600ms var(--sg-spring);
}
.sg--live .div-a { animation: sg-pane-a 2.6s var(--sg-ease) infinite; }
.sg--live .div-b { animation: sg-pane-b 2.6s var(--sg-ease) infinite; }
.sg--live .pane { animation: sg-pane-w 2.6s var(--sg-ease) infinite; }
@keyframes sg-pane-a {
  0%, 100% { transform: translateX(0); }
  33% { transform: translateX(-3px); }
  66% { transform: translateX(2px); }
}
@keyframes sg-pane-b {
  0%, 100% { transform: translateX(0); }
  33% { transform: translateX(3px); }
  66% { transform: translateX(2.5px); }
}
@keyframes sg-pane-w {
  0%, 100% { transform: translateX(0) scaleX(1); }
  33% { transform: translateX(0) scaleX(2); }
  66% { transform: translateX(2.25px) scaleX(1.08); }
}

/* ── providers ─────────────────────────────────────────────────────────────── */
.core {
  fill: currentColor;
  opacity: 0.35;
}
.pin {
  stroke-width: 1.5;
}
.sg--live .core {
  animation: sg-core 1.6s ease-in-out infinite;
}
@keyframes sg-core {
  0%, 100% { opacity: 0.35; transform: scale(1); }
  50% { opacity: 0.9; transform: scale(0.8); }
}
.sg--live .pin {
  animation: sg-signal 1.6s ease-in-out calc(var(--k) * 200ms) infinite;
}
@keyframes sg-signal {
  0%, 50%, 100% { stroke: currentColor; }
  20% { stroke: var(--ink); }
}

/* ── skills ────────────────────────────────────────────────────────────────── */
.slot {
  stroke-dasharray: 1.6 1.8;
  stroke-width: 1.2;
  opacity: 0.5;
}
.piece {
  fill: color-mix(in srgb, currentColor 30%, transparent);
  transform: translate(4px, 4px) rotate(18deg) scale(0.6);
  opacity: 0;
  transition:
    transform 520ms var(--sg-spring),
    opacity 200ms ease;
}
.sg--live .piece {
  opacity: 1;
  transform: none;
}

/* ── usage ─────────────────────────────────────────────────────────────────── */
.bar {
  fill: currentColor;
  stroke: none;
  opacity: 0.85;
  transform-origin: bottom;
  transform: scaleY(0);
  animation: sg-rise 520ms var(--sg-spring) calc(var(--row-delay, 0ms) + 200ms + var(--k) * 70ms) forwards;
}
@keyframes sg-rise {
  to { transform: scaleY(1); }
}
.sg--live .bar {
  transform: scaleY(1);
  animation: sg-bars 1.4s ease-in-out calc(var(--k) * 110ms) infinite;
}
@keyframes sg-bars {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.45); }
}

/* ── limits ────────────────────────────────────────────────────────────────── */
.fill {
  stroke: var(--accent);
  stroke-width: 2.2;
  stroke-dasharray: 1;
  stroke-dashoffset: 0.62;
  opacity: 0;
  transition: opacity 250ms ease;
}
.needle {
  stroke-width: 1.8;
  transform-box: view-box;
  transform-origin: 12px 17px;
  transform: rotate(-20deg);
}
.sg--live .fill {
  opacity: 1;
  animation: sg-fill 2.2s var(--sg-ease) infinite;
}
.sg--live .needle {
  animation: sg-sweep 2.2s var(--sg-ease) infinite;
}
@keyframes sg-sweep {
  0%, 100% { transform: rotate(-80deg); }
  55%, 70% { transform: rotate(52deg); }
}
@keyframes sg-fill {
  0%, 100% { stroke-dashoffset: 1; }
  55%, 70% { stroke-dashoffset: 0.21; }
}

/* ── settled: the intro is over, hold every stroke finished ──────────────────
   :where() keeps these at the base rules' weight, so a live loop still wins. */
:where(.sg--settled) .d,
:where(.sg--settled) .wire {
  animation: none;
  stroke-dashoffset: 0;
}
:where(.sg--settled) .kid,
:where(.sg--settled) .bar {
  animation: none;
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  .sg,
  .sg *,
  .sg--live * {
    animation: none !important;
    transition: none !important;
  }
  .d,
  .wire {
    stroke-dashoffset: 0;
  }
  .kid,
  .bar {
    transform: none;
  }
}
</style>
