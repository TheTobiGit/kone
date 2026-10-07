<script lang="ts">
import { quotaTone, type QuotaTone } from "~/composables/useAgentSettings";
import type { QuotaProviderReport, QuotaWindow } from "~/types/desktop";

// What a provider card says about limits, in the two sizes it comes in. Kept
// outside the setup block so the card's host can build the readout once and
// speak it in its own aria-label without rendering anything.

export type DeckMeter = { id: string; label: string; percent: number; tone: QuotaTone };

/** The open card has room for a few windows; the folded spine has room for
 *  one, so it wears the report's primary window — the one the provider itself
 *  names as most representative. */
export type DeckReadout = { open: DeckMeter[]; spine: DeckMeter | null };

const EMPTY: DeckReadout = { open: [], spine: null };

/** Only a window with a measured fraction gets a meter — a null percent or a
 *  window that hasn't started has no fill to draw, and an empty bar would claim
 *  a reading of zero. */
function deckMeter(w: QuotaWindow | null): DeckMeter | null {
  if (!w || w.percent === null || w.state === "notStarted") return null;
  const percent = Math.min(1, Math.max(0, w.percent));
  return { id: w.id, label: w.label, percent, tone: quotaTone(percent) };
}

/** A report that isn't a live read draws nothing: the Limits block below the
 *  deck is where an error or a missing sign-in gets explained. */
export function deckReadout(report: QuotaProviderReport | null | undefined): DeckReadout {
  if (!report || report.connection !== "connected") return EMPTY;
  const open = report.windows.map(deckMeter).filter((m): m is DeckMeter => m !== null).slice(0, 3);
  return { open, spine: deckMeter(report.primary) ?? open[0] ?? null };
}

export const pctOf = (m: DeckMeter) => Math.round(m.percent * 100);
export const pctLabel = (m: DeckMeter) => `${pctOf(m)}%`;
</script>

<script setup lang="ts">
// Drawn inside a provider card, positioned against it: a vertical gauge down the
// folded spine, and a short stack of window meters across the open card. Both
// are always mounted and cross-fade on `open`, in step with the card's own fold.
// The full figures, resets and spend live in the Limits block below the deck.

defineProps<{ readout: DeckReadout; open: boolean }>();
</script>

<template>
  <!-- Folded: one gauge filling from the foot — the primary window. -->
  <div
    v-if="readout.spine"
    class="pdl pdl__gauge"
    :class="[`pdl--${readout.spine.tone}`, { 'pdl__gauge--show': !open }]"
    :style="{ '--p': readout.spine.percent }"
    aria-hidden="true"
  >
    <span class="pdl__gaugetrack"><i class="pdl__gaugefill" /></span>
    <span class="pdl__gaugepct">{{ pctOf(readout.spine) }}</span>
  </div>

  <!-- Open: up to three windows, each a label, its percentage and a slim bar. -->
  <ul
    v-if="readout.open.length"
    class="pdl pdl__meters"
    :class="{ 'pdl__meters--show': open }"
    aria-hidden="true"
  >
    <li
      v-for="m in readout.open"
      :key="m.id"
      class="pdl__meter"
      :class="`pdl--${m.tone}`"
      :style="{ '--p': m.percent }"
    >
      <span class="pdl__meterhead">
        <span class="pdl__meterlabel">{{ m.label }}</span>
        <span class="pdl__meterpct">{{ pctLabel(m) }}</span>
      </span>
      <span class="pdl__metertrack"><i class="pdl__meterfill" /></span>
    </li>
  </ul>
</template>

<style scoped>
/* The fade and fill run on the card's own fold timing, so the readout moves as
   part of the card rather than beside it. */
.pdl {
  --pdl-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --pdl-t-small: 220ms;
  --pdl-t-fold: 460ms;
  position: absolute;
  pointer-events: none;
}

/* White on the card's own wash, like everything else the card wears. Tone only
   changes the fill: amber once a window is tight, red once it is nearly
   exhausted — quotaTone decides where those lines fall. */
.pdl__gauge,
.pdl__meter {
  --fill: rgba(255, 255, 255, 0.94);
}
.pdl--tight {
  --fill: var(--warn);
}
.pdl--low {
  --fill: var(--danger);
}

/* Folded: a hairline column between the signal pip and the spine mark. It
   fades with the spine mark as the card opens and the full readout takes over. */
.pdl__gauge {
  top: 32px;
  bottom: 48px;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transform: translateX(-50%);
  opacity: 0;
  transition: opacity var(--pdl-t-small) ease;
}
.pdl__gauge--show {
  opacity: 1;
}
.pdl__gaugetrack {
  position: relative;
  flex: 1 1 auto;
  width: 3px;
  border-radius: 999px;
  overflow: hidden;
  background-color: rgba(255, 255, 255, 0.2);
}
.pdl__gaugefill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-color: var(--fill);
  transform-origin: 50% 100%;
  transform: scaleY(var(--p));
  transition:
    transform var(--pdl-t-fold) var(--pdl-ease),
    background-color 140ms ease;
}
.pdl__gaugepct {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: rgba(255, 255, 255, 0.82);
}

/* Open: a short stack in the card's top-left, clear of the ghosted mark that
   bleeds off the right edge. Enters on the card foot's delay, so the card's
   contents arrive as one. */
.pdl__meters {
  top: 20px;
  left: 20px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  width: min(210px, calc(100% - 40px));
  margin: 0;
  padding: 0;
  list-style: none;
  opacity: 0;
  transform: translateY(-4px);
  transition:
    opacity var(--pdl-t-small) var(--pdl-ease),
    transform var(--pdl-t-small) var(--pdl-ease);
}
.pdl__meters--show {
  opacity: 1;
  transform: none;
  transition-delay: 120ms;
}
.pdl__meter {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.pdl__meterhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.pdl__meterlabel {
  font-size: 11px;
  line-height: 1.1;
  color: rgba(255, 255, 255, 0.78);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pdl__meterpct {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: #fff;
}
.pdl__metertrack {
  position: relative;
  height: 3px;
  border-radius: 999px;
  overflow: hidden;
  background-color: rgba(255, 255, 255, 0.2);
}
.pdl__meterfill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-color: var(--fill);
  transform-origin: 0 50%;
  transform: scaleX(var(--p));
  transition:
    transform var(--pdl-t-fold) var(--pdl-ease),
    background-color 140ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .pdl,
  .pdl__gaugefill,
  .pdl__meterfill {
    transition: none;
  }
}
</style>
