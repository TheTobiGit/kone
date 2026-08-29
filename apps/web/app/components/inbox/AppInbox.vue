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

import { computed, ref, watch } from "vue";
import { useElementSize, useEventListener, useStorage } from "@vueuse/core";
import {
  CHROME_WIDTH,
  clampListWidth,
  DEFAULT_LIST_WIDTH,
  GUTTER_WIDTH,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  RAIL_WIDTH,
} from "~/utils/inboxLayout";
import type { InboxViewId } from "~/types/inbox";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{
  /** The inbox is summoned. Hidden with `visibility`, never unmounted. */
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { cue } = useSound();

// Which list is on screen. Owned here rather than by the rail so the panes and
// the rail read the same value, and so a view is one thing the portal knows
// about itself rather than state buried in a control.
const view = ref<InboxViewId>("inbox");

// Starting a conversation takes over the reading pane rather than opening
// beside it: the inbox is one thing at a time, and a half-written message you
// cannot see is a message you lose. Selecting a thread puts it away, so the
// list stays the way out.
//
// It is also where the pane rests. With nothing picked there is nothing to
// read, and a line saying so would be a wall between you and the one thing you
// might want an empty inbox for — so the empty state IS the composer, and New
// is for when you are reading something and want to start beside it rather
// than a door you have to go through first.
const composing = ref(false);
const writing = computed(() => composing.value || selected.value === null);

// The portal is never unmounted, only hidden, so a pane that claims a session
// on mount would claim one at boot for a project nobody has opened. Latched
// rather than tied to `open`: once you have been in, the surface stays put
// across visits instead of throwing away a half-written message every time the
// inbox is dismissed.
const visited = ref(false);
watch(
  () => props.open,
  (open) => {
    if (open) visited.value = true;
  },
  { immediate: true },
);

function startNewThread(): void {
  cue("select");
  composing.value = true;
}

/** The composer's thread has started, so the composer's work is done. Showing
 *  it the way a picked row is shown is the point: from here on it is a thread
 *  like any other in the list, and there is nothing left that only the pane
 *  that made it could offer. */
function onThreadStarted(row: SessionSummary, sessionKey: string): void {
  selected.value = row;
  handedKey.value = sessionKey;
  composing.value = false;
}

/** A thread picked out of the list: the composer's, if it was up, goes away, and
 *  so does its session key — this thread is opened the ordinary way. */
function onPickThread(): void {
  composing.value = false;
  handedKey.value = null;
}

// Which thread the reading pane is showing. Portal-level rather than per-view,
// so switching between the inbox and the archive does not throw away what you
// were reading.
const selected = ref<SessionSummary | null>(null);

// The live session behind a thread the composer just started, so the reading
// pane attaches to that very session instead of looking one up by id. Only ever
// set by the handover, and dropped as soon as you read something else — every
// other thread is opened the ordinary way.
const handedKey = ref<string | null>(null);

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
// the portal's padding is already out of it.
const { width: contentWidth } = useElementSize(root);

/** The space the two panes share: everything the rail and the gaps do not take. */
function availableWidth(): number {
  // Before the first measurement, wide enough that a stored width is honoured
  // as-is; the observer corrects it on the same frame the element appears.
  if (!contentWidth.value) return MAX_LIST_WIDTH * 2;
  return contentWidth.value - CHROME_WIDTH;
}

const listWidth = computed(() => clampListWidth(stored.value, availableWidth()));

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
    stored.value = clampListWidth(startWidth + (move.clientX - startX), availableWidth());
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

/** The keyboard's version of the drag, so the split is not mouse-only. */
function onGutterKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? 48 : 12;
  if (e.key === "ArrowLeft") stored.value = clampListWidth(listWidth.value - step, availableWidth());
  else if (e.key === "ArrowRight")
    stored.value = clampListWidth(listWidth.value + step, availableWidth());
  else if (e.key === "Home") stored.value = MIN_LIST_WIDTH;
  else if (e.key === "End") stored.value = MAX_LIST_WIDTH;
  else return;
  e.preventDefault();
}

/** Double-click puts the split back where it started. */
function onGutterReset(): void {
  cue("select");
  stored.value = DEFAULT_LIST_WIDTH;
}

// ── leaving ──────────────────────────────────────────────────────────────────
// Escape leaves, but only when nothing inside owns it first — anything that
// answers Escape of its own stops the event at its handler, so reaching here
// means the inbox itself is the frontmost thing.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!props.open || e.key !== "Escape" || e.defaultPrevented) return;
  close();
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
    class="inbox"
    :class="{ 'inbox--hidden': !open, 'inbox--dragging': dragging }"
    :style="{
      '--inbox-list-w': `${listWidth}px`,
      '--inbox-gutter-w': `${GUTTER_WIDTH}px`,
      '--inbox-rail-w': `${RAIL_WIDTH}px`,
    }"
    :inert="!open"
  >
    <InboxRail v-model="view" />

    <section class="inbox__pane inbox__pane--list" aria-label="Threads">
      <!-- One list per view, mounted on first visit and kept alive after, so
           the archive costs nothing until it is asked for and nothing again
           once it has been. -->
      <KeepAlive>
        <InboxThreadList
          :key="view"
          v-model:selected="selected"
          :view="view"
          @new-thread="startNewThread"
          @update:selected="onPickThread"
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
      <InboxNewThread v-if="visited && writing" @started="onThreadStarted" />
      <InboxThreadReader
        v-else-if="selected"
        :row="selected"
        :session-key="handedKey ?? undefined"
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
  transition: opacity 0.22s ease;

  display: grid;
  /* The list is sized by what a row needs to read rather than by a share of the
     window; the reading pane takes whatever is left. `minmax(0, 1fr)` so a long
     unbroken line in there cannot push the grid wider than the portal. */
  grid-template-columns: var(--inbox-rail-w) var(--inbox-list-w) minmax(0, 1fr);
  gap: var(--inbox-gutter-w);
  padding: 20px;
}
.inbox--hidden {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
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
  top: 20px;
  bottom: 20px;
  /* The portal's own padding, then the rail and its gap, then the list — so the
     handle is pinned to the split it moves, with no second copy of the width to
     keep in step. */
  left: calc(20px + var(--inbox-rail-w) + var(--inbox-gutter-w) + var(--inbox-list-w));
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
  .inbox,
  .inbox__grip {
    transition-duration: 0.01s;
  }
}
</style>
