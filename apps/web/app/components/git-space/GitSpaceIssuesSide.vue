<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon } from "@hugeicons/core-free-icons";
import type { GitHubIssue } from "~/types/desktop";

// The issues' side column: the open ones read at once. How many have someone
// on them, which labels they carry, who they're with, and what has been open
// longest. Every drawing is also a filter, but the filters belong to the list:
// this only says which one was picked, and the list decides what that hides.

const props = defineProps<{
  issues: GitHubIssue[];
  myLogin: string | null;
  /** The assignee filter's values for "nobody" and "anyone", owned by the list. */
  nobody: string;
  anyone: string;
  labelFilter: string | null;
  assigneeFilter: string | null;
}>();

const emit = defineEmits<{
  pickLabel: [name: string];
  pickAssignee: [login: string];
  open: [number: number, origin: DOMRect | null];
}>();

const query = defineModel<string>("query", { required: true });

function openRow(e: MouseEvent, number: number) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", number, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

const open = computed(() => props.issues.filter((i) => i.state === "open"));
const taken = computed(() => open.value.filter((i) => i.assignees.length > 0).length);
const untaken = computed(() => open.value.length - taken.value);

interface Tally {
  key: string;
  label: string;
  color: string | null;
  face: string | null;
  count: number;
}

function tally(pick: (issue: GitHubIssue) => Omit<Tally, "count">[]): Tally[] {
  const by = new Map<string, Tally>();
  for (const issue of open.value) {
    for (const t of pick(issue)) {
      const hit = by.get(t.key);
      if (hit) hit.count++;
      else by.set(t.key, { ...t, count: 1 });
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const LABELS_SHOWN = 6;
/** The labels the open issues carry, the commonest first. */
const labels = computed(() =>
  tally((i) => i.labels.map((l) => ({ key: l.name, label: l.name, color: `#${l.color}`, face: null }))).slice(
    0,
    LABELS_SHOWN,
  ),
);
const labelPeak = computed(() => Math.max(1, ...labels.value.map((l) => l.count)));

/** Everyone the open issues are assigned to, the busiest first. */
const people = computed(() =>
  tally((i) => i.assignees.map((a) => ({ key: a.login, label: a.login, color: null, face: a.avatarDataUrl }))),
);
const peoplePeak = computed(() => Math.max(1, ...people.value.map((p) => p.count)));
const mine = computed(() => people.value.find((p) => p.key === props.myLogin)?.count ?? 0);

const DAY_MS = 86_400_000;
const OLDEST_SHOWN = 4;
/** The open issues that have been open longest, as bars of days. */
const oldest = computed(() => {
  // Measured to the latest activity on the list rather than the wall clock,
  // which for a live repository is the same moment.
  let now = 0;
  for (const i of props.issues) now = Math.max(now, Date.parse(i.updatedAt ?? i.createdAt) || 0);
  const aged = open.value.map((issue) => ({ issue, days: Math.max(0, (now - Date.parse(issue.createdAt)) / DAY_MS) }));
  return aged.sort((a, b) => b.days - a.days).slice(0, OLDEST_SHOWN);
});
const oldestPeak = computed(() => Math.max(1, ...oldest.value.map((o) => o.days)));

function initial(name: string) {
  return name[0]?.toUpperCase() ?? "";
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <aside class="gsi__side">
    <label class="gsi__search gsi__block" style="--i: 0">
      <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        placeholder="Find an issue"
        aria-label="Find an issue"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <div v-if="open.length" class="gsi__block" style="--i: 1">
      <div class="gsi__label">
        <span class="gsi__label-name">Who has them</span>
      </div>
      <div class="gsi__big">
        <span class="gsi__big-num">{{ taken }}</span>
        <span class="gsi__big-of">of {{ open.length }} have someone on them</span>
      </div>
      <div class="gsi__stack" role="presentation">
        <i
          v-if="taken"
          class="gsi__stack-seg"
          :class="{ 'gsi__stack-seg--dim': assigneeFilter === nobody }"
          :style="{ flexGrow: taken, background: 'var(--accent-2)' }"
        />
        <i
          v-if="untaken"
          class="gsi__stack-seg gsi__stack-seg--nobody"
          :class="{ 'gsi__stack-seg--dim': assigneeFilter === anyone }"
          :style="{ flexGrow: untaken }"
        />
      </div>
      <div class="gsi__legend">
        <button
          v-if="taken"
          type="button"
          class="gsi__key"
          :class="{ 'gsi__key--on': assigneeFilter === anyone, 'gsi__key--dim': assigneeFilter === nobody }"
          :aria-pressed="assigneeFilter === anyone"
          @click="emit('pickAssignee', anyone)"
        >
          <i class="gsi__key-dot" style="background: var(--accent-2)" />
          <span class="gsi__key-name">Someone on it</span>
          <span class="gsi__key-count">{{ taken }}</span>
        </button>
        <button
          v-if="untaken"
          type="button"
          class="gsi__key"
          :class="{ 'gsi__key--on': assigneeFilter === nobody, 'gsi__key--dim': assigneeFilter === anyone }"
          :aria-pressed="assigneeFilter === nobody"
          @click="emit('pickAssignee', nobody)"
        >
          <i class="gsi__key-dot gsi__key-dot--nobody" />
          <span class="gsi__key-name">Nobody yet</span>
          <span class="gsi__key-count">{{ untaken }}</span>
        </button>
      </div>
    </div>

    <div v-if="labels.length" class="gsi__block" style="--i: 2">
      <div class="gsi__label">
        <span class="gsi__label-name">Labels</span>
      </div>
      <div class="gsi__waiting">
        <button
          v-for="(l, n) in labels"
          :key="l.key"
          type="button"
          class="gsi__wait gsi__wait--label"
          :class="{ 'gsi__wait--on': labelFilter === l.key, 'gsi__wait--dim': labelFilter && labelFilter !== l.key }"
          :style="{ '--n': n }"
          :aria-pressed="labelFilter === l.key"
          @click="emit('pickLabel', l.key)"
        >
          <i class="gsi__key-dot" :style="{ background: l.color ?? undefined }" />
          <span class="gsi__wait-name" :title="l.label">{{ l.label }}</span>
          <span class="gsi__wait-track">
            <i class="gsi__wait-fill" :style="{ width: `${(l.count / labelPeak) * 100}%` }" />
          </span>
          <span class="gsi__key-count">{{ l.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="people.length" class="gsi__block" style="--i: 3">
      <div class="gsi__label">
        <span class="gsi__label-name">Who they're with</span>
        <span class="gsi__label-count">{{ people.length }}</span>
      </div>
      <div class="gsi__waiting">
        <button
          v-for="(p, n) in people"
          :key="p.key"
          type="button"
          class="gsi__wait"
          :class="{
            'gsi__wait--on': assigneeFilter === p.key,
            'gsi__wait--dim': assigneeFilter && assigneeFilter !== p.key,
          }"
          :style="{ '--n': n }"
          :aria-pressed="assigneeFilter === p.key"
          @click="emit('pickAssignee', p.key)"
        >
          <span class="gsi__face gsi__face--md" aria-hidden="true">
            <img v-if="p.face" :src="p.face" alt="" />
            <template v-else>{{ initial(p.label) }}</template>
          </span>
          <span class="gsi__wait-name" :title="p.label">{{ p.key === myLogin ? "you" : p.label }}</span>
          <span class="gsi__wait-track">
            <i class="gsi__wait-fill" :style="{ width: `${(p.count / peoplePeak) * 100}%` }" />
          </span>
          <span class="gsi__key-count">{{ p.count }}</span>
        </button>
      </div>
      <p class="gsi__sub">
        <template v-if="mine">
          <b>{{ plural(mine, "issue") }}</b>{{ " " }}{{ mine === 1 ? "is" : "are" }} with you.
        </template>
        <template v-else>None are with you.</template>
      </p>
    </div>

    <div v-if="oldest.length" class="gsi__block" style="--i: 4">
      <div class="gsi__label">
        <span class="gsi__label-name">Open longest</span>
      </div>
      <div class="gsi__ages">
        <button
          v-for="(o, n) in oldest"
          :key="o.issue.number"
          type="button"
          class="gsi__age"
          :title="o.issue.title"
          :aria-label="`#${o.issue.number}, ${o.issue.title}, opened ${o.issue.relative}`"
          aria-haspopup="dialog"
          @click="openRow($event, o.issue.number)"
        >
          <span class="gsi__age-num">#{{ o.issue.number }}</span>
          <span class="gsi__age-track">
            <i class="gsi__age-fill" :style="{ width: `${(o.days / oldestPeak) * 100}%`, '--n': n }" />
          </span>
          <span class="gsi__key-count">{{ o.issue.relative.replace(/ ago$/, "") }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* The side column holds still while the list scrolls past it. */
.gsi__side {
  position: sticky;
  top: 6rem;
  display: flex;
  flex-direction: column;
  gap: 36px;
  min-width: 0;
}
/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsi__block {
  animation: gsi-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
@keyframes gsi-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes gsi-grow {
  from {
    transform: scaleX(0);
  }
}
/* ── labels ───────────────────────────────────────────────────────────────── */
.gsi__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.gsi__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsi__label-count,
.gsi__key-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.gsi__sub {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.gsi__sub b {
  font-weight: 500;
  color: var(--ink-soft);
}
.gsi__face {
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
.gsi__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsi__face--md {
  width: 22px;
  height: 22px;
  font-size: 11px;
}
/* ── side ─────────────────────────────────────────────────────────────────── */
.gsi__search {
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
.gsi__search input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  background: none;
  border: 0;
  outline: none;
}
.gsi__search input::placeholder {
  color: var(--ink-soft);
  opacity: 0.75;
}
.gsi__search:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsi__big {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.gsi__big-num {
  font-family: var(--font-mono);
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--ink);
}
.gsi__big-of {
  font-size: 13px;
  color: var(--muted);
}
.gsi__stack {
  display: flex;
  gap: 2px;
  height: 10px;
  transform-origin: left center;
  animation: gsi-grow 640ms var(--gs-ease) backwards;
  animation-delay: 260ms;
}
.gsi__stack-seg {
  flex-basis: 0;
  min-width: 3px;
  border-radius: 3px;
  transition: opacity var(--gs-t-small) var(--gs-ease);
}
.gsi__stack-seg--dim {
  opacity: 0.25;
}
.gsi__legend {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
}
.gsi__key,
.gsi__wait,
.gsi__age {
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
.gsi__key:hover,
.gsi__key--on,
.gsi__wait:hover,
.gsi__wait--on,
.gsi__age:hover {
  background-color: var(--hover);
}
.gsi__key--dim,
.gsi__wait--dim {
  opacity: 0.45;
}
.gsi__key-dot--nobody {
  border: 1.5px dashed color-mix(in srgb, var(--ink) 40%, transparent);
  background: none;
}
.gsi__stack-seg--nobody {
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--ink) 22%, transparent) 0 3px,
    color-mix(in srgb, var(--ink) 8%, transparent) 3px 6px
  );
}
.gsi__key-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.gsi__key-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.gsi__waiting,
.gsi__ages {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gsi__wait {
  height: 32px;
}
.gsi__wait--label {
  height: 28px;
}
.gsi__wait-name {
  width: 92px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.gsi__wait-track,
.gsi__age-track {
  flex: 1 1 auto;
  height: 6px;
}
.gsi__wait-fill,
.gsi__age-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: left center;
  animation: gsi-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(300ms + var(--n, 0) * 60ms);
}
.gsi__age-num {
  width: 40px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
@media (max-width: 1180px) {
  .gsi__side {
    position: static;
    order: -1;
  }
}
.gsi__key:focus-visible,
.gsi__wait:focus-visible,
.gsi__age:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .gsi__block,
  .gsi__stack,
  .gsi__wait-fill,
  .gsi__age-fill {
    animation: none;
  }
}
</style>
