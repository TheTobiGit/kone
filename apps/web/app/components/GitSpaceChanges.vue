<script setup lang="ts">
import { computed } from "vue";
import type { GitChange } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { useProjectGit } from "~/composables/useProjectGit";

// The working tree, as two lists.
//
// Staged sits above not-staged because that's the order the work happens in and
// because the commit box at the foot acts on the top list. Rows are quiet by
// default — a path, a letter, a diffstat — and only reveal their actions when
// you're actually pointed at them, so a list of forty files reads as a list and
// not as eighty buttons.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  git: ReturnType<typeof useProjectGit>;
}>();

const emit = defineEmits<{ openFile: [path: string, rect: DOMRect | null] }>();

const { cue } = useSound();

const staged = computed(() => props.git.changes.value.filter((c) => c.staged));
const unstaged = computed(() => props.git.changes.value.filter((c) => !c.staged));
const conflicts = computed(() => new Set(props.space.state.value.conflicts));

const canPush = computed(() => props.space.origin.value !== null);

// One letter per status, in git's own alphabet — familiar, and it costs a column
// instead of a word.
const LETTER = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  untracked: "U",
  ignored: "I",
  conflicted: "!",
} satisfies Record<GitChange["status"], string>;

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}
function nameOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function open(e: Event, path: string) {
  const el = (e.currentTarget as HTMLElement).closest(".gsc__row");
  emit("openFile", path, el ? el.getBoundingClientRect() : null);
}

function stage(path: string) {
  cue("toggle");
  props.git.stagePaths([path]);
}
function unstage(path: string) {
  cue("toggle");
  props.git.unstagePaths([path]);
}
function discard(path: string) {
  props.git.discardPaths([path]);
}
function stageAll() {
  cue("toggle");
  props.git.stageAll();
}
function unstageAll() {
  cue("toggle");
  props.git.unstageAll();
}
function stashAll() {
  cue("press");
  void props.space.stash({ includeUntracked: true });
}
</script>

<template>
  <section class="gsc">
    <!-- Nothing renders until the first status has landed: a clean-tree line
         that flashes before the real files arrive is a small lie. -->
    <template v-if="git.loaded.value">
      <p v-if="git.clean.value" class="gsc__empty">
        Working tree clean.
        <span class="gsc__empty-sub">Nothing to commit.</span>
      </p>

      <template v-else>
        <p class="gsc__summary" :style="{ '--i': 0 }">
          <span>{{ git.fileCount.value }} files</span>
          <span class="gsc__sum-add">+{{ git.added.value }}</span>
          <span class="gsc__sum-del">−{{ git.removed.value }}</span>
        </p>

        <div v-if="staged.length" class="gsc__lane" :style="{ '--lane': 0 }">
          <header class="gsc__lanehead">
            <span class="gsc__eyebrow">Staged</span>
            <span class="gsc__lanecount">{{ staged.length }}</span>
            <span class="gsc__lanefill" />
            <button type="button" class="gsc__sweep" @click="unstageAll">
              Unstage all
            </button>
          </header>

          <div
            v-for="(c, i) in staged"
            :key="c.path"
            class="gsc__row"
            :class="{ 'gsc__row--conflict': conflicts.has(c.path) }"
            :style="{ '--i': i }"
          >
            <button
              type="button"
              class="gsc__open"
              :title="c.path"
              @click="open($event, c.path)"
            >
              <FileIcon :path="c.path" :size="15" />
              <span class="gsc__path">
                <span class="gsc__dir">{{ dirOf(c.path) }}</span>{{ nameOf(c.path) }}
              </span>
              <span v-if="c.from" class="gsc__from">from {{ nameOf(c.from) }}</span>
            </button>

            <span class="gsc__stat" :class="`gsc__stat--${c.status}`">
              {{ LETTER[c.status] }}
            </span>
            <span class="gsc__nums">
              <span v-if="c.added" class="gsc__add">+{{ c.added }}</span>
              <span v-if="c.removed" class="gsc__del">−{{ c.removed }}</span>
            </span>

            <div class="gsc__actions">
              <button type="button" class="gsc__act" @click="unstage(c.path)">
                Unstage
              </button>
            </div>
          </div>
        </div>

        <div v-if="unstaged.length" class="gsc__lane" :style="{ '--lane': 1 }">
          <header class="gsc__lanehead">
            <span class="gsc__eyebrow">Not staged</span>
            <span class="gsc__lanecount">{{ unstaged.length }}</span>
            <span class="gsc__lanefill" />
            <button
              type="button"
              class="gsc__sweep"
              :disabled="space.op.value !== null"
              @click="stashAll"
            >
              Stash all
            </button>
            <button type="button" class="gsc__sweep" @click="stageAll">
              Stage all
            </button>
          </header>

          <div
            v-for="(c, i) in unstaged"
            :key="c.path"
            class="gsc__row"
            :class="{ 'gsc__row--conflict': conflicts.has(c.path) }"
            :style="{ '--i': i }"
          >
            <button
              type="button"
              class="gsc__open"
              :title="c.path"
              @click="open($event, c.path)"
            >
              <FileIcon :path="c.path" :size="15" />
              <span class="gsc__path">
                <span class="gsc__dir">{{ dirOf(c.path) }}</span>{{ nameOf(c.path) }}
              </span>
              <span v-if="conflicts.has(c.path)" class="gsc__flag">conflict</span>
            </button>

            <span class="gsc__stat" :class="`gsc__stat--${c.status}`">
              {{ LETTER[c.status] }}
            </span>
            <span class="gsc__nums">
              <span v-if="c.added" class="gsc__add">+{{ c.added }}</span>
              <span v-if="c.removed" class="gsc__del">−{{ c.removed }}</span>
            </span>

            <div class="gsc__actions">
              <!-- Discarding is the one irreversible thing on this page, so it
                   takes a deliberate hold rather than a click. -->
              <HoldToConfirm
                :aria-label="`Hold to discard changes in ${nameOf(c.path)}`"
                title="Hold to discard"
                @confirm="discard(c.path)"
              >
                Discard
              </HoldToConfirm>
              <button type="button" class="gsc__act" @click="stage(c.path)">
                Stage
              </button>
            </div>
          </div>
        </div>

        <GitSpaceCommitBox
          :space="space"
          :staged-count="staged.length"
          :can-push="canPush"
        />
      </template>
    </template>
  </section>
</template>

<style scoped>
.gsc {
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}

.gsc__empty {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.gsc__empty-sub {
  color: var(--muted);
}

/* One quiet summary line above the lanes — count and totals only, so the
   diffstat the masthead used to recite still has a home here. It joins the
   row cascade as the --i: 0 item. */
.gsc__summary {
  /* Flex with a gap, not inline text: the separator below is drawn on the
     *following* span, so its left-hand space has to come from the row rather
     than from collapsed markup whitespace — otherwise the first dot glues to
     the word before it and the spacing walks. */
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-inline: 8px;
  margin-bottom: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  animation: gsc-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) + var(--lane, 0) * var(--gs-stagger));
}
/* Drawn separators, so they can't be selected or wrap onto their own line. */
.gsc__summary > span + span::before {
  content: "·";
  margin-right: 10px;
  opacity: 0.5;
}
.gsc__sum-add {
  color: var(--diff-add);
}
.gsc__sum-del {
  color: var(--diff-del);
}

.gsc__lane + .gsc__lane {
  margin-top: 26px;
}

.gsc__lanehead {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  margin-bottom: 6px;
  padding-inline: 8px;
}
.gsc__eyebrow {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}
.gsc__lanecount {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.65;
}
.gsc__lanefill {
  flex: 1 1 auto;
}
/* Lane sweeps stay hidden until the lane is under the pointer — the counts are
   the information; the actions are only wanted once you've decided. */
.gsc__sweep {
  padding: 3px 6px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsc__lane:hover .gsc__sweep,
.gsc__lane:focus-within .gsc__sweep {
  opacity: 1;
}
.gsc__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.gsc__sweep:disabled {
  opacity: 0.35;
  cursor: default;
}
.gsc__sweep:focus-visible {
  opacity: 1;
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── row ──────────────────────────────────────────────────────────────────── */
.gsc__row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding-inline: 8px;
  border-radius: 8px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
  animation: gsc-in var(--gs-t-enter) var(--gs-ease) backwards;
  /* Rows arrive in a short cascade, capped so a big list doesn't crawl. */
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) + var(--lane, 0) * var(--gs-stagger));
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
.gsc__row:hover,
.gsc__row:focus-within {
  background-color: var(--hover);
}
.gsc__row--conflict .gsc__path {
  color: var(--diff-del);
}

.gsc__open {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  text-align: left;
  cursor: pointer;
}
.gsc__open:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
  border-radius: 6px;
}
.gsc__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1;
  color: var(--ink);
}
/* The directory recedes so the filename is what the eye lands on. */
.gsc__dir {
  color: var(--muted);
}
.gsc__from,
.gsc__flag {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}
.gsc__flag {
  color: var(--diff-del);
}

.gsc__stat {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
}
.gsc__stat--added,
.gsc__stat--untracked {
  color: var(--diff-add);
}
.gsc__stat--deleted,
.gsc__stat--conflicted {
  color: var(--diff-del);
}

.gsc__nums {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  /* Fixed so the numbers line up down the list even when one side is missing. */
  min-width: 84px;
  justify-content: flex-end;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.gsc__add {
  color: var(--diff-add);
}
.gsc__del {
  color: var(--diff-del);
}

/* Actions occupy their space always, so revealing them never shifts a row. */
.gsc__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  flex-shrink: 0;
  min-width: 128px;
  opacity: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsc__row:hover .gsc__actions,
.gsc__row:focus-within .gsc__actions {
  opacity: 1;
}
.gsc__act {
  padding: 3px 6px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsc__act:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.gsc__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .gsc__row {
    animation: none;
    transition: none;
  }
  .gsc__summary {
    animation: none;
  }
  .gsc__sweep,
  .gsc__actions,
  .gsc__act {
    transition: none;
  }
}
</style>
