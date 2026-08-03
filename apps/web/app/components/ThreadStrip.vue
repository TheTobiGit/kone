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

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  useEventListener,
  usePreferredDark,
  usePreferredReducedMotion,
  useResizeObserver,
} from "@vueuse/core";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon, ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { ClosingPlasma } from "~/components/ui/closing-plasma";
import { Magnet } from "~/components/ui/magnet";
import type { Pane, PaneId, PaneKind } from "~/types/board";
import { PANE_KINDS, paneKindMeta } from "~/utils/paneKinds";
import { isBlankThread } from "~/utils/panes";
import { SESSION_BRAND } from "~/types/session";
import ContextWindowMeter from "~/components/ContextWindowMeter.vue";

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
}>();

const emit = defineEmits<{
  /** Focus this column (a click, or the rail settling on it after a swipe). */
  focus: [key: string];
  /** Step focus this many columns along the strip. */
  shift: [delta: number];
  /** Carry the focused column this many places along the strip. */
  move: [delta: number];
  /** Close this column. */
  close: [key: string];
  /** Archive this thread and close its column. Carries the provider thread id (so
   *  the store/history row can be stamped archived) and the pane key (so the
   *  column can be closed). Only ever fired for a non-blank thread column. */
  archive: [threadId: string, key: string];
  /** Insert a blank thread to the right of seam `seamIndex`. */
  "insert-column": [seamIndex: number, kind: "thread" | "terminal" | "scratchpad"];
  /** Write terminal input data. Keyed by the terminal *session* key, not the pane
   *  id: these two go straight to useTerminal, which keys its registry by session.
   *  Every other emit here carries a pane id, so the mismatch is easy to reintroduce
   *  — the strip has the session in hand (`c.session.key`), so it passes that. */
  "terminal-write": [sessionKey: string, data: string];
  /** Resize terminal PTY. Session-keyed, same as `terminal-write`. */
  "terminal-resize": [sessionKey: string, cols: number, rows: number];
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

// ── column widths ─────────────────────────────────────────────────────────────
// Fixed pixel rungs — unlike niri (output size is the monitor), our strip lives
// in a resizable app window, so the ladder itself does not drift every time you
// drag the window edge. Each rung is an absolute width that holds until you step
// it; the viewport cap only kicks in when the window is narrower than the preset.
const LADDER_PX = [840, 960, 1120, 1240] as const;
const LAST_STEPPED = LADDER_PX.length - 2;
const DEFAULT_PRESET = 0; // 840px — default and narrowest rung

interface Preset {
  id: string;
  label: string;
  px: number;
  width: string;
}
const PRESETS: Preset[] = LADDER_PX.map((px) => ({
  id: `w${px}`,
  label: String(px),
  px,
  // A percentage flex-basis is cyclic here: the plane is content-sized, so an
  // empty column can make `100%` resolve to its own small intrinsic width. The
  // viewport is definite and still gives us the intended narrow-window cap.
  width: `min(${px}px, 100vw)`,
}));

const widthAnim = ref<Record<string, boolean>>({});
const WIDTH_ANIM_MS = 520;
const animTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reducedMotionOn(): boolean {
  return reducedMotion.value === "reduce";
}
function scrollBehavior(): ScrollBehavior {
  return reducedMotionOn() ? "auto" : "smooth";
}

/** The width preset a column shows — read from the pane entry, the board's
 *  single source of truth. Emits back on change so restore/move can't drift. */
function presetIndexFor(key: string): number {
  const fromEntry = props.panes.find((c) => c.id === key)?.entry.width;
  return typeof fromEntry === "number" ? clampPreset(fromEntry) : DEFAULT_PRESET;
}
function clampPreset(index: number): number {
  return Math.min(PRESETS.length - 1, Math.max(0, index));
}
// ── zen (niri's maximize-column) ──────────────────────────────────────────────
// Zen is per column, not per strip. Maximizing a thread says something about that
// thread — that you want to read it — and says nothing about the terminal beside
// it. So the flag lives with the column and simply travels out of view with it:
// focus away and the strip goes back to the ladder widths, focus back and the
// column is still maximized. Keyed by pane id, pruned when panes go, and never
// persisted: a restored board that opens maximized hides the rest of the desktop
// with no explanation of why.
const zenIds = ref<Set<PaneId>>(new Set());

function zenPreset(): Preset {
  // Measured pixels, never `100%`. The column is `flex: 0 0 var(--col-w)` inside the
  // plane, and the plane is a content-sized flex row in a scroll container — so a
  // percentage basis resolves against the *plane* (the sum of the columns), not the
  // viewport. That's why zen came out at whatever fraction the other columns happened
  // to add up to: roomy with one 840px column in a 1040px window, absurdly narrow when
  // the percentage went cyclic and fell back to content width. railWidth is the rail's
  // clientWidth (the pads are custom properties on the plane, not real padding), so
  // this is exactly the visible width, and it re-derives on resize because railWidth
  // is a ref the resize observer writes.
  const px = railWidth.value || LADDER_PX[0];
  return { id: "zen", label: "max", px, width: `${px}px` };
}
/** Is `id` maximized *and* the focused column? Only the focused column may render
 *  full-width — an off-focus maximized column stays at its ladder rung so two
 *  maximized columns never fight for the viewport and break strip geometry. */
function isZen(id: string): boolean {
  return zenIds.value.has(id) && id === props.focusedId;
}

function presetFor(key: string): Preset {
  if (isZen(key)) return zenPreset();
  return PRESETS[presetIndexFor(key)] ?? PRESETS[DEFAULT_PRESET]!;
}
/** Flag `key` for the flex-basis glide and clear the flag once the transition
 *  window has passed, cancelling any in-flight timer for that column first so a
 *  rapid re-trigger doesn't strip the class mid-animation. Both the width ladder
 *  and zen borrow the same `is-width-anim` transition, so the timer bookkeeping
 *  lives here once rather than being copy-pasted into each caller. Callers gate the
 *  call on reduced motion — this helper always animates. */
function flagWidthAnim(key: string): void {
  widthAnim.value = { ...widthAnim.value, [key]: true };
  const prev = animTimers.get(key);
  if (prev) clearTimeout(prev);
  animTimers.set(
    key,
    setTimeout(() => {
      const { [key]: _, ...rest } = widthAnim.value;
      widthAnim.value = rest;
      animTimers.delete(key);
    }, WIDTH_ANIM_MS),
  );
}
function setPreset(key: string, index: number): void {
  const next = clampPreset(index);
  if (next === presetIndexFor(key)) return;
  // Mirror the choice onto the pane entry so it persists across restart.
  emit("width", key, next);
  if (reducedMotionOn()) return;
  flagWidthAnim(key);
}

function cycleWidth(key: string): void {
  cue("press");
  const next =
    presetIndexFor(key) >= LAST_STEPPED
      ? 0
      : presetIndexFor(key) + 1 === LAST_STEPPED
        ? PRESETS.length - 1
        : presetIndexFor(key) + 1;
  setPreset(key, next);
  void nextTick(() => scrollToColumn(key));
}
function growWidth(key: string): void {
  cue("press");
  setPreset(key, presetIndexFor(key) + 1);
  void nextTick(() => scrollToColumn(key));
}
function shrinkWidth(key: string): void {
  cue("press");
  setPreset(key, presetIndexFor(key) - 1);
  void nextTick(() => scrollToColumn(key));
}

function toggleZen(): void {
  if (!props.focusedId || props.panes.length === 0) return;
  cue("toggle");
  const id = props.focusedId;
  const next = new Set(zenIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  zenIds.value = next;
  if (!reducedMotionOn()) flagWidthAnim(id);
  void nextTick(() => props.focusedId && scrollToColumn(props.focusedId));
}

// ── overview (niri's Exposé) ───────────────────────────────────────────────────
// Zoom the whole plane out to a bird's-eye where every column is a card you can
// click into. The one hard constraint is that `transform` doesn't shrink a scroll
// container's `scrollWidth` — scale the flex row on its own and the rail still
// thinks the content is full-size, leaving a huge dead scroll region. So the rail
// wraps a two-element pair: `.rail__scaler` is the *layout box* (its width is the
// scaled content size, which is what the rail scrolls against) and `.rail__plane`
// is the real, unscaled flex row that we shrink into it with `transform: scale(k)`.
// Scaling the live DOM keeps every pane's identity — no portalled copy to remount a
// streaming thread or re-measure a terminal — and costs one GPU-composited property.
const overview = ref(false);
const plane = ref<HTMLElement | null>(null);
const naturalWidth = ref(0); // plane scrollWidth at k = 1, sampled on entry (with gaps)

// Fit the whole plane if we can, but never zoom out so far the columns turn into
// unreadable slivers — and never zoom *in*. With a couple of columns the plane
// pulls back gently; with a dozen it hits the floor and scrolls horizontally.
const OVERVIEW_MIN_K = 0.34;
const OVERVIEW_MAX_K = 0.78;
// Symmetric breathing room, applied as in-plane pads (see railPads) so it scales with
// the plane and — because k fits the plane to the *full* rail width — leaves equal
// gutters on both sides. Reserving the margin outside the plane instead (subtracting
// it from railWidth in the fit) would strand it all on the right, since the plane is
// left-anchored at scrollLeft 0.
const OVERVIEW_GUTTER = 56;
const OVERVIEW_ANIM_MS = 420; // the zoom transition; also the will-change lifetime
const OVERVIEW_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
// The cards ride a little above the rail's centre line so the captions below them read
// as belonging to the map rather than floating in the bottom margin. It's a *screen*
// offset applied ahead of the scale in the transform list, so it never scales with k and
// — crucially — costs no layout: the old version bought this air with `padding-block` on
// the plane, which shortened every column and reflowed every pane inside it mid-zoom.
const OVERVIEW_LIFT_PX = 14;

const k = computed(() => {
  if (!overview.value || !naturalWidth.value || !railWidth.value) return 1;
  const fit = railWidth.value / naturalWidth.value;
  return Math.max(OVERVIEW_MIN_K, Math.min(OVERVIEW_MAX_K, fit));
});

/** How far right the scaled plane must slide to sit centred in the rail. Only ever
 *  non-zero when the plane *fits* — with k clamped at OVERVIEW_MAX_K (two or three
 *  columns on a wide display, the most likely first sight of the feature) the scaled
 *  footprint comes out narrower than the rail, and a left-anchored plane would dump all
 *  the slack down the right-hand side and read as broken.
 *
 *  This used to be `margin-inline: auto` on the scaler, which centred it in *layout* —
 *  and therefore instantly, on the first frame of the zoom, while the plane was still
 *  full size and gliding. That step (≈190px for two columns) was the single biggest
 *  lurch in the entry animation. Carrying the offset in the transform instead means it
 *  interpolates with the scale, as one motion.
 *
 *  Safe for the scroll maths — which map `offsetLeft × k` against a left-anchored plane
 *  — *specifically because* it's zero whenever the plane overflows: when it doesn't,
 *  scrollWidth equals clientWidth, so `max` is 0 and every clamp() in scrollTargetFor /
 *  snapTargetFor / nearestKey already resolves to 0. No scroll, no offset in play. */
const centerShift = computed(() => {
  if (!overview.value || !naturalWidth.value || !railWidth.value) return 0;
  return Math.max(0, (railWidth.value - naturalWidth.value * k.value) / 2);
});

/** The plane's resting transform in the current mode — the *target* of every zoom.
 *  Ordered so the translations happen in the rail's own pixel space (a translate ahead
 *  of a scale isn't scaled by it) and only the scale is about the origin. */
function planeTransform(scale: number, shiftX: number): string {
  if (scale === 1 && shiftX === 0) return "none";
  return `translateX(${shiftX}px) translateY(${-OVERVIEW_LIFT_PX}px) scale(${scale})`;
}

// The scaler carries the *scaled* footprint so `scrollWidth` shrinks with k; the
// plane keeps its true width and is scaled into that smaller box from its left edge.
// Both fall back to the plain flex layout — `max-content` on the scaler reproduces
// exactly what the rail sized before this wrapper existed — not only when overview is
// off, but also during the one frame between flipping overview on and sampling
// naturalWidth. That matters: pinning the plane to `width: 0px` while naturalWidth is
// still 0 would collapse every column's `min(px, 100vw)` preset to 0 and the measure
// would come out tiny. So only constrain the width once we actually have naturalWidth
// — until then `max-content` sizes the scaler exactly as the resting layout does.
const scalerStyle = computed(() =>
  overview.value && naturalWidth.value
    ? { width: `${naturalWidth.value * k.value}px`, height: "100%" }
    : { width: "max-content", height: "100%" },
);
const planeStyle = computed(() =>
  overview.value && naturalWidth.value
    ? {
        width: `${naturalWidth.value}px`,
        transform: planeTransform(k.value, centerShift.value),
        // x-origin MUST stay 0 — the scroll maths map offsetLeft × k against a
        // left-anchored plane. The y-origin is free, and centring vertically balances
        // the cards in the viewport instead of stranding them against the top edge.
        transformOrigin: "0 50%",
        // Publish the inverse scale *once*, here on the plane, so every descendant
        // inherits it. The principle overview lives by: content scales, chrome doesn't.
        // The plane's `scale(k)` shrinks the live pane content (which is the point), but
        // it would equally shrink the card framing — ring, radius, shadows, hover lift,
        // caption gap — so at high column counts the whole visual language collapses and
        // it reads as a zoomed-out screenshot, not a designed map. Chrome expressed as
        // `calc(<px> * var(--inv-k))` counter-scales back to constant screen size at any k.
        "--inv-k": 1 / k.value,
      }
    : {},
);

/** Re-read the plane's true unscaled width while overview is *already* on. Needed
 *  because `naturalWidth` is only sampled on entry, and both a pane arriving (⌘N and
 *  friends still fire from here) and a window resize (a column's `min(px, 100vw)` rung
 *  collapses to the rail width on a narrow window) change the plane underneath us. Left
 *  stale, the scaler stays sized for the old plane: the new card falls outside the
 *  scroll extent and can't be reached, and `k` no longer fits what's actually there.
 *
 *  The measure has to defeat the pinned `width: naturalWidth` — with the box pinned,
 *  `scrollWidth` can grow past it but can never shrink below it. Swapping in
 *  `max-content` and restoring it without yielding forces one synchronous reflow the
 *  browser can't paint between, so there's no full-size frame flash. */
async function remeasurePlane(): Promise<void> {
  const p = plane.value;
  const r = rail.value;
  if (!overview.value || !p || !r) return;
  const pinned = p.style.width;
  p.style.width = "max-content";
  const measured = p.scrollWidth;
  p.style.width = pinned;
  if (!measured || Math.abs(measured - naturalWidth.value) <= 1) return;
  // A new plane width re-fits k, which moves every card. Ride the same FLIP the entry
  // animation uses rather than letting the new scale land in one frame — a card arriving
  // shouldn't make the whole map flinch.
  const fromTransform = planeTransform(k.value, centerShift.value);
  const fromScroll = r.scrollLeft;
  naturalWidth.value = measured;
  await nextTick();
  animateZoom(flipFrom(fromTransform, fromScroll, r.scrollLeft));
}

// `will-change: transform` promotes the plane — and thus every column, terminals
// included — to its own compositor layer, which is real memory to hold for a whole
// session. So flag it only for the length of the zoom transition, cleared on a
// timer. It also suppresses pointer events on the plane for that window: as the plane
// scales, cards sweep under a stationary cursor and each one that passes fires its
// hover lift, so the flight used to be speckled with cards twitching up and down.
// Reduced motion never animates, so it never sets this.
const isZooming = ref(false);
let zoomTimer: ReturnType<typeof setTimeout> | null = null;
function markZooming(): void {
  if (reducedMotionOn()) return;
  isZooming.value = true;
  if (zoomTimer) clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    isZooming.value = false;
    zoomTimer = null;
  }, OVERVIEW_ANIM_MS);
}

// A zoom owns the plane until it lands. Pinch in particular arrives as a burst of wheel
// events and would happily fire a second toggle mid-flight, which reads as the board
// convulsing; a keyboard mash does the same. Both no-op instead until the plane settles.
const zoomBusy = ref(false);
let busyTimer: ReturnType<typeof setTimeout> | null = null;
function markZoomBusy(): void {
  zoomBusy.value = true;
  if (busyTimer) clearTimeout(busyTimer);
  // Under reduced motion the change is instant, so the lockout is only long enough to
  // absorb the rest of the pinch gesture that asked for it — not a 420ms dead zone.
  busyTimer = setTimeout(
    () => {
      zoomBusy.value = false;
      busyTimer = null;
    },
    reducedMotionOn() ? 120 : OVERVIEW_ANIM_MS,
  );
}

/** Animate the plane from an explicitly-computed *previous* visual state to whatever its
 *  resting transform now is. This is a FLIP, and it's the whole reason the zoom is smooth.
 *
 *  The naive version — let CSS transition `transform`, and separately assign the remapped
 *  `scrollLeft` — cannot work, because scroll offset isn't animatable: the scroll jumps to
 *  its new value on frame 0 while the scale is still gliding, so the plane lurches sideways
 *  by scrollLeft × (1 − k) and then eases. The layout changes that come with the mode
 *  (gaps opening, gutters, the scaler's footprint) compound it.
 *
 *  So we do it the other way round: put the new state *fully* in place first — mode class,
 *  scaler width, final scroll offset — then hand the difference to one composited transform
 *  animation. `from` is computed by the caller as "the transform that, given the new scroll
 *  offset, renders the old view", which makes frame 0 pixel-identical to where we started.
 *  Layout-driven parts of the change (the 28px struts, the gutter pads) can't ride a
 *  transform, so they carry their own CSS transitions on the same duration and curve. */
let zoomAnim: Animation | null = null;
function animateZoom(from: string): void {
  const p = plane.value;
  if (!p || reducedMotionOn()) return;
  markZooming();
  // Cancel only *our* previous zoom, by handle — not `p.getAnimations()`, which would
  // also take out the CSS transitions on `gap` and `--inv-k` running on this same
  // element and snap the struts and the card chrome to their final size.
  zoomAnim?.cancel();
  // `fill: "none"` (the default) is deliberate: the resting transform is already the
  // final value in `planeStyle`, so when the animation drops off there's nothing to
  // snap back to.
  zoomAnim = p.animate(
    { transform: [from, planeTransform(k.value, centerShift.value)] },
    { duration: OVERVIEW_ANIM_MS, easing: OVERVIEW_EASE },
  );
}

const isSolo = computed(() => props.panes.length === 1);

/** The leading seam mirrored before the first column (see template) is a real
 *  14px-wide element in the plane, so it shifts the lone column right of centre
 *  unless the start pad gives its width back. Matches `.col-joint` width in CSS. */
const LEAD_JOINT_PX = 14;

/** Leading pad centres the lone thread; trailing pad lets the last column scroll
 *  to centre when there are two or more. */
const soloPadStart = computed(() => {
  if (!isSolo.value || !railWidth.value) return 0;
  const s = props.panes[0];
  if (!s) return 0;
  const colW = Math.min(presetFor(s.id).px, railWidth.value);
  // Pull the pad in by the leading seam's width so the column itself — not the
  // seam+column pair — sits centred, exactly as it did before the seam existed.
  return Math.max(0, (railWidth.value - colW) / 2 - LEAD_JOINT_PX);
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
  const padEnd = centerMode.value === "never" ? PEEK_PX : railWidth.value / 2;
  return {
    "--rail-pad-start": isSolo.value ? `${soloPadStart.value}px` : "0px",
    "--rail-pad-end": isSolo.value ? "0px" : `${padEnd}px`,
  };
});

// ── the rail ──────────────────────────────────────────────────────────────────
const colEls = new Map<string, HTMLElement>();
function setCol(key: string, el: unknown): void {
  if (el instanceof HTMLElement) colEls.set(key, el);
  else colEls.delete(key);
}

/** Where the rail should sit for `key` to be usable, or `null` for "don't move".
 *  Honours the centring mode: `never` nudges by the minimum, `on-overflow` centres
 *  but only when a scroll is actually needed, `always` centres unconditionally.
 *  Returning `null` — rather than the current position — is what makes the strip
 *  *stay put*: `scrollToColumn` already treats null as a no-op, so nothing
 *  programmatic fires and no smooth-scroll animation is queued. */
const VISIBILITY_EPS = 1; // sub-pixel layout noise; don't scroll for half a pixel
const PEEK_PX = 24;       // in `never`, leave a sliver of the neighbour showing

let programmaticAt = 0;
function scrollTargetFor(key: string): number | null {
  const r = rail.value;
  const el = colEls.get(key);
  if (!r || !el) return null;

  const max = Math.max(0, r.scrollWidth - r.clientWidth);
  const clamp = (n: number) => Math.max(0, Math.min(max, n));

  // `offsetLeft`/`offsetWidth` are unscaled *plane* coordinates, but `scrollLeft`
  // and `scrollWidth` are the rail's *scaled* scroller coordinates in overview. The
  // scaler shrinks the layout by exactly `k`, so multiply the column's geometry by k
  // to speak the same units. Without this, arrow-navigating in overview scrolls to
  // wildly wrong positions — the subtlest bug in the feature. Outside overview k is 1.
  const s = overview.value ? k.value : 1;
  const left = el.offsetLeft * s;
  const width = el.offsetWidth * s;
  const right = left + width;
  const centred = clamp(left + width / 2 - r.clientWidth / 2);

  if (centerMode.value === "always") return centred;

  // A column wider than the viewport can never be "fully visible" — centring it
  // would hide its left edge, which is where reading starts. Pin its left edge.
  if (width >= r.clientWidth) return clamp(left);

  const viewL = r.scrollLeft;
  const viewR = viewL + r.clientWidth;
  if (left >= viewL - VISIBILITY_EPS && right <= viewR + VISIBILITY_EPS) return null;

  if (centerMode.value === "on-overflow") return centred;

  // `never`: the smallest move that brings it in, plus a peek so the neighbour it
  // came from stays hinted at rather than guillotined at the frame edge.
  return clamp(left < viewL ? left - PEEK_PX : right - r.clientWidth + PEEK_PX);
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
  const max = Math.max(0, r.scrollWidth - r.clientWidth);
  const clamp = (n: number) => Math.max(0, Math.min(max, n));
  // Same scaled-coordinate correction as scrollTargetFor (see there). k is 1 outside
  // overview, and the settle path is suspended while overview is on anyway, but keep
  // the units honest so this function never lies about a column boundary.
  const s = overview.value ? k.value : 1;
  const left = el.offsetLeft * s;
  const width = el.offsetWidth * s;
  if (centerMode.value === "never") return clamp(left);
  return clamp(left + width / 2 - r.clientWidth / 2);
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
  if (how !== "auto" && Math.abs(r.scrollLeft - target) < 6) return;
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

/** The transform that renders the pre-change view now that the scroll offset has moved.
 *  Screen x of a point is `base − scrollLeft + translateX + scale × planeX`, so holding
 *  it fixed across a scroll change of (after − before) means shifting the old translate
 *  by exactly that difference and keeping the old scale. */
function flipFrom(previous: string, beforeScroll: number, afterScroll: number): string {
  const shift = afterScroll - beforeScroll;
  if (previous === "none") return `translateX(${shift}px) scale(1)`;
  // `previous` is always our own output, so parsing it back is safe and beats threading
  // the two numbers through every call site.
  const scale = Number(previous.match(/scale\(([-\d.]+)\)/)?.[1] ?? 1);
  const tx = Number(previous.match(/translateX\(([-\d.]+)px\)/)?.[1] ?? 0);
  return `translateX(${tx + shift}px) translateY(${-OVERVIEW_LIFT_PX}px) scale(${scale})`;
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
  if (zoomTimer) clearTimeout(zoomTimer);
  if (busyTimer) clearTimeout(busyTimer);
  if (pinchQuiet) clearTimeout(pinchQuiet);
  for (const t of animTimers.values()) clearTimeout(t);
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
      cue("press");
      emit("focus", key);
    }
    void exitOverview();
    return;
  }
  if (key === props.focusedId) return;
  cue("press");
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

function onClose(key: string): void {
  cue("press");
  emit("close", key);
}

function onArchive(c: Pane): void {
  if (c.kind !== "thread" || !c.session) return;
  cue("press");
  emit("archive", c.session.threadId.value, c.id);
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
    cue("toggle");
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
  cue("toggle");
}

function onInsertPick(kind: "thread" | "terminal" | "scratchpad"): void {
  if (openSeam.value === null) return;
  onInsertColumn(openSeam.value, kind);
  closeJoint();
}

// ── keyboard ──────────────────────────────────────────────────────────────────
const { matchesShortcut, bindingFor, displayTokens } = useShortcuts();

function isTyping(): boolean {
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
  if (c.kind === "thread") return c.session?.title.value || "New thread";
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
const isDark = usePreferredDark();
const plasmaOpacity = computed(() => (isDark.value ? 0.5 : 1));

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
</script>

<template>
  <div class="strip" :class="{ 'is-resizing': isResizing, 'is-overview': overview }">
    <!-- Overview is a mode, not a dialog — announce it politely for screen readers
         rather than trapping focus. Empty (not removed) when off so the region
         stays in the tree and the change is what's announced. -->
    <span class="sr-only" aria-live="polite">{{
      overview ? `Overview — ${panes.length} columns` : ""
    }}</span>
    <nav v-if="panes.length > 1 && !chooser" class="index" aria-label="Columns">
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
          },
        ]"
        :aria-label="`Column ${i + 1}: ${columnLabel(c)}`"
        :aria-current="c.id === focusedId"
        @click="onColumnClick(c.id)"
      />
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
                 edge (useBoard clamps `at` to [0, length]). -->
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
                    <h2 class="col__title">{{ c.session.title.value || "New thread" }}</h2>
                    <ContextWindowMeter
                      v-if="c.session.tokenUsage.value"
                      :usage="c.session.tokenUsage.value"
                    />
                  </template>
                  <template v-else>
                    <HugeiconsIcon :icon="paneKindMeta(c.kind).icon" :size="15" :stroke-width="2" class="text-muted" />
                    <h2 class="col__title">{{ columnLabel(c) }}</h2>
                  </template>
                </div>
                <div class="col__tools">
                  <button
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
                    v-if="c.id === focusedId"
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
                    :blocks="c.session.blocks.value"
                    :now="now"
                    :session-error="c.session.error.value"
                    :source-key="c.id"
                    @to-scratchpad="(text) => emit('to-scratchpad', text, c.id)"
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
                <!-- Dormant: the pane is restored but nothing has attached yet. It
                     attaches on focus, so this is what an unfocused restored pane
                     shows — a single muted line, no card / border / button / spinner.
                     A dormant scratchpad shows nothing (its empty-state idiom is an
                     empty page); a thread's "Opening…" is transient (focus attaches
                     immediately); a terminal invites the click that starts its PTY. -->
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
                >{{ columnLabel(c) }}</span
              >
            </section>

            <button
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
          light-color-a="#f6f5f3"
          light-color-b="#efe4dc"
          light-color-c="#e4c1af"
          dark-color-a="#070708"
          dark-color-b="#120d0a"
          dark-color-c="#43251a"
        />
      </motion.div>
      <div class="chooser__panel">
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
  </div>
</template>

<style scoped>
.strip {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  height: 100%;
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
  gap: 6px;
  pointer-events: none;
  transition: opacity 0.28s ease;
}
.index__dash {
  pointer-events: auto;
  cursor: pointer;
  width: 13px;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.3s ease;
}
.index__dash:hover {
  background: color-mix(in srgb, var(--ink) 34%, transparent);
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
  width: min(16rem, 100%);
}
.chooser__actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
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
