<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { UsageRange } from "~/types/desktop";
import type { SpaceUsage } from "~/composables/useSpaceUsage";
import { formatCount, formatPercent, formatTokens } from "~/utils/usageFormat";
import { RING_ORIGIN, rankModels, ringSlices } from "~/utils/spaceModels";
import { LONGER_USAGE_RANGES, USAGE_RANGES } from "~/utils/usageRanges";

// The project's most used models. "Used" is counted in responses: each time a
// model answered (one API call, one step of an agent loop) — see rankModels.
//
// A half-ring splits the window between the top models (the rest fold into one
// grey slice), with the total in its middle; a ranked list below names each
// one and the agent that ran it. A model takes its agent's colour, so it reads
// against the spend card; a second or third model from the same agent is a
// lighter tint of it. The ring, the list and the hover focus all read one list
// of entries.

const props = defineProps<{
  usage: SpaceUsage;
}>();

const providerColors = useProviderColors();
// Pulled out of `usage` because a template unwraps a ref only at the top level:
// `usage.settled` would read as the ref itself, and always be truthy.
const { settled, usageFor } = props.usage;

const range = ref<UsageRange>("30d");
const rangeLabel = computed(() => USAGE_RANGES.find((r) => r.id === range.value)?.long ?? "");

const ranked = computed(() => rankModels(usageFor(range.value)?.models ?? [], providerColors.value));
const entries = computed(() => ranked.value.entries);
const slices = computed(() => ringSlices(entries.value));

/** The entry under the pointer, in the ring or the list — they light together. */
const hovered = ref<string | null>(null);
// A flip of the window can take the hovered model out from under the pointer
// without a leave ever firing, so the hover is dropped with it.
watch(range, () => (hovered.value = null));
/** The hovered entry, only while it is still on the card — a re-read can
 *  reshuffle the ranking under a resting pointer. */
const focus = computed(() => entries.value.find((e) => e.key === hovered.value) ?? null);
const focusLabel = computed(() =>
  focus.value?.kind === "other" ? `${focus.value.models} other models` : (focus.value?.name ?? ""),
);
const dimmed = (key: string) => focus.value !== null && focus.value.key !== key;

function responses(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "response" : "responses"}`;
}
</script>

<template>
  <SpaceCard title="Models" label="Most used models" :count="ranked.count">
    <template #aside>
      <div class="models__seg" role="group" aria-label="Window">
        <button
          v-for="r in LONGER_USAGE_RANGES"
          :key="r.id"
          type="button"
          class="models__seg-btn"
          :class="{ 'is-on': range === r.id }"
          :aria-pressed="range === r.id"
          @click="range = r.id"
        >
          {{ r.short }}
        </button>
      </div>
    </template>

    <template v-if="entries.length">
      <div class="models__gauge">
        <svg viewBox="0 0 240 124" class="models__ring" aria-hidden="true" @pointerleave="hovered = null">
          <path
            v-for="(s, i) in slices"
            :key="s.key"
            :d="s.d"
            class="models__slice"
            :class="{
              'is-dim': dimmed(s.key),
              'is-focus': focus?.key === s.key,
            }"
            :style="{
              fill: s.color,
              stroke: s.color,
              transformOrigin: RING_ORIGIN,
              animationDelay: `${i * 45}ms`,
            }"
            @pointerenter="hovered = s.key"
          />
        </svg>
        <div class="models__center">
          <template v-if="focus">
            <span class="models__total">{{ formatCount(focus.responses) }}</span>
            <span class="models__sub" :title="focusLabel">
              <span class="models__sub-name">{{ focusLabel }}</span> ·
              {{ formatPercent(focus.share) }}
            </span>
          </template>
          <template v-else>
            <span class="models__total">{{ formatCount(ranked.total) }}</span>
            <span class="models__sub">responses · {{ rangeLabel.toLowerCase() }}</span>
          </template>
        </div>
      </div>

      <ol class="models__list">
        <li
          v-for="(m, i) in entries"
          :key="m.key"
          class="models__row"
          :class="{ 'is-dim': dimmed(m.key) }"
          @pointerenter="hovered = m.key"
          @pointerleave="hovered = null"
        >
          <span v-if="m.kind === 'model'" class="models__badge">
            <ProviderLogo :brand="m.brand" :size="16" />
            <span v-if="i < 3" class="models__rank" :class="`models__rank--${i + 1}`">{{ i + 1 }}</span>
          </span>
          <span v-else class="models__badge models__badge--more" aria-hidden="true">+{{ m.models }}</span>
          <span class="models__id">
            <span class="models__name-line">
              <span class="models__name" :title="m.name">{{ m.name }}</span>
              <span v-if="m.kind === 'model' && m.free" class="models__free">free</span>
            </span>
            <span v-if="m.kind === 'model'" class="models__agent">
              {{ m.agent
              }}<template v-if="m.outputTokens > 0"> · {{ formatTokens(m.outputTokens) }} out</template>
            </span>
            <span v-else class="models__agent">{{ m.models }} {{ m.models === 1 ? "model" : "models" }}</span>
          </span>
          <span class="models__nums">
            <span class="models__val" :title="responses(m.responses)">{{ formatCount(m.responses) }}</span>
            <span class="models__pct">{{ formatPercent(m.share) }}</span>
          </span>
          <span class="models__track" aria-hidden="true">
            <span
              class="models__fill"
              :class="{ 'models__fill--other': m.kind === 'other' }"
              :style="{
                width: `${Math.max(m.share * 100, m.share > 0 ? 2 : 0)}%`,
                backgroundColor: m.kind === 'model' ? m.color : undefined,
              }"
            />
          </span>
        </li>
      </ol>
    </template>

    <div v-else-if="!settled" class="models__skel-wrap" aria-hidden="true">
      <span class="models__skel models__skel--ring" />
      <span v-for="n in 3" :key="n" class="models__skel models__skel--row" />
    </div>

    <p v-else class="models__empty">No agent work in this window.</p>
  </SpaceCard>
</template>

<style scoped>
.models__seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
}
.models__seg-btn {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.models__seg-btn:hover:not(.is-on) {
  color: var(--ink);
}
.models__seg-btn.is-on {
  background-color: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--ink);
}
.models__seg-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}

/* ── half-ring ───────────────────────────────────────────────────────────── */
.models__gauge {
  position: relative;
  width: 100%;
  max-width: 280px;
  margin: 4px auto 0;
}
.models__ring {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
/* A stroke in the slice's own colour, joined round, softens its corners. */
.models__slice {
  cursor: default;
  stroke-width: 2.5;
  stroke-linejoin: round;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
  animation: models-slice-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.models__slice.is-focus {
  transform: scale(1.035);
}
@keyframes models-slice-in {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
}
.models__slice.is-dim {
  opacity: 0.35;
}
.models__center {
  position: absolute;
  left: 50%;
  bottom: 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 56%;
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
}
.models__total {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.5px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.models__sub {
  display: flex;
  max-width: 100%;
  gap: 3px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
.models__sub-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── ranked list ─────────────────────────────────────────────────────────── */
.models__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.models__row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    "badge id nums"
    "track track track";
  align-items: center;
  column-gap: 10px;
  row-gap: 8px;
  padding: 9px 0 0;
  transition: opacity 0.18s ease;
}
.models__row.is-dim {
  opacity: 0.5;
}
.models__badge {
  grid-area: badge;
  position: relative;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.models__rank {
  position: absolute;
  top: -5px;
  left: -5px;
  display: grid;
  place-items: center;
  width: 13px;
  height: 13px;
  border-radius: 999px;
  font-size: 8.5px;
  font-weight: 700;
  line-height: 1;
  color: #1a1206;
  box-shadow: 0 0 0 2px var(--ground);
}
.models__rank--1 {
  background-color: #e8c15a;
}
.models__rank--2 {
  background-color: #c4c8cf;
}
.models__rank--3 {
  background-color: #cf8f5c;
}
.models__id {
  grid-area: id;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.models__name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.models__free {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--muted);
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.models__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
}
.models__agent {
  font-size: 11px;
  color: var(--muted);
}
.models__nums {
  grid-area: nums;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  font-variant-numeric: tabular-nums;
}
.models__val {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
}
.models__pct {
  font-size: 11px;
  color: var(--muted);
}
/* The bar grows in from the right, under the figures it belongs to. */
.models__track {
  grid-area: track;
  display: flex;
  justify-content: flex-end;
  height: 3px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
  overflow: hidden;
}
.models__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}

/* ── the long tail ───────────────────────────────────────────────────────── */
.models__badge--more {
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.models__fill--other {
  background-color: color-mix(in srgb, var(--ink) 22%, transparent);
}

.models__empty {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.models__skel-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.models__skel {
  display: block;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
  animation: models-pulse 1.4s ease-in-out infinite;
}
.models__skel--ring {
  width: 220px;
  height: 110px;
  border-radius: 110px 110px 0 0;
}
.models__skel--row {
  width: 100%;
  height: 28px;
}
@keyframes models-pulse {
  50% {
    opacity: 0.5;
  }
}
@media (prefers-reduced-motion: reduce) {
  .models__skel {
    animation: none;
  }
  .models__slice,
  .models__fill {
    transition: none;
  }
  .models__slice {
    animation: none;
  }
  .models__slice.is-focus {
    transform: none;
  }
}
</style>
