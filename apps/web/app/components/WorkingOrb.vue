<script setup lang="ts">
// The general "agent is working" mark — a single-row particle band that grows
// longer, fuller, and denser the longer the wait lasts. Resets each time a new
// gap opens (send, or a lull between steps).
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  drawWorkingOrb,
  hexToHueDeg,
  WORKING_ORB_HUE,
  WORKING_ORB_LABEL,
} from "~/utils/toolOrbDraw";

const props = withDefaults(
  defineProps<{
    hue?: string;
    /** Fixed track width — the band grows within this, never wraps a second row. */
    width?: number;
    height?: number;
    active?: boolean;
  }>(),
  { hue: WORKING_ORB_HUE, width: 80, height: 14, active: true },
);

const canvas = ref<HTMLCanvasElement | null>(null);
const root = ref<HTMLElement | null>(null);

const darkMedia =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let isDark = darkMedia?.matches ?? true;
const onTheme = (e: MediaQueryListEvent) => (isDark = e.matches);
const reduced =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let phase = 0;
let waitSec = 0;
let last = 0;
let hueDeg = hexToHueDeg(WORKING_ORB_HUE);

function resolveHue(): string {
  const raw = props.hue.trim();
  if (raw.startsWith("#")) return raw;
  const el = root.value ?? canvas.value;
  if (!el || typeof window === "undefined") return WORKING_ORB_HUE;
  const probe = document.createElement("span");
  probe.style.color = raw;
  el.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  el.removeChild(probe);
  const m = resolved.match(/[\d.]+/g);
  if (!m || m.length < 3) return WORKING_ORB_HUE;
  return `#${[m[0], m[1], m[2]]
    .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function syncHue() {
  hueDeg = hexToHueDeg(resolveHue());
}

function resetWait() {
  waitSec = 0;
  phase = 0;
  last = 0;
}

function draw(now: number) {
  const el = canvas.value;
  if (!el || !ctx) return;
  if (!last) last = now;
  const dt = Math.min(0.05, (now - last) / 1000);
  phase += dt;
  waitSec += dt;
  last = now;
  const time = reduced ? 0.35 : phase;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = props.width;
  const H = props.height;
  const pxW = Math.round(W * dpr);
  const pxH = Math.round(H * dpr);
  if (el.width !== pxW || el.height !== pxH) {
    el.width = pxW;
    el.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  drawWorkingOrb({
    ctx,
    size: Math.max(W, H),
    width: W,
    height: H,
    time,
    waitSec,
    hueDeg,
    theme: { isDark, reduced },
  });
}

function loop(now: number) {
  draw(now);
  raf = requestAnimationFrame(loop);
}

function shouldRun() {
  return props.active && !(typeof document !== "undefined" && document.hidden);
}

function play() {
  syncHue();
  if (!shouldRun()) {
    if (!raf) draw(performance.now());
    return;
  }
  if (raf) return;
  resetWait();
  raf = requestAnimationFrame(loop);
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

watch(
  () => props.active,
  (on) => {
    if (on) resetWait();
    sync();
  },
);
watch(() => props.hue, syncHue);
watch([() => props.width, () => props.height], () => draw(performance.now()));

onMounted(() => {
  ctx = canvas.value?.getContext("2d") ?? null;
  darkMedia?.addEventListener("change", onTheme);
  document.addEventListener("visibilitychange", sync);
  play();
});

onBeforeUnmount(() => {
  pause();
  darkMedia?.removeEventListener("change", onTheme);
  document.removeEventListener("visibilitychange", sync);
});
</script>

<template>
  <span ref="root" class="working-orb">
    <canvas
      ref="canvas"
      class="working-orb__canvas"
      :style="{ width: width + 'px', height: height + 'px' }"
      role="img"
      :aria-label="WORKING_ORB_LABEL"
    />
  </span>
</template>

<style scoped>
.working-orb {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  flex: none;
  min-height: 14px;
}
.working-orb__canvas {
  display: block;
  pointer-events: none;
}
</style>
