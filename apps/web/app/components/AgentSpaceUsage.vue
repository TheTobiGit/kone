<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/ProviderLogo.vue";
import UsageProviderChart from "~/components/usage/UsageProviderChart.vue";
import { describeModelId } from "~/utils/modelCatalog";
import { SESSION_BRAND } from "~/types/session";
import type { ProviderKind, UsageDay, UsageRange } from "~/types/desktop";
import type { useAgentSpace } from "~/composables/useAgentSpace";
import {
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "~/utils/usageFormat";
import {
  PROVIDER_COLOR,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  isProviderKind,
} from "~/utils/usageProviders";

const props = withDefaults(
  defineProps<{
    space: ReturnType<typeof useAgentSpace>;
    showProjectScope?: boolean;
    foot?: boolean;
  }>(),
  { showProjectScope: true, foot: true },
);

const report = computed(() => props.space.usage.value);

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "1d", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

const metric = ref<"tokens" | "cost">("cost");
const breakdown = ref<"model" | "day">("model");

const days = computed(() => report.value?.days ?? []);
const dayLabels = computed(() => days.value.map((d) => d.date));
const recentDays = computed(() => [...days.value].reverse().slice(0, 8));

const windowLabel = computed(() => {
  const list = days.value;
  if (!list.length) return "";
  if (list.length === 1) return formatDayShort(list[0]!.date);
  return `${formatDayShort(list[0]!.date)} to ${formatDayShort(list[list.length - 1]!.date)}`;
});

const totals = computed(() => report.value?.totals);

const orderedProviders = computed(() => {
  const list = report.value?.providers ?? [];
  const mapped = list
    .filter((p) => isProviderKind(p.key))
    .map((p) => {
      const provider = p.key as ProviderKind;
      const totalTokens = totals.value?.tokens ?? 1;
      const totalCost = totals.value?.costUsd ?? 1;
      return {
        provider,
        label: PROVIDER_LABEL[provider] ?? p.label,
        brand: SESSION_BRAND[provider],
        tokens: p.tokens,
        costUsd: p.costUsd,
        tokenShare: totalTokens > 0 ? p.tokens / totalTokens : 0,
        costShare: totalCost > 0 ? p.costUsd / totalCost : 0,
      };
    });
  return mapped.sort((a, b) =>
    metric.value === "cost" ? b.costUsd - a.costUsd : b.tokens - a.tokens,
  );
});

const activeDays = computed(
  () => days.value.filter((day) => day.tokens > 0).length,
);
const dailyAverage = computed(() => {
  const t = totals.value;
  if (!t || activeDays.value === 0) return 0;
  return t.tokens / activeDays.value;
});

const observedInput = computed(() => totals.value?.inputTokens ?? 0);
const cachedShare = computed(() => {
  const t = totals.value;
  if (!t || observedInput.value === 0) return 0;
  return (t.cacheReadTokens ?? 0) / observedInput.value;
});
const uncachedInput = computed(() => {
  const t = totals.value;
  if (!t) return 0;
  return Math.max(0, t.inputTokens - (t.cacheReadTokens ?? 0));
});

const modelRows = computed(() => {
  const totalCost = totals.value?.costUsd ?? 1;
  return (report.value?.models ?? []).map((model) => ({
    ...model,
    name: describeModelId(model.label).name || model.label,
    brand: SESSION_BRAND[(model.provider as ProviderKind) ?? "codex"] ?? "generic",
    costShare: totalCost > 0 ? model.costUsd / totalCost : 0,
  }));
});

function providerDayCost(day: UsageDay, provider: ProviderKind): number {
  return day.byProvider?.find((row) => row.provider === provider)?.costUsd ?? 0;
}

const empty = computed(
  () => props.space.usageLoaded.value && (!report.value || report.value.totals.prompts === 0),
);
const settling = computed(() => props.space.usageLoading.value && !props.space.usageLoaded.value);

const SKELETON_BAR_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67];
const SKELETON_METRICS = [
  "Processed tokens",
  "Cached input",
  "Uncached input",
  "Output",
  "Threads",
];
</script>

<template>
  <section class="usage" aria-label="Usage">
    <div class="usage__toolbar">
      <div v-if="showProjectScope" class="usage__seg" role="group" aria-label="Scope">
        <button
          type="button"
          class="usage__seg-btn"
          :class="{ 'usage__seg-btn--on': space.usageScope.value === 'project' }"
          @click="space.setUsageScope('project')"
        >
          This project
        </button>
        <button
          type="button"
          class="usage__seg-btn"
          :class="{ 'usage__seg-btn--on': space.usageScope.value === 'global' }"
          @click="space.setUsageScope('global')"
        >
          All projects
        </button>
      </div>

      <div class="usage__toolbar-right">
        <p v-if="windowLabel" class="usage__window">{{ windowLabel }}</p>
        <div class="usage__seg" role="group" aria-label="Range">
          <button
            v-for="r in RANGES"
            :key="r.id"
            type="button"
            class="usage__seg-btn"
            :class="{ 'usage__seg-btn--on': space.range.value === r.id }"
            @click="space.setRange(r.id)"
          >
            {{ r.label }}
          </button>
        </div>
        <button
          type="button"
          class="usage__refresh"
          :disabled="space.usageLoading.value"
          aria-label="Refresh usage"
          @click="space.refreshUsage()"
        >
          <HugeiconsIcon
            class="usage__refresh-glyph"
            :class="{ 'usage__refresh-glyph--spin': space.usageLoading.value }"
            :icon="RefreshIcon"
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>

    <p v-if="empty" class="usage__empty">
      Nothing recorded yet — usage builds up here as the agents work.
    </p>

    <div v-else-if="settling" class="usage-skel">
      <div class="usage-skel__headline">
        <span class="usage-skel__kicker">Raw token cost</span>
        <div class="usage-skel__bar usage-skel__bar--lg" />
        <div class="usage-skel__bar usage-skel__bar--sm" />
      </div>

      <section class="usage-skel__split">
        <div class="usage-skel__split-bar" />
        <div class="usage-skel__legend">
          <div v-for="provider in PROVIDER_ORDER" :key="provider" class="usage-skel__leg">
            <span class="usage-skel__leg-name">{{ PROVIDER_LABEL[provider] }}</span>
            <div class="usage-skel__bar usage-skel__bar--xs" />
          </div>
        </div>
      </section>

      <section class="usage-skel__chart">
        <div class="usage-skel__bar usage-skel__bar--title" />
        <div class="usage-skel__bars">
          <div
            v-for="height in SKELETON_BAR_HEIGHTS"
            :key="height"
            class="usage-skel__col"
            :style="{ height: `${height}%` }"
          />
        </div>
      </section>
      <section class="usage-skel__metrics">
        <div v-for="label in SKELETON_METRICS" :key="label" class="usage-skel__metric">
          <span class="usage-skel__metric-label">{{ label }}</span>
          <div class="usage-skel__bar usage-skel__bar--val" />
          <div class="usage-skel__bar usage-skel__bar--detail" />
        </div>
      </section>
    </div>

    <template v-else>
      <section class="usage__lead">
        <div class="usage__headline">
          <span class="usage__kicker">
            {{ metric === "cost" ? "Raw token cost" : "Processed tokens" }}
          </span>
          <Transition name="usage-swap" mode="out-in">
            <span :key="metric" class="usage__figure">
              {{ metric === "cost" ? `${formatUsd(totals?.costUsd ?? 0)}*` : formatTokens(totals?.tokens ?? 0) }}
            </span>
          </Transition>
          <span class="usage__sub">
            {{
              metric === "cost"
                ? "* if billed at full API rate"
                : `Input, cache reads and output across ${formatCount(totals?.prompts ?? 0)} prompts.`
            }}
          </span>
        </div>

        <div class="usage__seg usage__seg--compact" role="group" aria-label="Measure">
          <button
            type="button"
            class="usage__seg-btn"
            :class="{ 'usage__seg-btn--on': metric === 'cost' }"
            @click="metric = 'cost'"
          >
            Cost
          </button>
          <button
            type="button"
            class="usage__seg-btn"
            :class="{ 'usage__seg-btn--on': metric === 'tokens' }"
            @click="metric = 'tokens'"
          >
            Tokens
          </button>
        </div>
      </section>

      <section class="usage__split" aria-label="Split by agent">
        <div class="usage__split-bar">
          <span
            v-for="provider in orderedProviders"
            v-show="(metric === 'cost' ? provider.costShare : provider.tokenShare) > 0"
            :key="`seg-${provider.provider}`"
            class="usage__split-seg"
            :style="{
              flexGrow: metric === 'cost' ? provider.costShare : provider.tokenShare,
              backgroundColor: PROVIDER_COLOR[provider.provider],
            }"
            :title="`${provider.label} · ${formatPercent(metric === 'cost' ? provider.costShare : provider.tokenShare)}`"
          />
        </div>

        <div class="usage__split-legend">
          <div
            v-for="provider in orderedProviders"
            v-show="(metric === 'cost' ? provider.costShare : provider.tokenShare) > 0"
            :key="`leg-${provider.provider}`"
            class="usage__leg"
          >
            <span class="usage__leg-name">
              <span
                class="usage__leg-dot"
                :style="{ backgroundColor: PROVIDER_COLOR[provider.provider] }"
              />
              <ProviderLogo :brand="provider.brand" :size="14" class="usage__leg-mark" />
              <span class="usage__leg-label">{{ provider.label }}</span>
            </span>
            <span class="usage__leg-val">
              {{ metric === "cost" ? formatUsd(provider.costUsd) : formatTokens(provider.tokens) }}
            </span>
            <span class="usage__leg-detail">
              {{
                metric === "cost"
                  ? `${formatPercent(provider.costShare)} · ${formatTokens(provider.tokens)} tk`
                  : `${formatPercent(provider.tokenShare)} · ${formatUsd(provider.costUsd)}`
              }}
            </span>
          </div>
        </div>
      </section>

      <section class="usage__chart-block">
        <div class="usage__chart-head">
          <h2 class="usage__chart-title">
            Daily {{ metric === "tokens" ? "processed tokens" : "cost" }}
          </h2>
        </div>
        <UsageProviderChart :days="dayLabels" :daily="days" :metric="metric" />
      </section>

      <section class="usage__metrics" aria-label="Token breakdown">
        <div class="usage__metric">
          <span class="usage__metric-label">Processed tokens</span>
          <span class="usage__metric-value">{{ formatTokens(totals?.tokens ?? 0) }}</span>
          <span class="usage__metric-detail">{{ formatTokens(dailyAverage) }} per active day</span>
        </div>
        <div class="usage__metric">
          <span class="usage__metric-label">Cached input</span>
          <span class="usage__metric-value">{{ formatTokens(totals?.cacheReadTokens ?? 0) }}</span>
          <span class="usage__metric-detail">{{ formatPercent(cachedShare) }} of observed input</span>
        </div>
        <div class="usage__metric">
          <span class="usage__metric-label">Uncached input</span>
          <span class="usage__metric-value">{{ formatTokens(uncachedInput) }}</span>
          <span class="usage__metric-detail">
            {{ formatTokens(totals?.cacheCreationTokens ?? 0) }} cache writes
          </span>
        </div>
        <div class="usage__metric">
          <span class="usage__metric-label">Output</span>
          <span class="usage__metric-value">{{ formatTokens(totals?.outputTokens ?? 0) }}</span>
          <span class="usage__metric-detail">
            includes {{ formatTokens(totals?.reasoningTokens ?? 0) }} reasoning
          </span>
        </div>
        <div class="usage__metric">
          <span class="usage__metric-label">Threads</span>
          <span class="usage__metric-value">{{ formatCount(totals?.threads ?? 0) }}</span>
          <span class="usage__metric-detail">{{ formatCount(totals?.prompts ?? 0) }} prompts</span>
        </div>
      </section>

      <section class="usage__breakdown">
        <div class="usage__breakdown-head">
          <h2 class="usage__breakdown-title">Breakdown</h2>
          <div class="usage__seg usage__seg--compact" role="group" aria-label="Breakdown view">
            <button
              type="button"
              class="usage__seg-btn"
              :class="{ 'usage__seg-btn--on': breakdown === 'model' }"
              @click="breakdown = 'model'"
            >
              Model
            </button>
            <button
              type="button"
              class="usage__seg-btn"
              :class="{ 'usage__seg-btn--on': breakdown === 'day' }"
              @click="breakdown = 'day'"
            >
              Day
            </button>
          </div>
        </div>

        <table v-if="breakdown === 'model'" class="usage__table">
          <thead>
            <tr>
              <th class="usage__th-rank">#</th>
              <th>Model</th>
              <th class="usage__th-share">Share</th>
              <th class="usage__th-right">Cost</th>
              <th class="usage__th-right">Tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!modelRows.length">
              <td colspan="5" class="usage__table-empty">No activity in this window.</td>
            </tr>
            <tr v-for="(model, mi) in modelRows" :key="`${model.provider}:${model.label}`">
              <td class="usage__rank">{{ mi + 1 }}</td>
              <td>
                <span class="usage__model-name">
                  <ProviderLogo :brand="model.brand" :size="15" class="usage__model-mark" />
                  <span class="usage__model-label">{{ model.name }}</span>
                </span>
              </td>
              <td class="usage__td-share">
                <span class="usage__share">
                  <span class="usage__share-bar">
                    <i
                      class="usage__share-fill"
                      :style="{
                        width: `${Math.max(model.costShare * 100, model.costShare > 0 ? 3 : 0)}%`,
                        backgroundColor: PROVIDER_COLOR[(model.provider as ProviderKind) ?? 'codex'],
                      }"
                    />
                  </span>
                  <span class="usage__share-num">{{ formatPercent(model.costShare) }}</span>
                </span>
              </td>
              <td class="usage__td-right usage__cost">{{ formatUsd(model.costUsd) }}</td>
              <td class="usage__td-right usage__td-muted">{{ formatTokens(model.tokens) }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else class="usage__table">
          <thead>
            <tr>
              <th>Day</th>
              <th class="usage__th-split">Split by agent</th>
              <th class="usage__th-right">Cost</th>
              <th class="usage__th-right">Tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!recentDays.length">
              <td colspan="4" class="usage__table-empty">No activity in this window.</td>
            </tr>
            <tr v-for="day in recentDays" :key="day.date">
              <td class="usage__day-date">{{ formatDayShort(day.date) }}</td>
              <td class="usage__td-split">
                <span class="usage__daybar" :title="`${formatUsd(day.costUsd)} across agents`">
                  <i
                    v-for="provider in PROVIDER_ORDER"
                    v-show="providerDayCost(day, provider) > 0"
                    :key="provider"
                    class="usage__daybar-seg"
                    :style="{
                      flexGrow: providerDayCost(day, provider),
                      backgroundColor: PROVIDER_COLOR[provider],
                    }"
                  />
                </span>
              </td>
              <td class="usage__td-right usage__cost">{{ formatUsd(day.costUsd) }}</td>
              <td class="usage__td-right usage__td-muted">{{ formatTokens(day.tokens) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p v-if="foot" class="usage__note">
        Cost is an estimate from published per-model rates, not a bill. Claude, Codex,
        OpenCode, Droid, and Antigravity come from each CLI's own logs on this machine;
        Cursor from its signed-in dashboard export when available.
      </p>
    </template>
  </section>
</template>

<style scoped>
.usage {
  --usage-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --usage-rise: 0.5s;
  display: flex;
  flex-direction: column;
  gap: 2rem;
  /* Clears the scroll container's bottom smoke fade so the closing note
     doesn't dissolve while it's the last thing in view. */
  padding-bottom: 4rem;
}

/* Content resolve — when the real report replaces the skeleton, the sections
   don't snap in; they settle up in sequence with a soft blur, so the pane reads
   as focusing into place. The toolbar stays put (it's live across all states);
   only the resolved content rides in. Runs once per mount of the v-else block. */
@keyframes usage-rise {
  from {
    opacity: 0;
    transform: translateY(9px);
    filter: blur(5px);
  }
  to {
    opacity: 1;
    transform: none;
    filter: blur(0);
  }
}
.usage__lead,
.usage__split,
.usage__chart-block,
.usage__metrics,
.usage__breakdown,
.usage__note {
  animation: usage-rise var(--usage-rise) var(--usage-ease) backwards;
}
.usage__lead {
  animation-delay: 0.03s;
}
.usage__split {
  animation-delay: 0.09s;
}
.usage__chart-block {
  animation-delay: 0.15s;
}
.usage__metrics {
  animation-delay: 0.21s;
}
.usage__breakdown {
  animation-delay: 0.27s;
}
.usage__note {
  animation-delay: 0.33s;
}

/* Metric swap — the hero figure blurs out and the new number resolves in, so
   flipping Cost/Tokens feels like a refocus rather than a hard text replace. */
.usage-swap-enter-active,
.usage-swap-leave-active {
  transition:
    opacity 0.26s var(--usage-ease),
    filter 0.26s var(--usage-ease),
    transform 0.26s var(--usage-ease);
}
.usage-swap-enter-from {
  opacity: 0;
  filter: blur(6px);
  transform: translateY(4px);
}
.usage-swap-leave-to {
  opacity: 0;
  filter: blur(6px);
  transform: translateY(-4px);
}

.usage__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.usage__toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
}
.usage__window {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

/* Quiet chip toggles — kone doesn't box its controls. Off reads as a faint
   ink wash, on carries the warm accent, same vocabulary as the model chips. */
.usage__seg {
  display: inline-flex;
  gap: 4px;
}
.usage__seg--compact .usage__seg-btn {
  padding: 3px 9px;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.usage__seg-btn {
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--muted);
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.usage__seg-btn:hover:not(.usage__seg-btn--on) {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
}
.usage__seg-btn--on {
  background-color: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--ink);
}
.usage__seg-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}

.usage__refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.usage__refresh:hover:not(:disabled) {
  color: var(--ink);
  background-color: var(--hover);
}
.usage__refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
@keyframes usage-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
.usage__refresh-glyph--spin {
  animation: usage-refresh-spin 0.8s linear infinite;
}

.usage__empty {
  font-size: 15px;
  color: var(--muted);
  padding: 1.5rem 0;
}

/* Lead — the money statement, with the metric switch parked at its top-right
   so the label you read ("Raw token cost") and the control that changes it sit
   together. Everything downstream inherits this one metric. */
.usage__lead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.usage__headline {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.usage__kicker {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.usage__figure {
  display: inline-block;
  font-size: 2.5rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.025em;
  color: var(--ink);
  line-height: 1.05;
}
.usage__sub {
  font-size: 12px;
  color: var(--muted);
}

/* The split — one full-width share bar reads the whole spend at a glance, a
   legend grid names the segments. Replaces the stacked rail of mini-bars; the
   colour dot ties each agent to its line in the chart below. */
.usage__split {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.usage__split-bar {
  display: flex;
  gap: 3px;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  /* The composed hero bar wipes in from the left once the split has risen. */
  transform-origin: left center;
  animation: usage-wipe 0.7s var(--usage-ease) 0.22s backwards;
}
.usage__split-seg {
  flex-basis: 0;
  min-width: 3px;
  border-radius: 999px;
  /* So a Cost/Tokens flip glides the segment widths instead of jumping. */
  transition:
    flex-grow 0.55s var(--usage-ease),
    background-color 0.3s ease;
}

/* One reveal for every meter that carries a proportion — the hero split, the
   day ribbons, the leaderboard fills all draw out from their left edge. */
@keyframes usage-wipe {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
.usage__split-legend {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px 8px;
}
@media (min-width: 720px) {
  .usage__split-legend {
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
}
/* Each agent is a compact stat: name label on top, its spend as the headline
   number right beneath it, share + tokens underneath. Stacking binds the money
   to the provider it belongs to — no far-floated figure to trace back. */
.usage__leg {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 12px;
  border-radius: 12px;
  transition: background-color 140ms ease;
}
.usage__leg:hover {
  background-color: var(--hover);
}
.usage__leg-name {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 13px;
  color: var(--muted);
}
.usage__leg-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage__leg-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.usage__leg-mark {
  flex-shrink: 0;
}
.usage__leg-val {
  font-size: 19px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.015em;
  line-height: 1;
  color: var(--ink);
}
.usage__leg-detail {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.usage__chart-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.usage__chart-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.usage__chart-title {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
/* Not a card grid — an editorial stat row. One faint rule top and bottom to
   set it apart from the chart, hair-thin verticals between columns, and air
   instead of fills. */
.usage__metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px 0;
  padding: 20px 0;
  border-block: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
@media (min-width: 720px) {
  .usage__metrics {
    grid-template-columns: repeat(5, 1fr);
    gap: 0;
  }
}
.usage__metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 22px;
}
.usage__metric:first-child {
  padding-left: 0;
}
@media (min-width: 720px) {
  .usage__metric + .usage__metric {
    border-left: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  }
}
.usage__metric-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.usage__metric-value {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.usage__metric-detail {
  font-size: 12px;
  color: var(--muted);
}

.usage__breakdown {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.usage__breakdown-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.usage__breakdown-title {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.usage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.usage__table th {
  padding: 0 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 400;
  text-align: left;
  color: var(--muted);
}
.usage__th-right,
.usage__td-right {
  text-align: right;
}
.usage__table tbody tr {
  transition: background-color 140ms ease;
}
.usage__table tbody tr:hover {
  background-color: var(--hover);
}
.usage__table td {
  padding: 11px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.usage__table tbody tr:last-child td {
  border-bottom: none;
}
/* Bleed the hover wash to the panel edge so rows breathe without a boxed frame. */
.usage__table td:first-child {
  padding-left: 10px;
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
}
.usage__table td:last-child {
  padding-right: 10px;
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
}
.usage__table th:first-child {
  padding-left: 10px;
}
.usage__table th:last-child {
  padding-right: 10px;
}
.usage__td-muted {
  color: var(--muted);
}
.usage__table-empty {
  padding: 24px 0 !important;
  text-align: center;
  color: var(--muted);
}
.usage__model-name {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.usage__model-mark {
  flex-shrink: 0;
}
.usage__model-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Rank gives the breakdown a leaderboard spine — quiet, tabular, out of the way. */
.usage__th-rank,
.usage__rank {
  width: 2rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: left;
}
.usage__rank {
  font-size: 12px;
}
/* Cost is the point of the table — let it sit at full ink while the rest recedes. */
.usage__cost {
  color: var(--ink);
}

/* Inline share meter — reads spend concentration at a glance, tinted to the
   model's own provider colour so the table echoes the chart. Left-aligned and
   wide so the bar itself carries the ranking, not just the number. */
.usage__th-share {
  text-align: left;
  width: 40%;
}
.usage__td-share {
  padding-right: 24px;
}
.usage__share {
  display: flex;
  align-items: center;
  gap: 12px;
}
.usage__share-bar {
  flex: 1;
  min-width: 40px;
  max-width: 160px;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
.usage__share-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  /* Fills draw out from the left on reveal, then track share changes smoothly. */
  transform-origin: left center;
  animation: usage-wipe 0.65s var(--usage-ease) 0.28s backwards;
  transition:
    width 0.55s var(--usage-ease),
    background-color 0.3s ease;
}
.usage__share-num {
  min-width: 3rem;
  text-align: right;
  color: var(--muted);
}

/* Day view — a stacked ribbon of each day's agent split, same colours as the
   hero bar and the chart, so a glance down the column reads the shifting mix. */
.usage__th-split {
  text-align: left;
  width: 46%;
}
.usage__td-split {
  padding-right: 24px;
}
.usage__day-date {
  color: var(--ink);
  white-space: nowrap;
}
.usage__daybar {
  display: flex;
  gap: 2px;
  width: 100%;
  max-width: 220px;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  transform-origin: left center;
  animation: usage-wipe 0.6s var(--usage-ease) 0.3s backwards;
}
.usage__daybar-seg {
  flex-basis: 0;
  min-width: 2px;
  border-radius: 999px;
  transition:
    flex-grow 0.55s var(--usage-ease),
    background-color 0.3s ease;
}

.usage__note {
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 52ch;
}

/* skeleton */
.usage-skel {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}
.usage-skel__headline {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.usage-skel__kicker {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.usage-skel__split {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.usage-skel__split-bar {
  height: 10px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.usage-skel__legend {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px 8px;
}
@media (min-width: 720px) {
  .usage-skel__legend {
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
}
.usage-skel__leg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
}
.usage-skel__leg-name {
  font-size: 14px;
  color: var(--muted);
}
.usage-skel__chart {
  display: flex;
  flex-direction: column;
}
.usage-skel__bar {
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.usage-skel__bar--lg {
  height: 32px;
  width: 9rem;
}
.usage-skel__bar--sm {
  height: 12px;
  width: 7rem;
}
.usage-skel__bar--xs {
  height: 14px;
  width: 3.5rem;
}
.usage-skel__bar--title {
  height: 14px;
  width: 6rem;
  margin-bottom: 12px;
}
.usage-skel__bar--val {
  height: 20px;
  width: 4rem;
  margin-top: 4px;
}
.usage-skel__bar--detail {
  height: 12px;
  width: 6rem;
}
.usage-skel__bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 14rem;
  padding-left: 3.75rem;
}
.usage-skel__col {
  flex: 1;
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}

/* A slow sheen crosses the placeholders so the pane reads as loading, not
   broken — low-contrast and unhurried, in keeping with everything else. */
@keyframes usage-shimmer {
  from {
    background-position: 180% 0;
  }
  to {
    background-position: -80% 0;
  }
}
.usage-skel__bar,
.usage-skel__split-bar,
.usage-skel__col {
  background-image: linear-gradient(
    100deg,
    transparent 30%,
    color-mix(in srgb, var(--ink) 7%, transparent) 50%,
    transparent 70%
  );
  background-repeat: no-repeat;
  background-size: 220% 100%;
  animation: usage-shimmer 1.6s ease-in-out infinite;
}
.usage-skel__col:nth-child(2n) {
  animation-delay: 0.15s;
}
.usage-skel__col:nth-child(3n) {
  animation-delay: 0.3s;
}
@media (prefers-reduced-motion: reduce) {
  .usage-skel__bar,
  .usage-skel__split-bar,
  .usage-skel__col {
    animation: none;
  }
}
.usage-skel__metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px 0;
  padding: 20px 0;
  border-block: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
@media (min-width: 720px) {
  .usage-skel__metrics {
    grid-template-columns: repeat(5, 1fr);
    gap: 0;
  }
}
.usage-skel__metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 22px;
}
.usage-skel__metric:first-child {
  padding-left: 0;
}

/* Calm is the default, but honour the system preference — no rise, no wipe, no
   figure blur, and shares land at their final width without gliding. */
@media (prefers-reduced-motion: reduce) {
  .usage__lead,
  .usage__split,
  .usage__chart-block,
  .usage__metrics,
  .usage__breakdown,
  .usage__note,
  .usage__split-bar,
  .usage__share-fill,
  .usage__daybar {
    animation: none;
  }
  .usage__split-seg,
  .usage__share-fill,
  .usage__daybar-seg {
    transition: background-color 0.3s ease;
  }
  .usage-swap-enter-active,
  .usage-swap-leave-active {
    transition: opacity 0.2s ease;
  }
  .usage-swap-enter-from,
  .usage-swap-leave-to {
    filter: none;
    transform: none;
  }
}
.usage-skel__metric-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
</style>
