<script setup lang="ts">
// The resting mark on the composer: a small round face that watches the pointer.
//
// It never changes shape. The composer opens out of it and covers it, and the
// face just stays where it is underneath — so waking is one move (the card
// growing) instead of two things negotiating the same silhouette.
//
// The eyes are holes in a mask, not shapes laid on top, so the silhouette clips
// them for free. Every frame is a pure function of the clock, so the loop can
// park while the face is covered and resume without a jump.
import { onMounted, onBeforeUnmount, ref, shallowRef, useId, watch } from "vue";
import { sampleFace, type FaceFrame } from "~/utils/sphereFace";

const props = withDefaults(
  defineProps<{
    /** Diameter of the body, in px. */
    size?: number;
    /** Turn the head toward the pointer as it comes near. */
    follow?: boolean;
    /** Something is covering it — hold the last frame instead of painting. */
    covered?: boolean;
  }>(),
  { size: 55, follow: true, covered: false },
);

const root = ref<HTMLElement | null>(null);

// Unique per instance so two faces on one page don't share a mask. Has to come
// from the framework rather than a random string: a random one differs between
// the server pass and the client pass, and the mask ends up pointing at an id
// that no longer exists — which renders as a plain filled square.
const maskId = `sphere-face-${useId()}`;

const reduced =
  "window" in globalThis &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const frame = shallowRef<FaceFrame>({ bodyPath: "", eyes: [] });

// ── pointer aim ─────────────────────────────────────────────────────────────
// Held as a raw client position and resolved against the element's box at draw
// time, so scrolling or a moving composer doesn't leave the gaze stale.
let pointer: { x: number; y: number } | null = null;
/** Full attention out to this many body radii; released by twice that. */
const NEAR = 4;
const FAR = 11;

function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
}

function aimNow() {
  const el = root.value;
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
let clock = 0;
let last = 0;

function render(dt: number) {
  clock += dt;
  frame.value = sampleFace(clock, { size: props.size, aim: aimNow() });
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
  if ("document" in globalThis && document.hidden) return false;
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
watch(() => props.size, () => render(0));

onMounted(() => {
  // Settle on an awake pose rather than the t=0 frame, so the first paint — and
  // the held frame under reduced motion — already has both eyes open.
  clock = 0.9;
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
  <div
    ref="root"
    class="sphere-face"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <!-- No viewBox on purpose: user units are then CSS px, so the geometry can
         be built straight from the size and nothing in the markup has to resize
         with it. -->
    <svg width="100%" height="100%">
      <defs>
        <!-- White keeps the body, black punches the eyes through it. -->
        <mask :id="maskId" maskUnits="userSpaceOnUse"
              x="0" y="0" width="100%" height="100%">
          <path :d="frame.bodyPath" fill="#fff" />
          <path
            v-for="(eye, i) in frame.eyes"
            :key="i"
            :d="eye.d"
            :transform="eye.matrix"
            :opacity="eye.alpha"
            fill="#000"
          />
        </mask>
      </defs>
      <g :mask="`url(#${maskId})`">
        <rect x="0" y="0" width="100%" height="100%" fill="var(--ink)" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.sphere-face {
  pointer-events: none;
}
.sphere-face svg {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
