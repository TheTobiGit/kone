<script setup lang="ts">
// The thread strip — a project's live conversations as columns on one
// infinitely-wide, horizontally scrollable rail. Modelled on niri (the
// scrollable-tiling Wayland compositor): columns tile from the left edge once
// there's more than one, each has a fixed pixel width preset, the strip extends
// rightward as you open threads. A lone thread is centred in the panel; opening
// a second pushes it left and tiles out niri-style.
//
// Navigation, all of it niri's vocabulary:
//   · ⌘⌥← / ⌘⌥→ ....... focus the column left / right (clamped, never wraps)
//   · ⌘⌥⇧← / ⌘⌥⇧→ ..... carry the focused column along the strip
//   · ⌘⇧R ............. cycle the focused column's width preset
//   · ⌘⌥↑ / ⌘⌥↓ ....... widen / narrow the focused column one preset step
//   · ← / → ........... same as focus left/right when you aren't typing
//   · two-finger swipe . free-scroll the rail; the column nearest centre takes
//                        focus when you let go (snap-on-release)
//
// This component owns only the strip's own geometry — column order, focus, and
// closing are registry operations, so they go up to ProjectView as events. Column
// *width* is purely presentational, so it lives here.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  useEventListener,
  usePreferredReducedMotion,
  useResizeObserver,
} from "@vueuse/core";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon, ArrowExpand01Icon, ArrowShrink01Icon, BubbleChatTemporaryIcon, Cancel01Icon, Folder01Icon, GitBranchIcon, Link05Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { ClosingPlasma } from "~/components/ui/closing-plasma";
import { Magnet } from "~/components/ui/magnet";
import type { Pane, PaneId, PaneKind } from "~/types/studio";
import { PANE_KINDS, paneKindMeta } from "~/utils/paneKinds";
import { isBlankThread } from "~/utils/panes";
// The scroll rule the centring modes name, and the geometry it reads. Shared with
// SettingsThreadStripPane so the settings preview runs the board's own maths rather
// than a copy of it — see the header of that module.
import {
  JOINT_PX,
  LADDER_PX,
  MIN_ANIMATED_PX,
  padEndFor,
  resolveScrollTarget,
  resolveSnapTarget,
} from "~/utils/stripScroll";
import { SESSION_BRAND } from "~/types/session";
import ContextWindowMeter from "~/components/thread/ContextWindowMeter.vue";
import ThreadInfoPanel from "~/components/thread/ThreadInfoPanel.vue";
import type { ThreadSession } from "~/composables/useAgent";
import { useStripOverview } from "~/composables/useStripOverview";
import { useStripPresets } from "~/composables/useStripPresets";
import type { GitRemote } from "~/types/desktop";

const props = defineProps<{
  /** Live panes in strip order (left to right). A pane's session may be null
   *  (dormant) — every read here is null-safe. */
  panes: Pane[];
  /** The focused pane's stable id. */
  focusedId: string;
  /** Ticking clock from useAgent, so every column's "working · Xs" counts up. */
  now: number;
  /** Briefly pulse a pad column's index dash after a thread → pad append. */
  pulseKey?: string | null;
  /** Whether the board surface is the visible one. The strip stays mounted while
   *  hidden (so panes and scroll positions survive), but a hidden rail measures
   *  zero width — so re-centre once it's revealed, not while it's hidden. */
  visible?: boolean;
  /** The desktop is bare — zero panes — so there's no column to hang an insert
   *  affordance off. Show the centered "new column" chooser over the rail.
   *  Picking a kind emits `choose`; ProjectView acts on it. A lone *blank thread*
   *  is deliberately NOT this case: that column shows plainly, with its trailing
   *  seam pill offering terminal / scratchpad. */
  chooser?: boolean;
  /** The project's folder name — handed to a thread's info panel. */
  repo?: string;
  /** The project's absolute path — the chooser pill shows the directories
   *  before the folder name, faded, so two same-named projects still read apart. */
  projectPath?: string;
  /** The project's current git branch, if any — handed to a thread's info
   *  panel, where it marks the thread as living in a git project. */
  branch?: string;
  /** The project's origin remote — handed to a thread's info panel, where it
   *  names the hosted repo the thread's work belongs to. */
  origin?: GitRemote | null;
}>();

const emit = defineEmits<{
  /** Focus this column (a click, or the rail settling on it after a swipe). */
  focus: [key: string];
  /** Step focus this many columns along the strip. */
  shift: [delta: number];
  /** Carry the focused column this many places along the strip. */
  move: [delta: number];
  close: [key: string];
  /** Archive this thread and close its column. Carries the provider thread id (so
   *  the store/history row can be stamped archived) and the pane key (so the
   *  column can be closed). Only ever fired for a non-blank thread column. */
  archive: [threadId: string, key: string];
  /** Fork a side chat off this thread's column (the per-host-thread "add panel"
   *  creator). Carries the source pane id; ProjectView opens the child beside it. */
  "side-chat": [paneId: string];
  /** Insert a blank thread to the right of seam `seamIndex`. */
  "insert-column": [seamIndex: number, kind: "thread" | "terminal" | "scratchpad"];
  /** Write terminal input data. Keyed by the terminal *session* key, not the pane
   *  id: these three go straight to useTerminal, which keys its registry by
   *  session. Every other emit here carries a pane id, so the mismatch is easy
   *  to reintroduce — the strip has the session in hand (`c.session.key`), so it
   *  passes that. */
  "terminal-write": [sessionKey: string, data: string];
  /** Resize terminal PTY. Session-keyed, same as `terminal-write`. */
  "terminal-resize": [sessionKey: string, cols: number, rows: number];
  /** Restart terminal PTY in place. Session-keyed, same as `terminal-write`. */
  "terminal-restart": [sessionKey: string];
  /** Append assistant reply markdown to a scratchpad. */
  "to-scratchpad": [text: string, sourceKey: string];
  "scratchpad-flush": [key: string];
  /** A column's width preset index changed — persist it onto the pane entry. */
  width: [key: string, index: number];
  /** The empty-board chooser picked a kind — start the board with that pane
   *  (or, for a thread, just reveal the waiting blank column). */
  choose: [kind: "thread" | "terminal" | "scratchpad"];
  /** Overview (Exposé) turned on or off. ProjectView listens only to hide its
   *  fixed composer while the plane is zoomed out — a single boolean seam, no
   *  more: the mode itself lives here, this just tells the one overlay outside
   *  the strip to get out of the way. */
  "update:overview": [value: boolean];
}>();

const { cue } = useSound();
// niri's `center-focused-column`, shared with the settings drawer through a
// module-scope ref (see useStripPrefs) so flipping it there steers the scroll
// maths below live, with no prop threaded in and no reload.
const { centerMode } = useStripPrefs();

const rail = ref<HTMLElement | null>(null);
const railWidth = ref(0);
const reducedMotion = usePreferredReducedMotion();

function reducedMotionOn(): boolean {
  return reducedMotion.value === "reduce";
}
function scrollBehavior(): ScrollBehavior {
  return reducedMotionOn() ? "auto" : "smooth";
}

const {
  PRESETS,
  DEFAULT_PRESET,
  widthAnim,
  zenIds,
  isSideChatPane,
  presetIndexFor,
  clampPreset,
  zenPreset,
  isZen,
  presetFor,
  flagWidthAnim,
  setPreset,
  cycleWidth,
  growWidth,
  shrinkWidth,
  toggleZen,
} = useStripPresets({
  panes: () => props.panes,
  focusedId: () => props.focusedId,
  railWidth,
  reducedMotionOn,
  onWidthEmit: (id, index) => emit("width", id, index),
  onScrollToColumn: (id) => scrollToColumn(id),
});

const {
  overview,
  plane,
  naturalWidth,
  k,
  centerShift,
  planeTransform,
  scalerStyle,
  planeStyle,
  isZooming,
  zoomBusy,
  markZooming,
  markZoomBusy,
  animateZoom,
  flipFrom,
  remeasurePlane,
} = useStripOverview({
  rail,
  railWidth,
  reducedMotionOn,
});

const isSolo = computed(() => props.panes.length === 1);

/** Leading pad centres the lone thread; trailing pad lets the last column scroll
 *  to centre when there are two or more. */
const soloPadStart = computed(() => {
  if (!isSolo.value || !railWidth.value) return 0;
  const s = props.panes[0];
  if (!s) return 0;
  const colW = Math.min(presetFor(s.id).px, railWidth.value);
  // Pull the pad in by the leading seam's width so the column itself — not the
  // seam+column pair — sits centred, exactly as it did before the seam existed.
  // (The leading seam mirrored before the first column is a real element in the
  // plane, so it would otherwise shift the lone column right of centre.)
  return Math.max(0, (railWidth.value - colW) / 2 - JOINT_PX);
});
const railPads = computed(() => {
  // In overview nothing centre-scrolls, so the half-screen trailing pad would just be
  // dead space on the right and — because it's inside the scaled plane, so it counts
  // toward naturalWidth — it would drag k toward the floor even with only a few
  // columns. Flatten both pads to a symmetric gutter instead: equal breathing room on
  // each side, and with k fitting the plane to the full rail width that reads as a
  // centred plane. (The pads stay in the plane; they just get small, matching values.)
  if (overview.value) {
    return {
      "--rail-pad-start": `${OVERVIEW_GUTTER}px`,
      "--rail-pad-end": `${OVERVIEW_GUTTER}px`,
    };
  }
  // The trailing pad only exists so the *last* column can reach the centre of the
  // viewport. In `never` we never centre, so that pad would just be scrollable
  // emptiness past the end of the strip — you'd swipe into nothing and nearestKey
  // (which picks by viewport centre) would start answering out there. Shrink it to
  // a peek. `on-overflow` still centres when it moves, so it keeps the half-screen.
  const padEnd = padEndFor(centerMode.value, railWidth.value);
  return {
    "--rail-pad-start": isSolo.value ? `${soloPadStart.value}px` : "0px",
    "--rail-pad-end": isSolo.value ? "0px" : `${padEnd}px`,
  };
});

// ── the rail ──────────────────────────────────────────────────────────────────
const colEls = new Map<string, HTMLElement>();
function setCol(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) colEls.set(key, el);
  else colEls.delete(key);
}

/** Where the rail should sit for `key` to be usable, or `null` for "don't move".
 *  Honours the centring mode: `never` nudges by the minimum, `on-overflow` centres
 *  but only when a scroll is actually needed, `always` centres unconditionally.
 *  Returning `null` — rather than the current position — is what makes the strip
 *  *stay put*: `scrollToColumn` already treats null as a no-op, so nothing
 *  programmatic fires and no smooth-scroll animation is queued. */
let programmaticAt = 0;

/** The column's geometry in the rail's *scroller* coordinates.
 *
 *  `offsetLeft`/`offsetWidth` are unscaled *plane* coordinates, but `scrollLeft`
 *  and `scrollWidth` are the rail's *scaled* scroller coordinates in overview. The
 *  scaler shrinks the layout by exactly `k`, so multiply the column's geometry by k
 *  to speak the same units. Without this, arrow-navigating in overview scrolls to
 *  wildly wrong positions — the subtlest bug in the feature. Outside overview k is 1. */
function measureColumn(r: HTMLElement, el: HTMLElement) {
  const s = overview.value ? k.value : 1;
  return {
    mode: centerMode.value,
    left: el.offsetLeft * s,
    width: el.offsetWidth * s,
    viewport: r.clientWidth,
    scrollLeft: r.scrollLeft,
    maxScroll: Math.max(0, r.scrollWidth - r.clientWidth),
  };
}

function scrollTargetFor(key: string): number | null {
  const r = rail.value;
  const el = colEls.get(key);
  if (!r || !el) return null;
  return resolveScrollTarget(measureColumn(r, el));
}

/** Where the rail should settle after a free swipe. Unlike `scrollTargetFor` this
 *  always returns a position: a released swipe must land on a column boundary
 *  rather than wherever the fingers stopped. In centring modes that boundary is the
 *  viewport centre; in `never` it's the column's left edge (its right edge, if it's
 *  the last one and the strip has run out of room — `clamp` handles that for
 *  free). */
function snapTargetFor(key: string): number | null {
  const r = rail.value;
  const el = colEls.get(key);
  if (!r || !el) return null;
  // Measured through the same scaled-coordinate correction as scrollTargetFor. k is 1
  // outside overview, and the settle path is suspended while overview is on anyway,
  // but keep the units honest so this never lies about a column boundary.
  return resolveSnapTarget(measureColumn(r, el));
}
let snapKey: string | null = null;
let snapAt = 0;
function scrollToColumn(
  key: string,
  behavior: ScrollBehavior = scrollBehavior(),
  // `reveal` obeys the centring mode and may decline to move (returns null);
  // `snap` is the swipe-release path, which must always land on a boundary.
  mode: "reveal" | "snap" = "reveal",
): void {
  const r = rail.value;
  if (!r) return;
  // A hidden layer measures zero width; scrolling against it would clamp the
  // rail to 0 and lose the real position. The re-centre on reveal restores it.
  if (r.clientWidth === 0) return;
  if (isSolo.value) {
    r.scrollLeft = 0;
    return;
  }
  // A snap we just fired owns this column's position for a beat. When the settle
  // crossed into a new column it emits `focus` *and* snaps; the focus watcher then
  // asks for a `reveal` of the very column already gliding to its boundary, and
  // mid-glide it measures that column as still clipped — so `never` aims a PEEK
  // short and the swipe lands 24px off the seam, but only when focus changed.
  // Suppressing the immediate follow-up keeps both settle paths landing identically.
  if (mode === "reveal" && key === snapKey && Date.now() - snapAt < 80) return;
  const target = mode === "snap" ? snapTargetFor(key) : scrollTargetFor(key);
  if (target === null) return;
  // A smooth scroll landing on top of a zoom is the "swimming" failure: the FLIP was
  // computed from a scroll offset that then keeps moving under it, so the plane drifts
  // against its own animation for the length of the glide. While a zoom is in flight the
  // scroll is part of that animation's from-state, so it has to be instant.
  const how = zoomBusy.value ? "auto" : behavior;
  if (how !== "auto" && Math.abs(r.scrollLeft - target) < MIN_ANIMATED_PX) return;
  if (mode === "snap") {
    snapKey = key;
    snapAt = Date.now();
  }
  programmaticAt = Date.now();
  if (how === "auto") r.scrollLeft = target;
  else r.scrollTo({ left: target, behavior: how });
}

async function enterOverview(): Promise<void> {
  const r = rail.value;
  const p = plane.value;
  if (!r || !p || props.panes.length < 2) return;
  // Zen's synthetic 100%-wide preset would poison the measure — an overview of one
  // full-bleed column is meaningless, and sampling naturalWidth while the focused
  // column is a full rail wide gives the wrong plane. Drop zen first, silently: we
  // don't restore it on exit and never persist it. Let the column fall back to its
  // real rung before we measure.
  //
  // Deliberately a *snap*, not a flagged flex-basis glide: is-width-anim would leave
  // the focused column mid-transition from 100% → its rung at the exact nextTick we
  // sample p.scrollWidth below, so naturalWidth would be measured against a still-
  // full-bleed column, k would come out too small, and the scaler would strand at the
  // wrong width for the rest of the session. The instant collapse is masked anyway by
  // the zoom-out starting in the same frame, so the glide isn't worth corrupting the
  // measure for. (Entering overview from a non-zen board has no width change at all.)
  zenIds.value.clear();
  markZoomBusy();
  // Where the view sits *now*, before anything moves. Both numbers feed the FLIP: the
  // scroll offset because it's about to be remapped under us, and the transform because
  // a re-entry can start from a plane that's still mid-flight.
  const fromScroll = r.scrollLeft;
  const fromTransform = planeTransform(k.value, centerShift.value);
  overview.value = true;
  emit("update:overview", true);
  // First flush lays out the `is-overview` state — the 28px struts especially — but
  // naturalWidth is still 0, so k falls back to 1 and no scale is applied yet. Sample
  // the plane's scrollWidth *now*, with the gaps in place: measure it gapless and the
  // cards overflow by 28×(n-1) once the struts arrive.
  await nextTick();
  naturalWidth.value = p.scrollWidth;
  // Second flush applies the real k — scale + scaler width — and the browser paints
  // straight from the resting layout to the scaled one, so the zoom transition runs
  // without a full-size frame flashing in between.
  await nextTick();
  programmaticAt = Date.now(); // the remap below is ours; don't let onScroll read it as a swipe
  r.scrollLeft = fromScroll * k.value; // same point in the plane, zoomed out
  animateZoom(flipFrom(fromTransform, fromScroll, r.scrollLeft));
}

async function exitOverview(): Promise<void> {
  const r = rail.value;
  if (!r) return;
  markZoomBusy();
  const fromScroll = r.scrollLeft;
  // Read the transform *before* clearing overview — both k and centerShift depend on it.
  const fromTransform = planeTransform(k.value, centerShift.value);
  const scale = k.value;
  overview.value = false;
  emit("update:overview", false);
  programmaticAt = Date.now();
  await nextTick();
  r.scrollLeft = scale ? fromScroll / scale : fromScroll;
  programmaticAt = Date.now();
  // Land the focused column cleanly — `auto`, no glide: the transform animation below
  // is what carries the motion, and a competing smooth scroll makes the plane swim.
  if (props.focusedId) scrollToColumn(props.focusedId, "auto");
  // Read the scroll offset back rather than trusting the arithmetic: it's been clamped
  // against the new scroll extent and then possibly overwritten by the reveal above, and
  // the FLIP is only exact if it starts from where the rail *actually* is.
  animateZoom(flipFrom(fromTransform, fromScroll, r.scrollLeft));
}

function toggleOverview(): void {
  // Overview of a single column is theatre — the guard is why the shortcut and the
  // pinch both no-op on a one-pane board.
  if (props.panes.length < 2) return;
  // Ignore a toggle that lands mid-flight (see markZoomBusy) — reversing the zoom
  // halfway through is the shakiest thing this feature can do, and a pinch gesture
  // asks for it constantly.
  if (zoomBusy.value) return;
  cue("toggle");
  if (overview.value) void exitOverview();
  else void enterOverview();
}

const isResizing = ref(false);
let resizeEndTimer: ReturnType<typeof setTimeout> | null = null;
let resizeRaf = 0;
function onRailResize(): void {
  const width = rail.value?.clientWidth ?? 0;
  // Ignore the zero-width tick a hidden layer reports — keep the last real
  // width so the rail's padding/centre maths stay intact until it's shown again.
  if (width === 0) return;
  railWidth.value = width;
  isResizing.value = true;
  if (resizeEndTimer) clearTimeout(resizeEndTimer);
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    // A narrower window shrinks every `min(px, 100vw)` rung, so the plane the scaler is
    // sized to changed too — not just the viewport `k` is measured against.
    void remeasurePlane();
    if (props.focusedId) scrollToColumn(props.focusedId, "auto");
  });
  resizeEndTimer = setTimeout(() => {
    isResizing.value = false;
  }, 120);
}
useResizeObserver(rail, onRailResize);
onBeforeUnmount(() => {
  cancelAnimationFrame(resizeRaf);
  if (resizeEndTimer) clearTimeout(resizeEndTimer);
  if (settleTimer) clearTimeout(settleTimer);
  if (pinchQuiet) clearTimeout(pinchQuiet);
});

// Trackpad pinch toggles overview. On macOS a pinch arrives as a wheel event with
// `ctrlKey` synthesised true; accumulate its deltaY and cross a threshold once per
// gesture (resetting after a beat of quiet, and after any toggle, so one pinch can't
// flap the mode). Pinch out — fingers apart, negative deltaY — pulls the plane back
// into overview; pinch in collapses it. A plain two-finger scroll has no ctrlKey and
// falls straight through to the rail, untouched.
let pinchAccum = 0;
let pinchQuiet: ReturnType<typeof setTimeout> | null = null;
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey) return;
  e.preventDefault(); // otherwise the browser zooms the whole page
  if (props.panes.length < 2) return;
  // A pinch keeps delivering deltas long after it crossed the threshold. Swallow them
  // while the zoom is in flight *and* keep the accumulator at zero, or the tail of the
  // same gesture banks up and fires a second toggle the moment the plane lands.
  if (zoomBusy.value) {
    pinchAccum = 0;
    return;
  }
  pinchAccum += e.deltaY;
  if (pinchQuiet) clearTimeout(pinchQuiet);
  pinchQuiet = setTimeout(() => {
    pinchAccum = 0;
    pinchQuiet = null;
  }, 200);
  if (Math.abs(pinchAccum) < 40) return;
  const out = pinchAccum < 0;
  pinchAccum = 0;
  if (out && !overview.value) toggleOverview();
  else if (!out && overview.value) toggleOverview();
}
useEventListener(rail, "wheel", onWheel, { passive: false });

/** Which column owns the viewport at a scroll position — seam-first, like niri. */
function nearestKey(scrollLeft?: number): string | null {
  const r = rail.value;
  if (!r || !props.panes.length) return null;
  const mid = (scrollLeft ?? r.scrollLeft) + r.clientWidth / 2;
  const dir = scrollLeft === undefined ? 0 : Math.sign(scrollLeft - lastScrollLeft);
  // Column geometry is unscaled plane coordinates; the scroll position it's compared
  // against is scaled in overview. Same k correction as scrollTargetFor.
  const zoom = overview.value ? k.value : 1;

  let byCentre: string | null = null;
  let centreDist = Infinity;
  let seamOwner: string | null = null;
  let seamDist = Infinity;
  for (const s of props.panes) {
    const el = colEls.get(s.id);
    if (!el) continue;
    const centre = (el.offsetLeft + el.offsetWidth / 2) * zoom;
    const dist = Math.abs(centre - mid);
    if (dist < centreDist || (dist === centreDist && dir && Math.sign(centre - mid) === dir)) {
      centreDist = dist;
      byCentre = s.id;
    }
    const seam = (el.offsetLeft + el.offsetWidth) * zoom;
    const sd = seam - mid;
    if (sd >= 0 && sd < seamDist) {
      seamDist = sd;
      seamOwner = s.id;
    }
  }
  return seamOwner ?? byCentre;
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastScrollLeft = 0;
function onScroll(): void {
  closeJoint();
  if (isSolo.value) return;
  // In overview the scroll is either the entry/exit remap or arrow-follow, both
  // driven programmatically — the snap-on-release settle fighting the zoom just
  // reads as jank, so leave the position exactly where the maths put it.
  if (overview.value) return;
  if (isResizing.value) return;
  if (Date.now() - programmaticAt < 480) return;
  const left = rail.value?.scrollLeft ?? 0;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    // Re-check the programmatic-scroll guard at settle time, not just at scroll
    // time: a focus-driven scroll that landed after the swipe (an open, a click,
    // a re-centre) supersedes the settle. Without this, a stale settle snaps to
    // the pre-open position and can steal focus from a column the user just
    // opened — the board "opens but doesn't focus" race.
    if (Date.now() - programmaticAt < 480) return;
    const key = nearestKey(left);
    lastScrollLeft = left;
    if (!key) return;
    // A released swipe must land on a column boundary, never at whatever sub-pixel
    // offset the fingers stopped at — so the settle path always snaps, whether or
    // not it also changed focus. Crossing into a new column emits `focus` (the
    // registry owns that), but we can't lean on the focus watcher to tidy the
    // scroll: in `never`/`on-overflow` its `reveal` declines to move an
    // already-visible column, which would leave the strip clipped at both edges.
    // `snap` (centre in the centring modes, left edge in `never`) is the boundary.
    if (key !== props.focusedId) emit("focus", key);
    scrollToColumn(key, scrollBehavior(), "snap");
  }, 170);
}

watch(
  () => props.focusedId,
  (key, prev) => {
    // A focus change means the user (or an open) is directing the strip — a
    // swipe settle still pending must not override it and snap to a stale
    // column. The settle's own focus emit runs the watcher only on the next
    // tick, after its snap has already fired, so this never cancels a settle
    // in progress.
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    // Per-column zen: focus away collapses the outgoing column to its ladder rung
    // while the incoming one expands only if *it* is maximized. Flag both when their
    // rendered width changes so the glide doesn't snap.
    if (!reducedMotionOn()) {
      if (prev && (zenIds.value.has(prev) || (key && zenIds.value.has(key)))) {
        if (prev && prev !== key) flagWidthAnim(prev);
        if (key) flagWidthAnim(key);
      }
    }
    if (key) void nextTick(() => scrollToColumn(key));
  },
);
// Prune zen flags for panes that left — recycled ids must not inherit maximize.
watch(
  () => props.panes.map((p) => p.id).join("|"),
  (ids) => {
    const live = new Set(ids.split("|").filter(Boolean));
    const next = new Set([...zenIds.value].filter((id) => live.has(id)));
    if (next.size !== zenIds.value.size) zenIds.value = next;
  },
);
watch(
  () => props.panes.length,
  () => {
    void nextTick(() => {
      // A column arrived or left while the plane is zoomed out — ⌘N / ⌘⇧T / ⌘⇧N are
      // global and still fire in overview, so this is reachable, and a stale scaler
      // would strand the new card outside the scroll extent.
      void remeasurePlane();
      if (props.focusedId) scrollToColumn(props.focusedId);
    });
  },
);
// Switching centring mode changes both what a "good" scroll position is and how
// wide the trailing pad is (so scrollWidth shifts). Re-settle the focused column
// once the new pad has laid out — `auto`, because the change was a preference
// flip, not a navigation, and a smooth glide there reads as the strip lurching on
// its own. A stale position after a mode flip is the quickest way this looks broken.
watch(centerMode, () => {
  if (props.focusedId) void nextTick(() => scrollToColumn(props.focusedId, "auto"));
});
// Re-centre on reveal. While hidden the rail measured zero and skipped every
// scroll; once the board surface is shown again, re-read the width and snap the
// focused column back to centre (no animation — it was already there before the
// surface flip; this just restores what the zero-width guard held back).
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    void nextTick(() => {
      railWidth.value = rail.value?.clientWidth ?? railWidth.value;
      if (props.focusedId) scrollToColumn(props.focusedId, "auto");
    });
  },
);
onMounted(() => {
  railWidth.value = rail.value?.clientWidth ?? 0;
  if (props.focusedId) void nextTick(() => scrollToColumn(props.focusedId, "auto"));
});

function onColumnClick(key: string): void {
  // In overview a card is a button, not a document: clicking one always exits — even
  // the already-focused card — flying the plane back in onto it. Focus it first (only
  // if it changed) so exitOverview lands on the right column.
  if (overview.value) {
    if (key !== props.focusedId) {
      cue("select");
      emit("focus", key);
    }
    void exitOverview();
    return;
  }
  if (key === props.focusedId) return;
  cue("select");
  emit("focus", key);
}

// Enter/Space select a card in overview — it's a `role="button"` there, so the
// keyboard must activate it like any button.
function onCardKeydown(key: string, e: KeyboardEvent): void {
  if (!overview.value) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onColumnClick(key);
  }
}

/** Terminal I/O is the one pair of emits that speaks in session keys rather than pane
 *  ids (useTerminal keys its registry by session), so it goes through these instead of
 *  an inline arrow: the template's `c.session` check doesn't narrow inside a closure,
 *  and re-widening it with `!` is exactly how a pane id ends up on the wire again —
 *  which silently swallows every keystroke, because useTerminal's lookup just misses. */
function onTerminalWrite(pane: Pane, data: string): void {
  if (pane.kind !== "terminal" || !pane.session) return;
  emit("terminal-write", pane.session.key, data);
}
function onTerminalResize(pane: Pane, cols: number, rows: number): void {
  if (pane.kind !== "terminal" || !pane.session) return;
  emit("terminal-resize", pane.session.key, cols, rows);
}
function onTerminalRestart(pane: Pane): void {
  if (pane.kind !== "terminal" || !pane.session) return;
  emit("terminal-restart", pane.session.key);
}

function onClose(key: string): void {
  cue("collapse");
  emit("close", key);
}

function onArchive(c: Pane): void {
  if (c.kind !== "thread" || !c.session) return;
  cue("press");
  emit("archive", c.session.threadId.value, c.id);
}

// ── turn retry / resend / reload — the session's own send & open paths ───────
// ConversationThread never touches the send path; these forward its intents to
// the column's session, which owns send/openStored/start. `send` is the same
// function the composer uses, so a retry lands exactly like a fresh prompt.
function onRetryTurn(c: Pane, text: string): void {
  if (c.kind !== "thread") return;
  const s = c.session;
  if (!s || !text.trim() || s.busy.value) return;
  void s.send(text);
}
function onResendTurn(c: Pane, text: string): void {
  if (c.kind !== "thread") return;
  const s = c.session;
  if (!s || !text.trim() || s.busy.value) return;
  void s.send(text);
}
function onRetryLoad(c: Pane): void {
  if (c.kind !== "thread") return;
  const s = c.session;
  const id = anchoredThreadId(c);
  if (!s || !id) return;
  void s.openStored(id);
}
function onRetrySession(c: Pane): void {
  if (c.kind !== "thread") return;
  const s = c.session;
  if (!s) return;
  void s.start();
}
/** Windowed stored threads page their older history on demand — forward the
 *  thread's request to the session's loadOlder (the store read + prepend). */
function onLoadOlder(c: Pane): void {
  if (c.kind !== "thread") return;
  const s = c.session;
  if (!s || !s.hasOlder.value) return;
  void s.loadOlder();
}

/** The stored conversation this pane is anchored to — null for a fresh blank
 *  column. This is the discriminator ConversationThread needs: a thread whose
 *  transcript failed to load still carries its real stored id on the anchor,
 *  while a never-sent blank column's anchor remembers none. */
function anchoredThreadId(c: Pane): string | null {
  if (c.kind !== "thread") return null;
  const anchor = c.entry.anchor;
  return anchor.kind === "thread" ? anchor.threadId : null;
}

// ── thread rename ───────────────────────────────────────────────────────────
// A thread is renamed from its info panel's Name row; the strip owns the write
// because the column title is a live ref on the session. The new name lands
// optimistically and reverts if the store's renameThread says no.
async function onRename(title: string): Promise<void> {
  const s = infoSession.value;
  if (!s) return;
  const previous = s.title.value;
  s.title.value = title; // optimistic — the strip shows it immediately
  if (!import.meta.client) return;
  const api = window.koneDesktop?.agent;
  if (!api) return; // browser dev — no store to tell; the optimistic title stands
  try {
    const ok = await api.renameThread(s.threadId.value, title);
    if (ok === false) s.title.value = previous;
  } catch {
    s.title.value = previous; // bridge hiccup — never keep a title the store lost
  }
}

// The thread-info drop-down: clicking a column title toggles a panel anchored
// beneath it. We keep the opening title's viewport rect as the anchor and the
// session itself (its refs stay live while the panel is open).
const infoPaneId = ref<string | null>(null);
const infoAnchor = ref<DOMRect | null>(null);
const infoSession = shallowRef<ThreadSession | null>(null);
function toggleInfo(c: Pane, ev: Event): void {
  if (c.kind !== "thread") return;
  if (infoPaneId.value === c.id) {
    closeInfo();
    return;
  }
  // SAFETY: toggleInfo is bound to the pane title's <h2> element, so
  // currentTarget is that HTMLElement during dispatch (nulled after — hence
  // | null before the guard below).
  const el = ev.currentTarget as HTMLElement | null;
  if (!el || !c.session) return;
  infoAnchor.value = el.getBoundingClientRect();
  infoSession.value = c.session;
  infoPaneId.value = c.id;
}
function closeInfo(): void {
  infoPaneId.value = null;
  infoAnchor.value = null;
  infoSession.value = null;
}

function onInsertColumn(seamIndex: number, kind: "thread" | "terminal" | "scratchpad"): void {
  cue("press");
  emit("insert-column", seamIndex, kind);
}

// ── seam insert flyout ────────────────────────────────────────────────────────
const openSeam = ref<number | null>(null);
const menuAnchor = ref({ x: 0, y: 0 });

function closeJoint(): void {
  openSeam.value = null;
}

function toggleJoint(i: number, target: EventTarget | null): void {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return;
  if (openSeam.value === i) {
    closeJoint();
    cue("collapse");
    return;
  }
  const rect = el.getBoundingClientRect();
  menuAnchor.value = {
    // The leading seam (-1) unfolds rightward, so anchor its card to the seam's
    // right edge; every trailing seam unfolds leftward from its left edge.
    x: i === -1 ? rect.right : rect.left,
    y: rect.top + rect.height / 2,
  };
  openSeam.value = i;
  cue("expand");
}

function onInsertPick(kind: "thread" | "terminal" | "scratchpad"): void {
  if (openSeam.value === null) return;
  onInsertColumn(openSeam.value, kind);
  closeJoint();
}

// ── keyboard ──────────────────────────────────────────────────────────────────
const { matchesShortcut, bindingFor, displayTokens } = useShortcuts();

function isTyping(): boolean {
  // SAFETY: only tagName and isContentEditable are read; a non-HTMLElement
  // focus target simply fails both checks and yields false.
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (matchesShortcut("focus-thread-left", e)) {
    e.preventDefault();
    cue("press");
    return emit("shift", -1);
  }
  if (matchesShortcut("focus-thread-right", e)) {
    e.preventDefault();
    cue("press");
    return emit("shift", 1);
  }
  if (matchesShortcut("move-thread-left", e)) {
    e.preventDefault();
    cue("press");
    return emit("move", -1);
  }
  if (matchesShortcut("move-thread-right", e)) {
    e.preventDefault();
    cue("press");
    return emit("move", 1);
  }
  if (matchesShortcut("cycle-thread-width", e)) {
    e.preventDefault();
    if (props.focusedId) cycleWidth(props.focusedId);
    return;
  }
  if (matchesShortcut("grow-thread-width", e)) {
    e.preventDefault();
    if (props.focusedId) growWidth(props.focusedId);
    return;
  }
  if (matchesShortcut("shrink-thread-width", e)) {
    e.preventDefault();
    if (props.focusedId) shrinkWidth(props.focusedId);
    return;
  }
  if (matchesShortcut("maximize-thread", e)) {
    e.preventDefault();
    toggleZen();
    return;
  }
  if (matchesShortcut("toggle-overview", e)) {
    e.preventDefault();
    toggleOverview();
    return;
  }
  // Escape precedence: overview wins. It sits above the zen branch so a single Esc
  // exits overview and never also drops zen in the same press (they can't both be on
  // — entering overview clears zen — but the ordering keeps that guarantee explicit).
  if (e.key === "Escape" && overview.value) {
    e.preventDefault();
    void exitOverview();
    return;
  }
  // Esc leaves zen — but only swallow the event while zen is actually on, so the
  // rest of the time Escape still bubbles up to close a modal or the settings drawer.
  if (e.key === "Escape" && props.focusedId && zenIds.value.has(props.focusedId)) {
    e.preventDefault();
    toggleZen();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping()) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    cue("press");
    emit("shift", -1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    cue("press");
    emit("shift", 1);
  }
});

function brandOf(c: Pane) {
  if (c.kind !== "thread" || !c.session) return "generic";
  return SESSION_BRAND[c.session.provider.value] ?? "generic";
}

/** Is a pane of this kind already on the strip? Drives the seam menu's greying
 *  of singleton kinds (the scratchpad, today). */
function hasKind(kind: PaneKind): boolean {
  return props.panes.some((c) => c.kind === kind);
}
/** The project's single scratchpad is on the strip — the seam menu greys its row. */
const hasScratchpad = computed(() => {
  const singleton = PANE_KINDS.find((m) => m.singleton);
  return singleton ? hasKind(singleton.kind) : false;
});

function columnLabel(c: Pane): string {
  if (c.kind === "thread") {
    const title = c.session?.title.value || "New thread";
    return c.session?.isSideChat.value ? `Side chat · ${title}` : title;
  }
  return paneKindMeta(c.kind).label;
}

// ── bare-board chooser ──────────────────────────────────────────────────────
// The same pane-kind registry the seam menu offers, laid out as a centered pick
// for a desktop with no windows at all. No singleton greying here: the chooser
// only shows on a zero-pane board, so nothing is ever already open.
//
// On white, the plasma's ridge veins read as a soft cloud; on near-black the
// same veins glow as high-contrast filaments — the same tuning as the
// projects-list empty state, so the bare board shares its ambient floor.
const { scheme } = useTheme();
const plasmaOpacity = computed(() => (scheme.value === "dark" ? 0.5 : 1));

// Everything before the folder's own name in the project path — the faded lead
// of the chooser pill. The trailing separator is kept so the two spans read as
// one continuous path; null when there is no parent (a root-level project).
const chooserDir = computed(() => {
  if (!props.projectPath) return null;
  const cut = props.projectPath.lastIndexOf("/");
  if (cut <= 0) return null;
  return props.projectPath.slice(0, cut + 1);
});

const chooserActions = computed(() =>
  PANE_KINDS.map((meta) => ({
    kind: meta.kind,
    label: meta.insertLabel,
    icon: meta.icon,
    // The kind's own shortcut, resolved through any user rebind and split into
    // display chips (⌘-glyphs on mac, words elsewhere) — so the empty state
    // teaches the gesture that opens each column.
    keys: displayTokens(bindingFor(meta.shortcutId)),
  })),
);
function onChoose(kind: PaneKind): void {
  cue("press");
  emit("choose", kind);
}

/** Every column is closeable: the board is a desktop, so closing the last window
 *  leaves it bare and the chooser takes over. Nothing is respawned behind it. */
function canClose(): boolean {
  return true;
}

/** Is any blank thread column on the board? Drives the seam menu's greyed
 *  "New thread" row (L3) — board-wide, not only when it's the lone column. */
const hasBlankThread = computed(() => props.panes.some((p) => isBlankThread(p)));

function paneThreadId(p: Pane): string | null {
  if (p.kind !== "thread") return null;
  return p.session?.threadId.value ?? (p.entry.anchor.kind === "thread" ? p.entry.anchor.threadId : null);
}

function paneSideChatSource(p: Pane): string | null {
  if (p.kind !== "thread") return null;
  return (
    p.session?.sideChatSource.value ??
    (p.entry.anchor.kind === "thread" ? p.entry.anchor.sideChatSource ?? null : null)
  );
}

function isLinkedToNext(i: number): boolean {
  if (i < 0 || i >= props.panes.length - 1) return false;
  const current = props.panes[i];
  const next = props.panes[i + 1];
  if (!current || !next) return false;
  if (current.kind !== "thread" || next.kind !== "thread") return false;

  const nextSource = paneSideChatSource(next);
  if (!nextSource) return false;

  const currentId = paneThreadId(current);
  const currentSource = paneSideChatSource(current);

  return nextSource === currentId || (Boolean(currentSource) && currentSource === nextSource);
}
</script>

<template>
  <div class="strip" :class="{ 'is-resizing': isResizing, 'is-overview': overview }">
    <!-- Overview is a mode, not a dialog — announce it politely for screen readers
         rather than trapping focus. Empty (not removed) when off so the region
         stays in the tree and the change is what's announced. -->
    <span class="sr-only" aria-live="polite">{{
      overview ? `Overview — ${panes.length} columns` : ""
    }}</span>
    <nav v-if="!chooser && (panes.length > 1 || repo)" class="index" aria-label="Columns">
      <div v-if="panes.length > 1" class="index__dashes">
        <button
          v-for="(c, i) in panes"
          :key="c.id"
          type="button"
          class="index__dash"
          :class="[
            paneKindMeta(c.kind).dashClass,
            {
              'is-focused': c.id === focusedId,
              'is-dormant': !c.session && c.id !== focusedId,
              'is-live': c.kind === 'thread' && !!c.session && c.session.busy.value && c.id !== focusedId,
              'is-pulse': c.id === props.pulseKey,
              'is-sidechat': c.kind === 'thread' && !!c.session?.isSideChat.value,
            },
          ]"
          :aria-label="`Column ${i + 1}: ${columnLabel(c)}`"
          :aria-current="c.id === focusedId"
          @click="onColumnClick(c.id)"
        />
      </div>
      <span v-if="repo" class="index__project" :title="projectPath">{{ repo }}</span>
    </nav>

    <!-- Solo: leading pad centres the thread. Multi: tile from the left, trailing
         pad lets the rightmost column scroll to centre when focused. -->
    <div
      ref="rail"
      class="rail"
      :class="{ 'is-solo': isSolo, 'is-overview': overview, 'is-zooming': isZooming }"
      :style="railPads"
      @scroll="onScroll"
    >
      <!-- Two-element wrap so the scaled plane and the layout footprint it occupies
           are separate boxes: the scaler carries the shrunken width (so the rail's
           scrollWidth shrinks with k), the plane is the real flex row we scale in
           place. Keep the plane's x-origin at 0 — no position, no padding-inline —
           or every offsetLeft the scroll maths reads silently changes meaning. -->
      <div class="rail__scaler" :style="scalerStyle">
        <div ref="plane" class="rail__plane" :style="planeStyle">
          <div class="rail__pad rail__pad--start" aria-hidden="true" />

          <template v-for="(c, i) in panes" :key="c.id">
            <!-- Leading seam — first column only. Every column carries a trailing
                 seam (below) that inserts to its right; without borders that seam is
                 also the one visible mark of a column's right edge. The leftmost
                 column's left edge — the board's own left bound — has no such mark, so
                 mirror a seam there. Insert index -1 → `seamIndex + 1` = 0, the left
                 edge (useStudio clamps `at` to [0, length]). -->
            <button
              v-if="i === 0"
              type="button"
              class="col-joint col-joint--lead"
              aria-label="Insert column at start"
              aria-haspopup="dialog"
              :aria-expanded="openSeam === -1"
              :inert="overview"
              @click.stop="toggleJoint(-1, $event.currentTarget)"
            >
              <span class="col-joint__pill" aria-hidden="true" />
            </button>
            <section
              :ref="(el) => setCol(c.id, el)"
              class="col"
              :data-column-key="c.id"
              :class="{
                'is-focused': c.id === focusedId,
                'is-width-anim': widthAnim[c.id],
                'is-sidechat': c.kind === 'thread' && !!c.session?.isSideChat.value,
              }"
              :style="{ '--col-w': presetFor(c.id).width }"
              :role="overview ? 'button' : undefined"
              :tabindex="overview ? 0 : undefined"
              :aria-label="overview ? columnLabel(c) : undefined"
              @click="onColumnClick(c.id)"
              @keydown="onCardKeydown(c.id, $event)"
            >
              <!-- In overview the card is a single button; `inert` (not just the visual
                   opacity: 0 on the tools) removes its inner controls from tab order and
                   the a11y tree, so tabbing steps card → card and the outer role="button"
                   no longer wraps focusable descendants (which would be invalid ARIA). -->
              <header class="col__head" :inert="overview">
                <div class="col__title-wrap">
                  <template v-if="c.kind === 'thread' && c.session">
                    <ProviderLogo :brand="brandOf(c)" :size="15" />
                    <span
                      v-if="c.session.isSideChat.value"
                      class="col__sidechat"
                      :title="'Side chat — forked from a conversation'"
                    >
                      <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="11" :stroke-width="2" aria-hidden="true" />
                    </span>
                    <!-- The title opens the info panel — which is also where it
                         gets renamed, so the header itself stays a read-out. -->
                    <h2
                      class="col__title col__title--btn"
                      :title="c.session.title.value || 'New thread'"
                      role="button"
                      tabindex="0"
                      :aria-expanded="infoPaneId === c.id"
                      @click.stop="toggleInfo(c, $event)"
                      @keydown.enter.prevent="toggleInfo(c, $event)"
                      @keydown.space.prevent="toggleInfo(c, $event)"
                    >{{ c.session.title.value || "New thread" }}</h2>
                    <ContextWindowMeter
                      v-if="c.session.tokenUsage.value"
                      :usage="c.session.tokenUsage.value"
                    />
                  </template>
                  <template v-else>
                    <HugeiconsIcon :icon="paneKindMeta(c.kind).icon" :size="15" :stroke-width="2" class="text-muted" />
                    <h2 class="col__title">{{ columnLabel(c) }}</h2>
                    <!-- A terminal's live subprocess (vim, `npm run dev`): one
                         quiet dot + dim command name. Deliberately tiny and
                         muted — it must not fight the terminal for attention. -->
                    <span
                      v-if="c.kind === 'terminal' && c.session?.hasRunningSubprocess"
                      class="col__busy"
                      :title="c.session.childCommandLabel ? `Running: ${c.session.childCommandLabel}` : 'Running a command'"
                    >
                      <span class="col__busy-dot" aria-hidden="true" />
                      <span v-if="c.session.childCommandLabel" class="col__busy-label">{{ c.session.childCommandLabel }}</span>
                    </span>
                  </template>
                </div>
                <div class="col__tools">
                  <button
                    v-if="!isSideChatPane(c.id)"
                    type="button"
                    class="col__tool col__tool--width"
                    :disabled="isZen(c.id)"
                    :aria-label="isZen(c.id) ? 'Width — maximized' : `Cycle width (currently ${presetFor(c.id).px}px)`"
                    :title="isZen(c.id) ? 'Maximized' : `Width: ${presetFor(c.id).px}px`"
                    @click.stop="cycleWidth(c.id)"
                  >
                    {{ presetFor(c.id).label }}
                  </button>
                  <button
                    v-if="c.kind === 'terminal' && c.session"
                    type="button"
                    class="col__tool"
                    aria-label="Restart terminal"
                    title="Restart terminal"
                    @click.stop="onTerminalRestart(c)"
                  >
                    <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <button
                    v-if="c.id === focusedId && !isSideChatPane(c.id)"
                    type="button"
                    class="col__tool"
                    :aria-label="isZen(c.id) ? 'Restore column' : 'Maximize column'"
                    :title="isZen(c.id) ? 'Restore column' : 'Maximize column'"
                    @click.stop="toggleZen()"
                  >
                    <HugeiconsIcon
                      :icon="isZen(c.id) ? ArrowShrink01Icon : ArrowExpand01Icon"
                      :size="13"
                      :stroke-width="2"
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    v-if="
                      c.kind === 'thread' &&
                      c.session &&
                      !isBlankThread(c) &&
                      !c.session.isSideChat.value
                    "
                    type="button"
                    class="col__tool"
                    aria-label="Open a side chat"
                    title="Open a side chat"
                    @click.stop="emit('side-chat', c.id)"
                  >
                    <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <button
                    v-if="c.kind === 'thread' && c.session && !isBlankThread(c)"
                    type="button"
                    class="col__tool"
                    aria-label="Archive conversation"
                    title="Archive conversation"
                    @click.stop="onArchive(c)"
                  >
                    <HugeiconsIcon :icon="Archive02Icon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <button
                    v-if="canClose()"
                    type="button"
                    class="col__tool"
                    aria-label="Close column"
                    title="Close column"
                    @click.stop="onClose(c.id)"
                  >
                    <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div
                class="col__body selectable"
                :class="paneKindMeta(c.kind).bodyClass"
                :data-column-type="c.kind"
                :inert="overview"
              >
                <template v-if="c.kind === 'thread' && c.session">
                  <ConversationThread
                    :blocks="c.session.timelineBlocks.value"
                    :now="now"
                    :session-error="c.session.error.value"
                    :source-key="c.id"
                    :thread-id="anchoredThreadId(c)"
                    :load-failed="c.session.transcriptLoadFailed.value"
                    :agent-seed="c.session.threadId.value"
                    :loading="c.session.sessionState.value === 'starting'"
                    :busy="c.session.busy.value"
                    :queued="c.session.queuedTurns.value"
                    :has-older="c.session.hasOlder.value"
                    :loading-older="c.session.loadingOlder.value"
                    :older-error="c.session.olderError.value"
                    @to-scratchpad="(text) => emit('to-scratchpad', text, c.id)"
                    @retry="(text) => onRetryTurn(c, text)"
                    @resend="(text) => onResendTurn(c, text)"
                    @retry-load="() => onRetryLoad(c)"
                    @retry-session="() => onRetrySession(c)"
                    @load-older="() => onLoadOlder(c)"
                  />
                </template>
                <template v-else-if="c.kind === 'terminal' && c.session">
                  <TerminalPane
                    :session="c.session"
                    @write="(data) => onTerminalWrite(c, data)"
                    @resize="(cols, rows) => onTerminalResize(c, cols, rows)"
                  />
                </template>
                <template v-else-if="c.kind === 'scratchpad' && c.session">
                  <ScratchpadPane
                    :session="c.session"
                    @flush="emit('scratchpad-flush', c.id)"
                  />
                </template>
                <!-- Dormant: the pane is restored but nothing has attached yet.
                     Threads attach when the board is shown (and on focus if they
                     were evicted past the resident cap) — "Opening…" is that
                     brief load, not a resting state. A dormant scratchpad shows
                     nothing (its empty-state idiom is an empty page); a terminal
                     invites the click that starts its PTY. -->
                <template v-else-if="c.kind === 'terminal'">
                  <p class="col__dormant">Terminal ready — click to open a shell.</p>
                </template>
                <template v-else-if="c.kind === 'thread'">
                  <p class="col__dormant">Opening…</p>
                </template>
              </div>

              <!-- The card's true-size caption. Card content scaled to k is illegible
                   mush; a crisp label under each card is what makes the zoom read as a
                   designed overview and not a broken shrink. It lives *inside* the scaled
                   plane, so counter-scaling by 1/k (via --inv-k, published once on the
                   plane) parks it back at ~12.5px on screen — rendering it outside the
                   plane would need manual x-positioning that desyncs during the zoom. -->
              <span
                v-if="overview"
                class="col__map-label"
                aria-hidden="true"
              >
                <ProviderLogo
                  v-if="c.kind === 'thread'"
                  :brand="brandOf(c)"
                  :size="13"
                  class="col__map-logo"
                />
                <span class="col__map-text">{{ columnLabel(c) }}</span>
              </span>
            </section>

            <template v-if="isLinkedToNext(i)">
              <div
                class="col-joint col-joint--linked"
                aria-label="Linked to conversation"
                title="Linked to conversation"
                :inert="overview"
              >
                <span class="col-joint__link" aria-hidden="true">
                  <HugeiconsIcon :icon="Link05Icon" :size="12" :stroke-width="2.2" />
                </span>
              </div>
            </template>
            <button
              v-else
              type="button"
              class="col-joint"
              aria-label="Insert column"
              aria-haspopup="dialog"
              :aria-expanded="openSeam === i"
              :inert="overview"
              @click.stop="toggleJoint(i, $event.currentTarget)"
            >
              <span class="col-joint__pill" aria-hidden="true" />
            </button>
          </template>

          <div class="rail__pad rail__pad--end" aria-hidden="true" />
        </div>
      </div>
    </div>

    <!-- Ambient floor glow for the zoomed-out overview — the same plasma the
         bare board and the projects-list empty state rise off, so the spread of
         cards doesn't read as a bland empty grid. Sits behind the cards, never
         takes pointer events; only mounted while zoomed out. -->
    <AnimatePresence>
      <motion.div
        v-if="overview"
        class="overview__plasma pointer-events-none"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :exit="{ opacity: 0, transition: { duration: 0.4 } }"
        :transition="{ duration: 1.4, delay: 0.2, ease: 'easeOut' }"
      >
        <ClosingPlasma
          class="size-full"
          :interactive="false"
          :speed="0.55"
          :turbulence="0.85"
          :grain="0.4"
          :sparkle="0.35"
          :opacity="plasmaOpacity"
        />
      </motion.div>
    </AnimatePresence>

    <!-- Bare desktop — every window closed, zero panes. Offer the same pick the
         seam menu gives (thread / terminal / scratchpad), centered. The rail
         stays mounted behind this so it keeps measuring. -->
    <div v-if="chooser" class="chooser" role="dialog" aria-label="Start a column">
      <!-- Ambient close: the warm plasma glow from the projects-list empty
           state rises off the bare board's floor and dissolves into the ground,
           giving the empty desktop depth without a hard edge. Purely
           decorative — never intercepts pointer events, sits behind the pick. -->
      <motion.div
        class="chooser__plasma pointer-events-none"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :transition="{ duration: 1.4, delay: 0.2, ease: 'easeOut' }"
      >
        <ClosingPlasma
          class="size-full"
          :interactive="false"
          :speed="0.55"
          :turbulence="0.85"
          :grain="0.4"
          :sparkle="0.35"
          :opacity="plasmaOpacity"
        />
      </motion.div>
      <div class="chooser__panel">
        <!-- The row this empty board belongs to, named above the pick — the
             chooser covers the whole surface, so without it nothing says
             which project you'd be starting a column in. -->
        <p v-if="repo" class="chooser__pill" :title="projectPath">
          <HugeiconsIcon :icon="Folder01Icon" :size="15" :stroke-width="1.7" aria-hidden="true" />
          <span class="chooser__path">{{ chooserDir }}</span>
          <span class="chooser__title">{{ repo }}</span>
          <template v-if="branch">
            <span class="chooser__sep" aria-hidden="true"></span>
            <HugeiconsIcon
              :icon="GitBranchIcon"
              :size="13"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            <span class="chooser__branch">{{ branch }}</span>
          </template>
        </p>
        <div class="chooser__actions">
          <!-- Each row leans gently toward the cursor as it approaches, then
               eases back — the same magnet pull the app's other action rows
               ride (start actions, lane actions, folder rows). -->
          <Magnet
            v-for="action in chooserActions"
            :key="action.kind"
            class="block w-full"
            inner-class="w-full"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              class="chooser__row"
              @click="onChoose(action.kind)"
            >
              <span class="chooser__row-lead">
                <HugeiconsIcon :icon="action.icon" :size="16" :stroke-width="1.9" aria-hidden="true" />
              </span>
              <span class="chooser__row-label">{{ action.label }}</span>
              <span v-if="action.keys.length" class="chooser__keys" aria-hidden="true">
                <kbd v-for="(k, ki) in action.keys" :key="ki" class="chooser__key">{{ k }}</kbd>
              </span>
            </button>
          </Magnet>
        </div>
      </div>
    </div>

    <ThreadInsertMenu
      :open="openSeam !== null"
      :x="menuAnchor.x"
      :y="menuAnchor.y"
      :side="openSeam === -1 ? 'right' : 'left'"
      :scratchpad-open="hasScratchpad"
      :blank-thread-open="hasBlankThread"
      @close="closeJoint"
      @pick="onInsertPick"
    />

    <ThreadInfoPanel
      v-if="infoSession && infoAnchor"
      :session="infoSession"
      :anchor="infoAnchor"
      :repo="repo"
      :branch="branch"
      :origin="origin"
      @close="closeInfo"
      @rename="onRename"
    />
  </div>
</template>

<style scoped>
.strip {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  height: 100%;
  overflow: hidden;
  /* Entering overview dips the backdrop (see .strip.is-overview); ease it so the
     mode change settles rather than flashing. */
  transition: background-color 0.4s ease;
}

.index {
  position: absolute;
  top: 1.7rem;
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  align-items: center;
  pointer-events: none;
  transition: opacity 0.28s ease;
}
.index__dashes {
  display: flex;
  align-items: center;
  gap: 6px;
}
.index__project {
  position: absolute;
  right: 2rem;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
  user-select: none;
  pointer-events: auto;
  transition: color 0.18s ease;
}
.index__dash {
  pointer-events: auto;
  cursor: pointer;
  position: relative;
  width: 13px;
  height: 2px;
  border-radius: 999px;
  -webkit-tap-highlight-color: transparent;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.3s ease;
}
/* A 2px hairline is not a pointer target. Expand the clickable box off-layout —
   half the 6px gutter on each side, so neighbouring dashes meet without
   overlapping — leaving the mark itself the size it wants to be. */
.index__dash::after {
  content: "";
  position: absolute;
  inset: -8px -3px;
}
.index__dash:hover {
  background: color-mix(in srgb, var(--ink) 34%, transparent);
}
/* Keyboard arrival has to be visible: the strip's nav is otherwise a row of
   near-identical hairlines. */
.index__dash:focus-visible {
  outline: none;
  width: 24px;
  background: var(--accent);
}
.index__dash.is-focused {
  width: 24px;
  background: var(--ink);
}
.index__dash.is-pad {
  width: 10px;
  height: 2px;
}
/* A dormant pane (restored, not yet attached) reads even quieter than a resting
   dash — present, but clearly "asleep". */
.index__dash.is-dormant {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.index__dash.is-dormant:hover {
  background: color-mix(in srgb, var(--ink) 22%, transparent);
}
.index__dash.is-pulse {
  animation: dash-pulse 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes dash-pulse {
  0%,
  100% {
    background: color-mix(in srgb, var(--ink) 16%, transparent);
  }
  40% {
    background: var(--accent);
    width: 18px;
  }
}
.index__dash.is-live {
  background: var(--accent);
  animation: dash-breathe 1.9s ease-in-out infinite;
}
@keyframes dash-breathe {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

/* Empty-board chooser — an opaque layer over the rail, its pick stack centred.
   Borderless and soft, in keeping with the rest of the board (no card, no
   divider, no heavy shadow). */
.chooser {
  position: absolute;
  inset: 0;
  z-index: 15;
  display: grid;
  place-items: center;
  background: var(--ground);
  padding: 3.5rem 1rem 1rem;
  overflow: hidden;
}
/* The ambient plasma — same floor glow as the projects-list empty state:
   anchored to the chooser's bottom edge, masked so it dissolves into the
   ground. Sits behind the pick stack, never takes pointer events. */
.chooser__plasma {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  z-index: 0;
  height: 42vh;
  max-height: 380px;
  min-height: 220px;
  mask-image: linear-gradient(to bottom, transparent, black 55%);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 55%);
}
.chooser__panel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  /* Wider than the action column: the identity pill above it carries a whole
     path + branch, and crushing it to 16rem ellipsized both into noise. The
     actions keep their own 16rem column, centred, so the pick stack is
     unchanged. */
  width: min(30rem, 100%);
}
.chooser__pill {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  min-width: 0;
  max-width: 100%;
  margin: 0 auto 1.15rem;
  color: var(--ink);
}
.chooser__pill > svg {
  align-self: center;
  flex: none;
}
.chooser__path {
  overflow: hidden;
  flex: 0 1 auto;
  min-width: 0;
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 450;
  letter-spacing: -0.005em;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Truncate from the front, not the end: when space runs out, what must
     survive is the segments nearest the project name — "/…/Developer/" says
     more than "/Users/gideonsar…". Reversing the direction moves the ellipsis
     to the left edge while the Latin text itself still lays out left-to-right. */
  direction: rtl;
  text-align: left;
}
.chooser__title {
  flex: none;
  font-family: var(--font-serif);
  font-optical-sizing: auto;
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
/* The branch tail — a hairline divider, then the checked-out branch beside its
   glyph. Quieter than the name but firmer than the path: it is state, not
   location, and it changes as you work. */
.chooser__sep {
  align-self: center;
  width: 1px;
  height: 13px;
  background: color-mix(in srgb, var(--ink) 14%, transparent);
}
.chooser__branch {
  max-width: 14rem;
  overflow: hidden;
  color: var(--ink-soft);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chooser__actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(16rem, 100%);
  margin: 0 auto;
}
.chooser__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: var(--ink-soft);
  background: transparent;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.chooser__row:hover {
  background: var(--hover);
  color: var(--ink);
}
.chooser__row-lead {
  display: inline-flex;
  flex: none;
  color: var(--muted);
}
.chooser__row:hover .chooser__row-lead {
  color: var(--ink-soft);
}
.chooser__row-label {
  min-width: 0;
  flex: 1;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.chooser__keys {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
.chooser__row:hover .chooser__keys {
  opacity: 1;
}
.chooser__key {
  display: inline-grid;
  place-items: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}

.rail {
  /* Just the scroll container now — the flex layout moved down onto the plane so a
     transform on the plane can shrink what this scrolls against (see rail__scaler). */
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  /* Scroll anchoring is a fight we can only lose here. Entering overview changes the
     scroll extent and the struts in the same frame we assign scrollLeft ourselves; the
     browser's anchor node then "helpfully" adjusts the offset again on top of that, and
     the two corrections beat against each other for a few frames as visible judder. */
  overflow-anchor: none;
}
.rail.is-solo {
  overflow-x: hidden;
}
.rail::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* The layout footprint. Resting it's `max-content` — exactly the width the flex row
   used to size the rail to, so the non-overview layout is pixel-identical to before
   this wrapper existed. In overview it becomes the scaled width (naturalWidth × k),
   which is what shrinks the rail's scrollWidth so there's no dead scroll region. */
/* Deliberately *not* transitioned. Animating this width would animate the rail's scroll
   extent, and a scroll container whose extent shrinks under a scrollLeft that's near the
   end clamps that offset again on every single frame — which is felt as the whole plane
   juddering sideways through the zoom. The footprint snaps to its final value instead and
   the motion is carried entirely by the plane's transform (see animateZoom). Left-anchored
   in both modes: centring, when the scaled plane doesn't fill the rail, is a transform too
   (see centerShift) so it can interpolate with the scale rather than stepping on frame 0. */
.rail__scaler {
  /* no width transition — see above */
}
/* The real, unscaled flex row. In overview it keeps its true width and is scaled into
   the (smaller) scaler from its left edge. Its x-origin must stay at 0.

   `transform` isn't transitioned here either: the zoom is a FLIP driven from script
   (animateZoom), because the scroll remap that goes with it isn't animatable and a plain
   CSS transition would glide the scale while the scroll jumped. What *is* transitioned is
   the part of the change a transform can't express — the struts opening between cards —
   plus `--inv-k`, so the card chrome counter-scales continuously instead of snapping to
   its final size on the first frame. Same duration and curve as the zoom, so the three
   read as one motion. */
.rail__plane {
  display: flex;
  align-items: stretch;
  gap: 0;
  height: 100%;
  transform-origin: 0 50%;
  transition:
    gap 420ms cubic-bezier(0.22, 1, 0.36, 1),
    --inv-k 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* Struts. The strip is deliberately gapless — that borderlessness is the house
   aesthetic — which is exactly why the overview needs gaps: they're what let the
   cards read as separate objects. The plane's natural width grows by the gaps, so
   naturalWidth is sampled *after* they're applied (see enterOverview). The gap stays in
   plane px on purpose: it feeds naturalWidth, which feeds k — a counter-scaled gap would
   be circular. The gutter that frames the plane is handled the same way, in railPads.

   There is deliberately no `padding-block` here. An earlier version bought vertical room
   for the captions that way, and it was the worst jolt in the feature: padding on the
   plane shortens every column, so on the first frame of the zoom every pane inside every
   column relaid out — conversations reflowed, terminals re-fit — while the plane was
   still gliding. The scale already leaves (1 − k) of vertical slack to seat the captions
   in, and OVERVIEW_LIFT_PX nudges the cards up off the centre line using the transform.
   Column heights now never change between modes. */
.rail.is-overview .rail__plane {
  gap: 28px;
}
/* Promote to a compositor layer only while the zoom is actually animating — leaving
   will-change on would hold a layer per column, terminals included, all session.
   Pointer events go quiet for the same window: the plane sweeps cards under a stationary
   cursor, and each one that crosses it would fire its hover lift mid-flight. */
.rail.is-zooming .rail__plane {
  will-change: transform;
  pointer-events: none;
}
.rail__pad {
  flex: none;
}
/* Both pads glide. The end pad used to change instantly, which meant entering overview —
   where it collapses from half a screen to the gutter — moved the whole scroll extent in
   one step under a plane that was still easing. Matching the zoom's curve and duration
   makes the two halves of the change one gesture. */
.rail__pad--start {
  width: var(--rail-pad-start, 0px);
  transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
.rail__pad--end {
  width: var(--rail-pad-end, 0px);
  transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
.strip.is-resizing .rail__pad--start,
.strip.is-resizing .rail__pad--end {
  transition: none;
}

.col {
  position: relative; /* containing block for the overview caption; inert otherwise */
  display: flex;
  min-width: 0;
  flex: 0 0 var(--col-w);
  flex-direction: column;
  height: 100%;
  padding-top: 3.5rem;
  transition:
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s ease;
}
.col.is-width-anim {
  transition:
    flex-basis 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s ease;
}
.strip.is-resizing .col {
  transition: none;
}
.col:not(.is-focused) {
  cursor: pointer;
  opacity: 0.34;
  filter: saturate(0.7);
  transform: scale(0.985);
}
.col:not(.is-focused):hover {
  opacity: 0.52;
}

/* Seam trigger — fixed footprint; the insert menu floats above the rail. */
.col-joint {
  flex: none;
  align-self: center;
  z-index: 8;
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 14px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
}
.col-joint__pill {
  width: 5px;
  height: 18px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 32%, transparent);
  transition:
    background-color 0.2s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.col-joint:hover .col-joint__pill,
.col-joint[aria-expanded="true"] .col-joint__pill {
  background: color-mix(in srgb, var(--ink) 48%, transparent);
  transform: scaleY(1.08);
}

.col-joint--linked {
  cursor: default;
  pointer-events: none;
  width: 14px;
}
.col-joint__link {
  display: grid;
  place-items: center;
  width: 14px;
  height: 18px;
  color: color-mix(in srgb, var(--accent) 76%, var(--ink-soft));
  background: transparent;
  transition: color 0.25s ease;
}

.col__head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  min-width: 0;
  padding: 0 0.4rem 0.85rem;
}
.col__title-wrap {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  max-width: calc(100% - 3.25rem);
  justify-self: center;
}
.col__title-wrap :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.col__title {
  margin: 0;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--muted);
  transition: color 0.3s ease;
}
.col.is-focused .col__title {
  color: var(--ink);
}

.col__title--btn {
  cursor: pointer;
}
.col__title--btn:hover {
  color: var(--ink);
}
.col__title--btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 2px;
  border-radius: 6px;
}

/* ── side chats: the temporary look ────────────────────────────────────────────
   A side chat is a forked, throwaway conversation — a question asked on the
   side. It reads as provisional chrome: the side-chat icon beside the title, an
   italic accent-tinted title and a faint accent wash over the body. No text, no
   borders — the icon carries the signal. Deliberately distinct from a main
   thread column — the user should never wonder whether this column is a real
   conversation. */
.col__sidechat {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: color-mix(in srgb, var(--accent) 72%, var(--ink-soft));
}
.col.is-sidechat .col__title {
  color: color-mix(in srgb, var(--accent) 58%, var(--muted));
  font-style: italic;
  font-weight: 560;
}
.col.is-focused .col.is-sidechat .col__title,
.col.is-sidechat.is-focused .col__title {
  color: color-mix(in srgb, var(--accent) 66%, var(--ink));
}
.col.is-sidechat .col__body {
  background: color-mix(in srgb, var(--accent) 2.5%, transparent);
}
.index__dash.is-sidechat {
  background: color-mix(in srgb, var(--accent) 40%, transparent);
}
.index__dash.is-sidechat.is-focused {
  background: color-mix(in srgb, var(--accent) 82%, transparent);
}

/* Dormant body — a single muted line, centred, no chrome. */
.col__dormant {
  margin: 0;
  padding: 2.5rem 0.4rem 0;
  text-align: center;
  font-family: var(--font-sans);
  font-size: 12.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  opacity: 0.7;
}

.col__tools {
  grid-column: 2;
  grid-row: 1;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  justify-self: end;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.col:hover .col__tools,
.col__tools:focus-within {
  opacity: 1;
}
.col__tool {
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--muted);
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}
.col__tool:hover {
  background: var(--hover);
  color: var(--ink);
}
/* In zen the width rung is meaningless (the column is filling the rail), so the
   width tool sits disabled showing `max` rather than a pixel figure. Dim it and
   drop its pointer target, but keep it in the row — hiding it would reflow the
   tools every time you toggle zen. */
.col__tool:disabled {
  cursor: default;
  opacity: 0.4;
  pointer-events: none;
}
.col__tool--width {
  width: auto;
  min-width: 20px;
  padding-inline: 4px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* A terminal's busy pill — the subprocess dot + command name in the column
   header. Quiet by design: a soft tinted capsule, a plain muted dot (no pulse,
   no glow), and the label clamped so a long command can't shove the title. */
.col__busy {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  max-width: 8rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.col__busy-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.col__busy-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 620;
  letter-spacing: 0.01em;
  color: var(--muted);
}

.col__body {
  --fade-top: 0px;
  --fade-end: 14px;

  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--fade-end) 0.4rem 208px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent var(--fade-top),
    #000 var(--fade-end),
    #000 calc(100% - 176px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent var(--fade-top),
    #000 var(--fade-end),
    #000 calc(100% - 176px),
    transparent 100%
  );
  scrollbar-width: none;
}
.col__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* A terminal column is a PTY, not a chat log: it must NOT inherit the thread
 * body's tall top/bottom padding, its top/bottom mask fade, or its own scroll
 * container — all of which fade out, mis-size and clip xterm (which manages its
 * own viewport + scrollback). Give it a clean full-height box so FitAddon can
 * measure the real height. */
.col__body--terminal {
  padding: 0.5rem 0.65rem 0.65rem;
  overflow: hidden;
  -webkit-mask-image: none;
  mask-image: none;
}

/* Scratchpad columns are prose editors, not chat logs: drop the thread body's
 * tall bottom padding and its col-level mask — the pane's own scroll box owns
 * the top/bottom smoke now (ScratchpadPane `.pad__body`), where the mask can
 * anchor to the true scroll viewport instead of this padding-only frame. */
.col__body--scratchpad {
  padding: 0.65rem 0.4rem 1.25rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── overview (Exposé) ─────────────────────────────────────────────────────────
   Everything below applies *only* in overview. The plane's scale does the zoom;
   these turn the shrunk columns into a legible map — cards to float, a soft
   backdrop to float them on, captions at true size, and every in-card affordance
   silenced so the card reads as a single button. */

/* A soft backdrop dip so the cards have something to sit on. Transitioned, so
   entering overview settles rather than flashes. */
.strip.is-overview {
  background: color-mix(in srgb, var(--ink) 3.5%, var(--ground));
  /* Own stacking context so the floor plasma can sit at z-index:-1 — above this
     dipped backdrop, below the cards — without escaping behind the strip. */
  isolation: isolate;
}
/* Same floor glow as the chooser / projects-list empty state, anchored to the
   overview's bottom edge and masked so it dissolves into the ground. Behind the
   cards (see .strip.is-overview isolation), never intercepts pointer events. */
.overview__plasma {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  z-index: -1;
  height: 42vh;
  max-height: 380px;
  min-height: 220px;
  mask-image: linear-gradient(to bottom, transparent, black 55%);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 55%);
}
/* A minimap on top of a map is noise — the cards *are* the index now. Faded, not cut:
   it sits right where the eye is during the zoom-out. */
.strip.is-overview .index {
  opacity: 0;
  pointer-events: none;
}

/* Columns become cards — a soft radius over a ground fill, no border (kone doesn't
   use them). The opacity/filter/transform overrides undo the resting unfocused dim so
   the map shows every column evenly; the two shadow layers are deliberately near-
   invisible, since kone never leans on elevation — soft float, not a drop shadow.

   Every px of chrome here is counter-scaled by 1/k (--inv-k, published on the plane):
   these values are authored in *plane* pixels, so left alone they'd render at ×k on
   screen — the radius, the shadow softness, and especially the focus ring would all
   shrink with k, gutting the "which card" signal at exactly the column counts where
   it matters most. calc(<px> * var(--inv-k)) holds them at constant screen size. */
.rail.is-overview .col {
  border-radius: calc(18px * var(--inv-k, 1));
  background: var(--ground);
  /* The card must NOT clip its own overflow: the caption lives just below it (see
     col__map-label) and `overflow: hidden` here would guillotine it. The live
     content is clipped to the radius by the body instead (below). */
  opacity: 1;
  filter: none;
  transform: none;
  cursor: pointer;
  box-shadow:
    0 calc(1px * var(--inv-k, 1)) calc(2px * var(--inv-k, 1)) color-mix(in srgb, var(--ink) 4%, transparent),
    0 calc(8px * var(--inv-k, 1)) calc(24px * var(--inv-k, 1)) calc(-14px * var(--inv-k, 1)) color-mix(in srgb, var(--ink) 14%, transparent);
  transition:
    opacity 0.3s ease,
    filter 0.3s ease,
    box-shadow 0.18s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
/* The focused card gets presence without a border: the third shadow layer is an
   accent ring drawn as a spread shadow, so it costs no layout and animates for free.
   Its 1.5px width is counter-scaled too — a ring that thins to 0.5px at k = 0.34 is
   the exact signal we can least afford to lose in a crowded overview. */
.rail.is-overview .col.is-focused {
  box-shadow:
    0 calc(1px * var(--inv-k, 1)) calc(2px * var(--inv-k, 1)) color-mix(in srgb, var(--ink) 5%, transparent),
    0 calc(10px * var(--inv-k, 1)) calc(30px * var(--inv-k, 1)) calc(-14px * var(--inv-k, 1)) color-mix(in srgb, var(--accent) 34%, transparent),
    0 0 0 calc(1.5px * var(--inv-k, 1)) color-mix(in srgb, var(--accent) 42%, transparent);
}
/* A side chat's overview card carries its provisional tint, so the map still
   tells the temporary columns apart from real conversations at a glance. */
.rail.is-overview .col.is-sidechat {
  background: color-mix(in srgb, var(--accent) 4.5%, var(--ground));
}
/* A subtle lift on hover. It's on the card, not the plane, so it doesn't fight the
   plane's scale — but the lift distance is in plane px, so counter-scale it or a 4px
   rise becomes an imperceptible 1.4px at k = 0.34. */
.rail.is-overview .col:hover {
  transform: translateY(calc(-4px * var(--inv-k, 1)));
  box-shadow:
    0 calc(2px * var(--inv-k, 1)) calc(4px * var(--inv-k, 1)) color-mix(in srgb, var(--ink) 5%, transparent),
    0 calc(14px * var(--inv-k, 1)) calc(34px * var(--inv-k, 1)) calc(-14px * var(--inv-k, 1)) color-mix(in srgb, var(--ink) 18%, transparent);
}
.rail.is-overview .col.is-focused:hover {
  transform: translateY(calc(-4px * var(--inv-k, 1)));
  box-shadow:
    0 calc(2px * var(--inv-k, 1)) calc(4px * var(--inv-k, 1)) color-mix(in srgb, var(--ink) 6%, transparent),
    0 calc(14px * var(--inv-k, 1)) calc(36px * var(--inv-k, 1)) calc(-14px * var(--inv-k, 1)) color-mix(in srgb, var(--accent) 38%, transparent),
    0 0 0 calc(1.5px * var(--inv-k, 1)) color-mix(in srgb, var(--accent) 46%, transparent);
}

/* In overview the card is a button, not a document: silence everything inside it so
   a click anywhere on it lands as "focus this column", never as a scroll or a tool
   press. */
.rail.is-overview .col__body,
.rail.is-overview .col__head {
  pointer-events: none;
}
.rail.is-overview .col__body {
  /* Clips the live pane content to the card's lower radius (the header above is
     centred text that never reaches a corner), standing in for the overflow the
     card itself can't have without eating the caption. Counter-scaled by the same
     1/k as the card's border-radius so the two stay equal at every k — mismatch them
     and the clip and the card edge part company. */
  overflow: hidden;
  border-bottom-left-radius: calc(18px * var(--inv-k, 1));
  border-bottom-right-radius: calc(18px * var(--inv-k, 1));
}
.rail.is-overview .col__tools,
.rail.is-overview .col-joint {
  opacity: 0;
  pointer-events: none;
}

/* The caption. Counter-scaled by 1/k (--inv-k, inherited from the plane) so it stays
   crisp at ~12.5px on screen while its parent plane is scaled down to k. Its `bottom`
   offset counter-scales too, or the gap below the card shrinks with k and the label
   crowds the card it names. Colour (not weight — Geist is 400-only) carries focus. */
.col__map-label {
  position: absolute;
  left: 50%;
  bottom: calc(-30px * var(--inv-k, 1));
  transform: translateX(-50%) scale(var(--inv-k, 1));
  transform-origin: top center;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 12.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  transition: color 0.3s ease;
  /* It's `v-if`d in with the mode, so it has no from-state to transition from — it would
     otherwise appear at full strength on frame 0, at the bottom of a card that's still
     full size, i.e. somewhere off screen, and then fly up with the plane. Fading it in
     over the back half of the zoom lands it once its card has nearly settled. */
  animation: map-label-in 260ms cubic-bezier(0.22, 1, 0.36, 1) 170ms both;
}
@keyframes map-label-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.col__map-logo {
  flex: none;
}
.col.is-focused .col__map-label {
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .index__dash,
  .col,
  .col.is-width-anim,
  .col__tools,
  .col-joint__pill,
  .strip,
  .rail__plane,
  .rail__scaler,
  .col__map-label,
  .rail.is-overview .col {
    transition: none;
  }
  /* No lift, no glide — the zoom is instant. */
  .rail.is-overview .col:hover,
  .rail.is-overview .col.is-focused:hover {
    transform: none;
  }
  .index__dash.is-live,
  .index__dash.is-pulse,
  .col__map-label {
    animation: none;
  }
}
</style>
