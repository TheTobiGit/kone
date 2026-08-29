<script setup lang="ts">
// One view's rows: every thread you have, from every project, in one flat list.
//
// Flat is the point. The launcher's list groups by pin under its own header and
// reads as a place you go to resume something; this one is a queue, and a queue
// with sections in it stops being a queue. So a pin is expressed as position
// plus a mark on the row, not as a division of the list. Ordering is otherwise
// plain recency for now — once threads carry live agent state the sort key
// becomes "when the agent last spoke", which is a different question than "when
// did this thread last change".
//
// A row selects and nothing else: no archiving, no pinning, no menus. Selecting
// is the one gesture the list owns, because it is the only one that is about
// the list rather than about the thread.

import { computed, nextTick, onActivated, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Add01Icon,
  CheckmarkCircle02Icon,
  Folder01Icon,
  GitBranchIcon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { agentIdentity } from "~/utils/agentIdentity";
import { sessionBrand } from "~/utils/modelCatalog";
import { byRecency } from "~/utils/sessionList";
import { timeAgo } from "~/utils/timeAgo";
import type { InboxViewId } from "~/types/inbox";
import type { SessionSummary } from "~/types/session";

const { cue } = useSound();

const props = defineProps<{ view: InboxViewId }>();

const HEADINGS = {
  inbox: "Inbox",
  done: "Done",
  archived: "Archived",
} satisfies Record<InboxViewId, string>;

/** Which thread the reading pane is showing — the row itself, not its id. The
 *  reading pane needs the project the thread lives in before it can be
 *  anything more than a transcript, and the row is already carrying it: passing
 *  the id alone would mean reading the same record back to find out.
 *
 *  Owned by the portal, not by this list — each view has its own list, and a
 *  selection made in one stays on screen after switching to another. */
const selected = defineModel<SessionSummary | null>("selected", { default: null });

const emit = defineEmits<{
  /** Start a conversation. The portal owns what that means — the list has no
   *  project to start one in, and neither does the inbox until it asks. */
  "new-thread": [];
}>();

// Read once at setup rather than watched: the pane mounts one of these per view
// and keeps it alive, so an instance never changes which set it is reading.
//
// Inbox and Done read the same live set and split it here; only the archive is
// a different query, because only the archive is a different set of rows. A
// done thread has not gone anywhere — it is in the same list, not asking.
const source = useAllRecentSessions({ archived: props.view === "archived" });

/** This view's share of a run of rows. The archive shows everything it holds:
 *  being finished with a thread and having put it away are separate decisions,
 *  and the archive is the place you go to see what you put away, whichever. */
function forView(rows: SessionSummary[]): SessionSummary[] {
  if (props.view === "inbox") return rows.filter((s) => !s.done);
  if (props.view === "done") return rows.filter((s) => s.done);
  return rows;
}

// A pin is a claim about what you want to come back to, so it only means
// anything where coming back is the point. In Done it would sort a list you
// have already finished reading — so that view drops the privilege entirely and
// runs on plain recency, and the mark on the row goes with it: it exists to
// explain a position, and there is no position left to explain.
const ranks = computed(() => props.view !== "done");

// Pinned threads lead, each run newest-first. The composable has already split
// them, and both arrive sorted, so this is a concatenation rather than a sort —
// which also means the boundary between the two runs is exact, and the row at
// the top of the unpinned run can draw the line that a section header otherwise
// would.
const pinnedRows = computed(() => (ranks.value ? forView(source.pinned.value) : []));
const threads = computed(() => {
  const rest = forView(source.recent.value);
  if (ranks.value) return [...pinnedRows.value, ...rest];
  return [...forView(source.pinned.value), ...rest].sort(byRecency);
});
const pinnedCount = computed(() => pinnedRows.value.length);

// Two different silences: still counting, and nothing to count. Claiming
// emptiness while the fan-out is still running would be a lie that corrects
// itself a moment later — and an empty archive is a normal, permanent state
// worth wording differently from an empty inbox.
const QUIET = {
  inbox: "Nothing here yet.",
  done: "Nothing marked done.",
  archived: "Nothing archived.",
} satisfies Record<InboxViewId, string>;

const quiet = computed(() => (source.loading.value ? "Gathering threads…" : QUIET[props.view]));

// No visible scrollbar — the thread list smokes its top/bottom edges over whatever
// content runs past the cutoff, easing in over the first ~28px of scroll.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

watch(threads, () => void nextTick(measure));

// Each view keeps its own rows, so a thread you finish with in one is stale in
// the other until something re-reads. Re-reading on the way back in is what
// makes marking done and un-marking read as one movement between two lists
// rather than a row that vanishes from here and has not arrived there yet. The
// first activation is the mount, which has already loaded.
let entered = false;
onActivated(() => {
  if (entered) void source.reload();
  entered = true;
  void nextTick(measure);
});

function select(row: SessionSummary): void {
  if (selected.value?.threadId === row.threadId) return;
  cue("select");
  selected.value = row;
}

function togglePin(row: SessionSummary): void {
  cue("press");
  source.togglePin(row.threadId);
}

function toggleDone(row: SessionSummary): void {
  cue("press");
  source.toggleDone(row.threadId);
}
</script>

<template>
  <div class="tl">
    <!-- Names the list under it, because the rail's mark alone says which tab is
         lit without saying what you are now looking at. -->
    <header class="tl__head">
      <h2 class="tl__heading">{{ HEADINGS[view] }}</h2>
      <button
        type="button"
        class="tl__new"
        aria-label="New chat"
        title="New chat"
        @click="emit('new-thread')"
      >
        <HugeiconsIcon :icon="Add01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
      </button>
    </header>

    <div
      ref="scroller"
      class="tl__scroll"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <ol v-if="threads.length" class="tl__list">
        <li
          v-for="(s, i) in threads"
          :key="s.threadId"
          class="tl__row"
          :class="{
            'tl__row--pinned': s.pinned && ranks,
            'tl__row--resumes': i === pinnedCount && i > 0,
            'tl__row--on': s.threadId === selected?.threadId,
          }"
          :style="{ '--i': i }"
        >
          <!-- Opening the thread is the row's own gesture, so it is one real
               button rather than a clickable <li>: the actions beside it are
               buttons too, and a button inside a button is a control a keyboard
               can see but never reach. -->
          <button
            type="button"
            class="tl__open"
            :aria-current="s.threadId === selected?.threadId ? 'true' : undefined"
            @click="select(s)"
          >
            <span class="tl__lead">
              <AgentFace :seed="s.threadId" :size="32" />
              <span class="tl__badge">
                <ProviderLogo :brand="sessionBrand(s.provider, s.brand, s.model)" :size="16" />
              </span>
            </span>

            <span class="tl__main">
              <span class="tl__title">
                <HugeiconsIcon
                  v-if="s.pinned && ranks"
                  class="tl__pin"
                  :icon="PinIcon"
                  :size="11"
                  :stroke-width="2"
                  aria-label="Pinned"
                />
                <span class="tl__name">{{ s.title }}</span>
              </span>
              <span class="tl__meta">
                <span class="tl__agent">{{ agentIdentity(s.threadId).name }}</span>

                <span v-if="s.projectName" class="tl__chip" :title="s.projectPath">
                  <HugeiconsIcon
                    :icon="Folder01Icon"
                    :size="11"
                    :stroke-width="1.7"
                    aria-hidden="true"
                  />
                  {{ s.projectName }}
                </span>

                <span v-if="s.branch" class="tl__chip" :title="s.branch">
                  <HugeiconsIcon
                    :icon="GitBranchIcon"
                    :size="11"
                    :stroke-width="2"
                    aria-hidden="true"
                  />
                  {{ s.branch }}
                </span>
              </span>
            </span>
          </button>

          <!-- The stamp and the actions share the right edge: the stamp is what
               the row is telling you, the actions are what you can tell it, and
               only one of those is wanted at a time. Swapping in place keeps the
               row from reflowing under the cursor that just arrived. -->
          <div class="tl__tail">
            <span class="tl__when">{{ timeAgo(s.updatedAt) }}</span>
            <div class="tl__acts">
              <button
                v-if="ranks"
                type="button"
                class="tl__act"
                :class="{ 'tl__act--on': s.pinned }"
                :aria-pressed="Boolean(s.pinned)"
                :aria-label="s.pinned ? `Unpin ${s.title}` : `Pin ${s.title}`"
                :title="s.pinned ? 'Unpin' : 'Pin'"
                @click="togglePin(s)"
              >
                <HugeiconsIcon :icon="PinIcon" :size="14" :stroke-width="1.9" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="tl__act"
                :class="{ 'tl__act--on': s.done }"
                :aria-pressed="Boolean(s.done)"
                :aria-label="s.done ? `Mark ${s.title} not done` : `Mark ${s.title} done`"
                :title="s.done ? 'Not done' : 'Done'"
                @click="toggleDone(s)"
              >
                <HugeiconsIcon
                  :icon="CheckmarkCircle02Icon"
                  :size="14"
                  :stroke-width="1.9"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </li>
      </ol>

      <p v-else class="tl__quiet">{{ quiet }}</p>
    </div>
  </div>
</template>

<style scoped>
.tl {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* Pinned above the scroll so the heading and the button stay put while the rows
   move under them. */
.tl__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 14px 10px;
}

.tl__heading {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink-soft);
}

.tl__new {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}
.tl__new:hover {
  color: var(--accent);
  background: var(--accent-wash);
}

.tl__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 8px;
  scrollbar-width: none;
}
.tl__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.tl__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.tl__row {
  display: flex;
  align-items: center;
  padding: 9px 10px;
  border-radius: 12px;
  /* Capped so a long list's last rows are not still arriving after the eye has
     already reached them. */
  animation: tl-row-in 260ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: min(calc(var(--i, 0) * 22ms), 320ms);
}

.tl__open {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  text-align: left;
  background: transparent;
  cursor: pointer;
}
.tl__open:focus-visible {
  outline: none;
}

.tl__lead {
  position: relative;
  flex: none;
  line-height: 0;
}
/* The vendor mark rides the corner of the face rather than taking a column of
   its own — which thread it is and what runs it are one glance, not two. */
.tl__badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: grid;
  place-items: center;
  padding: 2px;
  border-radius: 999px;
  background: var(--panel);
}

.tl__main {
  flex: 1;
  min-width: 0;
}
.tl__title,
.tl__main {
  display: block;
}

.tl__title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.tl__name {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 19px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The mark explains the row's position rather than decorating it, so it leads
   the title instead of trailing the row: by the time the eye reaches the right
   edge it has already wondered why this one is at the top. */
.tl__pin {
  flex: none;
  color: var(--accent);
}

.tl__row--pinned .tl__name {
  color: var(--ink);
}

.tl__row {
  transition: background-color 0.14s ease;
}
.tl__row:hover,
.tl__row:focus-within {
  background: var(--hover);
}
.tl__row--on,
.tl__row--on:hover {
  background: var(--selected);
}
.tl__row--on .tl__name {
  color: var(--ink);
}

/* Where the pinned run ends. A rule, not a header — the list stays one
   sequence, but the eye is told that the recency clock restarts here rather
   than being left to read the timestamps and work it out. */
.tl__row--resumes {
  margin-top: 9px;
  position: relative;
}
.tl__row--resumes::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 10px;
  right: 10px;
  height: 1px;
  background: var(--line-soft);
}

.tl__meta {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--muted);
  white-space: nowrap;
}
.tl__agent {
  flex: none;
}
.tl__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl__chip svg {
  flex: none;
}

/* One slot, two occupants. The stamp is laid out and the actions are stacked
   over it, so the row's width is decided by the wider of the two once and never
   moves when they swap. */
.tl__tail {
  position: relative;
  flex: none;
  align-self: flex-start;
  display: grid;
  place-items: center end;
  min-width: 62px;
  min-height: 22px;
}

.tl__when {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
  transition: opacity 0.14s ease;
}

.tl__acts {
  position: absolute;
  inset: 0 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.14s ease;
}
.tl__row:hover .tl__acts,
.tl__row:focus-within .tl__acts {
  opacity: 1;
  pointer-events: auto;
}
.tl__row:hover .tl__when,
.tl__row:focus-within .tl__when {
  opacity: 0;
}
.tl__act {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  color: var(--faint);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.14s ease,
    background-color 0.14s ease,
    opacity 0.14s ease;
}
.tl__act:hover {
  color: var(--ink-soft);
  background: var(--selected);
}
.tl__act--on,
.tl__act--on:hover {
  color: var(--accent);
}

.tl__quiet {
  padding: 18px 12px;
  font-size: 12.5px;
  color: var(--muted);
}

@keyframes tl-row-in {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tl__row {
    animation: none;
  }
}
</style>
