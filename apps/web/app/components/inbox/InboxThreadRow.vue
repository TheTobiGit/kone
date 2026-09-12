<script setup lang="ts">
// One inbox queue row: the thread, its stamp, and everything you can tell it.
//
// The list owns ordering, selection, and which threads are running; this owns
// one row — its menu, its tooltip, and the six mutations behind its buttons.
// A pin is position plus a mark, not a division of the list, so the mark lives
// here where the position is explained.

import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  GitBranchIcon,
  Archive02Icon,
  ArchiveRestoreIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  InboxUnreadIcon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import InboxRowMenu, {
  type RowActionId,
  type RowMenuItem,
} from "~/components/inbox/InboxRowMenu.vue";
import { useAllRecentSessions } from "~/composables/useAllRecentSessions";
import { agentIdentity } from "~/utils/agentIdentity";
import { sessionBrand } from "~/utils/modelCatalog";
import { timeAgo } from "~/utils/timeAgo";
import type { TurnOrbState } from "~/utils/thinkingOrb";
import type { HugeIcon } from "~/utils/toolPresentation";
import type { InboxViewId } from "~/types/inbox";
import type { SessionSummary } from "~/types/session";

/** One row action, inline or overflow. The template renders inline ones as
 *  buttons and hands overflow ones to the menu; a menu pick resolves back to
 *  the same runner, so there is one definition per gesture instead of a button
 *  plus a menu item plus a string switch. */
export type RowAction = {
  id: RowActionId;
  label: string;
  icon: HugeIcon;
  danger?: boolean;
  placement: "inline" | "overflow";
  run: (row: SessionSummary) => void;
};

const props = defineProps<{
  thread: SessionSummary;
  view: InboxViewId;
  /** Whether the reading pane is showing this thread. */
  selected: boolean;
  /** Whether pins rank. In Done the list runs on plain recency and the mark
   *  goes with it: it exists to explain a position, and there is no position
   *  left to explain. */
  ranks: boolean;
  /** What the running turn is doing, when one is running on this thread. */
  orb?: { state: TurnOrbState; label: string };
  /** Position in the rendered list, for the stagger. */
  index: number;
  /** Whether this row draws the pinned-run divider above it. */
  resumes: boolean;
}>();

const emit = defineEmits<{
  select: [thread: SessionSummary];
  /** A row action cleared the reading selection (archiving, deleting, or
   *  marking what is on screen). The list owns selection, so it clears. */
  clear: [threadId: string];
}>();

const { cue } = useSound();

// Read once at setup: a row never changes which set it belongs to without its
// list remounting, and the shared pipeline means this is the same instance the
// list reads — an optimistic drop here moves the list's rows too.
const source = useAllRecentSessions({ archived: props.view === "archived" });

function togglePin(row: SessionSummary): void {
  cue("press");
  source.togglePin(row.threadId);
}

function toggleDone(row: SessionSummary): void {
  cue("press");
  if (props.selected && props.view === "inbox") emit("clear", row.threadId);
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
  if (props.selected) emit("clear", row.threadId);
  source.markUnread(row.threadId);
}

/** Take a thread back out of the archive. The row leaves this list because the
 *  archive and the live list are disjoint queries — it has not been deleted,
 *  it has gone back to where it came from. */
function restore(row: SessionSummary): void {
  cue("press");
  if (props.selected) emit("clear", row.threadId);
  void source.restore(row.threadId);
}

function archiveRow(row: SessionSummary): void {
  cue("press");
  if (props.selected) emit("clear", row.threadId);
  void source.archive(row.threadId, true);
}

function removeRow(row: SessionSummary): void {
  cue("press");
  if (props.selected) emit("clear", row.threadId);
  source.remove(row.threadId);
}

/** Every gesture this row offers, in one list.
 *
 *  Done and archive stay on the row because they are the two ways a thread
 *  leaves the queue, and leaving the queue is what an inbox is for. Pinning is
 *  a preference about the order of what is left, and putting the mark back is
 *  rare, so both go behind the overflow — which is what keeps the row's right
 *  edge at three targets instead of five. Delete is behind the overflow
 *  wherever it appears, regardless of room: it does not come back, and a bare
 *  button for that in a list of rows is a mistake waiting for a fast cursor.
 *  The archive offers one inline thing, and it is the way out. */
const actions = computed<RowAction[]>(() => {
  const s = props.thread;
  if (props.view === "archived") {
    return [
      {
        id: "restore",
        label: "Restore",
        icon: ArchiveRestoreIcon,
        placement: "inline",
        run: (row) => restore(row),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Delete02Icon,
        danger: true,
        placement: "overflow",
        run: (row) => removeRow(row),
      },
    ];
  }
  const out: RowAction[] = [
    {
      id: "done",
      label: s.done ? "Not done" : "Done",
      icon: CheckmarkCircle02Icon,
      placement: "inline",
      run: (row) => toggleDone(row),
    },
    {
      id: "archive",
      label: "Archive",
      icon: Archive02Icon,
      placement: "inline",
      run: (row) => archiveRow(row),
    },
  ];
  if (props.ranks)
    out.push({
      id: "pin",
      label: s.pinned ? "Unpin" : "Pin",
      icon: PinIcon,
      placement: "overflow",
      run: (row) => togglePin(row),
    });
  // The mark is what this puts back, so offering it on a thread that already
  // carries one is a control that does nothing.
  if (!s.unread)
    out.push({
      id: "unread",
      label: "Mark unread",
      icon: InboxUnreadIcon,
      placement: "overflow",
      run: (row) => markUnread(row),
    });
  return out;
});

const inlineActions = computed(() => actions.value.filter((a) => a.placement === "inline"));
const overflowItems = computed<RowMenuItem[]>(() =>
  actions.value
    .filter((a) => a.placement === "overflow")
    .map((a) => ({ id: a.id, label: a.label, icon: a.icon, danger: a.danger })),
);

/** Which row has its overflow panel up. Tracked here rather than left to the
 *  menu because the row is what has to stop behaving as though the cursor had
 *  left it — see the model on InboxRowMenu. */
const menuOpen = ref(false);

function onPick(id: RowActionId): void {
  const found = actions.value.find((a) => a.id === id);
  if (found) found.run(props.thread);
}

/** The chip said in full, for the rows whose own is clipped.
 *
 *  The path rather than the display name, because a tooltip that repeats what
 *  is already on screen is worth nothing and the path is what the name is short
 *  for. And the branch gets a verb: "dev" beside a project reads as the branch
 *  the thread is on, which is a promise nothing in the app keeps — so the one
 *  place with room to be exact says what it actually is. */
function whereTitle(s: SessionSummary): string {
  const where = s.projectPath ?? s.projectName ?? null;
  const ran = s.branch ? `Last ran on ${s.branch}` : null;
  // Only worth saying when it is not the ordinary case. A thread in the
  // project's checkout is already fully described by the two lines above.
  const lives = s.worktreePath
    ? `Works in its own worktree:\n${s.worktreePath}`
    : s.workspacePending
      ? "Its worktree hasn't been created yet."
      : null;
  return [where, ran, lives].filter(Boolean).join("\n");
}

function select(): void {
  emit("select", props.thread);
}
</script>

<template>
  <li
    class="tl__row"
    :class="{
      'tl__row--pinned': thread.pinned && ranks,
      'tl__row--resumes': resumes,
      'tl__row--on': selected,
      'tl__row--unread': thread.unread,
      'tl__row--menu': menuOpen,
    }"
    :style="{ '--i': index }"
  >
    <button
      type="button"
      class="tl__open"
      :aria-current="selected ? 'true' : undefined"
      :aria-describedby="thread.unread ? `unread-${thread.threadId}` : undefined"
      @click="select"
    >
      <span class="tl__lead">
        <AgentFace :seed="thread.threadId" :size="32" />
        <!-- The engine's mark rides the face instead of taking width on a
             line of its own: it is an attribute of who is answering, and
             the face is already where the eye goes to ask that. -->
        <span class="tl__brand">
          <ProviderLogo :brand="sessionBrand(thread.provider, thread.brand, thread.model)" :size="11" />
        </span>
      </span>

      <!-- Two lines, and each has one job: what the thread is, then the
           last thing said in it. The engine, the call sign and the branch
           all used to sit above the title on a third line — none of them
           is how anyone picks a thread out of a queue, and together they
           made every row a paragraph. -->
      <span class="tl__main">
        <span class="tl__title">
          <HugeiconsIcon
            v-if="thread.pinned && ranks"
            class="tl__pin"
            :icon="PinIcon"
            :size="11"
            :stroke-width="2"
            aria-label="Pinned"
          />
          <span class="tl__name">{{ thread.title }}</span>
          <!-- Where the thread's work went, as one chip. The list spans
               every project, so this is the context the title cannot
               imply, and the repo, the branch and the workspace are one
               answer to one question rather than three chips.

               The branch is still a record rather than a setting — it is
               stamped when a turn settles and says where that turn ran.
               What it means depends on where the thread lives. A thread in
               the project's checkout shares that checkout's branch with
               every other thread there, so its branch can be moved out
               from under it and the record says where the work landed, not
               where the next turn will go. A thread with a worktree of its
               own holds its branch: nothing else can check out something
               different inside it.

               The worktree mark is the discriminator, and its absence is
               what says "this one is in the project's checkout" — most
               threads are, so marking them all would say nothing. The
               tooltip spells it out. -->
          <span
            v-if="thread.projectName || thread.branch || thread.worktreePath || thread.workspacePending"
            class="tl__chip"
            :title="whereTitle(thread)"
          >
            <span v-if="thread.projectName" class="tl__where">{{ thread.projectName }}</span>
            <span v-if="thread.branch" class="tl__branch">
              <HugeiconsIcon
                :icon="GitBranchIcon"
                :size="10"
                :stroke-width="2"
                aria-hidden="true"
              />
              <span class="tl__branch-name">{{ thread.branch }}</span>
            </span>
          </span>
        </span>

        <span v-if="orb || thread.snippet" class="tl__sub">
          <span v-if="orb" class="tl__active-label">
            {{ orb.label }}
          </span>
          <template v-else-if="thread.snippet">
            <span class="tl__who">{{ agentIdentity(thread.threadId).name }}</span>
            <span class="tl__snippet" :title="thread.snippet">{{ thread.snippet }}</span>
          </template>
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
          v-if="thread.unread"
          :id="`unread-${thread.threadId}`"
          class="tl__dot"
          role="img"
          aria-label="Unread"
        />

        <!-- A running thread says so where its stamp would be. "Last touched
             4m ago" is a fact about a thread that has stopped; while one is
             mid-turn the orb is the truer answer to the same question, and
             it is the same orb the thread itself is carrying. -->
        <TurnOrb
          v-if="orb"
          class="tl__orb"
          :state="orb.state"
          :size="18"
          :aria-label="`${thread.title}: ${orb.label}`"
        />
        <span v-else class="tl__when">{{ timeAgo(thread.updatedAt) }}</span>
      </span>

      <div class="tl__acts">
        <template v-for="action in inlineActions" :key="action.id">
          <button
            v-if="action.id === 'restore'"
            type="button"
            class="tl__act"
            :aria-label="`Restore ${thread.title}`"
            title="Restore"
            @click="action.run(thread)"
          >
            <HugeiconsIcon
              :icon="action.icon"
              :size="14"
              :stroke-width="1.9"
              aria-hidden="true"
            />
          </button>
          <button
            v-else-if="action.id === 'done'"
            type="button"
            class="tl__act"
            :class="{ 'tl__act--on': thread.done }"
            :aria-pressed="Boolean(thread.done)"
            :aria-label="thread.done ? `Mark ${thread.title} not done` : `Mark ${thread.title} done`"
            :title="thread.done ? 'Not done' : 'Done'"
            @click="action.run(thread)"
          >
            <HugeiconsIcon
              :icon="action.icon"
              :size="14"
              :stroke-width="1.9"
              aria-hidden="true"
            />
          </button>
          <button
            v-else
            type="button"
            class="tl__act"
            :aria-label="`Archive ${thread.title}`"
            title="Archive"
            @click="action.run(thread)"
          >
            <HugeiconsIcon
              :icon="action.icon"
              :size="14"
              :stroke-width="1.9"
              aria-hidden="true"
            />
          </button>
        </template>

        <InboxRowMenu
          v-if="overflowItems.length"
          v-model:open="menuOpen"
          :items="overflowItems"
          :label="`More actions for ${thread.title}`"
          @pick="onPick"
        />
      </div>
    </div>
  </li>
</template>

<style scoped>
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

/* Set into the face's corner on its own disc, so the mark stays legible over
   whatever the portrait happens to be behind it. */
.tl__brand {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 0 0 1.5px var(--panel);
}

.tl__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
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
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  font-size: 11.5px;
  line-height: 15px;
}

/* Who said the line under the title. Named here rather than above it: on its
   own line the call sign is a label for the agent, and beside the snippet it is
   the speaker of it — which is the more useful of the two readings and costs no
   extra row. */
.tl__who {
  flex: none;
  font-family: var(--font-sans);
  font-weight: 500;
  color: var(--ink-soft);
  white-space: nowrap;
}
.tl__who::after {
  content: ":";
  color: var(--faint);
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
  --row-wash: transparent;
  background: var(--row-wash);
  transition: background-color 240ms cubic-bezier(0.33, 1, 0.68, 1);
}

/* The wash is resolved as one value rather than declared three times, so which
   state wins is settled by this short cascade instead of by which rule happened
   to be written last. The pointer states are wrapped in :where() to give up
   their specificity, which is what lets selection below outrank them by being
   plainly named rather than by being over-qualified.

   :focus-visible, not :focus-within: clicking a row leaves the button inside it
   focused, so a :focus-within wash survives the cursor leaving — the row paints
   as hovered until you click something else, and the same selection reads as
   two different shades depending on where focus happens to be. */
:where(.tl__row):hover,
:where(.tl__row):has(:focus-visible) {
  --row-wash: var(--hover);
  transition-duration: 110ms;
}

/* Selection outranks both. Which row is open is a fact about the list; it must
   not change shade because the pointer moved off it or because the window lost
   focus to another app. */
.tl__row--on {
  --row-wash: var(--selected);
}
/* Still worth acknowledging the cursor — one step up from the selected wash
   rather than the hover wash, which would read as the selection coming off. */
.tl__row--on:hover {
  --row-wash: color-mix(in oklab, var(--accent) 17%, transparent);
}

/* Keyboard focus needs a mark of its own: on an already-selected row the wash
   cannot move (see above), so without this the focused row and the merely
   selected one are indistinguishable to someone arriving by Tab. */
.tl__row:has(:focus-visible) {
  box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--accent) 55%, transparent);
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

/* Allowed to shrink but never below a few characters, so a long title takes the
   ellipsis first and where the thread lives is still readable at the narrowest
   list the gutter permits. */
.tl__chip {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 40px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 14px;
  color: var(--faint);
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
}

/* The repo holds its ground and the branch gives way. At the width where only
   one of them survives, the repo is the half that still locates the thread —
   a bare branch name says nothing about which checkout it is on. */
.tl__where {
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tl__branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.tl__branch svg {
  flex: none;
}
.tl__branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Only when something precedes it — a thread whose repo could not be named
   still opens its chip on the branch, with nothing to be divided from. The
   same rule carries the workspace mark, which follows whichever of the two
   actually rendered. */
.tl__where + .tl__branch,
  margin-left: 4px;
  padding-left: 5px;
  border-left: 1px solid color-mix(in oklab, var(--faint) 35%, transparent);
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
  min-width: 72px;
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

/* The unread mark. Small and solid — it has to survive being the only coloured
   thing in a list of greys without becoming the thing you read first. */
.tl__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}

.tl__when {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
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
.tl__row:has(:focus-visible) .tl__acts,
.tl__row--menu .tl__acts {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition-delay: 90ms;
}
.tl__row:hover .tl__stamp,
.tl__row:has(:focus-visible) .tl__stamp,
.tl__row--menu .tl__stamp {
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
.tl__act--danger:hover {
  color: var(--danger, var(--diff-del));
  background: color-mix(in srgb, var(--danger, var(--diff-del)) 10%, transparent);
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
  .tl__row:has(:focus-visible) .tl__stamp,
  .tl__row:hover .tl__acts,
  .tl__row:has(:focus-visible) .tl__acts,
  .tl__row--menu .tl__stamp,
  .tl__row--menu .tl__acts {
    transform: none;
    transition-delay: 0ms;
  }
}
</style>
