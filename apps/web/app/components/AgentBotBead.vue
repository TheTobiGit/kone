<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { sampleBot, type AgentBot, type BotFrame } from "~/utils/bot";

// An agent's bot, resting on the composer and watching the pointer.
//
// This is the mark for a thread that belongs to somebody: where a guest thread
// rests under a rolled face, an agent's thread rests under the creature that
// agent drives. Same place, same size, same behaviour — it blinks, it wanders,
// it follows — the only thing that changes is whose it is, which is the whole
// point of it being here.
//
// The expression the agent chose is untouched: a wary bot follows you warily.
// The look replaces where the head points, not the shape of the eyes.

const props = withDefaults(
  defineProps<{
    bot: AgentBot;
    /** Diameter, in px. */
    size?: number;
    /** Turn toward the pointer as it comes near. */
    follow?: boolean;
    /** Something is covering it — hold the last frame instead of painting. */
    covered?: boolean;
    ariaLabel?: string;
  }>(),
  { size: 55, follow: true, covered: false, ariaLabel: "" },
);

const host = shallowRef<HTMLElement | null>(null);

const reduced =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Full attention out to this many body radii; released by twice that. */
const NEAR = 4;
const FAR = 11;

const frame = shallowRef<BotFrame>(sampleBot(0.9, props.bot));

// ── pointer aim ─────────────────────────────────────────────────────────────
// Held as a raw client position and resolved against the element's box at draw
// time, so scrolling or a moving composer doesn't leave the gaze stale.
let pointer: { x: number; y: number } | null = null;

function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
}

function lookNow() {
  const el = host.value;
  if (!props.follow || !pointer || !el) return undefined;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return undefined;
  const r = Math.min(rect.width, rect.height) / 2;
  const dx = (pointer.x - (rect.left + rect.width / 2)) / r;
  const dy = (pointer.y - (rect.top + rect.height / 2)) / r;
  const dist = Math.hypot(dx, dy);
  // Eases off with distance instead of snapping, so a pointer crossing the far
  // side of the screen doesn't yank the head around.
  const mix = 1 - clamp01((dist - NEAR) / (FAR - NEAR));
  if (mix <= 0) return undefined;
  // Clamped to the unit box: past the near ring the direction is what matters,
  // not how far past it the pointer has gone.
  const k = Math.max(1, dist);
  return { nx: dx / k, ny: dy / k, mix };
}

// ── render loop ─────────────────────────────────────────────────────────────
let raf = 0;
// An accumulated clock, not wall time: a resume after a pause picks up where it
// left off rather than jumping the whole gap.
let clock = 0.9;
let last = 0;

function render(dt: number) {
  clock += dt;
  frame.value = sampleBot(clock, props.bot, lookNow());
}

function step(now: number) {
  if (!last) last = now;
  render(Math.min(0.05, (now - last) / 1000));
  last = now;
  raf = requestAnimationFrame(step);
}

function shouldRun() {
  if (reduced) return false;
  if (props.covered) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return true;
}
function play() {
  if (raf || !shouldRun()) return;
  last = 0;
  raf = requestAnimationFrame(step);
}
function pause() {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}
function sync() {
  if (shouldRun()) play();
  else pause();
}

watch(() => props.covered, sync);
watch(
  () => props.bot,
  () => render(0),
  { deep: true },
);

onMounted(() => {
  // Settle on an awake pose rather than the t=0 frame, so the first paint — and
  // the held frame under reduced motion — already has both eyes open.
  render(0);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  play();
});
onBeforeUnmount(() => {
  pause();
  document.removeEventListener("visibilitychange", sync);
  window.removeEventListener("pointermove", onPointerMove);
});
</script>

<template>
  <span
    ref="host"
    class="bot-bead"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :role="ariaLabel ? 'img' : undefined"
    :aria-label="ariaLabel || undefined"
    :aria-hidden="ariaLabel ? undefined : 'true'"
  >
    <svg viewBox="0 0 100 100">
      <g transform="translate(50 50)">
        <path
          :d="frame.bodyPath"
          :fill="frame.fill"
          :transform="`translate(${frame.driftX} ${frame.driftY}) scale(1 ${frame.breath})`"
        />
        <path
          v-for="(eye, i) in frame.eyes"
          :key="i"
          :d="eye.d"
          :transform="eye.matrix"
          :opacity="eye.alpha"
          :fill="frame.ink"
        />
      </g>
    </svg>
  </span>
</template>

<style scoped>
.bot-bead {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  pointer-events: none;
}
.bot-bead svg {
  display: block;
  width: 100%;
  height: 100%;
  /* The outline's smoothing bulges a hair past the tile; clipping it would flatten
     the widest shapes against their own edge. */
  overflow: visible;
}
</style>
