<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { TokenUsage } from "~/types/desktop";

const props = defineProps<{ usage: TokenUsage }>();

// Geometry. A 20×20 viewBox rendered at 15px so the ring sits level with the
// 15px provider logo and title beside it. r/stroke chosen so the arc reads as a
// crisp hairline ring, not a chunky donut.
const RADIUS = 7;
const STROKE = 2.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Draw-in. The arc mounts empty and sweeps to its value one paint later, so the
// meter *fills* into view rather than snapping — the same motion whether the
// thread is brand new or being reopened from disk with a restored snapshot.
// Under reduced-motion we skip the sweep and land on the value immediately.
const drawn = ref(false);
onMounted(() => {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    drawn.value = true;
    return;
  }
  // Two frames: the first commits the empty arc, the second flips the bound
  // value so the CSS transition has an empty→filled delta to animate.
  requestAnimationFrame(() => requestAnimationFrame(() => (drawn.value = true)));
});

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

const used = computed(() => props.usage.contextUsed ?? props.usage.total ?? 0);
const max = computed(() => props.usage.contextWindow);
const percentage = computed(() =>
  max.value && max.value > 0 ? Math.min(100, Math.max(0, (used.value / max.value) * 100)) : 0,
);

// Calm terracotta while there's room, leaning to full accent as it fills, then
// the delete-red only once the window is genuinely near-capacity. Graded, not a
// binary alarm — the colour cross-fades as the arc grows.
const level = computed<"calm" | "warm" | "full">(() =>
  percentage.value >= 90 ? "full" : percentage.value >= 70 ? "warm" : "calm",
);

const dashOffset = computed(() =>
  drawn.value ? CIRCUMFERENCE - (percentage.value / 100) * CIRCUMFERENCE : CIRCUMFERENCE,
);

const usageLabel = computed(() => {
  const usedText = formatTokens(used.value);
  if (!max.value || max.value <= 0) return `${usedText} tokens used`;
  return `${Math.round(percentage.value)}% used · ${usedText} of ${formatTokens(max.value)} tokens`;
});
const tooltip = computed(() =>
  props.usage.compactsAutomatically
    ? `${usageLabel.value}. Automatically compacts when needed.`
    : usageLabel.value,
);
</script>

<template>
  <span
    class="context-meter"
    :class="`is-${level}`"
    role="img"
    :aria-label="`Context window: ${usageLabel}`"
    :title="tooltip"
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="context-meter__track" cx="10" cy="10" :r="RADIUS" :stroke-width="STROKE" />
      <circle
        v-if="percentage > 0"
        class="context-meter__fill"
        cx="10"
        cy="10"
        :r="RADIUS"
        :stroke-width="STROKE"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
  </span>
</template>

<style scoped>
.context-meter {
  display: inline-flex;
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  /* Whole-meter arrival: scale + fade in once, each time it mounts (new thread,
     or a reopened one). Pairs with the arc sweep for a single settle-in. */
  animation: context-meter-in 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.context-meter svg {
  width: 100%;
  height: 100%;
  /* Start the arc at 12 o'clock and sweep clockwise. */
  transform: rotate(-90deg);
}

.context-meter circle {
  fill: none;
}

.context-meter__track {
  stroke: color-mix(in srgb, var(--muted) 22%, transparent);
}

.context-meter__fill {
  stroke: var(--meter-color);
  stroke-linecap: round;
  transition:
    stroke-dashoffset 640ms cubic-bezier(0.22, 1, 0.36, 1),
    stroke 380ms ease;
}

/* Colour ramp. Calm sits between muted and accent so a fresh thread reads as a
   soft, low-key ring; warm resolves to full accent; full crosses to red. */
.context-meter.is-calm {
  --meter-color: color-mix(in srgb, var(--accent) 52%, var(--muted));
}
.context-meter.is-warm {
  --meter-color: var(--accent);
}
.context-meter.is-full {
  --meter-color: var(--diff-del);
}

@keyframes context-meter-in {
  from {
    opacity: 0;
    transform: scale(0.55);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .context-meter {
    animation: none;
  }
  .context-meter__fill {
    transition: none;
  }
}
</style>
