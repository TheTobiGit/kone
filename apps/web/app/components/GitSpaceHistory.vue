<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { useGitSpace } from "~/composables/useGitSpace";

// The branch, as a line you can read down.
//
// A single hairline runs through the gutter with a dot at every commit — enough
// of a graph to feel like history without pretending to draw a full DAG (which
// at this width is a decoration, not information). The list pages itself as you
// reach the bottom rather than making you ask.
//
// A commit opens two ways, and the difference is whether you're still scanning.
// Clicking the row unfolds it here, under the dot, so the timeline above and
// below stays put — that's for reading down the branch, checking as you go. The
// revealed "Open" leaves for the commit's own page, which introduces it properly
// and has room for every file. One is a glance, the other is a destination.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const emit = defineEmits<{ open: [hash: string] }>();

const { cue } = useSound();

const openHash = ref<string | null>(null);
const sentinel = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;

// Only the first page gets the staggered cascade; rows a later page appends must
// not re-run it, so the boundary is the list length right after the first load.
const firstBatchSize = ref<number | null>(
  props.space.commits.value.length > 0 ? props.space.commits.value.length : null,
);
function isPaged(i: number) {
  return firstBatchSize.value !== null && i >= firstBatchSize.value;
}
watch(
  () => props.space.commits.value.length,
  (len) => {
    if (len === 0) firstBatchSize.value = null;
    else if (firstBatchSize.value === null) firstBatchSize.value = len;
  },
);

function toggle(hash: string) {
  cue("toggle");
  openHash.value = openHash.value === hash ? null : hash;
}

// Auto-page: the foot of the list coming into view is the request.
function observe() {
  io?.disconnect();
  if (!sentinel.value || props.space.commitsDone.value) return;
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void props.space.loadCommits();
    },
    { rootMargin: "240px" },
  );
  io.observe(sentinel.value);
}

watch(sentinel, observe);
watch(() => props.space.commitsDone.value, observe);
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <section class="gsh">
    <template v-if="space.commits.value.length">
      <div
        v-for="(c, i) in space.commits.value"
        :key="c.hash"
        class="gsh__item"
        :class="{ 'gsh__item--paged': isPaged(i) }"
        :style="{ '--i': i }"
      >
        <div class="gsh__row" :class="{ 'gsh__row--on': openHash === c.hash }">
          <button
            type="button"
            class="gsh__rowmain"
            :aria-expanded="openHash === c.hash"
            @click="toggle(c.hash)"
          >
            <span class="gsh__rail" aria-hidden="true">
              <i class="gsh__dot" />
            </span>
            <span class="gsh__subject">{{ c.subject }}</span>
            <span class="gsh__author">{{ c.author }}</span>
            <span class="gsh__when">{{ c.relative }}</span>
            <span class="gsh__short">{{ c.short }}</span>
          </button>

          <button
            type="button"
            class="gsh__open"
            :title="`Open ${c.short}`"
            @click="emit('open', c.hash)"
          >
            Open
          </button>
        </div>

        <div v-if="openHash === c.hash" class="gsh__detail">
          <GitSpaceCommitDetail :space="space" :hash="c.hash" />
        </div>
      </div>

      <div ref="sentinel" class="gsh__foot">
        <span v-if="!space.commitsDone.value" class="gsh__more">Loading more…</span>
        <span v-else class="gsh__more">
          {{ space.commits.value.length }} commits · start of history
        </span>
      </div>
    </template>

    <!-- Only ever shown once a read has finished and genuinely found nothing. -->
    <p v-else-if="space.commitsDone.value" class="gsh__empty">
      No commits yet.
      <span class="gsh__empty-sub">The first one will show up here.</span>
    </p>
  </section>
</template>

<style scoped>
.gsh {
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}

.gsh__item {
  animation: gsh-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
@keyframes gsh-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* Rows a later page appends fade in flat — no cascade, no translate, no stagger. */
.gsh__item--paged {
  animation: gsh-fade var(--gs-t-small) var(--gs-ease) backwards;
  animation-delay: 0;
}
@keyframes gsh-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* The row is the tinted surface; the two things inside it are the targets. The
   tint belongs to the row so a hover anywhere on it reads as one object. */
.gsh__row {
  display: flex;
  align-items: center;
  width: 100%;
  height: 32px;
  padding-right: 8px;
  border-radius: 8px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsh__row:hover,
.gsh__row:focus-within,
.gsh__row--on {
  background-color: var(--hover);
}
.gsh__rowmain {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  text-align: left;
  cursor: pointer;
}
.gsh__rowmain:focus-visible,
.gsh__open:focus-visible {
  outline: none;
  border-radius: 6px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* Revealed on hover, like every other row action in the space. It holds its
   width when hidden so the hash column above it never shifts sideways. */
.gsh__open {
  flex-shrink: 0;
  min-width: 46px;
  padding-left: 10px;
  text-align: right;
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsh__row:hover .gsh__open,
.gsh__row:focus-within .gsh__open {
  opacity: 1;
}
.gsh__open:hover {
  color: var(--ink);
}

/* The spine: a hairline the full height of the row so consecutive rows join up,
   with the commit's dot sitting on it. */
.gsh__rail {
  position: relative;
  flex-shrink: 0;
  width: 22px;
  height: 32px;
}
.gsh__rail::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-0.5px);
  background-color: color-mix(in srgb, var(--ink) 11%, transparent);
}
.gsh__dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background-color: var(--muted);
  /* A ring of page colour so the hairline appears to pass behind the dot. */
  box-shadow: 0 0 0 3px var(--ground);
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    transform var(--gs-t-small) var(--gs-ease-move);
}
.gsh__row:hover .gsh__dot {
  background-color: var(--ink-soft);
}
.gsh__row--on .gsh__dot {
  background-color: var(--accent);
  transform: translate(-50%, -50%) scale(1.35);
}

.gsh__subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--ink);
}
.gsh__author,
.gsh__when,
.gsh__short {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
}
.gsh__author {
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gsh__when {
  min-width: 10ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.gsh__short {
  min-width: 7ch;
  text-align: right;
  opacity: 0.7;
}

/* Detail hangs off the same spine the dots sit on. */
.gsh__detail {
  position: relative;
  margin-left: 22px;
  padding-left: 12px;
}
.gsh__detail::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 10px;
  width: 1px;
  transform: translateX(-0.5px);
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
}

.gsh__foot {
  padding: 14px 0 4px 22px;
}
.gsh__more {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
  opacity: 0.7;
}

.gsh__empty {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.gsh__empty-sub {
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .gsh__item,
  .gsh__item--paged {
    animation: none;
  }
  .gsh__row,
  .gsh__open,
  .gsh__dot {
    transition: none;
  }
}
</style>
