// How much floor a scrolling transcript must leave for the docks that float
// over it.
//
// Every reading surface stacks something over its own bottom edge — the
// composer bar (which grows with its input and its queued strips), the pills
// above it, the corner Changes / Tasks / Subagents cards (which expand when
// clicked). The transcript scrolls *behind* all of it, so the last thing said
// is only readable if the scroll floor clears whatever is currently stacked
// there. Guessing that height goes wrong the moment anything opens, so it is
// measured: one ResizeObserver over the floating elements, the tallest of them
// plus the gap they float in, never below the surface's resting floor.
//
// Point it at the floating element(s) — a plain element ref or a component ref
// (its root element is read) — and bind the returned `clear` as the scroller's
// bottom padding.

import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

/** The thread strip's resting floor, in px, and the geometry it is built from.
 *  ThreadStrip's `.col__body` carries the same numbers as the CSS fallbacks for
 *  `--dock-clear` / `--dock-fade` (for a strip rendered without a row to
 *  publish them); change them here and there together. */
export const STRIP_DOCK_RESTING = 208;
export const STRIP_DOCK_FLOAT = 32;
export const STRIP_DOCK_AIR = 24;

/** A template ref pointing at a floating dock: an element ref, or a component
 *  ref whose root element is read. Typed loosely on purpose — a component's
 *  instance type is its own, and all this wants out of either is a DOM node. */
export type DockRef = Readonly<Ref<HTMLElement | { $el?: unknown } | null | undefined>>;

export interface DockClearanceOptions {
  /** The floor with nothing floating — never goes below this. */
  resting: number;
  /** How far the floating element sits off the surface's bottom edge. */
  float: number;
  /** Air between the last line and the floating element. */
  air: number;
}

function rootEl(r: DockRef): HTMLElement | null {
  const v = r.value;
  if (v instanceof HTMLElement) return v;
  // A component ref: `$el` is its root node — an element while the component
  // renders one, a comment placeholder while its root `v-if` is false.
  const el = v?.$el;
  return el instanceof HTMLElement ? el : null;
}

export function useDockClearance(refs: DockRef | DockRef[], opts: DockClearanceOptions) {
  const list = Array.isArray(refs) ? refs : [refs];
  const height = ref(0);
  let ro: ResizeObserver | null = null;

  function measure(): void {
    let tallest = 0;
    for (const r of list) {
      const el = rootEl(r);
      if (el) tallest = Math.max(tallest, el.offsetHeight);
    }
    height.value = tallest;
  }

  // The observed elements come and go (a dock renders only while it has
  // something to show), so re-attach when a ref changes rather than observing
  // once. A ref that stays put while its own contents swap is covered by the
  // ResizeObserver itself; one that appears later — a dock whose data lands
  // after mount — needs `refresh()`.
  function refresh(): void {
    ro?.disconnect();
    ro = null;
    const els = list.map(rootEl).filter((el): el is HTMLElement => el !== null);
    if (els.length) {
      ro = new ResizeObserver(measure);
      for (const el of els) ro.observe(el);
    }
    measure();
  }

  onMounted(refresh);
  watch(list, refresh, { flush: "post" });
  onBeforeUnmount(() => {
    ro?.disconnect();
    ro = null;
  });

  const clear = computed(() => Math.max(opts.resting, height.value + opts.float + opts.air));

  return { height, clear, refresh };
}
