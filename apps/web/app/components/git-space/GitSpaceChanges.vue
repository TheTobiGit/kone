<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon } from "@hugeicons/core-free-icons";
import type { GitChange, GitFileStatus } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { useProjectGit } from "~/composables/useProjectGit";
import HoldToConfirm from "~/components/ui/HoldToConfirm.vue";
import {
  areaOf,
  dirOf,
  changeKindOf,
  nameOf,
  sideOf,
  type ChangeSide,
} from "~/utils/changeLanguage";

// The working tree, as work in three states.
//
// Staged files sit first because that's the order a commit happens in: the box
// at the foot takes the top list. A file with work on both sides of the index
// is its own state, not counted as staged and not hidden from unstaged — it
// gets its own row and its own "Stage rest" move. Every other file is one row,
// drawn the way the rest of the space draws a row — a mark, what it is, the
// work it carries — and opens in the same card a change opens anywhere else.
// The side column reads the whole tree at once: how much is staged, what kinds
// of change there are, where they live and which files are carrying the most
// work, each drawing doubling as a filter.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  git: ReturnType<typeof useProjectGit>;
}>();

const emit = defineEmits<{ openFile: [path: string, rect: DOMRect | null] }>();

const { cue } = useSound();

const changes = computed(() => props.git.changes.value);
const staged = computed(() => changes.value.filter((c) => sideOf(c) === "staged"));
const partly = computed(() => changes.value.filter((c) => sideOf(c) === "partly"));
const unstaged = computed(() => changes.value.filter((c) => sideOf(c) === "unstaged"));
/** Every file the commit box would take: fully and partly staged alike. */
const stagedWorkCount = computed(() => staged.value.length + partly.value.length);
const conflicts = computed(() => new Set(props.space.state.value.conflicts));
const canPush = computed(() => props.space.origin.value !== null);
const busy = computed(() => props.space.op.value !== null);

// The commit box stays stuck to the foot, so a row focused near the bottom has
// to scroll clear of it rather than land behind it (WCAG 2.4.11). Its height
// moves as the message grows, so it's measured, not guessed.
const commitBox = ref<ComponentPublicInstance | null>(null);
const footHeight = ref(0);
useResizeObserver(commitBox, (entries) => {
  footHeight.value = entries[0]?.contentRect.height ?? 0;
});

// ── filters ──────────────────────────────────────────────────────────────────

const query = ref("");
const kindFilter = ref<GitFileStatus | null>(null);
const areaFilter = ref<string | null>(null);
const stageFilter = ref<ChangeSide | null>(null);
const filtering = computed(
  () => !!query.value.trim() || !!kindFilter.value || !!areaFilter.value || !!stageFilter.value,
);

function pickKind(id: GitFileStatus) {
  cue("press");
  kindFilter.value = kindFilter.value === id ? null : id;
}
function pickArea(area: string) {
  cue("press");
  areaFilter.value = areaFilter.value === area ? null : area;
}
function pickStage(side: ChangeSide) {
  cue("press");
  stageFilter.value = stageFilter.value === side ? null : side;
}
function clearFilters() {
  cue("press");
  query.value = "";
  kindFilter.value = null;
  areaFilter.value = null;
  stageFilter.value = null;
}

/** Everything but the stage filter, which belongs to the groups themselves. */
function shown(c: GitChange): boolean {
  const q = query.value.trim().toLowerCase();
  if (q && !c.path.toLowerCase().includes(q) && !(c.from ?? "").toLowerCase().includes(q)) return false;
  if (kindFilter.value && c.status !== kindFilter.value) return false;
  if (areaFilter.value && areaOf(c.path) !== areaFilter.value) return false;
  return true;
}

function inStage(role: ChangeSide): boolean {
  return !stageFilter.value || stageFilter.value === role;
}

const stagedShown = computed(() => (inStage("staged") ? staged.value.filter(shown) : []));
const partlyShown = computed(() => (inStage("partly") ? partly.value.filter(shown) : []));
const unstagedShown = computed(() => (inStage("unstaged") ? unstaged.value.filter(shown) : []));
const shownCount = computed(
  () => stagedShown.value.length + partlyShown.value.length + unstagedShown.value.length,
);

/** The groups in commit order, each only while it has rows to show. */
const groups = computed(() =>
  [
    { side: "staged" as const, label: "Staged", rows: stagedShown.value },
    { side: "partly" as const, label: "Partly staged", rows: partlyShown.value },
    { side: "unstaged" as const, label: "Not staged", rows: unstagedShown.value },
  ].filter((g) => g.rows.length),
);

// ── a row ────────────────────────────────────────────────────────────────────

function open(e: Event, path: string) {
  // SAFETY: the handler is bound on the row's own button, so currentTarget is
  // that element and its row is the card's grow origin.
  const el = (e.currentTarget as HTMLElement).closest(".gsc__row");
  emit("openFile", path, el ? el.getBoundingClientRect() : null);
}
function openFromSide(change: GitChange, origin: DOMRect | null) {
  emit("openFile", change.path, origin);
}

function stage(path: string) {
  cue("toggle");
  props.git.stagePaths([path]);
}
function unstage(path: string) {
  cue("toggle", { off: true });
  props.git.unstagePaths([path]);
}
// Behind a hold-to-confirm; the hold finishing is the commit.
function discard(path: string) {
  cue("discard");
  props.git.discardPaths([path]);
}
// The bulk actions act on the rows the group is showing, so a filter can't
// quietly stage or unstage files the user can't see.
function stageShown(rows: GitChange[]) {
  if (!rows.length) return;
  cue("toggle");
  props.git.stagePaths(rows.map((c) => c.path));
}
function unstageAll() {
  if (!stagedShown.value.length) return;
  cue("toggle", { off: true });
  props.git.unstagePaths(stagedShown.value.map((c) => c.path));
}
function stashAll() {
  if (filtering.value) return;
  cue("press");
  void props.space.stash({ includeUntracked: true });
}
</script>

<template>
  <section class="gsc" :style="{ '--gsc-foot': `${footHeight}px` }">
    <!-- A placeholder is only honest while the first status is still on its way;
         once it lands, a clean tree is a fact and gets a sentence. -->
    <div v-if="!git.loaded.value" class="gsc__span">
      <GitSpaceSkeleton :rows="7" />
    </div>

    <p v-else-if="git.clean.value" class="gsc__empty">
      Working tree clean.
      <span class="gsc__empty-sub">Nothing to commit.</span>
    </p>

    <template v-else>
      <!-- ══ the main column: the list ═════════════════════════════════════ -->
      <div class="gsc__main">
        <header class="gsc__head">
          <span class="gsc__headcount">
            <b>{{ changes.length }}</b> changed
          </span>
          <span class="gsc__headstat">
            <span class="gsc__add">+{{ git.added.value }}</span>
            <span class="gsc__del">−{{ git.removed.value }}</span>
          </span>
          <button v-if="filtering" type="button" class="gsc__clear" @click="clearFilters">
            {{ shownCount }} of {{ changes.length }} · clear
          </button>
          <span class="gsc__fill" />
          <!-- Stashing takes the whole tree, staged and not, so it sits with the
               tree's own count rather than under one group. It can't follow a
               filter, so while one is on it waits rather than reach past it. -->
          <button
            type="button"
            class="gsc__sweep"
            :disabled="busy || filtering"
            :title="filtering ? 'Clear the filter to stash every change' : 'Set every change aside, staged or not, without committing it'"
            @click="stashAll"
          >
            <HugeiconsIcon :icon="Archive02Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
            Stash all
          </button>
        </header>

        <div
          v-for="(g, gi) in groups"
          :key="g.side"
          class="gsc__group"
          :style="{ '--i': gi }"
        >
          <div class="gsc__label">
            <span class="gsc__label-name">{{ g.label }}</span>
            <span class="gsc__label-count">{{ g.rows.length }}</span>
            <span class="gsc__fill" />
            <button v-if="g.side === 'staged'" type="button" class="gsc__sweep" @click="unstageAll">
              Unstage all
            </button>
            <button v-else type="button" class="gsc__sweep" @click="stageShown(g.rows)">Stage all</button>
          </div>

          <div
            v-for="(c, i) in g.rows"
            :key="`${g.side}:${c.path}`"
            class="gsc__row"
            :style="{ '--n': i }"
          >
            <button
              type="button"
              class="gsc__rowmain"
              :title="c.path"
              aria-haspopup="dialog"
              @click="open($event, c.path)"
            >
              <span class="gsc__mark" :style="{ background: changeKindOf(c.status).color }" aria-hidden="true" />
              <span class="gsc__body">
                <span class="gsc__path">
                  <span class="gsc__dir">{{ dirOf(c.path) }}</span>{{ nameOf(c.path) }}
                </span>
                <span class="gsc__meta">
                  <span class="gsc__kind">{{ changeKindOf(c.status).label }}</span>
                  <span v-if="c.from" class="gsc__from">from {{ nameOf(c.from) }}</span>
                  <span v-if="conflicts.has(c.path)" class="gsc__flag">conflict</span>
                </span>
              </span>
              <span class="gsc__right">
                <span class="gsc__nums">
                  <span v-if="c.added" class="gsc__add">+{{ c.added }}</span>
                  <span v-if="c.removed" class="gsc__del">−{{ c.removed }}</span>
                </span>
              </span>
            </button>

            <div class="gsc__actions">
              <!-- Discarding is the one irreversible thing on this page, so it
                   takes a deliberate hold rather than a click. -->
              <HoldToConfirm
                v-if="g.side === 'unstaged'"
                :disabled="busy"
                :aria-label="`Hold to discard changes in ${nameOf(c.path)}`"
                title="Hold to discard"
                @confirm="discard(c.path)"
              >
                Discard
              </HoldToConfirm>
              <button v-if="g.side !== 'unstaged'" type="button" class="gsc__act" @click="unstage(c.path)">
                Unstage
              </button>
              <button v-if="g.side !== 'staged'" type="button" class="gsc__act" @click="stage(c.path)">
                {{ g.side === "partly" ? "Stage rest" : "Stage" }}
              </button>
            </div>
          </div>
        </div>

        <p v-if="filtering && !shownCount" class="gsc__none">
          Nothing matches.
          <button type="button" class="gsc__link" @click="clearFilters">Show every change</button>
        </p>

        <GitSpaceCommitBox ref="commitBox" :space="space" :staged-count="stagedWorkCount" :can-push="canPush" />
      </div>

      <!-- ══ the side column: the tree at a glance ═════════════════════════ -->
      <GitSpaceChangesSide
        v-model:query="query"
        :changes="changes"
        :kind-filter="kindFilter"
        :area-filter="areaFilter"
        :stage-filter="stageFilter"
        @pick-kind="pickKind"
        @pick-area="pickArea"
        @pick-stage="pickStage"
        @open="openFromSide"
      />
    </template>
  </section>
</template>

<style scoped>
.gsc {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  align-items: start;
  padding-bottom: 12px;
}
.gsc__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.gsc__fill {
  flex: 1 1 auto;
}
.gsc__span,
.gsc__empty {
  grid-column: 1 / -1;
}
.gsc__empty {
  max-width: 56ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.gsc__empty-sub {
  color: var(--muted);
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsc__head {
  animation: gsc-in var(--gs-t-enter) var(--gs-ease) backwards;
}
.gsc__group {
  animation: gsc-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
.gsc__row {
  animation: gsc-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3 + min(var(--n, 0), 7) * var(--gs-stagger));
}
@keyframes gsc-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.gsc__head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  margin-bottom: 26px;
}
.gsc__headcount {
  font-size: 12.5px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.gsc__headcount b {
  font-weight: 500;
  color: var(--ink);
}
.gsc__headstat {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.gsc__add {
  color: var(--diff-add);
}
.gsc__del {
  color: var(--diff-del);
}
.gsc__clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 7px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  background-color: var(--hover);
  cursor: pointer;
}
.gsc__clear:hover {
  color: var(--ink);
}
.gsc__sweep {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsc__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gsc__sweep:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── labels ───────────────────────────────────────────────────────────────── */
.gsc__label {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin-bottom: 8px;
}
.gsc__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsc__label-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.gsc__group + .gsc__group {
  margin-top: 30px;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
.gsc__row {
  position: relative;
  /* The box's height plus the fade above it. */
  scroll-margin-bottom: calc(var(--gsc-foot, 0px) + 40px);
  display: flex;
  align-items: center;
  margin-inline: -10px;
  border-radius: 10px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsc__row:hover,
.gsc__row:focus-within {
  background-color: var(--hover);
}
.gsc__rowmain {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px;
  text-align: left;
  cursor: pointer;
}
.gsc__rowmain:focus-visible {
  outline: none;
  border-radius: 10px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* The same dot the side column's legends are made of: what kind of change a
   row is, before you read its label. */
.gsc__mark {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.gsc__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
}
.gsc__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--ink);
}
/* The directory recedes so the filename is what the eye lands on, but stays at
   a readable contrast rather than the muted grey it used to sit at. */
.gsc__dir {
  color: var(--ink-soft);
}
.gsc__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.2;
  color: var(--ink-soft);
  white-space: nowrap;
}
.gsc__kind {
  flex-shrink: 0;
}
.gsc__from,
.gsc__flag {
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
}
.gsc__flag {
  color: var(--warn);
}

.gsc__right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsc__nums {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  /* Fixed so the numbers line up down the list even when one side is missing. */
  min-width: 84px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* Acting on a file takes the right end's place on hover, so revealing an
   action never shifts the row. */
.gsc__actions {
  position: absolute;
  right: 8px;
  top: 50%;
  display: flex;
  align-items: center;
  gap: 2px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsc__row:hover .gsc__actions,
.gsc__row:focus-within .gsc__actions {
  opacity: 1;
  pointer-events: auto;
}
.gsc__row:has(.gsc__actions):hover .gsc__right,
.gsc__row:has(.gsc__actions):focus-within .gsc__right {
  opacity: 0;
}
.gsc__act {
  padding: 4px 9px;
  border-radius: 7px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-soft);
  background-color: var(--sunken);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsc__act:hover {
  color: var(--ink);
}

.gsc__none {
  max-width: 56ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.gsc__link {
  margin-left: 6px;
  color: var(--accent);
  cursor: pointer;
}

.gsc__clear:focus-visible,
.gsc__sweep:focus-visible,
.gsc__act:focus-visible,
.gsc__link:focus-visible {
  outline: none;
  border-radius: 8px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

@media (max-width: 1180px) {
  .gsc {
    grid-template-columns: minmax(0, 1fr);
    gap: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsc__head,
  .gsc__group,
  .gsc__row {
    animation: none;
  }
  .gsc__row,
  .gsc__actions,
  .gsc__right,
  .gsc__act,
  .gsc__sweep {
    transition: none;
  }
}
</style>
