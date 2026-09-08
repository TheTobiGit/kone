<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import PickerShell from "~/components/ui/PickerShell.vue";
import { useContextMeter } from "~/composables/useContextMeter";
import type { TokenUsage } from "~/types/desktop";
import type { MeterCompactProps } from "~/utils/compactAvailability";

const props = defineProps<
  {
    usage: TokenUsage;
  } & MeterCompactProps
>();

// The ring is a thin view: every number it reads comes from the composable,
// so this file owns only geometry, mount motion and the popover itself.
const {
  showRing,
  percentage,
  level,
  usageLabel,
  tooltip,
  rows,
  note,
  compactReady,
  compactBusy,
  pressCompact,
} = useContextMeter({
  usage: () => props.usage,
  compact: () => props,
});

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
    "window" in globalThis &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    drawn.value = true;
    return;
  }
  // Two frames: the first commits the empty arc, the second flips the bound
  // value so the CSS transition has an empty→filled delta to animate.
  requestAnimationFrame(() => requestAnimationFrame(() => (drawn.value = true)));
});

const dashOffset = computed(() =>
  drawn.value ? CIRCUMFERENCE - (percentage.value / 100) * CIRCUMFERENCE : CIRCUMFERENCE,
);

// ── the popover ─────────────────────────────────────────────────────────────
// Click toggles, outside-click or Escape cancels, split into a data card (the
// numbers) and an actions card (Compact). Hover never opens it — a hover card
// can't host a working control.
const open = ref(false);
const shown = ref(false);
const wrapEl = ref<HTMLElement | null>(null);

function close(): void {
  if (!open.value) return;
  open.value = false;
  shown.value = false;
}

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  shown.value = false;
  void nextTick(() => {
    requestAnimationFrame(() => {
      shown.value = true;
    });
  });
}

function onRingKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggle();
    return;
  }
  if (e.key === "Escape") close();
}

onClickOutside(wrapEl, () => close());
</script>

<template>
  <!-- Click toggles the popover; outside-click or Escape cancels. The wrapper
       owns the outside detector so ring clicks don't dismiss it mid-toggle. -->
  <span ref="wrapEl" class="meter-wrap">
    <button
      v-if="showRing"
      type="button"
      class="context-meter"
      :class="`is-${level}`"
      :aria-label="`Context window: ${usageLabel}`"
      :aria-expanded="open"
      :title="tooltip"
      @click.stop="toggle"
      @keydown="onRingKeydown"
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
    </button>

    <PickerShell
      v-if="open"
      class="meter-card"
      title="Context window"
      :shown="shown"
      @close="close"
    >
      <!-- Section 1: the numbers -->
      <section class="picker-card meter-data" aria-label="Usage">
        <div v-for="row in rows" :key="row.label" class="meter-data__row">
          <span class="meter-data__label">{{ row.label }}</span>
          <span class="meter-data__value">{{ row.value }}</span>
        </div>
        <p v-if="note" class="meter-data__note">{{ note }}</p>
      </section>

      <!-- Section 2: the action -->
      <section v-if="onCompact" class="picker-card meter-actions" aria-label="Actions">
        <button
          type="button"
          class="action-row"
          :disabled="!compactReady"
          :title="!compactReady && !compactBusy ? (compactReason ?? undefined) : undefined"
          @click="pressCompact"
        >
          <span class="action-row__icon">
            <HugeiconsIcon :icon="ArrowShrink01Icon" :size="16" :stroke-width="1.7" aria-hidden="true" />
          </span>
          <span class="action-row__label">{{
            compactBusy ? "Compacting…" : "Compact context"
          }}</span>
          <HugeiconsIcon
            v-if="compactReady"
            :icon="ArrowRight01Icon"
            :size="13"
            :stroke-width="2"
            class="action-row__arrow text-muted"
            aria-hidden="true"
          />
        </button>
        <p v-if="compactError" class="action-error" role="alert">{{ compactError }}</p>
      </section>
    </PickerShell>
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
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
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

/* The expanded readout — the shared picker shell, right-aligned so it can
   never clip against the column's left edge. Shell/header/card/row styles
   live in PickerShell; only the popover's position and the meter's own data
   rows stay here. */
.meter-card {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  width: 260px;
}

/* Section 1: the numbers — the old readout rows, kept verbatim in voice. */
.meter-data {
  padding: 9px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
}
.meter-data__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
.meter-data__label {
  color: var(--muted);
}
.meter-data__value {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.meter-data__note {
  margin: 6px 0 0;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--muted);
  line-height: 1.5;
}

/* Section 2: the action card's inset. The row itself is the shared shell's. */
.meter-actions {
  padding: 4px;
}
.action-error {
  margin: 0;
  padding: 2px 10px 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--diff-del);
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
