<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

// An organic spline branch connecting the bottom-left of the user request
// bubble down into the agent avatar (x=13px) at the start of the response.
const props = defineProps<{
  running?: boolean;
}>();

const svgEl = ref<SVGSVGElement | null>(null);
const d = ref("");
const nodeX = ref(0);
const nodeY = ref(0);
const visible = ref(false);

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let rafId: number | null = null;

function measure(): void {
  if (!import.meta.client) return;
  const svg = svgEl.value;
  if (!svg) return;
  const exchange = svg.parentElement;
  if (!exchange) return;

  const bubble = exchange.querySelector(".body--you, .edit-box") as HTMLElement | null;
  const speaker = exchange.querySelector(".speaker") as HTMLElement | null;

  if (!bubble || !speaker) {
    visible.value = false;
    return;
  }

  const exRect = exchange.getBoundingClientRect();
  const bRect = bubble.getBoundingClientRect();
  const sRect = speaker.getBoundingClientRect();

  if (exRect.width === 0 || exRect.height === 0) return;

  // Start at the bottom-left of the user request bubble (offset slightly inside the radius)
  const x1 = Math.round(bRect.left - exRect.left + 14);
  const y1 = Math.round(bRect.bottom - exRect.top);

  // End at the top center of the agent face avatar (x=13px within speaker)
  const x2 = Math.round(sRect.left - exRect.left + 13);
  const y2 = Math.round(sRect.top - exRect.top);

  if (y2 > y1) {
    const dy = y2 - y1;
    // Cubic spline: leaves bubble downward, sweeps left, and lands vertically into avatar
    const cp1x = x1;
    const cp1y = y1 + Math.max(10, Math.min(dy * 0.55, 36));
    const cp2x = x2;
    const cp2y = y2 - Math.max(10, Math.min(dy * 0.55, 36));

    d.value = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
    nodeX.value = x1;
    nodeY.value = y1;
    visible.value = true;
  } else {
    visible.value = false;
  }
}

function scheduleMeasure(): void {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    measure();
    rafId = null;
  });
}

onMounted(() => {
  const svg = svgEl.value;
  const exchange = svg?.parentElement;
  if (exchange && "ResizeObserver" in window) {
    ro = new ResizeObserver(scheduleMeasure);
    ro.observe(exchange);
  }
  if (exchange && "MutationObserver" in window) {
    mo = new MutationObserver(scheduleMeasure);
    mo.observe(exchange, { childList: true, subtree: true, attributes: true });
  }
  scheduleMeasure();
  window.setTimeout(scheduleMeasure, 60);
  window.setTimeout(scheduleMeasure, 200);
  window.setTimeout(scheduleMeasure, 500);
});

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  ro?.disconnect();
  mo?.disconnect();
});
</script>

<template>
  <svg
    ref="svgEl"
    class="exchange-connector"
    :class="{ 'is-running': running, 'is-visible': visible }"
    aria-hidden="true"
  >
    <path v-if="visible && d" :d="d" class="connector-path" />
    <circle v-if="visible && d" :cx="nodeX" :cy="nodeY" r="2.5" class="connector-node" />
  </svg>
</template>

<style scoped>
.exchange-connector {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
  z-index: 0;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.exchange-connector.is-visible {
  opacity: 1;
}
.connector-path {
  stroke: var(--rail, color-mix(in srgb, var(--ink) 12%, transparent));
  stroke-width: 1.5px;
  stroke-linecap: round;
  fill: none;
  transition: stroke 0.2s ease, stroke-width 0.2s ease;
}
.exchange-connector.is-running .connector-path {
  stroke: color-mix(in oklab, var(--accent) 45%, var(--rail, color-mix(in srgb, var(--ink) 12%, transparent)));
  stroke-width: 1.75px;
}
:global(.exchange:hover) .connector-path {
  stroke: color-mix(in srgb, var(--ink) 25%, transparent);
}
.connector-node {
  fill: color-mix(in srgb, var(--ink) 28%, transparent);
  transition: fill 0.2s ease;
}
.exchange-connector.is-running .connector-node {
  fill: color-mix(in oklab, var(--accent) 75%, var(--ink));
}
:global(.exchange:hover) .connector-node {
  fill: var(--ink-soft);
}
</style>
