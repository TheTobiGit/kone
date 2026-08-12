<script setup lang="ts">
import { computed, ref } from "vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { SESSION_BRAND } from "~/types/session";
import type { UsageDay } from "~/types/desktop";
import { formatDayShort, formatTokens, formatUsd } from "~/utils/usageFormat";
import {
  PROVIDER_COLOR,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
} from "~/utils/usageProviders";

export type UsageChartMetric = "tokens" | "cost";

const props = defineProps<{
  days: readonly string[];
  daily: readonly UsageDay[];
  metric: UsageChartMetric;
}>();

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

interface Point {
  x: number;
  y: number;
}

interface DayColumn {
  bands: { provider: (typeof PROVIDER_ORDER)[number]; value: number }[];
  total: number;
}

interface CurveSegment {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

function valueFor(
  daily: UsageDay | undefined,
  provider: (typeof PROVIDER_ORDER)[number],
  metric: UsageChartMetric,
): number {
  const entry = daily?.byProvider?.find((row) => row.provider === provider);
  if (!entry) return 0;
  return metric === "tokens" ? entry.tokens : entry.costUsd;
}

function monotoneTangents(points: readonly Point[]): number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

function smoothCurve(points: readonly Point[]): CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(segments: readonly CurveSegment[], startCommand: "M" | "L"): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `${startCommand}${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

function niceScale(peak: number, count: number): { max: number; ticks: number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const byDay = computed(() => new Map(props.daily.map((entry) => [entry.date, entry])));

const hoverIndex = ref<number | null>(null);
const plotRef = ref<HTMLDivElement | null>(null);

const chart = computed(() => {
  const days = props.days;
  if (days.length === 0) {
    return {
      paths: [] as {
        provider: (typeof PROVIDER_ORDER)[number];
        total: number;
        area: string;
        line: string;
      }[],
      ticks: [0] as number[],
      stepX: 0,
      toY: (_value: number) => VIEW_HEIGHT,
      series: [] as DayColumn[],
    };
  }

  const columns: DayColumn[] = days.map((day) => {
    const entry = byDay.value.get(day);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, props.metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });

  const peak = columns.reduce(
    (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
    0,
  );
  const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
  const step = days.length === 1 ? 0 : VIEW_WIDTH / (days.length - 1);
  const toY = (value: number) =>
    max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

  const built = PROVIDER_ORDER.map((provider, providerIndex) => {
    const curve = smoothCurve(
      columns.map((column, dayIndex) => ({
        x: dayIndex * step,
        y: toY(column.bands[providerIndex]?.value ?? 0),
      })),
    );
    const line = curvePath(curve, "M");
    return {
      provider,
      total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
      area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
      line,
    };
  });

  const ordered = [...built].sort((a, b) => b.total - a.total);

  return { paths: ordered, ticks: tickValues, stepX: step, toY, series: columns };
});

const format = computed(() => (props.metric === "tokens" ? formatTokens : formatUsd));

function onMove(event: MouseEvent): void {
  const bounds = plotRef.value?.getBoundingClientRect();
  if (!bounds || bounds.width === 0 || props.days.length === 0) return;
  const fraction = (event.clientX - bounds.left) / bounds.width;
  const index = Math.round(fraction * (props.days.length - 1));
  hoverIndex.value = Math.min(props.days.length - 1, Math.max(0, index));
}

const hoveredDay = computed(() =>
  hoverIndex.value === null ? undefined : props.days[hoverIndex.value],
);
const hoveredColumn = computed(() =>
  hoverIndex.value === null ? undefined : chart.value.series[hoverIndex.value],
);
const hoverLeft = computed(() =>
  props.days.length <= 1 ? 0 : ((hoverIndex.value ?? 0) / (props.days.length - 1)) * 100,
);

const activeProviders = computed(() =>
  PROVIDER_ORDER.filter((provider) =>
    chart.value.paths.some((path) => path.provider === provider && path.total > 0),
  ),
);
</script>

<template>
  <div class="upc">
    <div class="upc__row">
      <div class="upc__axis">
        <span
          v-for="tick in chart.ticks"
          :key="tick"
          class="upc__tick"
          :style="{ top: `${(chart.toY(tick) / VIEW_HEIGHT) * 100}%` }"
        >
          {{ tick === 0 ? "0" : format(tick) }}
        </span>
      </div>

      <div
        ref="plotRef"
        class="upc__plot"
        @mousemove="onMove"
        @mouseleave="hoverIndex = null"
      >
        <svg
          class="upc__svg"
          :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`Daily ${metric === 'tokens' ? 'processed tokens' : 'cost'} by provider`"
        >
          <defs>
            <linearGradient
              v-for="{ provider } in chart.paths"
              :id="`upc-grad-${provider}`"
              :key="`grad-${provider}`"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" :stop-color="PROVIDER_COLOR[provider]" stop-opacity="0.2" />
              <stop offset="100%" :stop-color="PROVIDER_COLOR[provider]" stop-opacity="0" />
            </linearGradient>
          </defs>

          <line
            v-for="tick in chart.ticks"
            :key="`grid-${tick}`"
            :x1="0"
            :x2="VIEW_WIDTH"
            :y1="chart.toY(tick)"
            :y2="chart.toY(tick)"
            class="upc__grid"
            :class="{ 'upc__grid--base': tick === 0 }"
            vector-effect="non-scaling-stroke"
          />

          <path
            v-for="{ provider, area } in chart.paths"
            :key="`fill-${provider}`"
            :d="area"
            :fill="`url(#upc-grad-${provider})`"
          />
          <path
            v-for="{ provider, line } in chart.paths"
            :key="`line-${provider}`"
            :d="line"
            fill="none"
            :stroke="PROVIDER_COLOR[provider]"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
          />

          <line
            v-if="hoverIndex !== null"
            :x1="hoverIndex * chart.stepX"
            :x2="hoverIndex * chart.stepX"
            :y1="PLOT_TOP"
            :y2="VIEW_HEIGHT"
            class="upc__hover-line"
            vector-effect="non-scaling-stroke"
          />
        </svg>

        <div
          v-if="hoveredDay"
          class="upc__tip"
          :style="{
            left: `${hoverLeft}%`,
            transform: hoverLeft > 60 ? 'translateX(-100%)' : 'translateX(0)',
          }"
        >
          <div class="upc__tip-day">{{ formatDayShort(hoveredDay) }}</div>
          <div
            v-for="provider in activeProviders"
            :key="provider"
            class="upc__tip-row"
          >
            <span class="upc__tip-label">
              <ProviderLogo
                :brand="SESSION_BRAND[provider]"
                :size="12"
                class="upc__tip-mark"
              />
              {{ PROVIDER_LABEL[provider] }}
            </span>
            <span class="upc__tip-val">
              {{ format(hoveredColumn?.bands.find((b) => b.provider === provider)?.value ?? 0) }}
            </span>
          </div>
          <div class="upc__tip-total">
            <span class="upc__tip-label">Total</span>
            <span class="upc__tip-val">{{ format(hoveredColumn?.total ?? 0) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="upc__dates">
      <span>{{ days[0] ? formatDayShort(days[0]) : "" }}</span>
      <span>{{ days[Math.floor(days.length / 2)] ? formatDayShort(days[Math.floor(days.length / 2)]!) : "" }}</span>
      <span>{{ days[days.length - 1] ? formatDayShort(days[days.length - 1]!) : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
.upc {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.upc__row {
  display: flex;
  gap: 8px;
}
.upc__axis {
  position: relative;
  width: 3.5rem;
  flex-shrink: 0;
  height: 14rem;
}
.upc__tick {
  position: absolute;
  right: 0;
  transform: translateY(-50%);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.upc__plot {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 14rem;
}
.upc__svg {
  width: 100%;
  height: 100%;
}
.upc__grid {
  stroke: color-mix(in srgb, var(--ink) 6%, transparent);
  stroke-width: 1;
  stroke-dasharray: 2 5;
}
.upc__grid--base {
  stroke: color-mix(in srgb, var(--ink) 10%, transparent);
  stroke-dasharray: none;
}
.upc__hover-line {
  stroke: var(--muted);
  stroke-width: 1;
}
.upc__tip {
  pointer-events: none;
  position: absolute;
  top: 0;
  z-index: 1;
  min-width: 9rem;
  padding: 8px 10px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ground) 92%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--ink) 12%, transparent);
  font-size: 12px;
}
.upc__tip-day {
  margin-bottom: 4px;
  color: var(--muted);
}
.upc__tip-row,
.upc__tip-total {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.upc__tip-total {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
}
.upc__tip-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.upc__tip-mark {
  flex-shrink: 0;
}
.upc__tip-val {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.upc__dates {
  display: flex;
  justify-content: space-between;
  padding-left: 3.75rem;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--muted);
}
</style>
