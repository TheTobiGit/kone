<script setup lang="ts">
// The reasoning-step orb — a slow violet dot-globe while the model thinks.
// Settled thinking rows fall back to the brain glyph in ConversationThread.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  drawThinkingOrb,
  hexToHueDeg,
  THINKING_ORB_HUE,
  THINKING_ORB_LABEL,
} from "~/utils/toolOrbDraw";

const props = withDefaults(
  defineProps<{
    hue?: string;
    size?: number;
    active?: boolean;
  }>(),
  { hue: THINKING_ORB_HUE, size: 14, active: true },
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
let last = 0;
let hueDeg = hexToHueDeg(THINKING_ORB_HUE);

function resolveHue(): string {
  const raw = props.hue.trim();
  if (raw.startsWith("#")) return raw;
  const el = root.value ?? canvas.value;
  if (!el || typeof window === "undefined") return THINKING_ORB_HUE;
  const probe = document.createElement("span");
  probe.style.color = raw;
  el.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  el.removeChild(probe);
  const m = resolved.match(/[\d.]+/g);
  if (!m || m.length < 3) return THINKING_ORB_HUE;
  return `#${[m[0], m[1], m[2]]
    .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function syncHue() {
  hueDeg = hexToHueDeg(resolveHue());
}

function draw(now: number) {
  const el = canvas.value;
  if (!el || !ctx) return;
  if (!last) last = now;
  phase += Math.min(0.05, (now - last) / 1000);
  last = now;
  const time = reduced ? 0.45 : phase;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const S = props.size;
  const px = Math.round(S * dpr);
  if (el.width !== px) {
    el.width = px;
    el.height = px;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  drawThinkingOrb({
    ctx,
    size: S,
    time,
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
  last = 0;
  raf = requestAnimationFrame(loop);
}

function pause() {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

function sync() {
  shouldRun() ? play() : pause();
}

watch(() => props.active, sync);
watch(() => props.hue, syncHue);

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
  <span ref="root" class="think-step-orb">
    <canvas
      ref="canvas"
      class="think-step-orb__canvas"
      :style="{ width: size + 'px', height: size + 'px' }"
      role="img"
      :aria-label="THINKING_ORB_LABEL"
    />
  </span>
</template>

<style scoped>
.think-step-orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.think-step-orb__canvas {
  display: block;
  pointer-events: none;
}
</style>
