<script setup lang="ts">
// AppInbox — the second portal, and the studio's opposite number.
//
// The studio organises work by place: a row is a project, a column is a pane,
// and you travel to where the work lives. The inbox organises the same work by
// its claim on you — what an agent said, what it is waiting on you for — with
// no regard for which project it came from.
//
// It is a portal, not a panel: it takes the whole viewport and it never shares
// the screen with the work surface. Summoning it sends the studio away, and
// leaving it puts you back on the page you were on. That exclusivity is the
// whole discipline — an inbox that can be docked beside the work is a sidebar,
// and a sidebar is something you learn to stop seeing.
//
// The shell is a view rail standing on the ground, then two panes raised off
// it — the list of threads, and the one you are reading — with a draggable
// gutter between them. The window itself is the outer shelf, so there is no
// frame around the panes to repeat an edge that is already there.

import { computed, nextTick, reactive, ref, watch } from "vue";
import { useElementSize, useEventListener, useStorage } from "@vueuse/core";
import {
  DEFAULT_LIST_WIDTH,
  dragListWidth,
  GUTTER_WIDTH,
  gutterKeyWidth,
  INBOX_PADDING,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  RAIL_WIDTH,
  resolveListWidth,
} from "~/utils/inboxLayout";
import {
  createInboxReadingPaneState,
  openThread,
  pickThread,
  resolveInboxReadingPane,
  threadStarted,
} from "~/utils/inboxReadingPane";
import InboxNewThread from "~/components/inbox/InboxNewThread.vue";
import { useShortcuts } from "~/composables/useShortcuts";
import { setInlineThread } from "~/composables/useAgent";
import type { PortalState, ThreadJumpTarget } from "~/composables/usePortals";
import type { SurfaceId } from "~/utils/surfaceTop";
import { resolveThreadSummary, summarizeSession } from "~/utils/sessionList";
import type { InboxViewId } from "~/types/inbox";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{
  /** Where the inbox sits in the portal stack. `hidden` is away, `active` is
   *  the frontmost layer, `covered` is open underneath another portal. Hidden
   *  with `visibility`, never unmounted. */
  state: PortalState;
  /** Which viewport surface owns Escape, resolved once in the page. The inbox
   *  answers only when named, so one press never dismisses two layers. */
  surfaceTop: SurfaceId;
  /** A parked thread asking to be read here. Set by the portal orchestrator's
   *  jump and cleared once taken — the inbox routes it the ordinary way. */
  pendingJump: ThreadJumpTarget | null;
}>();

// The frontmost layer answers keys and holds focus; anything else stays quiet
// underneath while keeping its paint, the same terms the plane renders from.
const isActive = computed(() => props.state === "active");
const isCovered = computed(() => props.state === "covered");

const emit = defineEmits<{
  close: [];
  jumpConsumed: [];
}>();

const { cue } = useSound();
const { matchesShortcut } = useShortcuts();
// Where a thread started here goes on the plane. See useStudioIntake.
const intake = useStudioIntake();

// Which list is on screen. Owned here rather than by the rail so the panes and
// the rail read the same value, and so a view is one thing the portal knows
// about itself rather than state buried in a control.
const view = ref<InboxViewId>("inbox");

// What the reading pane is showing, as one value. The pieces behind it — a
// half-written message, the picked thread, whether the portal has ever been
// entered, the session a just-started thread is running in — live here as
// portal-owned state: the list v-model, the read-marking watcher, and the
// child-thread lookup read the selection directly, and the single-field steps
// assign directly. The module holds the resolver the template switches on and
// the multi-field transitions where more than one field moves together.
const paneState = reactive(createInboxReadingPaneState());
const pane = computed(() => resolveInboxReadingPane(paneState));

// No thread is on screen: the composer is up, or nothing has been picked, or
// the portal has never been entered. Read-marking and the bots' skip both key
// off the negation, so a reply landing while nobody is looking still raises
// its mark.
const writing = computed(() => pane.value.kind !== "reader");

/** Somebody is actually looking at the selected thread. The three ways that
 *  stops being true are all silent — the portal leaves the front, the composer takes
 *  the pane, or nothing is picked — and none of them clear the selection, which is
 *  deliberate: coming back should put you where you were. So the fact that a
 *  selection exists says nothing about whether it is on screen, and the lists
 *  need to be told, because marking a thread read is a claim that it was read. */
const reading = computed(() => isActive.value && !writing.value);

// Latched rather than tied to the frontmost state: once you have been in, the
// surface stays put across visits instead of throwing away a half-written
// message every time the inbox is dismissed. Until then the pane stays idle —
// the portal is never unmounted, only hidden, so mounting the composer earlier
// would claim a session at boot for a project nobody has opened.
watch(
  isActive,
  (active) => {
    if (active) paneState.visited = true;
  },
  { immediate: true },
);

const newThreadRef = ref<InstanceType<typeof InboxNewThread> | null>(null);

function startNewThread(): void {
  cue("select");
  // The selection underneath is kept, not cleared — the composer covers it,
  // and dismissing the composer puts you back where you were.
  paneState.composing = true;
  void nextTick(() => {
    newThreadRef.value?.focus();
  });
}

/** The composer's thread has started, so the composer's work is done. Showing
 *  it the way a picked row is shown is the point: from here on it is a thread
 *  like any other in the list, and there is nothing left that only the pane
 *  that made it could offer. */
function onThreadStarted(row: SessionSummary, sessionKey: string): void {
  threadStarted(paneState, row, sessionKey);
  // The two portals hold the same work under different questions, and this is
  // the one moment a thread exists in only one of them. The inbox is where you
  // started it; the studio is where the project's work lives, so the thread gets
  // a column on that project's row too. It lands unfocused and does not summon
  // the plane — you are reading the thread here, and being moved would be the
  // portal deciding for you where you meant to be. A birth always joins: it is
  // live by definition, so it goes through the same entry as every other adopt
  // with that said outright. Fire-and-forget — the column converges the next
  // time you travel to the row either way.
  void intake
    .adoptInboxThread({
      projectPath: row.projectPath ?? null,
      threadId: row.threadId,
      view: "inbox",
      done: false,
    })
    .catch(() => undefined);
}

/** A thread picked out of the list: the composer's, if it was up, goes away, and
 *  so does its session key — this thread is opened the ordinary way. The picked
 *  row arrives as the update payload, so this reads the row rather than
 *  re-reading the binding. A null payload is a clear from a row action — silent,
 *  with the composer left alone. When opened from the live inbox list, an
 *  unfinished thread joins its project's studio row as well. That policy lives
 *  in the intake entry — this only forwards what the list knows. */
function onPickThread(row: SessionSummary | null): void {
  if (row === null) return;
  pickThread(paneState);
  void intake
    .adoptInboxThread({
      projectPath: row.projectPath ?? null,
      threadId: row.threadId ?? null,
      view: view.value,
      done: row.done,
    })
    .catch(() => undefined);
}

/** A spawned child's own conversation, asked for from the reading pane's
 *  subagent shell. The child lives in the same project as the thread that
 *  spawned it, so its row is resolved out of that project's stored threads and
 *  selected the ordinary way — the pane remounts onto it. A child the store
 *  cannot name yet leaves you where you are. */
async function onOpenThread(threadId: string): Promise<void> {
  const parent = paneState.selected;
  const projectPath = parent?.projectPath;
  if (!projectPath) return;
  await onOpenProjectThread(projectPath, threadId, parent?.projectName);
}

/** A parked thread the bots row names, possibly in another project. Resolved
 *  out of that project's stored threads and selected the ordinary way — the
 *  pane remounts onto it and its ask answers inline there. An unfinished thread
 *  opened from the live inbox list joins its project's studio row as well, the
 *  way a picked row does. */
async function onOpenProjectThread(
  projectPath: string,
  threadId: string,
  projectName?: string,
): Promise<void> {
  const summary = await resolveThreadSummary(projectPath, threadId, projectName);
  if (!summary) return;
  cue("select");
  openThread(paneState, summary);
  void intake
    .adoptInboxThread({
      projectPath,
      threadId,
      view: view.value,
      done: summary.done,
    })
    .catch(() => undefined);
}

// Report the thread on screen, so the global bots skip what is already in
// front of the user: its ask answers inline in the reading pane. `reading`
// already excludes the dismissed portal, the composer, and the empty state —
// the report is just the thread it names, or null the moment nothing is shown.
watch(
  () => (reading.value ? (paneState.selected?.threadId ?? null) : null),
  (threadId) => setInlineThread("inbox", threadId),
  { immediate: true },
);

// A cross-portal jump waiting to be routed: a parked thread (any project) the
// orchestrator recorded, opened the ordinary way so its ask answers inline
// here. Cleared the moment it is taken — before the async resolve — so a
// second jump landing mid-resolve is a fresh value rather than being wiped by
// the first one's completion.
watch(
  () => props.pendingJump,
  (jump) => {
    if (!jump) return;
    emit("jumpConsumed");
    void onOpenProjectThread(jump.projectPath, jump.threadId, jump.projectName);
  },
);

// ── the gutter ───────────────────────────────────────────────────────────────
// How wide the list is, in pixels, remembered across restarts. Stored raw and
// clamped on the way out rather than on the way in: the window it was set in
// may have been wider than the one it is read back into, and a width that was
// squeezed by a narrow window should spring back when the window grows again
// instead of being permanently written down small.

const root = ref<HTMLElement | null>(null);
const stored = useStorage("kone.inbox.list-width", DEFAULT_LIST_WIDTH);

// Observed rather than read on demand, so the clamp tracks a window being
// resized and not only the moment of the last drag. This is the content box, so
// the portal's padding is already out of it. The width maths lives in
// inboxLayout: this only forwards what is stored and what is observed.
const { width: contentWidth } = useElementSize(root);

const listWidth = computed(() => resolveListWidth(stored.value, contentWidth.value));

const dragging = ref(false);

function onGutterDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  // SAFETY: currentTarget during dispatch is the element the listener is bound
  // to, and this handler is bound only to the gutter <div> in this template.
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const startWidth = listWidth.value;
  dragging.value = true;
  handle.setPointerCapture(e.pointerId);

  const onMove = (move: PointerEvent) => {
    stored.value = dragListWidth(startWidth, startX, move.clientX, contentWidth.value);
  };
  const onUp = () => {
    dragging.value = false;
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
  };

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

/** The keyboard's version of the drag, so the split is not mouse-only. The
 *  module maps the key to the width to store, or null when the key is not the
 *  gutter's — this only forwards the event and writes down the answer. */
function onGutterKey(e: KeyboardEvent): void {
  const next = gutterKeyWidth(listWidth.value, e.key, e.shiftKey, contentWidth.value);
  if (next === null) return;
  stored.value = next;
  e.preventDefault();
}

/** Double-click puts the split back where it started. */
function onGutterReset(): void {
  cue("select");
  stored.value = DEFAULT_LIST_WIDTH;
}

// ── keyboard shortcuts & leaving ─────────────────────────────────────────────
// Escape leaves, but only when nothing inside owns it first — anything that
// answers Escape of its own stops the event at its handler, so reaching here
// means the inbox itself is the frontmost thing. While covered or away, or
// while a modal or the assistant stands over it, that layer (or nothing) owns
// keys, so one press never dismisses both.
//
// ⌘N starts a new conversation in the inbox portal rather than delegating to
// the studio plane behind it.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!isActive.value || e.defaultPrevented) return;
  if (matchesShortcut("new-thread", e)) {
    e.preventDefault();
    startNewThread();
    return;
  }
  if (e.key === "Escape") {
    if (props.surfaceTop !== "inbox") return;
    e.preventDefault();
    close();
    return;
  }
});

function close(): void {
  cue("collapse");
  emit("close");
}
</script>

<template>
  <!-- Opaque and full-bleed inside the stage, so it is clipped by the stage and
       rides the settings-drawer slide for free. Above the studio plane: the two
       are siblings in one stacking context and the inbox always wins, because
       summoning it is a decision to stop looking at the work. -->
  <div
    ref="root"
    class="inbox portal-fade"
    :class="{
      'portal-fade--hidden': state === 'hidden',
      'portal-fade--covered': isCovered,
      'inbox--dragging': dragging,
    }"
    :style="{
      '--inbox-list-w': `${listWidth}px`,
      '--inbox-gutter-w': `${GUTTER_WIDTH}px`,
      '--inbox-rail-w': `${RAIL_WIDTH}px`,
      '--inbox-pad': `${INBOX_PADDING}px`,
    }"
    :inert="!isActive"
  >
    <InboxRail v-model="view" />

    <section class="inbox__pane inbox__pane--list" aria-label="Threads">
      <!-- One list per view, mounted on first visit and kept alive after, so
           the archive costs nothing until it is asked for and nothing again
           once it has been. -->
      <KeepAlive>
        <InboxThreadList
          :key="view"
          v-model:selected="paneState.selected"
          :view="view"
          :reading="reading"
          @new-thread="startNewThread"
          @update:selected="(row) => onPickThread(row)"
        />
      </KeepAlive>
    </section>

    <!-- The handle lies over the gap rather than taking a column of its own, so
         the gap stays a real `gap` and the width maths in script can measure it
         the same way the browser lays it out. Its hit area reaches past the grip
         on both sides — the visible mark is 2px wide and nobody aims at 2px. -->
    <div
      class="inbox__gutter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the thread list"
      :aria-valuenow="listWidth"
      :aria-valuemin="MIN_LIST_WIDTH"
      :aria-valuemax="MAX_LIST_WIDTH"
      tabindex="0"
      @pointerdown="onGutterDown"
      @keydown="onGutterKey"
      @dblclick="onGutterReset"
    >
      <span class="inbox__grip" aria-hidden="true" />
    </div>

    <section class="inbox__pane inbox__pane--read" aria-label="Thread">
      <!-- One value picks the pane: the composer while writing, the reader for
           the picked thread, and nothing while idle — idle is the portal before
           its first visit, kept empty on purpose rather than mounting the
           composer and claiming a session for a project nobody has opened. -->
      <InboxNewThread
        v-if="pane.kind === 'composer'"
        ref="newThreadRef"
        @started="onThreadStarted"
      />
      <InboxThreadReader
        v-else-if="pane.kind === 'reader'"
        :row="pane.row"
        :session-key="pane.sessionKey ?? undefined"
        @open-thread="onOpenThread"
        @new-thread="startNewThread"
      />
    </section>
  </div>
</template>

<style scoped>
.inbox {
  position: absolute;
  inset: 0;
  z-index: 45;
  overflow: hidden;
  background: var(--ground);
  /* Hide/show timing lives with .portal-fade in assets/css/main.css. */

  display: grid;
  /* The list is sized by what a row needs to read rather than by a share of the
     window; the reading pane takes whatever is left. `minmax(0, 1fr)` so a long
     unbroken line in there cannot push the grid wider than the portal. */
  grid-template-columns: var(--inbox-rail-w) var(--inbox-list-w) minmax(0, 1fr);
  gap: var(--inbox-gutter-w);
  padding: var(--inbox-pad);
}

/* Surfaces rather than outlines: the panes are a step up off the ground, the
   way every other raised thing in the app is, so nothing has to be drawn around
   them to say where they end. */
.inbox__pane {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 22px;
  background: var(--panel);
}

.inbox__gutter {
  position: absolute;
  top: var(--inbox-pad);
  bottom: var(--inbox-pad);
  /* The portal's own padding, then the rail and its gap, then the list — so the
     handle is pinned to the split it moves, with no second copy of the width to
     keep in step. */
  left: calc(
    var(--inbox-pad) + var(--inbox-rail-w) + var(--inbox-gutter-w) + var(--inbox-list-w)
  );
  width: var(--inbox-gutter-w);
  display: grid;
  place-items: center;
  cursor: col-resize;
  /* Or the browser starts scrolling the pane under a touch drag instead. */
  touch-action: none;
}
/* Widens the grab area past the gap without widening the gap. */
.inbox__gutter::before {
  content: "";
  position: absolute;
  inset: 0 -6px;
}
.inbox__gutter:focus-visible {
  outline: none;
}

.inbox__grip {
  width: 2px;
  height: 28px;
  border-radius: 1px;
  background: var(--faint);
  transition:
    background-color 0.16s ease,
    height 0.16s ease;
}
.inbox__gutter:hover .inbox__grip,
.inbox__gutter:focus-visible .inbox__grip {
  height: 44px;
  background: var(--muted);
}
.inbox--dragging .inbox__grip,
.inbox__gutter:active .inbox__grip {
  height: 44px;
  background: var(--accent);
}

/* While dragging, the pointer belongs to the gutter and nothing else: without
   this the cursor flickers between arrows as it crosses the panes, and a drag
   that overshoots starts selecting text in them. */
.inbox--dragging {
  cursor: col-resize;
  user-select: none;
}

@media (prefers-reduced-motion: reduce) {
  .inbox__grip {
    transition-duration: 0.01s;
    transition-delay: 0s;
  }
}
</style>
