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
// The list owns ordering and selection; each row owns what you can tell its
// thread — its buttons, its overflow, and the writes behind them. Selecting is
// the one gesture about the list rather than about the thread, so it stays
// here while everything else lives on the row.

import { computed, nextTick, onActivated, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon } from "@hugeicons/core-free-icons";
import InboxThreadRow from "~/components/inbox/InboxThreadRow.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { byRecency, nextVisitStamp, type VisitStamp } from "~/utils/sessionList";
import { type TurnOrbState } from "~/utils/thinkingOrb";
import { describeTurnActivity } from "~/utils/turnActivity";
import { liveTurns } from "~/composables/useAgent";
import type { InboxViewId } from "~/types/inbox";
import type { SessionSummary } from "~/types/session";

const { cue } = useSound();

const props = defineProps<{
  view: InboxViewId;
  /** The reading pane is showing this list's selected thread right now.
   *
   *  Not derivable here: the portal is never unmounted — it hides with
   *  `visibility` and `inert`, and KeepAlive holds every view's list — so a
   *  selection made before you left is still a selection an hour later. Only the
   *  portal knows whether anyone is actually looking at it. */
  reading: boolean;
}>();

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
  const sel = selected.value;
  const includeSel = Boolean(
    sel &&
      props.view === "inbox" &&
      !source.pinned.value.some((s) => s.threadId === sel.threadId) &&
      !source.recent.value.some((s) => s.threadId === sel.threadId),
  );
  const recentList = includeSel && sel ? [sel, ...rest] : rest;
  if (ranks.value) return [...pinnedRows.value, ...recentList];
  return [...forView(source.pinned.value), ...recentList].sort(byRecency);
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

// Which rows are cooking, and what their orb is doing.
//
// The rows themselves are read off disk and know nothing about processes;
// `liveTurns` is every turn running anywhere in the app, keyed by thread id, so
// a thread mid-turn in a studio column reads as mid-turn here too — this list
// never opens a session of its own to find that out. Built as one map rather
// than resolved per row, so a render walks the running turns once instead of
// once per row, and a row with nothing running costs a miss.
const orbs = computed(() => {
  const out = new Map<string, { state: TurnOrbState; label: string }>();
  for (const [threadId, block] of liveTurns.value) {
    const activity = describeTurnActivity(block);
    if (!activity || activity.orb === "done") continue;
    out.set(threadId, { state: activity.orbState, label: activity.label });
  }
  return out;
});

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
  if (entered) void source.reload(true);
  entered = true;
  void nextTick(measure);
});

function select(row: SessionSummary): void {
  if (selected.value?.threadId === row.threadId) return;
  cue("select");
  selected.value = row;
}

function clearSelection(threadId: string): void {
  if (selected.value?.threadId === threadId) selected.value = null;
}

// Reading a thread is what marks it read — and it keeps marking it, for as long
// as it is the one on screen. The check below owns which row is the stamp
// target and whether the thread is actually in front of someone; the latch it
// compares against lives here, one entry per list, so a reload echo never
// becomes a second write and nothing leaks across views. The write is this
// list's own markVisited, so the row clears under the eye first and the bridge
// write lands behind it.
//
// Watching the rows rather than only the selection is what keeps the stamp
// live: the reload behind a landed turn re-summarizes every row from the
// record, so a reply arriving under the open thread comes back unread and the
// same check takes the mark straight back off.
//
// `reading` is what keeps that from running in the dark. A selection outlives
// the visit that made it — the portal only hides, the list stays alive behind
// it, and a composer takes the reading pane without clearing what was picked —
// so without this gate a reply landing while you are somewhere else entirely is
// marked read by a list nobody can see, and the mark it should have raised is
// gone for good.
const lastStamp = ref<VisitStamp | null>(null);
watch(
  [selected, threads, () => props.reading],
  () => {
    const transition = nextVisitStamp(lastStamp.value, {
      reading: props.reading,
      selectedThreadId: selected.value?.threadId,
      rows: threads.value,
    });
    lastStamp.value = transition.next;
    if (transition.toStamp) source.markVisited(transition.toStamp.threadId, Date.now());
  },
  { immediate: true },
);

// The portal re-reads the current view when it comes forward — the list
// behind it may have been filled at boot, before the retention sweep ran or
// while its events landed with nobody watching. Only the shown view reloads;
// the kept-alive others re-read on their own activation. Silent: an open
// never flashes loading.
defineExpose({ reload: (silent = false) => source.reload(silent) });
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
        <InboxThreadRow
          v-for="(s, i) in threads"
          :key="s.threadId"
          :thread="s"
          :view="view"
          :selected="s.threadId === selected?.threadId"
          :ranks="ranks"
          :orb="orbs.get(s.threadId)"
          :index="i"
          :resumes="i === pinnedCount && i > 0"
          @select="select"
          @clear="clearSelection"
        />
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
    color 140ms ease,
    background-color 200ms cubic-bezier(0.33, 1, 0.68, 1);
}
.tl__new:hover {
  color: var(--accent);
  background: var(--accent-wash);
  transition-duration: 90ms;
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

.tl__quiet {
  padding: 18px 12px;
  font-size: 12.5px;
  color: var(--muted);
}
</style>
