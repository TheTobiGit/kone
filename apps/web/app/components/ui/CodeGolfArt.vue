<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";

const containerRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
let time = 0;
let animationFrameId = 0;

/** CSS-pixel size of the slot the art fills — drives canvas backing store + scale. */
const layoutW = ref(0);
const layoutH = ref(0);
const accentColorStr = ref("rgba(130, 130, 130, 0.4)");

// The tweet-scale art was tuned for a full thread column; scale everything from
// the smaller of width/height so narrow strip presets stay composed, not cropped.
const REF_SIZE = 520;

// Typical peak extents from the loop below — used to keep margin on each axis
// without clipping or masking. One uniform spread keeps the shape proportional.
const Q_PEAK = 122;
const Y_PEAK = 285;
const EDGE_MARGIN = 0.08;
const SPREAD_SAFETY = 1;
const PAN_SAFETY = 0.9;
const SIZE_BOOST = 1.12;

const mag = (x: number, y: number) => Math.sqrt(x * x + y * y);

/** Static centroid at t=0 so the blob sits on the canvas center. */
function measureCentroid(): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  const n = 10000;
  for (let i = n; i--; ) {
    const y_val = i / 790;
    const k_part =
      y_val < 8 ? 9 + Math.sin(Math.pow(y_val, 9)) * 6 : 4 + Math.cos(y_val);
    const k = k_part * Math.cos(i);

    const e = y_val / 3 - 13;
    const d = mag(k, e) + Math.cos(e + (i % 2) * 4);

    const q = (y_val * k) / 5 * (2 + Math.sin(d * 2 + y_val)) + 80;
    const c = d / 4 + (i % 2) * 3;

    sumX += q * Math.cos(c);
    sumY += q * Math.sin(c) + d * 9 - 180;
  }
  return { x: sumX / n, y: sumY / n };
}

const CENTROID = measureCentroid();

const updateColor = () => {
  if (typeof window !== "undefined") {
    const root = document.documentElement;
    const accent = getComputedStyle(root).getPropertyValue("--accent").trim();
    if (accent) accentColorStr.value = accent;
  }
};

function fitScale(): number {
  const w = layoutW.value;
  const h = layoutH.value;
  if (w <= 0 || h <= 0) return 1;
  return Math.min(1.55, Math.max(0.38, Math.min(w, h) / REF_SIZE));
}

function syncCanvasSize(): void {
  const canvas = canvasRef.value;
  const container = containerRef.value;
  if (!canvas || !container) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  layoutW.value = rect.width;
  layoutH.value = rect.height;

  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const render = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = layoutW.value || canvas.clientWidth;
  const h = layoutH.value || canvas.clientHeight;
  const fit = fitScale();

  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";

  const baseScale = 2.3 * fit;
  const dot = Math.max(0.75, 1.5 * fit);
  const maxExtent = baseScale * SIZE_BOOST;

  const maxX = w / 2 - w * EDGE_MARGIN - dot;
  const maxY = h / 2 - h * EDGE_MARGIN - dot;
  const xSpread = (maxX / (Q_PEAK * maxExtent)) * SPREAD_SAFETY;
  const ySpread = (maxY / (Y_PEAK * maxExtent)) * SPREAD_SAFETY;
  const spread = Math.min(1, xSpread, ySpread);
  const size = baseScale * spread * SIZE_BOOST;

  const maxPanX = Math.max(0, maxX - Q_PEAK * size * PAN_SAFETY);
  const maxPanY = Math.max(0, maxY - Y_PEAK * size * PAN_SAFETY);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.translate(
    Math.sin(time * 0.15) * Math.min(60 * fit, maxPanX),
    Math.cos(time * 0.1) * Math.min(40 * fit, maxPanY),
  );
  ctx.rotate(time * 0.05);

  ctx.fillStyle = accentColorStr.value;
  ctx.globalAlpha = 0.15;

  const iterations = 10000;

  ctx.save();
  for (let i = iterations; i--; ) {
    const y_val = i / 790;
    const k_part =
      y_val < 8 ? 9 + Math.sin(Math.pow(y_val, 9)) * 6 : 4 + Math.cos(y_val);
    const k = k_part * Math.cos(i + time / 4);

    const e = y_val / 3 - 13;
    const d = mag(k, e) + Math.cos(e + time * 2 + (i % 2) * 4);

    const q = (y_val * k) / 5 * (2 + Math.sin(d * 2 + y_val - time * 4)) + 80;
    const c = d / 4 - time / 2 + (i % 2) * 3;

    const x = (q * Math.cos(c) - CENTROID.x) * size;
    const y = (q * Math.sin(c) + d * 9 - 180 - CENTROID.y) * size;

    ctx.fillRect(x, y, dot, dot);
  }
  ctx.restore();

  ctx.restore();
  ctx.globalCompositeOperation = "source-over";

  time += 0.02;
  animationFrameId = requestAnimationFrame(render);
};

useResizeObserver(containerRef, syncCanvasSize);

let colorObserver: MutationObserver | null = null;

onMounted(() => {
  syncCanvasSize();
  updateColor();
  render();

  colorObserver = new MutationObserver(updateColor);
  colorObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrameId);
  colorObserver?.disconnect();
});
</script>

<template>
  <div ref="containerRef" class="art">
    <canvas ref="canvasRef" class="art__canvas" />
  </div>
</template>

<style scoped>
.art {
  pointer-events: none;
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.art__canvas {
  position: absolute;
  inset: 0;
  display: block;
  background-color: transparent;
}
</style>
