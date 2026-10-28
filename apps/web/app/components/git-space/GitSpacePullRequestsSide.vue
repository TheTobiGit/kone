<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon } from "@hugeicons/core-free-icons";
import type { GitHubPullRequest } from "~/types/desktop";
import { PR_STANDS, prStandOf, type PrStand, type PrStandInfo } from "~/utils/prStand";

// The pull requests' side column: the whole list read at once. Where they
// stand as one stacked bar, who the reviews are waiting on, and what has been
// open longest. Every drawing is also a filter, but the filters belong to the
// list: this only says which one was picked, and the list decides what that
// hides.
//
// While the list is still on its way from GitHub the column is drawn pending:
// the labels are real, because they never depend on the data, and every number
// and drawing is a blank slot in the plan's dotted hand. When the list lands
// only those slots fill, so nothing on the page swaps for something else.

const props = defineProps<{
  prs: GitHubPullRequest[];
  /** The list hasn't landed yet: draw the slots, not the numbers. */
  pending?: boolean;
  myLogin: string | null;
  standFilter: PrStand | null;
  waitingFilter: string | null;
}>();

const emit = defineEmits<{
  pickStand: [id: PrStand];
  pickWaiting: [login: string];
  open: [number: number, origin: DOMRect | null];
}>();

const query = defineModel<string>("query", { required: true });

function openRow(e: MouseEvent, number: number) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", number, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

function standOf(pr: GitHubPullRequest): PrStand {
  return prStandOf({ ...pr, failingChecks: pr.checkCounts.failing, pendingChecks: pr.checkCounts.pending });
}

interface StandCount extends PrStandInfo {
  count: number;
}

const stands = computed<StandCount[]>(() => {
  const counts = new Map<PrStand, number>();
  for (const pr of props.prs) counts.set(standOf(pr), (counts.get(standOf(pr)) ?? 0) + 1);
  const out: StandCount[] = [];
  for (const s of PR_STANDS) {
    const count = counts.get(s.id) ?? 0;
    if (count) out.push({ ...s, count });
  }
  return out;
});
const readyCount = computed(() => stands.value.find((s) => s.id === "ready")?.count ?? 0);
const openCount = computed(() => props.prs.filter((pr) => pr.state === "open").length);

interface Waiting {
  login: string;
  face: string | null;
  count: number;
}

/** Everyone a review is waiting on, the busiest first. */
const waitingOn = computed<Waiting[]>(() => {
  const by = new Map<string, Waiting>();
  for (const pr of props.prs) {
    if (pr.state !== "open" || pr.isDraft) continue;
    for (const r of pr.reviewers) {
      if (r.state !== "pending") continue;
      const hit = by.get(r.person.login);
      if (hit) hit.count++;
      else by.set(r.person.login, { login: r.person.login, face: r.person.avatarDataUrl, count: 1 });
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
});
const waitingPeak = computed(() => Math.max(1, ...waitingOn.value.map((w) => w.count)));
const myWaiting = computed(() => waitingOn.value.find((w) => w.login === props.myLogin)?.count ?? 0);

const DAY_MS = 86_400_000;
const OLDEST_SHOWN = 4;
/** The open pull requests that have been open longest, as bars of days. */
const oldest = computed(() => {
  // Measured to the latest activity on the list rather than the wall clock,
  // which for a live repository is the same moment.
  let now = 0;
  for (const pr of props.prs) now = Math.max(now, Date.parse(pr.updatedAt ?? pr.createdAt) || 0);
  const open = props.prs.filter((pr) => pr.state === "open");
  const aged = open.map((pr) => ({ pr, days: Math.max(0, (now - Date.parse(pr.createdAt)) / DAY_MS) }));
  return aged.sort((a, b) => b.days - a.days).slice(0, OLDEST_SHOWN);
});
const oldestPeak = computed(() => Math.max(1, ...oldest.value.map((o) => o.days)));

/** How many slots each drawing holds while pending: about what a busy
 *  repository fills, so the column is near its landed height. */
const SLOTS = { stands: 4, waiting: 3, ages: OLDEST_SHOWN };

function initial(name: string) {
  return name[0]?.toUpperCase() ?? "";
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <aside class="gsp__side" :class="{ 'gsp__side--pending': pending }" :aria-busy="pending">
    <label class="gsp__search gsp__block" style="--i: 0">
      <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" />
      <input
        v-model="query"
        type="search"
        placeholder="Find a pull request"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <div class="gsp__block" style="--i: 1">
      <div class="gsp__label">
        <span class="gsp__label-name">Where they stand</span>
      </div>
      <div class="gsp__big">
        <span v-if="pending" class="gsp__slot gsp__slot--big" />
        <span v-else class="gsp__big-num gsp__land">{{ readyCount }}</span>
        <span class="gsp__big-of">
          of
          <span v-if="pending" class="gsp__slot" />
          <span v-else class="gsp__land">{{ openCount }}</span>
          ready to merge
        </span>
      </div>
      <div v-if="pending" class="gsp__stack gsp__stack--plan" role="presentation" />
      <div v-else class="gsp__stack" role="presentation">
        <i
          v-for="s in stands"
          :key="s.id"
          class="gsp__stack-seg"
          :class="{ 'gsp__stack-seg--dim': standFilter && standFilter !== s.id }"
          :style="{ flexGrow: s.count, background: s.tone }"
        />
      </div>
      <div v-if="pending" class="gsp__legend" aria-hidden="true">
        <span v-for="n in SLOTS.stands" :key="n" class="gsp__key gsp__key--plan" :style="{ '--n': n }">
          <i class="gsp__key-dot gsp__ring-plan" />
          <i class="gsp__base-plan" />
          <span class="gsp__slot" />
        </span>
      </div>
      <div v-else class="gsp__legend">
        <button
          v-for="s in stands"
          :key="s.id"
          type="button"
          class="gsp__key gsp__land"
          :class="{ 'gsp__key--on': standFilter === s.id, 'gsp__key--dim': standFilter && standFilter !== s.id }"
          :aria-pressed="standFilter === s.id"
          @click="emit('pickStand', s.id)"
        >
          <i class="gsp__key-dot" :style="{ background: s.tone }" />
          <span class="gsp__key-name">{{ s.label }}</span>
          <span class="gsp__key-count">{{ s.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="pending || waitingOn.length" class="gsp__block" style="--i: 2">
      <div class="gsp__label">
        <span class="gsp__label-name">Waiting on</span>
        <span v-if="!pending" class="gsp__label-count gsp__land">{{ waitingOn.length }}</span>
      </div>
      <div v-if="pending" class="gsp__waiting" aria-hidden="true">
        <span v-for="n in SLOTS.waiting" :key="n" class="gsp__wait gsp__key--plan" :style="{ '--n': n }">
          <i class="gsp__face gsp__face--md gsp__ring-plan" />
          <i class="gsp__base-plan gsp__base-plan--name" />
          <span class="gsp__wait-track gsp__track-plan" />
          <span class="gsp__slot" />
        </span>
      </div>
      <div v-else class="gsp__waiting">
        <button
          v-for="(w, n) in waitingOn"
          :key="w.login"
          type="button"
          class="gsp__wait gsp__land"
          :class="{ 'gsp__wait--on': waitingFilter === w.login, 'gsp__wait--dim': waitingFilter && waitingFilter !== w.login }"
          :style="{ '--n': n }"
          :aria-pressed="waitingFilter === w.login"
          @click="emit('pickWaiting', w.login)"
        >
          <span class="gsp__face gsp__face--md" aria-hidden="true">
            <img v-if="w.face" :src="w.face" alt="" />
            <template v-else>{{ initial(w.login) }}</template>
          </span>
          <span class="gsp__wait-name">{{ w.login === myLogin ? "you" : w.login }}</span>
          <span class="gsp__wait-track">
            <i class="gsp__wait-fill" :style="{ width: `${(w.count / waitingPeak) * 100}%` }" />
          </span>
          <span class="gsp__key-count">{{ w.count }}</span>
        </button>
      </div>
      <i v-if="pending" class="gsp__base-plan gsp__base-plan--sub" />
      <p v-else class="gsp__sub gsp__land">
        <template v-if="myWaiting">
          <b>{{ plural(myWaiting, "review") }}</b>{{ " " }}{{ myWaiting === 1 ? "is" : "are" }} waiting on you.
        </template>
        <template v-else>Nothing is waiting on you.</template>
      </p>
    </div>

    <div v-if="pending || oldest.length" class="gsp__block" style="--i: 3">
      <div class="gsp__label">
        <span class="gsp__label-name">Open longest</span>
      </div>
      <div v-if="pending" class="gsp__ages" aria-hidden="true">
        <span v-for="n in SLOTS.ages" :key="n" class="gsp__age gsp__key--plan" :style="{ '--n': n }">
          <span class="gsp__age-num gsp__num-plan">#–––</span>
          <span class="gsp__age-track gsp__track-plan" />
          <span class="gsp__slot" />
        </span>
      </div>
      <div v-else class="gsp__ages">
        <button
          v-for="(o, n) in oldest"
          :key="o.pr.number"
          type="button"
          class="gsp__age gsp__land"
          :title="o.pr.title"
          @click="openRow($event, o.pr.number)"
        >
          <span class="gsp__age-num">#{{ o.pr.number }}</span>
          <span class="gsp__age-track">
            <i class="gsp__age-fill" :style="{ width: `${(o.days / oldestPeak) * 100}%`, '--n': n }" />
          </span>
          <span class="gsp__key-count">{{ o.pr.relative.replace(/ ago$/, "") }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* The side column holds still while the list scrolls past it. */
.gsp__side {
  position: sticky;
  top: 6rem;
  display: flex;
  flex-direction: column;
  gap: 36px;
  min-width: 0;
}
/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsp__block {
  animation: gsp-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
/* What fills a slot when the list lands settles on the same beat as the
   list's rows, so the whole page settles at once. It starts part of the way
   in rather than from nothing: the slot it replaces goes in that frame, and
   from nothing the column would read as blank for a beat. */
.gsp__land {
  animation: gsp-land var(--gs-t-enter) var(--gs-ease) backwards;
}
@keyframes gsp-land {
  from {
    opacity: 0.4;
  }
}
@keyframes gsp-in {
  from {
    opacity: 0;
  }
}
@keyframes gsp-grow {
  from {
    transform: scaleX(0);
  }
}
/* ── labels ───────────────────────────────────────────────────────────────── */
.gsp__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.gsp__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsp__label-count,
.gsp__key-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.gsp__sub {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.gsp__sub b {
  font-weight: 500;
  color: var(--ink-soft);
}
.gsp__face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-size: 9px;
  color: var(--muted);
}
.gsp__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsp__face--md {
  width: 22px;
  height: 22px;
  font-size: 11px;
}
/* ── side ─────────────────────────────────────────────────────────────────── */
.gsp__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--muted);
  background-color: var(--hover);
  cursor: text;
}
.gsp__search input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  background: none;
  border: 0;
  outline: none;
}
.gsp__search input::placeholder {
  color: var(--muted);
}
.gsp__search:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 18%, transparent);
}
.gsp__big {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.gsp__big-num {
  font-family: var(--font-mono);
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--ink);
}
.gsp__big-of {
  font-size: 13px;
  color: var(--muted);
}
.gsp__stack {
  display: flex;
  gap: 2px;
  height: 10px;
  transform-origin: left center;
  animation: gsp-grow var(--gs-t-enter) var(--gs-ease) backwards;
}
.gsp__stack-seg {
  flex-basis: 0;
  min-width: 3px;
  border-radius: 3px;
  transition: opacity var(--gs-t-small) var(--gs-ease);
}
.gsp__stack-seg--dim {
  opacity: 0.25;
}
.gsp__legend {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
}
.gsp__key,
.gsp__wait,
.gsp__age {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 6px;
  margin-inline: -6px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) ease,
    opacity var(--gs-t-small) ease;
}
.gsp__key:hover,
.gsp__key--on,
.gsp__wait:hover,
.gsp__wait--on,
.gsp__age:hover {
  background-color: var(--hover);
}
.gsp__key--dim,
.gsp__wait--dim {
  opacity: 0.45;
}
.gsp__key-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.gsp__key-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.gsp__waiting,
.gsp__ages {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gsp__wait {
  height: 32px;
}
.gsp__wait-name {
  width: 92px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.gsp__wait-track,
.gsp__age-track {
  flex: 1 1 auto;
  height: 6px;
}
.gsp__wait-fill,
.gsp__age-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: left center;
  animation: gsp-grow var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(var(--n, 0) * var(--gs-stagger));
}
.gsp__age-num {
  width: 40px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
/* ── pending: the slots, in the list plan's dotted hand ───────────────────── */
.gsp__side--pending {
  --gsp-plan: color-mix(in srgb, var(--ink) 30%, transparent);
  --gsp-plan-soft: color-mix(in srgb, var(--ink) 16%, transparent);
}
.gsp__slot {
  display: inline-block;
  width: 14px;
  height: 0.9em;
  border-bottom: 1px dashed var(--gsp-plan);
}
.gsp__slot--big {
  width: 24px;
  height: 26px;
}
.gsp__key--plan .gsp__slot {
  flex-shrink: 0;
  width: 12px;
  height: 11px;
  margin-bottom: 4px;
  align-self: flex-end;
}
.gsp__key--plan {
  cursor: default;
}
.gsp__key--plan:hover {
  background-color: transparent;
}
.gsp__stack--plan {
  border: 1px dashed var(--gsp-plan);
  border-radius: 3px;
}
.gsp__ring-plan {
  background-color: transparent;
  border: 1px dashed var(--gsp-plan);
  animation: gsp-in var(--gs-t-small) var(--gs-ease) backwards;
  animation-delay: calc(var(--n, 0) * 60ms);
}
/* A baseline the name will sit on: dotted and drawn in, like the list's. */
.gsp__base-plan {
  display: block;
  flex: 1 1 auto;
  align-self: flex-end;
  height: 1px;
  margin-bottom: 8px;
  background-image: linear-gradient(to right, var(--gsp-plan) 50%, transparent 50%);
  background-size: 4px 1px;
  transform-origin: left center;
  animation: gsp-grow 560ms var(--gs-ease) backwards;
  animation-delay: calc(120ms + var(--n, 0) * 60ms);
}
.gsp__base-plan--name {
  flex: 0 0 92px;
}
.gsp__base-plan--sub {
  width: 70%;
  margin: 20px 0 0;
  background-image: linear-gradient(to right, var(--gsp-plan-soft) 50%, transparent 50%);
}
.gsp__track-plan {
  box-sizing: border-box;
  border: 1px dashed var(--gsp-plan-soft);
  border-radius: 3px;
}
.gsp__num-plan {
  color: color-mix(in srgb, var(--ink) 40%, transparent);
}

@media (max-width: 1180px) {
  .gsp__side {
    position: static;
    order: -1;
  }
}
.gsp__key:focus-visible,
.gsp__wait:focus-visible,
.gsp__age:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .gsp__block,
  .gsp__land,
  .gsp__ring-plan,
  .gsp__base-plan,
  .gsp__stack,
  .gsp__wait-fill,
  .gsp__age-fill {
    animation: none;
  }
}
</style>
