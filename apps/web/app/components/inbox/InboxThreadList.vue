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
  ArchiveRestoreIcon,
  CheckmarkCircle02Icon,
  Folder01Icon,
  GitBranchIcon,
  InboxUnreadIcon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { agentIdentity } from "~/utils/agentIdentity";
import { sessionBrand } from "~/utils/modelCatalog";
import { byRecency, threadToStampVisited } from "~/utils/sessionList";
import { timeAgo } from "~/utils/timeAgo";
import { stateForToolFamily, type TurnOrbState } from "~/utils/thinkingOrb";
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
    const state: TurnOrbState =
      activity.orb === "thinking"
        ? "thinking"
        : activity.orb === "working"
          ? "working"
          : stateForToolFamily(activity.family);
    out.set(threadId, { state, label: activity.label });
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
  if (entered) void source.reload();
  entered = true;
  void nextTick(measure);
});

function select(row: SessionSummary): void {
  if (selected.value?.threadId === row.threadId) return;
  cue("select");
  selected.value = row;
}

// Reading a thread is what marks it read — and it keeps marking it, for as long
// as it is the one on screen. The reload behind a landed turn re-summarizes
// every row from the record, so a reply that arrives while you are looking at
// the thread would otherwise come back unread a beat after you read it. Watching
// the rows rather than only the selection is what closes that: whatever puts a
// mark on the open thread takes it straight back off.
//
// `reading` is what keeps that from running in the dark. A selection outlives
// the visit that made it — the portal only hides, the list stays alive behind
// it, and a composer takes the reading pane without clearing what was picked —
// so without this gate a reply landing while you are somewhere else entirely is
// marked read by a list nobody can see, and the mark it should have raised is
// gone for good.
watch(
  [selected, threads, () => props.reading],
  () => {
    const open = threadToStampVisited({
      reading: props.reading,
      selectedThreadId: selected.value?.threadId,
      rows: threads.value,
    });
    if (open) source.markVisited(open);
  },
  { immediate: true },
);

function togglePin(row: SessionSummary): void {
  cue("press");
  source.togglePin(row.threadId);
}

function toggleDone(row: SessionSummary): void {
  cue("press");
  source.toggleDone(row.threadId);
}

/** Put the mark back on a thread you have read.
 *
 *  Read state is a comparison against when you last looked, so the only way to
 *  say "unread" is to move that visit back behind the thread's last activity —
 *  which also means a thread being shown right now would be re-stamped read the
 *  instant it were marked, so the selection is dropped first. Saying you are not
 *  finished with something and continuing to stare at it are not the same
 *  gesture. */
function markUnread(row: SessionSummary): void {
  cue("press");
  if (selected.value?.threadId === row.threadId) selected.value = null;
  source.markUnread(row.threadId);
}

/** Take a thread back out of the archive. The row leaves this list because the
 *  archive and the live list are disjoint queries — it has not been deleted,
 *  it has gone back to where it came from. */
function restore(row: SessionSummary): void {
  cue("press");
  if (selected.value?.threadId === row.threadId) selected.value = null;
  void source.restore(row.threadId);
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
            'tl__row--unread': s.unread,
          }"
          :style="{ '--i': i }"
        >
          <button
            type="button"
            class="tl__open"
            :aria-current="s.threadId === selected?.threadId ? 'true' : undefined"
            :aria-describedby="s.unread ? `unread-${s.threadId}` : undefined"
            @click="select(s)"
          >
            <span class="tl__lead">
              <AgentFace :seed="s.threadId" :size="32" />
              <span class="tl__badge">
                <ProviderLogo :brand="sessionBrand(s.provider, s.brand, s.model)" :size="16" />
              </span>
            </span>

            <span class="tl__main">
              <span class="tl__header">
                <span class="tl__agent">{{ agentIdentity(s.threadId).name }}</span>
                <span v-if="s.projectName" class="tl__chip tl__chip--subtle" :title="s.projectPath">
                  {{ s.projectName }}
                </span>
                <span v-if="s.branch" class="tl__chip tl__chip--branch" :title="s.branch">
                  <HugeiconsIcon
                    :icon="GitBranchIcon"
                    :size="10"
                    :stroke-width="2"
                    aria-hidden="true"
                  />
                  {{ s.branch }}
                </span>
              </span>

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

              <span v-if="orbs.has(s.threadId) || s.snippet" class="tl__sub">
                <span v-if="orbs.has(s.threadId)" class="tl__active-label">
                  {{ orbs.get(s.threadId)?.label ?? "Working…" }}
                </span>
                <span v-else-if="s.snippet" class="tl__snippet" :title="s.snippet">
                  {{ s.snippet }}
                </span>
              </span>
            </span>
          </button>

          <!-- The stamp and the actions share the right edge: the stamp is what
               the row is telling you, the actions are what you can tell it, and
               only one of those is wanted at a time. Swapping in place keeps the
               row from reflowing under the cursor that just arrived. -->
          <div class="tl__tail">
            <span class="tl__stamp">
              <!-- The thread has spoken since you last looked. A dot rather than
                   a count: there is one thing to catch up on either way, and the
                   number of turns you missed is not the thing you are deciding
                   on. It rides beside the stamp instead of leading the row,
                   because the row already opens on a face — a mark there would
                   be read as being about the agent rather than about the thread.
                   -->
              <span
                v-if="s.unread"
                :id="`unread-${s.threadId}`"
                class="tl__dot"
                role="img"
                aria-label="Unread"
              />

              <!-- A running thread says so where its stamp would be. "Last touched
                   4m ago" is a fact about a thread that has stopped; while one is
                   mid-turn the orb is the truer answer to the same question, and
                   it is the same orb the thread itself is carrying. -->
              <TurnOrb
                v-if="orbs.has(s.threadId)"
                class="tl__orb"
                :state="orbs.get(s.threadId)?.state ?? 'working'"
                :size="18"
                :aria-label="`${s.title}: ${orbs.get(s.threadId)?.label ?? 'Working'}`"
              />
              <span v-else class="tl__when">{{ timeAgo(s.updatedAt) }}</span>
            </span>
            <!-- The archive offers one thing, and it is the way out. Pinning
                 and marking done are claims about a queue this row has left, so
                 repeating them here would be offering to sort a list of things
                 you have already put away. -->
            <div v-if="view === 'archived'" class="tl__acts">
              <button
                type="button"
                class="tl__act"
                :aria-label="`Restore ${s.title}`"
                title="Restore"
                @click="restore(s)"
              >
                <HugeiconsIcon
                  :icon="ArchiveRestoreIcon"
                  :size="14"
                  :stroke-width="1.9"
                  aria-hidden="true"
                />
              </button>
            </div>
            <div v-else class="tl__acts">
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
              <!-- Only on a thread you have read: the mark is what this puts
                   back, and offering to put back one that is already there is a
                   control that does nothing. -->
              <button
                v-if="!s.unread"
                type="button"
                class="tl__act"
                :aria-label="`Mark ${s.title} unread`"
                title="Mark unread"
                @click="markUnread(s)"
              >
                <HugeiconsIcon
                  :icon="InboxUnreadIcon"
                  :size="14"
                  :stroke-width="1.9"
                  aria-hidden="true"
                />
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

.tl__row {
  display: flex;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 12px;
  /* Capped so a long list's last rows are not still arriving after the eye has
     already reached them. */
  animation: tl-row-in 260ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: min(calc(var(--i, 0) * 22ms), 320ms);
}

.tl__open {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: 10px;
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
  margin-top: 2px;
  line-height: 0;
}

.tl__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.5px;
}

.tl__header {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.tl__agent {
  font-family: var(--font-sans);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-soft);
  white-space: nowrap;
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

.tl__title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.tl__name {
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 18px;
  color: var(--ink);
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

.tl__sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  line-height: 15px;
}

.tl__snippet {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl__active-label {
  color: var(--accent);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Quick to light, slow to leave. Arriving under the cursor should feel like
   the row was already there; leaving is not something the eye is following, so
   it can take its time and the list settles instead of flickering as the cursor
   crosses it. */
.tl__row {
  transition: background-color 240ms cubic-bezier(0.33, 1, 0.68, 1);
}
.tl__row:hover,
.tl__row:focus-within {
  background: var(--hover);
  transition-duration: 110ms;
}
.tl__row--on,
.tl__row--on:hover {
  background: var(--selected);
}
.tl__row--on .tl__name {
  color: var(--ink);
}
/* An unread row leans forward: full ink and a heavier stroke. The dot says
   which rows are unread; this is what makes the list *look* like it has unread
   rows in it before you have read a single one of them. */
.tl__row--unread .tl__name {
  color: var(--ink);
  font-weight: 700;
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
  gap: 6px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--muted);
  white-space: nowrap;
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

.tl__chip--subtle {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 4px;
}

.tl__chip--branch {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 4px;
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

/* What the row is telling you, as one group: the unread mark, and either the
   turn's orb or the stamp. The group is what hands the slot over to the actions
   on hover, rather than each part fading on its own clock — whichever is leaving
   clears first and the other follows a beat later. Fading both together leaves a
   moment where the slot is two half-lit things at once, which is the part that
   reads as a flicker. */
.tl__stamp {
  display: flex;
  align-items: center;
  gap: 6px;
  transition:
    opacity 150ms ease,
    transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  transition-delay: 90ms;
}

.tl__when {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

/* The unread mark. Small and solid — it has to survive being the only coloured
   thing in a list of greys without becoming the thing you read first. */
.tl__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}

.tl__acts {
  position: absolute;
  inset: 0 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transform: translateX(5px);
  pointer-events: none;
  transition:
    opacity 150ms ease,
    transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.tl__row:hover .tl__acts,
.tl__row:focus-within .tl__acts {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition-delay: 90ms;
}
.tl__row:hover .tl__stamp,
.tl__row:focus-within .tl__stamp {
  opacity: 0;
  transform: translateX(-5px);
  transition-delay: 0ms;
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
    color 140ms ease,
    background-color 200ms cubic-bezier(0.33, 1, 0.68, 1);
}
.tl__act:hover {
  color: var(--ink-soft);
  background: var(--selected);
  transition-duration: 90ms;
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
  /* The hand-over stays — it is what tells you the slot changed hands — but it
     loses the travel and the wait, so it is a plain swap rather than movement. */
  .tl__stamp,
  .tl__acts,
  .tl__row:hover .tl__stamp,
  .tl__row:focus-within .tl__stamp,
  .tl__row:hover .tl__acts,
  .tl__row:focus-within .tl__acts {
    transform: none;
    transition-delay: 0ms;
  }
}
</style>
