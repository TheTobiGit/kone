<script setup lang="ts">
// language at icon scale. While status is in-progress the canvas animates; once
// settled, ConversationThread swaps back to the static Phosphor glyph.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  drawToolOrb,
  hexToHueDeg,
  TOOL_ORB_LABELS,
  type ToolOrbFamily,
} from "~/utils/toolOrbDraw";

const props = withDefaults(
  defineProps<{
    family: ToolOrbFamily;
    /** CSS colour or hex — family hue from the tool table. */
    hue?: string;
    size?: number;
    active?: boolean;
  }>(),
  { hue: "#71717a", size: 14, active: true },
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
let hueDeg = hexToHueDeg("#71717a");

function resolveHue(): string {
  const raw = props.hue.trim();
  if (raw.startsWith("#")) return raw;
  const el = root.value ?? canvas.value;
  if (!el || typeof window === "undefined") return "#71717a";
  const probe = document.createElement("span");
  probe.style.color = raw;
  el.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  el.removeChild(probe);
  const m = resolved.match(/[\d.]+/g);
  if (!m || m.length < 3) return "#71717a";
  const hex = `#${[m[0], m[1], m[2]]
    .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
    .join("")}`;
  return hex;
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
  const time = reduced ? 0.55 : phase;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const S = props.size;
  const px = Math.round(S * dpr);
  if (el.width !== px) {
    el.width = px;
    el.height = px;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  drawToolOrb(props.family, {
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
watch(() => props.family, () => draw(performance.now()));
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
  <span ref="root" class="tool-step-orb">
    <canvas
      ref="canvas"
      class="tool-step-orb__canvas"
      :style="{ width: size + 'px', height: size + 'px' }"
      role="img"
      :aria-label="TOOL_ORB_LABELS[family]"
    />
  </span>
</template>

<style scoped>
.tool-step-orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.tool-step-orb__canvas {
  display: block;
  pointer-events: none;
}
</style>
