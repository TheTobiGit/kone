<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { SpaceUsage } from "~/composables/useSpaceUsage";
import {
  activityStats,
  buildGrid,
  dateKey,
  dayAgents,
  quartileLevels,
  versusAverage,
  type GridDay,
} from "~/utils/spaceActivity";
import { formatCount, formatTokens, formatUsd } from "~/utils/usageFormat";

// Which days agents worked in this project this year — January through the
// current month (months still to come aren't drawn), a column per week, each
// day shaded by the tokens spent here. It reads the
// all-time usage report, which claims a session by the folder it ran in, so a
// session started from a terminal counts the same as one kone ran. Tokens
// rather than prompts: only kone's own threads record a prompt count, while
// every provider's log records tokens.
//
// Beside the grid, a day panel reads one day in full: today unless a square is
// hovered or pinned with a click. When the grid needs the width (late in the
// year, or a narrow window) the panel moves under it. The calendar and
// streak arithmetic lives in ~/utils/spaceActivity.

const props = defineProps<{
  usage: SpaceUsage;
}>();

const providerColors = useProviderColors();

const GAP = 3;
const DAY_LABEL_WIDTH = 28;
const MIN_CELL = 8;
const MAX_CELL = 14;
/** The panel sits beside the grid only while this width is left for it and
 *  the squares stay at least COMFY_CELL; otherwise it drops below. */
const PANEL_MIN = 210;
const PANEL_GAP = 28;
const COMFY_CELL = 11;
/** Rows the panel keeps for agents. A day with more lists one fewer and
 *  spends the last row on "+N more", so the panel never grows. */
const PANEL_ROWS = 3;

const now = new Date();
const todayKey = dateKey(now);
const year = now.getFullYear();
const grid = buildGrid(now);

const report = computed(() => props.usage.usageFor("all"));
const loading = computed(() => !report.value && !props.usage.settled.value);
/** This year's days only — the grid, the shading and every number below it
 *  agree on the same span. */
const yearDays = computed(() => (report.value?.days ?? []).filter((d) => d.date.startsWith(`${year}-`)));
const byDate = computed(() => new Map(yearDays.value.map((d) => [d.date, d])));

const shade = computed(() => quartileLevels(yearDays.value.map((d) => d.tokens)));
const levelOf = (key: string) => shade.value(byDate.value.get(key)?.tokens ?? 0);

// ── layout: the months shown always fit, the squares take the card's width ──
const weekCount = grid.weeks.length;

const main = ref<HTMLElement | null>(null);
const wrap = ref<HTMLElement | null>(null);
const { width } = useElementSize(main);
function fitCell(room: number): number {
  return Math.floor((room - DAY_LABEL_WIDTH - GAP * (weekCount - 1)) / weekCount);
}
/** Room for the panel beside the grid, with squares still comfortable. */
const side = computed(() => width.value === 0 || fitCell(width.value - PANEL_MIN - PANEL_GAP) >= COMFY_CELL);
const cell = computed(() => {
  const room = side.value ? width.value - PANEL_MIN - PANEL_GAP : width.value;
  return Math.max(MIN_CELL, Math.min(MAX_CELL, fitCell(room) || MAX_CELL));
});

// Squares never shrink past MIN_CELL, so late in the year on a narrow card the
// grid is wider than the card and scrolls sideways. It rests on the latest
// weeks — where today is — rather than on January.
watch([cell, side, width], async () => {
  await nextTick();
  const el = wrap.value;
  if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
});

const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: "short" });

/** Each shown month's name over the column holding its 1st. */
const months = computed(() =>
  grid.months.map(({ month, column }) => ({
    label: MONTH_FMT.format(new Date(year, month, 1)),
    left: DAY_LABEL_WIDTH + column * (cell.value + GAP),
  })),
);

// ── the numbers under the grid ───────────────────────────────────────────────
const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const LONG_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const stats = computed(() => activityStats(yearDays.value, todayKey));
const busiest = computed(() => {
  const top = stats.value.busiest;
  return top ? { label: DAY_FMT.format(new Date(`${top.date}T00:00:00`)), tokens: top.tokens } : null;
});

const empty = computed(() => !loading.value && stats.value.activeDays === 0);
const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

// ── the day panel ────────────────────────────────────────────────────────────
const hovered = ref<GridDay | null>(null);
const pinned = ref<GridDay | null>(null);

function onEnter(c: GridDay): void {
  if (loading.value || c.outside) return;
  hovered.value = c;
}

function onPick(c: GridDay): void {
  if (loading.value || c.outside) return;
  pinned.value = pinned.value?.key === c.key ? null : c;
}

const shown = computed(() => {
  const key = hovered.value?.key ?? pinned.value?.key ?? todayKey;
  const date = hovered.value?.date ?? pinned.value?.date ?? now;
  const day = byDate.value.get(key);
  const tokens = day?.tokens ?? 0;
  const agents = dayAgents(day, providerColors.value);
  return {
    key,
    label: LONG_FMT.format(date),
    today: key === todayKey,
    pinned: !hovered.value && pinned.value?.key === key,
    future: key > todayKey,
    tokens,
    cost: day?.costUsd ?? 0,
    agents: agents.length > PANEL_ROWS ? agents.slice(0, PANEL_ROWS - 1) : agents,
    moreAgents: agents.length > PANEL_ROWS ? agents.length - (PANEL_ROWS - 1) : 0,
    versus: versusAverage(tokens, stats.value.averageTokens, stats.value.activeDays),
  };
});
</script>

<template>
  <SpaceCard title="Activity" :style="{ '--cell': `${cell}px`, '--gap': `${GAP}px` }">
    <template #aside>
      <span class="act__year">{{ year }}</span>
    </template>

    <div ref="main" class="act__main" :class="{ 'is-stacked': !side }">
      <div ref="wrap" class="act__wrap" :class="{ 'is-loading': loading }" @mouseleave="hovered = null">
        <div class="act__months" aria-hidden="true">
          <span v-for="m in months" :key="m.label" class="act__month" :style="{ left: `${m.left}px` }">
            {{ m.label }}
          </span>
        </div>
        <div class="act__body">
          <div class="act__days" :style="{ width: `${DAY_LABEL_WIDTH}px` }" aria-hidden="true">
            <span />
            <span>Mon</span>
            <span />
            <span>Wed</span>
            <span />
            <span>Fri</span>
            <span />
          </div>
          <div
            class="act__grid"
            role="img"
            :aria-label="`Agent activity in ${year}: ${plural(stats.activeDays, 'active day')}`"
          >
            <div v-for="(week, wi) in grid.weeks" :key="wi" class="act__week">
              <span
                v-for="c in week"
                :key="c.key"
                class="act__cell"
                :class="[
                  `lv-${loading ? 0 : levelOf(c.key)}`,
                  {
                    'is-outside': c.outside,
                    'is-future': c.future && !c.outside,
                    'is-today': c.key === todayKey,
                    'is-hovered': hovered?.key === c.key,
                    'is-pinned': pinned?.key === c.key,
                  },
                ]"
                @mouseenter="onEnter(c)"
                @click="onPick(c)"
              />
            </div>
          </div>
        </div>
      </div>

      <aside class="act__day" :aria-label="`${shown.label} activity`" aria-live="polite">
        <header class="act__day-head">
          <span class="act__day-date">{{ shown.label }}</span>
          <span v-if="shown.today" class="act__day-tag">Today</span>
          <button
            v-else-if="shown.pinned"
            type="button"
            class="act__day-tag act__day-tag--btn"
            title="Back to today"
            @click="pinned = null"
          >
            Pinned ×
          </button>
        </header>

        <!-- Every state fills the same three fixed-height slots (figure, one
             line, the agent rows), so the panel is one height whatever day
             it reads. -->
        <div class="act__day-total">
          <span v-if="loading" class="act__skel act__skel--figure" aria-hidden="true" />
          <template v-else-if="shown.tokens > 0">
            <span class="act__day-figure">{{ formatTokens(shown.tokens) }}</span>
            <span class="act__day-unit">tokens</span>
            <span class="act__day-cost">{{ formatUsd(shown.cost) }}</span>
          </template>
          <span v-else class="act__day-figure act__day-figure--none">—</span>
        </div>
        <span class="act__day-versus">
          <template v-if="loading">&nbsp;</template>
          <template v-else-if="shown.tokens > 0">{{ shown.versus ?? "\u00a0" }}</template>
          <template v-else>{{
            shown.future ? "Still to come." : shown.today ? "Nothing yet today." : "No agent work this day."
          }}</template>
        </span>
        <ul class="act__day-agents">
          <template v-if="!loading">
            <li v-for="a in shown.agents" :key="a.provider" :title="a.label">
              <i class="act__dot" :style="{ backgroundColor: a.color }" aria-hidden="true" />
              <ProviderLogo :brand="a.brand" :size="13" />
              <span class="sr-only">{{ a.label }}</span>
              <span class="act__day-track" aria-hidden="true">
                <span
                  class="act__day-fill"
                  :style="{
                    width: `${Math.max(a.share * 100, 3)}%`,
                    backgroundColor: a.color,
                  }"
                />
              </span>
              <span class="act__day-val">{{ formatTokens(a.tokens) }}</span>
            </li>
            <li v-if="shown.moreAgents" class="act__day-more">+{{ shown.moreAgents }} more</li>
          </template>
        </ul>
      </aside>
    </div>

    <p v-if="empty" class="act__empty">No agent activity in this project this year.</p>
    <dl v-else class="act__stats">
      <div class="act__stat">
        <dt>Active days</dt>
        <dd>{{ loading ? "—" : formatCount(stats.activeDays) }}</dd>
      </div>
      <div class="act__stat">
        <dt>Current streak</dt>
        <dd>{{ loading ? "—" : plural(stats.current, "day") }}</dd>
      </div>
      <div class="act__stat">
        <dt>Longest streak</dt>
        <dd>{{ loading ? "—" : plural(stats.longest, "day") }}</dd>
      </div>
      <div class="act__stat">
        <dt>Busiest day</dt>
        <dd v-if="busiest">
          {{ busiest.label }}
          <span class="act__stat-detail">{{ formatTokens(busiest.tokens) }}</span>
        </dd>
        <dd v-else>—</dd>
      </div>
      <div class="act__legend" aria-hidden="true">
        Less
        <span v-for="lv in 5" :key="lv" class="act__key" :class="`lv-${lv - 1}`" />
        More
      </div>
    </dl>
  </SpaceCard>
</template>

<style scoped>
.act__year {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── grid ────────────────────────────────────────────────────────────────── */
.act__wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.act__months {
  position: relative;
  height: 13px;
}
.act__month {
  position: absolute;
  top: 0;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted);
}
.act__body {
  display: flex;
}
.act__days {
  display: grid;
  flex: none;
  grid-template-rows: repeat(7, var(--cell));
  row-gap: var(--gap);
  font-size: 9.5px;
  line-height: var(--cell);
  color: var(--muted);
}
.act__grid {
  display: flex;
  gap: var(--gap);
}
.act__week {
  display: grid;
  grid-template-rows: repeat(7, var(--cell));
  row-gap: var(--gap);
}
.act__cell {
  display: block;
  width: var(--cell);
  height: var(--cell);
  border-radius: 3px;
  transition: box-shadow 0.12s ease;
}
.act__cell.is-outside {
  visibility: hidden;
}
.act__cell.is-future {
  background-color: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
}
.act__cell.is-today {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ink) 45%, transparent);
}
.act__cell.is-hovered {
  box-shadow: 0 0 0 1.5px var(--ink);
}
.lv-0 {
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
.lv-1 {
  background-color: color-mix(in srgb, var(--accent) 28%, transparent);
}
.lv-2 {
  background-color: color-mix(in srgb, var(--accent) 50%, transparent);
}
.lv-3 {
  background-color: color-mix(in srgb, var(--accent) 74%, transparent);
}
.lv-4 {
  background-color: var(--accent);
}
.act__wrap.is-loading .act__cell:not(.is-future) {
  animation: act-pulse 1.4s ease-in-out infinite;
}
@keyframes act-pulse {
  50% {
    opacity: 0.5;
  }
}

/* ── grid + day panel ────────────────────────────────────────────────────── */
.act__main {
  display: flex;
  align-items: stretch;
  gap: 28px;
  min-width: 0;
}
.act__main.is-stacked {
  flex-direction: column;
  gap: 14px;
}
.act__main > .act__wrap {
  flex: none;
}
/* Stacked, the grid gets the card's full width. Squares stop shrinking at
   MIN_CELL, so if even those outrun it the grid scrolls sideways instead of
   spilling out of the card; the little padding leaves room for a hovered
   square's ring at the far edges. */
.act__main.is-stacked > .act__wrap {
  overflow-x: auto;
  padding: 0 2px 3px 0;
  scrollbar-width: thin;
}
.act__cell {
  cursor: pointer;
}
.act__cell.is-pinned {
  box-shadow: 0 0 0 1.5px var(--accent);
}

/* The panel reads one day: a hairline marks it off from the grid it answers. */
/* Its slots are fixed heights (below), so scrubbing across days with one
   agent or three, or none, never moves the card. */
.act__day {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;

  padding-left: 20px;
  border-left: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.act__main.is-stacked .act__day {
  padding: 12px 0 0;
  border-left: none;
  border-top: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.act__day-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 18px;
}
.act__day-date {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--muted);
}
.act__day-tag {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--ink);
  background-color: color-mix(in srgb, var(--accent) 16%, transparent);
}
.act__day-tag--btn {
  cursor: pointer;
  transition: background-color 0.14s ease;
}
.act__day-tag--btn:hover {
  background-color: color-mix(in srgb, var(--accent) 26%, transparent);
}
.act__day-tag--btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}
.act__day-total {
  display: flex;
  flex: none;
  align-items: baseline;
  height: 28px;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.act__day-figure {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.5px;
  line-height: 1.1;
  color: var(--ink);
}
.act__day-unit {
  font-size: 11.5px;
  color: var(--muted);
}
.act__day-cost {
  margin-left: auto;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.act__day-versus {
  overflow: hidden;
  height: 15px;
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
/* PANEL_ROWS rows of --row, whether or not they're filled. */
.act__day-agents {
  --row: 16px;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 5px;
  height: calc(3 * var(--row) + 2 * 5px);
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.act__day-agents li {
  flex: none;
  height: var(--row);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.act__day-track {
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.act__day-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.act__day-val {
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.act__day-agents li.act__day-more {
  color: var(--muted);
}
.act__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
}
.act__day-figure--none {
  color: var(--muted);
}
.act__skel {
  display: block;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
  animation: act-pulse 1.4s ease-in-out infinite;
}
.act__skel--figure {
  width: 96px;
  height: 26px;
}
.act__skel--line {
  width: 70%;
  height: 12px;
}

/* ── numbers ─────────────────────────────────────────────────────────────── */
.act__stats {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 10px 24px;
  margin: 0;
}
.act__stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.act__stat dt {
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.act__stat dd {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.act__stat-detail {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}
.act__legend {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  font-size: 10.5px;
  color: var(--muted);
}
.act__key {
  display: block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.act__key:first-of-type {
  margin-left: 4px;
}
.act__key:last-of-type {
  margin-right: 4px;
}
.act__empty {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .act__wrap.is-loading .act__cell,
  .act__skel {
    animation: none;
  }
  .act__day-fill {
    transition: none;
  }
}
</style>
