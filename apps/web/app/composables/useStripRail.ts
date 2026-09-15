import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
  type Ref,
} from "vue";
import {
  useEventListener,
  useResizeObserver,
} from "@vueuse/core";

import type { Pane } from "~/types/studio";
import {
  MIN_ANIMATED_PX,
  resolveScrollTarget,
  resolveSnapTarget,
} from "~/utils/stripScroll";
import type { Preset } from "./useStripPresets";
import type { useStripOverview } from "./useStripOverview";
import { useStripPrefs } from "./useStripPrefs";
import { useSound } from "./useSound";

type OverviewApi = Pick<
  ReturnType<typeof useStripOverview>,
  | "overview"
  | "plane"
  | "naturalWidth"
  | "k"
  | "centerShift"
  | "planeTransform"
  | "zoomBusy"
  | "markZoomBusy"
  | "animateZoom"
  | "flipFrom"
  | "remeasurePlane"
>;

// The rail — column geometry, programmatic scrolling, overview zoom, swipe
// settle, pinch-zoom and resize handling. The single largest cluster and the
// most entangled: four mutable timing latches (`programmaticAt`, `snapKey`,
// `snapAt`, `lastScrollLeft`) exist to tell *programmatic* scrolls apart from
// *user* scrolls, and they all stay inside here — nothing about them is
// returned. Every `watch` moves with the state it watches; all four timer
// teardowns (`resizeEndTimer`, `resizeRaf`, `settleTimer`, `pinchQuiet`) move
// with the `onBeforeUnmount` that owns them.
//
// Pure geometry stays delegated to `stripScroll.ts` (`resolveScrollTarget`,
// `resolveSnapTarget`); anything further-pure found here belongs there with a
// test, not in this composable.
//
// Takes the `rail` element ref and the `panes`/`focusedId`/`visible` props in
// as arguments (plus the overview machinery, the preset readers, and the seam
// card's close as callbacks); returns the template bindings and the controls
// the keyboard and pane-action clusters call into.
export function useStripRail(deps: {
  rail: Ref<HTMLElement | null>;
  railWidth: Ref<number>;
  panes: () => Pane[];
  focusedId: () => string;
  visible: () => boolean | undefined;
  /** The controlled overview prop (`undefined` = uncontrolled). */
  controlledOverview: () => boolean | undefined;
  isSolo: Ref<boolean>;
  reducedMotionOn: () => boolean;
  presetFor: (key: string) => Preset;
  flagWidthAnim: (key: string) => void;
  /** Any rail scroll closes the seam insert card. */
  closeJoint: () => void;
  ov: OverviewApi;
  emits: {
    updateOverview: (value: boolean) => void;
    toggleOverview: () => void;
    focus: (key: string) => void;
  };
}) {
  const {
    rail,
    railWidth,
    panes,
    focusedId,
    visible,
    controlledOverview,
    isSolo,
    reducedMotionOn,
    presetFor,
    flagWidthAnim,
    closeJoint,
    ov,
    emits,
  } = deps;
  const {
    overview,
    plane,
    naturalWidth,
    k,
    centerShift,
    planeTransform,
    zoomBusy,
    markZoomBusy,
    animateZoom,
    flipFrom,
    remeasurePlane,
  } = ov;
  const { cue } = useSound();
  // niri's `center-focused-column`, shared with the settings drawer through a
  // module-scope ref so flipping it there steers the scroll maths live.
  const { centerMode } = useStripPrefs();

  function scrollBehavior(): ScrollBehavior {
    return reducedMotionOn() ? "auto" : "smooth";
  }

  // ── the rail ────────────────────────────────────────────────────────────────
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

  function computeOverviewNaturalWidth(): number {
    let total = 0;
    const count = panes().length;
    if (count > 1) {
      total += (count - 1) * 28;
    }
    for (const pane of panes()) {
      total += presetFor(pane.id).px;
    }
    return total;
  }

  function enterOverview(): void {
    const r = rail.value;
    const p = plane.value;
    if (!r || !p) return;
    if (controlledOverview() === undefined && panes().length < 2) return;
    markZoomBusy();

    const fromScroll = r.scrollLeft;
    const fromTransform = planeTransform(k.value, centerShift.value);

    // Set the measured natural width synchronously so `k`, `centerShift` and `scalerStyle`
    // are fully computed in the exact same render cycle overview becomes true.
    naturalWidth.value = computeOverviewNaturalWidth();
    overview.value = true;
    emits.updateOverview(true);

    programmaticAt = Date.now();
    r.scrollLeft = fromScroll * k.value;
    animateZoom(flipFrom(fromTransform, fromScroll, r.scrollLeft));
  }

  async function exitOverview(targetKey?: string): Promise<void> {
    const r = rail.value;
    const p = plane.value;
    if (!r || !p) return;
    markZoomBusy();
    const fromScroll = r.scrollLeft;
    const fromTransform = planeTransform(k.value, centerShift.value);
    const scale = k.value;

    // Lock the current transform inline before clearing overview so there is no
    // unscaled pop before the FLIP animation takes over.
    p.style.transform = fromTransform;

    overview.value = false;
    emits.updateOverview(false);
    programmaticAt = Date.now();
    await nextTick();

    p.style.transform = "";
    r.scrollLeft = scale ? fromScroll / scale : fromScroll;
    programmaticAt = Date.now();
    const focusKey = targetKey ?? focusedId();
    if (focusKey) scrollToColumn(focusKey, "auto");
    animateZoom(flipFrom(fromTransform, fromScroll, r.scrollLeft));
  }

  function toggleOverview(): void {
    if (controlledOverview() !== undefined) {
      emits.toggleOverview();
      return;
    }
    if (panes().length < 2) return;
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
      if (focusedId()) scrollToColumn(focusedId(), "auto");
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
    if (panes().length < 2 && controlledOverview() === undefined) return;
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
    if (!r || !panes().length) return null;
    const mid = (scrollLeft ?? r.scrollLeft) + r.clientWidth / 2;
    const dir = scrollLeft === undefined ? 0 : Math.sign(scrollLeft - lastScrollLeft);
    // Column geometry is unscaled plane coordinates; the scroll position it's compared
    // against is scaled in overview. Same k correction as scrollTargetFor.
    const zoom = overview.value ? k.value : 1;

    let byCentre: string | null = null;
    let centreDist = Infinity;
    let seamOwner: string | null = null;
    let seamDist = Infinity;
    for (const s of panes()) {
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
      if (key !== focusedId()) emits.focus(key);
      scrollToColumn(key, scrollBehavior(), "snap");
    }, 170);
  }

  watch(
    () => focusedId(),
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
        const prevZen = prev ? Boolean(panes().find((p) => p.id === prev)?.entry.zen) : false;
        const keyZen = key ? Boolean(panes().find((p) => p.id === key)?.entry.zen) : false;
        if (prevZen || keyZen) {
          if (prev && prev !== key) flagWidthAnim(prev);
          if (key) flagWidthAnim(key);
        }
      }
      if (key) void nextTick(() => scrollToColumn(key));
    },
  );
  watch(
    () => panes().length,
    () => {
      void nextTick(() => {
        // A column arrived or left while the plane is zoomed out — ⌘N / ⌘⇧T / ⌘⇧N are
        // global and still fire in overview, so this is reachable, and a stale scaler
        // would strand the new card outside the scroll extent.
        void remeasurePlane();
        if (focusedId()) scrollToColumn(focusedId());
      });
    },
  );
  // Switching centring mode changes both what a "good" scroll position is and how
  // wide the trailing pad is (so scrollWidth shifts). Re-settle the focused column
  // once the new pad has laid out — `auto`, because the change was a preference
  // flip, not a navigation, and a smooth glide there reads as the strip lurching on
  // its own. A stale position after a mode flip is the quickest way this looks broken.
  watch(centerMode, () => {
    if (focusedId()) void nextTick(() => scrollToColumn(focusedId(), "auto"));
  });
  // Re-centre on reveal. While hidden the rail measured zero and skipped every
  // scroll; once the board surface is shown again, re-read the width and snap the
  // focused column back to centre (no animation — it was already there before the
  // surface flip; this just restores what the zero-width guard held back).
  watch(
    () => visible(),
    (isVisible) => {
      if (!isVisible) return;
      void nextTick(() => {
        railWidth.value = rail.value?.clientWidth ?? railWidth.value;
        if (focusedId()) scrollToColumn(focusedId(), "auto");
      });
    },
  );
  onMounted(() => {
    railWidth.value = rail.value?.clientWidth ?? 0;
    if (focusedId()) void nextTick(() => scrollToColumn(focusedId(), "auto"));
  });

  watch(
    () => controlledOverview(),
    (val) => {
      if (val === undefined) return;
      if (val && !overview.value) enterOverview();
      else if (!val && overview.value) void exitOverview();
    },
    { immediate: true },
  );

  return {
    isResizing,
    setCol,
    scrollToColumn,
    enterOverview,
    exitOverview,
    toggleOverview,
    onScroll,
  };
}
