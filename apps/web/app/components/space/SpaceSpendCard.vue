<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { SpaceUsage } from "~/composables/useSpaceUsage";
import { formatCount, formatDayShort, formatTokens, formatUsd } from "~/utils/usageFormat";
import { knownProviderRows } from "~/utils/usageProviders";
import { LONGER_USAGE_RANGES } from "~/utils/usageRanges";

// Spend, at a glance: today up front, the longer windows beside it, and the
// last 30 days as a strip of daily bars over a split by agent. The full story
// (charts, models, cache) is the Usage pane in settings, one click away; this
// card only has to answer "what has this project cost". Every figure is the
// local usage report, scoped to this project — an estimate, never a bill.

const props = defineProps<{
  usage: SpaceUsage;
}>();

const { openDrawer } = useSettingsSurface();
const { cue } = useSound();
const providerColors = useProviderColors();
// Pulled out of `usage` because a template unwraps a ref only at the top level:
// `usage.settled` would read as the ref itself, and always be truthy.
const { settled, usageFor } = props.usage;

const today = computed(() => usageFor("1d")?.totals ?? null);
const month = computed(() => usageFor("30d"));

/** Each longer window's totals, read once per render rather than per use. */
const windows = computed(() =>
  LONGER_USAGE_RANGES.map((w) => ({ id: w.id, label: w.label, totals: usageFor(w.id)?.totals ?? null })),
);

const bars = computed(() => {
  const days = month.value?.days ?? [];
  const max = Math.max(0, ...days.map((d) => d.costUsd));
  return days.map((d) => ({
    date: d.date,
    cost: d.costUsd,
    height: max > 0 ? Math.max(d.costUsd > 0 ? 6 : 0, (d.costUsd / max) * 100) : 0,
  }));
});

// Every agent that did any work is listed, even one that cost nothing: it holds
// no width in the bar (it has no dollars to share), but its legend entry says
// why — "free" when every record priced at nothing (a free-tier model), "not
// priced" when some model no catalog knows was left out of the total.
const split = computed(() => {
  const total = month.value?.totals.costUsd ?? 0;
  return knownProviderRows(month.value?.providers ?? [], providerColors.value)
    .filter(({ row }) => row.tokens > 0)
    .map(({ row, identity }) => ({
      ...identity,
      costUsd: row.costUsd,
      unpriced: (row.unpricedRecords ?? 0) > 0,
      share: total > 0 ? row.costUsd / total : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
});

function openUsage(): void {
  cue("open");
  openDrawer("agentsUsage");
}
</script>

<template>
  <SpaceCard title="Spend">
    <template #aside>
      <button type="button" class="spend__more" @click="openUsage">
        Full usage
        <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
      </button>
    </template>

    <div class="spend__top">
      <div class="spend__today">
        <span class="spend__label">Today</span>
        <template v-if="today">
          <span class="spend__figure" title="Estimated at published API rates, not a bill">
            {{ formatUsd(today.costUsd) }}
          </span>
          <span class="spend__detail">
            {{ formatTokens(today.tokens) }} tokens · {{ formatCount(today.prompts) }}
            {{ today.prompts === 1 ? "prompt" : "prompts" }}
          </span>
        </template>
        <template v-else-if="!settled">
          <span class="spend__skel spend__skel--figure" aria-hidden="true" />
          <span class="spend__skel spend__skel--detail" aria-hidden="true" />
        </template>
        <span v-else class="spend__figure spend__figure--none">—</span>
      </div>

      <dl class="spend__windows">
        <div v-for="w in windows" :key="w.id" class="spend__window">
          <dt class="spend__label">{{ w.label }}</dt>
          <dd v-if="w.totals" class="spend__window-val">
            {{ formatUsd(w.totals.costUsd) }}
            <span class="spend__window-tokens">{{ formatTokens(w.totals.tokens) }}</span>
          </dd>
          <dd v-else-if="!settled" class="spend__window-val">
            <span class="spend__skel spend__skel--window" aria-hidden="true" />
          </dd>
          <dd v-else class="spend__window-val spend__window-val--none">—</dd>
        </div>
      </dl>
    </div>

    <div v-if="bars.length" class="spend__strip" aria-label="Daily cost, last 30 days">
      <span
        v-for="(b, i) in bars"
        :key="b.date"
        class="spend__bar"
        :class="{ 'is-zero': b.cost <= 0 }"
        :style="{ height: `${b.height}%`, '--bi': i }"
        :title="`${formatDayShort(b.date)} · ${formatUsd(b.cost)}`"
      />
    </div>

    <div v-if="split.length" class="spend__split">
      <div class="spend__split-bar" aria-hidden="true">
        <span
          v-for="s in split"
          v-show="s.share > 0"
          :key="s.provider"
          class="spend__split-seg"
          :style="{ flexGrow: s.share, backgroundColor: s.color }"
        />
      </div>
      <ul class="spend__legend" aria-label="Last 30 days by agent">
        <li v-for="s in split" :key="s.provider" class="spend__leg" :title="s.label">
          <i class="spend__dot" :style="{ backgroundColor: s.color }" aria-hidden="true" />
          <ProviderLogo :brand="s.brand" :size="14" class="spend__mark" />
          <span class="sr-only">{{ s.label }}</span>
          <span v-if="s.costUsd > 0" class="spend__leg-val">{{ formatUsd(s.costUsd) }}</span>
          <span v-else-if="s.unpriced" class="spend__leg-val spend__leg-val--none">not priced</span>
          <span v-else class="spend__leg-val spend__leg-val--none">free</span>
        </li>
      </ul>
    </div>

    <p class="spend__note">Estimated at published API rates, not billed amounts.</p>
  </SpaceCard>
</template>

<style scoped>
.spend__more {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 6px 3px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.spend__more:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.spend__more:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}

.spend__top {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.spend__today {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.spend__label {
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.spend__figure {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.6px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.spend__figure--none {
  color: var(--muted);
}
.spend__detail {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.spend__windows {
  display: flex;
  gap: 18px;
  margin: 0;
}
.spend__window {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.spend__window-val {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.spend__window-val--none {
  color: var(--muted);
}
.spend__window-tokens {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}

/* ── last 30 days ────────────────────────────────────────────────────────── */
.spend__strip {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 40px;
}
.spend__bar {
  flex: 1;
  min-width: 0;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--accent) 70%, transparent);
  transform-origin: bottom;
  animation: spend-bar-in 0.36s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: calc(140ms + var(--bi, 0) * 5ms);
  transition: background-color 0.15s ease;
}
@keyframes spend-bar-in {
  from {
    opacity: 0.25;
    transform: scaleY(0);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}
.spend__bar:hover {
  background-color: var(--accent);
}
/* A quiet day still holds its slot, as a hairline on the floor. */
.spend__bar.is-zero {
  height: 2px !important;
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
}

.spend__split {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.spend__split-bar {
  display: flex;
  gap: 2px;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  animation: spend-split-in 0.38s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: 200ms;
}
@keyframes spend-split-in {
  from {
    opacity: 0;
    clip-path: inset(0 100% 0 0 round 999px);
  }
  to {
    opacity: 1;
    clip-path: inset(0 0 0 0 round 999px);
  }
}
.spend__split-seg {
  min-width: 3px;
}
.spend__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  animation: spend-fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: 240ms;
}
@keyframes spend-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.spend__leg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
/* The dot ties the entry to its segment in the bar above; the mark names it. */
.spend__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
}
.spend__mark {
  flex: none;
}
.spend__leg-val {
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.spend__leg-val--none {
  color: var(--muted);
  font-style: italic;
}

.spend__note {
  margin: 0;
  font-size: 11px;
  color: color-mix(in srgb, var(--muted) 80%, transparent);
}

.spend__skel {
  display: block;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
  animation: spend-pulse 1.4s ease-in-out infinite;
}
.spend__skel--figure {
  width: 84px;
  height: 30px;
}
.spend__skel--detail {
  width: 120px;
  height: 12px;
}
.spend__skel--window {
  width: 52px;
  height: 16px;
}
@keyframes spend-pulse {
  50% {
    opacity: 0.5;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spend__skel,
  .spend__bar,
  .spend__split-bar,
  .spend__legend {
    animation: none;
  }
}
</style>
