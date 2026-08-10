<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

// A usable numerator: a concrete reported fill — an explicit 0 counts, since
// "nothing consumed yet" is a real answer. Absent both contextUsed and total we
// don't know how much sits in the window, and a fallback of 0 would read as
// "nothing consumed", which is false.
const usedKnown = computed(() => {
  const n = props.usage.contextUsed ?? props.usage.total;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
});
const max = computed(() => props.usage.contextWindow);
const hasWindow = computed(() => typeof max.value === "number" && max.value > 0);
// A ring is a fraction — "x of a window" — so it needs BOTH halves. A window
// with no reported fill (Cursor derives the window from the selected model but
// its ACP transport never reports usage) would otherwise sit forever on an
// empty 0% arc that claims "nothing consumed" when we simply don't know.
const showRing = computed(() => hasWindow.value && usedKnown.value !== undefined);
const used = computed(() => usedKnown.value ?? 0);
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

// ── the expanded readout ──────────────────────────────────────────────────────
// The ring is a fraction; the popover is the whole story — used %, remaining,
// the input/output/total split the events already carry but the ring never
// showed, and the window. Every row renders only when its number is real:
// Cursor derives the window but its ACP transport reports no usage at all, so
// half-empty data must not read as "nothing consumed".
const open = ref(false);
const popoverId = useId();
function openPopover(): void {
  open.value = true;
}
function closePopover(): void {
  open.value = false;
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") closePopover();
}
onMounted(() => {
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
});

const rows = computed(() => {
  const u = props.usage;
  const out: { label: string; value: string }[] = [];
  const m = max.value;
  if (usedKnown.value !== undefined && m !== undefined && m > 0) {
    out.push({ label: "Used", value: `${Math.round(percentage.value)}% · ${formatTokens(used.value)}` });
    const remaining = m - used.value;
    if (remaining > 0) out.push({ label: "Remaining", value: formatTokens(remaining) });
  }
  if (typeof u.input === "number" && Number.isFinite(u.input)) {
    out.push({ label: "Input", value: formatTokens(u.input) });
  }
  if (typeof u.output === "number" && Number.isFinite(u.output)) {
    out.push({ label: "Output", value: formatTokens(u.output) });
  }
  if (typeof u.total === "number" && Number.isFinite(u.total)) {
    out.push({ label: "Total", value: formatTokens(u.total) });
  }
  if (m !== undefined && m > 0) out.push({ label: "Window", value: formatTokens(m) });
  return out;
});
const note = computed(() =>
  props.usage.compactsAutomatically ? "Auto-compacts when full." : "",
);
</script>

<template>
  <!-- Hover or focus opens the popover (touch: tapping the ring focuses it);
       Esc closes. The wrapper owns hover so moving from the ring onto the
       popover doesn't close it mid-read. -->
  <span class="meter-wrap" @mouseenter="openPopover" @mouseleave="closePopover">
    <span
      v-if="showRing"
      class="context-meter"
      :class="`is-${level}`"
      role="img"
      tabindex="0"
      :aria-label="`Context window: ${usageLabel}`"
      :aria-describedby="popoverId"
      :title="tooltip"
      @focus="openPopover"
      @blur="closePopover"
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

    <Transition name="meter-pop">
      <div v-if="open" :id="popoverId" class="meter-pop" role="tooltip">
        <div v-for="row in rows" :key="row.label" class="meter-pop__row">
          <span class="meter-pop__label">{{ row.label }}</span>
          <span class="meter-pop__value">{{ row.value }}</span>
        </div>
        <p v-if="note" class="meter-pop__note">{{ note }}</p>
      </div>
    </Transition>
  </span>
</template>

<style scoped>
.meter-wrap {
  position: relative;
  display: inline-flex;
}
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
  /* The meter is now keyboard-reachable — give it the same visible ring the
     strip's other focusable tools wear. */
  border-radius: 50%;
}
.context-meter:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 2px;
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

/* The expanded readout — a quiet card under the ring, right-aligned so it can
   never clip against the column's left edge. Hairline ring + one soft shadow,
   the same family as the pickers. */
.meter-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  min-width: 196px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--surface, var(--ground));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 6px 24px rgba(0, 0, 0, 0.12);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
  pointer-events: none;
}
.meter-pop__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
.meter-pop__label {
  color: var(--muted);
}
.meter-pop__value {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.meter-pop__note {
  margin: 6px 0 0;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--muted);
  line-height: 1.5;
}
.meter-pop-enter-active,
.meter-pop-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.meter-pop-enter-from,
.meter-pop-leave-to {
  opacity: 0;
  transform: translateY(-3px);
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
