<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon } from "@hugeicons/core-free-icons";
import HoldToConfirm from "~/components/ui/HoldToConfirm.vue";
import type { GitBranch } from "~/types/desktop";
import {
  STALE_DAYS,
  STANDINGS,
  daysSince,
  kindOf,
  shortAge,
  spokenAge,
  standing,
  type BranchStanding,
} from "~/utils/branchStanding";

// The branches' side column: the local ones read at once. How they stand with
// their remote, which have gone quiet longest, what kinds of work they are,
// and which are already in the default branch and can go. Every drawing is
// also a filter, but the filters belong to the list: this only says which one
// was picked, and the list decides what that hides.

const props = defineProps<{
  /** Every branch, local and remote. */
  branches: GitBranch[];
  standingFilter: BranchStanding | null;
  kindFilter: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  pickStanding: [id: BranchStanding];
  pickKind: [kind: string];
  open: [branch: GitBranch, origin: DOMRect | null];
  clearMerged: [names: string[]];
}>();

const query = defineModel<string>("query", { required: true });

function openRow(e: MouseEvent, branch: GitBranch) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", branch, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

const local = computed(() => props.branches.filter((b) => !b.remote));
const defaultName = computed(() => local.value.find((b) => b.default)?.name ?? "main");

const stands = computed(() => {
  const counts = new Map<BranchStanding, number>();
  for (const b of local.value) counts.set(standing(b), (counts.get(standing(b)) ?? 0) + 1);
  return STANDINGS.map((s) => ({ ...s, count: counts.get(s.id) ?? 0 })).filter((s) => s.count > 0);
});
const even = computed(() => stands.value.find((s) => s.id === "even")?.count ?? 0);

const QUIET_SHOWN = 5;
/** The local branches nobody has committed to longest, the default aside. */
const quiet = computed(() => {
  const aged = local.value
    .filter((b) => !b.default)
    .map((branch) => ({ branch, days: daysSince(branch) }))
    .filter((a): a is { branch: GitBranch; days: number } => a.days !== null);
  return aged.sort((a, b) => b.days - a.days).slice(0, QUIET_SHOWN);
});
const quietPeak = computed(() => Math.max(1, ...quiet.value.map((q) => q.days)));
const stale = computed(
  () => local.value.filter((b) => !b.default && (daysSince(b) ?? 0) >= STALE_DAYS).length,
);

/** The kinds of work, read off the name before the first slash. */
const kinds = computed(() => {
  const by = new Map<string, number>();
  for (const b of local.value) {
    const k = kindOf(b.name);
    if (k) by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
});
const kindPeak = computed(() => Math.max(1, ...kinds.value.map((k) => k.count)));

/** Local branches whose work is all in the default branch, and can go. The
 *  one you're on, and one another worktree has out, stay. */
const merged = computed(() => local.value.filter((b) => b.merged && !b.current && !b.worktree));

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "es"}`;
}
</script>

<template>
  <aside class="gsbs">
    <label class="gsbs__search gsbs__block" style="--i: 0">
      <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        placeholder="Find a branch"
        aria-label="Find a branch"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <div v-if="local.length" class="gsbs__block" style="--i: 1">
      <div class="gsbs__label">
        <span class="gsbs__label-name">How they stand</span>
      </div>
      <div class="gsbs__big">
        <span class="gsbs__big-num">{{ even }}</span>
        <span class="gsbs__big-of">of {{ local.length }} in step with their remote</span>
      </div>
      <div class="gsbs__stack" role="presentation">
        <i
          v-for="s in stands"
          :key="s.id"
          class="gsbs__stack-seg"
          :class="[
            `gsbs__stack-seg--${s.id}`,
            { 'gsbs__stack-seg--dim': standingFilter && standingFilter !== s.id },
          ]"
          :style="{ flexGrow: s.count, background: s.color || undefined }"
        />
      </div>
      <div class="gsbs__legend">
        <button
          v-for="s in stands"
          :key="s.id"
          type="button"
          class="gsbs__key"
          :class="{
            'gsbs__key--on': standingFilter === s.id,
            'gsbs__key--dim': standingFilter && standingFilter !== s.id,
          }"
          :aria-pressed="standingFilter === s.id"
          @click="emit('pickStanding', s.id)"
        >
          <i
            class="gsbs__key-dot"
            :class="`gsbs__key-dot--${s.id}`"
            :style="{ background: s.color || undefined }"
          />
          <span class="gsbs__key-name">{{ s.label }}</span>
          <span class="gsbs__key-count">{{ s.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="quiet.length" class="gsbs__block" style="--i: 2">
      <div class="gsbs__label">
        <span class="gsbs__label-name">Quiet longest</span>
      </div>
      <div class="gsbs__ages">
        <button
          v-for="(q, n) in quiet"
          :key="q.branch.name"
          type="button"
          class="gsbs__age"
          :class="{ 'gsbs__age--stale': q.days >= STALE_DAYS }"
          :title="q.branch.name"
          :aria-label="`${q.branch.name}, last commit ${spokenAge(q.days)}`"
          aria-haspopup="dialog"
          @click="openRow($event, q.branch)"
        >
          <span class="gsbs__age-name">{{ q.branch.name }}</span>
          <span class="gsbs__age-track">
            <i class="gsbs__age-fill" :style="{ width: `${(q.days / quietPeak) * 100}%`, '--n': n }" />
          </span>
          <span class="gsbs__key-count">{{ shortAge(q.days) }}</span>
        </button>
      </div>
      <p class="gsbs__sub">
        <template v-if="stale">
          <b>{{ stale }}</b> {{ stale === 1 ? "has" : "have" }} had no commit in {{ STALE_DAYS }} days.
        </template>
        <template v-else>Every branch has moved this month.</template>
      </p>
    </div>

    <div v-if="kinds.length > 1" class="gsbs__block" style="--i: 3">
      <div class="gsbs__label">
        <span class="gsbs__label-name">Kinds of work</span>
      </div>
      <div class="gsbs__waiting">
        <button
          v-for="(k, n) in kinds"
          :key="k.kind"
          type="button"
          class="gsbs__wait"
          :class="{ 'gsbs__wait--on': kindFilter === k.kind, 'gsbs__wait--dim': kindFilter && kindFilter !== k.kind }"
          :style="{ '--n': n }"
          :aria-pressed="kindFilter === k.kind"
          @click="emit('pickKind', k.kind)"
        >
          <span class="gsbs__wait-name">{{ k.kind }}/</span>
          <span class="gsbs__wait-track">
            <i class="gsbs__wait-fill" :style="{ width: `${(k.count / kindPeak) * 100}%` }" />
          </span>
          <span class="gsbs__key-count">{{ k.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="merged.length" class="gsbs__block" style="--i: 4">
      <div class="gsbs__label">
        <span class="gsbs__label-name">Already in {{ defaultName }}</span>
        <span class="gsbs__label-count">{{ merged.length }}</span>
      </div>
      <p class="gsbs__sub gsbs__sub--top">
        Everything on {{ merged.length === 1 ? "this branch" : "these branches" }} is in {{ defaultName }},
        so {{ merged.length === 1 ? "it" : "they" }} can go without losing work.
      </p>
      <ul class="gsbs__merged">
        <li v-for="b in merged.slice(0, 4)" :key="b.name">{{ b.name }}</li>
        <li v-if="merged.length > 4" class="gsbs__merged-more">and {{ merged.length - 4 }} more</li>
      </ul>
      <HoldToConfirm
        class="gsbs__clear"
        :disabled="busy"
        :aria-label="`Hold to delete ${plural(merged.length, 'merged branch')}`"
        title="Hold to delete"
        @confirm="emit('clearMerged', merged.map((b) => b.name))"
      >
        Delete {{ merged.length === 1 ? "it" : `all ${merged.length}` }}
      </HoldToConfirm>
    </div>
  </aside>
</template>

<style scoped>
/* The side column holds still while the list scrolls past it. */
.gsbs {
  position: sticky;
  top: 6rem;
  display: flex;
  flex-direction: column;
  gap: 36px;
  min-width: 0;
}
/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsbs__block {
  animation: gsbs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
@keyframes gsbs-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes gsbs-grow {
  from {
    transform: scaleX(0);
  }
}
/* ── labels ───────────────────────────────────────────────────────────────── */
.gsbs__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.gsbs__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsbs__label-count,
.gsbs__key-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.gsbs__sub {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.gsbs__sub--top {
  margin: 0 0 10px;
}
.gsbs__sub b {
  font-weight: 500;
  color: var(--ink);
}
/* ── search ───────────────────────────────────────────────────────────────── */
.gsbs__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--ink-soft);
  background-color: var(--hover);
  cursor: text;
}
.gsbs__search input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  background: none;
  border: 0;
  outline: none;
}
.gsbs__search input::placeholder {
  color: var(--ink-soft);
  opacity: 0.75;
}
.gsbs__search:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
/* ── the stand ────────────────────────────────────────────────────────────── */
.gsbs__big {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.gsbs__big-num {
  font-family: var(--font-mono);
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.gsbs__big-of {
  font-size: 13px;
  color: var(--ink-soft);
}
.gsbs__stack {
  display: flex;
  gap: 2px;
  height: 10px;
  transform-origin: left center;
  animation: gsbs-grow 640ms var(--gs-ease) backwards;
  animation-delay: 260ms;
}
.gsbs__stack-seg {
  flex-basis: 0;
  min-width: 3px;
  border-radius: 3px;
  transition: opacity var(--gs-t-small) var(--gs-ease);
}
.gsbs__stack-seg--dim {
  opacity: 0.25;
}
/* The two standings with no remote to speak of are drawn, not coloured:
   hatched for never pushed, an outline for a remote that has gone. */
.gsbs__stack-seg--unpushed {
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--ink) 26%, transparent) 0 3px,
    color-mix(in srgb, var(--ink) 8%, transparent) 3px 6px
  );
}
.gsbs__stack-seg--gone {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 34%, transparent);
}
.gsbs__legend {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
}
.gsbs__key,
.gsbs__wait,
.gsbs__age {
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
.gsbs__key:hover,
.gsbs__key--on,
.gsbs__wait:hover,
.gsbs__wait--on,
.gsbs__age:hover {
  background-color: var(--hover);
}
.gsbs__key--dim,
.gsbs__wait--dim {
  opacity: 0.45;
}
.gsbs__key-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.gsbs__key-dot--unpushed {
  border: 1.5px dashed color-mix(in srgb, var(--ink) 45%, transparent);
}
.gsbs__key-dot--gone {
  border: 1.5px solid color-mix(in srgb, var(--ink) 40%, transparent);
}
.gsbs__key-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
}
/* ── bars ─────────────────────────────────────────────────────────────────── */
.gsbs__waiting,
.gsbs__ages {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gsbs__wait-name,
.gsbs__age-name {
  width: 108px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.gsbs__wait-track,
.gsbs__age-track {
  flex: 1 1 auto;
  height: 6px;
}
.gsbs__wait-fill,
.gsbs__age-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: left center;
  animation: gsbs-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(300ms + var(--n, 0) * 60ms);
}
/* Past a month, the bar takes the warning hue; the sentence under the bars
   says the same in words. */
.gsbs__age--stale .gsbs__age-fill {
  background-color: color-mix(in srgb, var(--warn) 70%, transparent);
}
/* ── cleanup ──────────────────────────────────────────────────────────────── */
.gsbs__merged {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.gsbs__merged li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gsbs__merged-more {
  font-family: var(--font-sans);
  font-size: 12px;
}
.gsbs__key:focus-visible,
.gsbs__wait:focus-visible,
.gsbs__age:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (max-width: 1180px) {
  .gsbs {
    position: static;
    order: -1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .gsbs__block,
  .gsbs__stack,
  .gsbs__wait-fill,
  .gsbs__age-fill {
    animation: none;
  }
}
</style>
