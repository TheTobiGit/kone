<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

// A thin elbow line connecting the user request to the agent's response:
// it leaves the bubble's left edge at its vertical midpoint, runs horizontally
// over to the avatar column, then drops straight down to stop just above the
// speaker row, with a soft bend where the two legs meet.
const STANDOFF = 8;
const CORNER_RADIUS = 12;

const props = defineProps<{
  running?: boolean;
}>();

const svgEl = ref<SVGSVGElement | null>(null);
const d = ref("");
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

  // SAFETY: these class names belong to plain <div>s rendered by ConversationThread around
  // this connector; querySelector returns null when they're absent, which is handled below.
  const bubble = exchange.querySelector(".body--you, .edit-box") as HTMLElement | null;
  // SAFETY: .speaker is a plain <div> rendered by ConversationThread; a null result is handled below.
  const speaker = exchange.querySelector(".speaker") as HTMLElement | null;

  if (!bubble || !speaker) {
    visible.value = false;
    return;
  }

  const exRect = exchange.getBoundingClientRect();
  const bRect = bubble.getBoundingClientRect();
  const sRect = speaker.getBoundingClientRect();

  if (exRect.width === 0 || exRect.height === 0) return;

  // Leave the bubble's left edge at its vertical midpoint
  const x1 = Math.round(bRect.left - exRect.left);
  const y1 = Math.round(bRect.top - exRect.top + bRect.height / 2);

  // The drop column sits over the avatar centre (26px face, so x=13 within speaker)
  const x2 = Math.round(sRect.left - exRect.left + 13);
  // Stop short of the speaker row rather than touching it
  const y2 = Math.round(sRect.top - exRect.top - STANDOFF);

  if (y2 > y1 && x2 < x1 - 2) {
    // Ease the corner with a quadratic bend, sized to whatever both legs can spare
    const r = Math.min(CORNER_RADIUS, (x1 - x2) / 2, y2 - y1);
    d.value = `M ${x1} ${y1} L ${x2 + r} ${y1} Q ${x2} ${y1}, ${x2} ${y1 + r} L ${x2} ${y2}`;
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
  stroke: var(--rail, color-mix(in srgb, var(--ink) 9%, transparent));
  stroke-width: 1px;
  fill: none;
  /* A whisper of shadow under the hairline so it reads as sitting on the
     surface rather than painted onto it — depth without weight. */
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.35));
  transition: stroke 0.2s ease;
}
.exchange-connector.is-running .connector-path {
  stroke: color-mix(in oklab, var(--accent) 45%, var(--rail, color-mix(in srgb, var(--ink) 9%, transparent)));
}
:global(.exchange:hover) .connector-path {
  stroke: color-mix(in srgb, var(--ink) 25%, transparent);
}
</style>
