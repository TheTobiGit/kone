import { describe, expect, test } from "bun:test";

import {
  CENTER_MODES,
  JOINT_PX,
  LADDER_PX,
  MIN_ANIMATED_PX,
  PEEK_PX,
  PREVIEW_PAIR_FIT,
  PREVIEW_RUNGS,
  VISIBILITY_EPS,
  columnLeftFor,
  columnLeftsFor,
  columnsInView,
  maxScrollFor,
  maxScrollForWidths,
  padEndFor,
  planeWidthFor,
  planeWidthForWidths,
  previewColumnWidths,
  resolveScrollTarget,
  resolveSnapTarget,
  type CenterMode,
} from "./stripScroll";

// These tests exist to hold two things still.
//
// The first is the *rule*: each centring mode's promise, stated as behaviour rather
// than as a branch, so a refactor of `resolveScrollTarget` can't quietly change what
// a setting means. The settings page renders those promises as prose next to a live
// preview, so a silent change there ships a page that lies.
//
// The second is the *model*: `columnLeftFor` / `planeWidthFor` describe a plane
// ThreadStrip.vue builds in the DOM (a leading seam, then a seam after every column,
// at `gap: 0`). Nothing in the type system ties the model to that template, so the
// arithmetic is pinned here — if the plane grows another element, these fail and the
// preview gets fixed with the board instead of drifting away from it.

const COL = LADDER_PX[0];
const MODES = CENTER_MODES.map((m) => m.value);

/** The rail as the settings preview models it: N default-width columns, no start
 *  pad (that's the solo case, which never scrolls). */
function strip(count: number, viewport: number, mode: CenterMode) {
  return {
    maxScroll: maxScrollFor(mode, count, COL, viewport),
    at(index: number, scrollLeft: number) {
      return resolveScrollTarget({
        mode,
        left: columnLeftFor(index, COL),
        width: COL,
        viewport,
        scrollLeft,
        maxScroll: maxScrollFor(mode, count, COL, viewport),
      });
    },
  };
}

describe("the modelled plane matches ThreadStrip's DOM", () => {
  test("a column sits behind its own leading seam", () => {
    expect(columnLeftFor(0, COL)).toBe(JOINT_PX);
    expect(columnLeftFor(1, COL)).toBe(JOINT_PX + COL + JOINT_PX);
  });

  test("an N-column plane carries N+1 seams", () => {
    for (const count of [1, 2, 5, 12]) {
      expect(planeWidthFor(count, COL)).toBe(count * COL + (count + 1) * JOINT_PX);
    }
  });

  test("the last column's right edge is one seam short of the plane", () => {
    const count = 5;
    const lastRight = columnLeftFor(count - 1, COL) + COL;
    expect(planeWidthFor(count, COL) - lastRight).toBe(JOINT_PX);
  });

  test("`never` trades the centring pad for a peek, so it cannot scroll as far", () => {
    const viewport = 2560;
    expect(padEndFor("never", viewport)).toBe(PEEK_PX);
    expect(padEndFor("on-overflow", viewport)).toBe(viewport / 2);
    expect(maxScrollFor("never", 5, COL, viewport)).toBeLessThan(
      maxScrollFor("always", 5, COL, viewport),
    );
  });
});

describe("what each mode promises", () => {
  const viewport = 2560; // wide enough that two columns fit — where the modes differ

  test("`always` moves even when the column is already fully in view", () => {
    const rail = strip(5, viewport, "always");
    // Column 1 at rest is fully visible, and `always` recentres it anyway.
    expect(rail.at(0, 0)).not.toBeNull();
    const target = rail.at(1, 0);
    expect(target).toBe(columnLeftFor(1, COL) + COL / 2 - viewport / 2);
  });

  test("`never` and `on-overflow` hold when the column already fits", () => {
    for (const mode of ["never", "on-overflow"] as const) {
      // Column 1 sits at the very start of the plane, so at scroll 0 it's in view.
      expect(strip(5, viewport, mode).at(0, 0)).toBeNull();
    }
  });

  test("`never` makes the smallest move that reveals the column, plus a peek", () => {
    const rail = strip(5, viewport, "never");
    const from = 0;
    const target = rail.at(2, from);
    // Scrolling right: the column's right edge lands a peek inside the frame.
    expect(target).toBe(columnLeftFor(2, COL) + COL - viewport + PEEK_PX);
    // And it is strictly less work than centring the same column.
    const centred = columnLeftFor(2, COL) + COL / 2 - viewport / 2;
    expect(target!).toBeLessThan(centred);
  });

  test("`on-overflow` centres, but only once it has to move at all", () => {
    const rail = strip(5, viewport, "on-overflow");
    expect(rail.at(0, 0)).toBeNull();
    expect(rail.at(2, 0)).toBe(columnLeftFor(2, COL) + COL / 2 - viewport / 2);
  });

  test("every mode stays inside the scrollable range", () => {
    for (const mode of MODES) {
      const rail = strip(5, viewport, mode);
      for (let i = 0; i < 5; i += 1) {
        for (const from of [0, 900, rail.maxScroll]) {
          const target = rail.at(i, from);
          if (target === null) continue;
          expect(target).toBeGreaterThanOrEqual(0);
          expect(target).toBeLessThanOrEqual(rail.maxScroll);
        }
      }
    }
  });

  test("a column wider than the viewport pins its left edge, never its centre", () => {
    const viewportNarrow = 600; // narrower than any rung
    for (const mode of ["never", "on-overflow"] as const) {
      const target = resolveScrollTarget({
        mode,
        left: columnLeftFor(2, COL),
        width: COL,
        viewport: viewportNarrow,
        scrollLeft: 0,
        maxScroll: maxScrollFor(mode, 5, COL, viewportNarrow),
      });
      expect(target).toBe(columnLeftFor(2, COL));
    }
  });

  test("visibility is judged with a sub-pixel tolerance", () => {
    // A column overhanging the frame by less than the epsilon counts as in view.
    const width = 100;
    const viewportTight = 1000;
    const base = { mode: "never" as const, width, viewport: viewportTight, maxScroll: 5000 };
    const scrollLeft = 0;
    const flush = viewportTight - width + VISIBILITY_EPS;
    expect(resolveScrollTarget({ ...base, left: flush, scrollLeft })).toBeNull();
    expect(
      resolveScrollTarget({ ...base, left: flush + 2 * VISIBILITY_EPS, scrollLeft }),
    ).not.toBeNull();
  });
});

describe("a released swipe always lands on a boundary", () => {
  const viewport = 2560;

  test("`never` settles on the column's left edge, the others on the centre line", () => {
    const args = { left: columnLeftFor(2, COL), width: COL, viewport };
    expect(
      resolveSnapTarget({ ...args, mode: "never", maxScroll: maxScrollFor("never", 5, COL, viewport) }),
    ).toBe(columnLeftFor(2, COL));
    for (const mode of ["on-overflow", "always"] as const) {
      expect(
        resolveSnapTarget({ ...args, mode, maxScroll: maxScrollFor(mode, 5, COL, viewport) }),
      ).toBe(columnLeftFor(2, COL) + COL / 2 - viewport / 2);
    }
  });

  test("the last column clamps to the end rather than overshooting", () => {
    const mode = "never" as const;
    const maxScroll = maxScrollFor(mode, 5, COL, viewport);
    expect(resolveSnapTarget({ mode, left: columnLeftFor(4, COL), width: COL, viewport, maxScroll })).toBe(
      maxScroll,
    );
  });
});

describe("how much window the modes need to differ at all", () => {
  // The settings page leans on this: below two columns' worth of width there is no
  // such thing as "already fully in view", so `on-overflow` has nothing to hold for
  // and collapses onto `always`. The page detects that by simulation, but the
  // threshold itself is a property of the geometry and is worth pinning.
  const laps = (mode: CenterMode, viewport: number) => {
    const walk = [1, 2, 3, 4, 3, 2, 1, 0];
    const rail = strip(5, viewport, mode);
    let at = 0;
    return walk.map((index) => {
      const target = rail.at(index, at);
      if (target === null) return "held";
      const moved = Math.round(target - at);
      at = target;
      return String(moved);
    });
  };

  test("two columns fit: the centring modes are distinguishable", () => {
    const viewport = 2560;
    expect(columnsInView(viewport, COL)).toBe(2);
    expect(laps("on-overflow", viewport)).not.toEqual(laps("always", viewport));
  });

  test("one column fits: the centring modes become the same setting", () => {
    const viewport = 1680;
    expect(columnsInView(viewport, COL)).toBe(1);
    expect(laps("on-overflow", viewport)).toEqual(laps("always", viewport));
  });

  test("`never` stays distinct even then — it is the one that doesn't centre", () => {
    const viewport = 1680;
    expect(laps("never", viewport)).not.toEqual(laps("always", viewport));
  });

  test("a whole pitch, seam included, is what buys another column", () => {
    const pitch = COL + JOINT_PX;
    expect(columnsInView(pitch, COL)).toBe(1);
    expect(columnsInView(2 * pitch, COL)).toBe(2);
    expect(columnsInView(pitch - 2, COL)).toBe(0);
  });
});

describe("the page's focus walk is a closed loop", () => {
  // The preview runs this walk on repeat. If a lap didn't return every mode to
  // where it started, the second lap would be a different demo from the first —
  // path dependence is real behaviour, but a preview that drifts is just confusing.
  const WALK = [1, 2, 3, 4, 3, 2, 1, 0];

  /** A lap, run the way the settings page runs it. The threshold matters here and
   *  not on the board: the page's rails glide, so they inherit the board's refusal
   *  to animate a trivial distance, and a declined move leaves the rail somewhere
   *  `resolveScrollTarget` didn't choose. That's the drift this asserts against. */
  function lap(mode: CenterMode, viewport: number, threshold: number) {
    const rail = strip(5, viewport, mode);
    let at = 0;
    for (const index of WALK) {
      const target = rail.at(index, at);
      if (target === null) continue;
      if (Math.abs(Math.round(target - at)) < threshold) continue;
      at = target;
    }
    return at;
  }

  for (const viewport of [2560, 1920, 1680, 1440, 1280]) {
    test(`every mode ends the lap where it began it at ${viewport}px`, () => {
      for (const mode of MODES) expect(lap(mode, viewport, 0)).toBe(0);
    });

    test(`suppressing unanimated moves doesn't unbalance the lap at ${viewport}px`, () => {
      for (const mode of MODES) expect(lap(mode, viewport, MIN_ANIMATED_PX)).toBe(0);
    });
  }
});

describe("a move too small to animate", () => {
  // The board declines to fire a smooth scroll under this distance, so the preview
  // has to describe the same non-event. Pinned as a shared constant rather than a
  // literal in two files, which is what it used to be.
  test("the threshold is small enough to be invisible and large enough to matter", () => {
    expect(MIN_ANIMATED_PX).toBeGreaterThan(VISIBILITY_EPS);
    expect(MIN_ANIMATED_PX).toBeLessThan(PEEK_PX);
  });

  test("the rule itself still reports the target — declining is the caller's job", () => {
    // `resolveScrollTarget` must stay a pure statement of where the column belongs.
    // An instant scroll (reduced motion, mid-zoom) makes the small move, so folding
    // the threshold into the rule would change the board, not just the preview.
    const viewport = 2560;
    const width = 100;
    const left = viewport - width + 2 * VISIBILITY_EPS; // overhangs by a hair
    const target = resolveScrollTarget({
      mode: "never",
      left,
      width,
      viewport,
      scrollLeft: 0,
      maxScroll: 5000,
    });
    expect(target).not.toBeNull();
    expect(Math.abs(target!)).toBeLessThan(MIN_ANIMATED_PX + PEEK_PX);
  });
});

describe("the preview's mixed-width plane", () => {
  // The settings page models five columns at five different rungs, sized so the
  // opening pair sits in the window — otherwise When needed and Always collapse
  // into the same picture on a laptop. These tests hold that plane to the same
  // standard as the uniform one: correct seams, agreement with the uniform
  // arithmetic where they should agree, a focus walk that still settles, and the
  // disagreement the page is there to show.
  const WALK = [1, 2, 3, 4, 3, 2, 1, 0];
  /** Widened so `toContain` accepts any number — the rung tuple's literal union
   *  would otherwise demand the argument be one of its own members. */
  const RUNGS: readonly number[] = LADDER_PX;

  /** One focus step, exactly the way the page runs it: the rule's answer, dropped
   *  when it declines (out of range) or when the glide isn't worth firing. */
  function apply(mode: CenterMode, viewport: number, index: number, at: number): number {
    const widths = previewColumnWidths(viewport);
    const lefts = columnLeftsFor(widths);
    const target = resolveScrollTarget({
      mode,
      left: lefts[index]!,
      width: widths[index]!,
      viewport,
      scrollLeft: at,
      maxScroll: maxScrollForWidths(mode, widths, viewport),
    });
    if (target === null) return at;
    if (Math.abs(Math.round(target - at)) < MIN_ANIMATED_PX) return at;
    return target;
  }

  function lapSig(mode: CenterMode, viewport: number): string {
    let at = 0;
    const lap: string[] = [];
    for (const index of WALK) {
      const next = apply(mode, viewport, index, at);
      lap.push(next === at ? "held" : String(Math.round(next - at)));
      at = next;
    }
    return lap.join("|");
  }

  test("the widths are distinct rungs off the ladder", () => {
    for (const w of PREVIEW_RUNGS) expect(RUNGS).toContain(w);
    expect(new Set(PREVIEW_RUNGS).size).toBeGreaterThan(1);
  });

  test("mixed and uniform arithmetic agree where they describe the same plane", () => {
    const uniform = [COL, COL, COL];
    expect(planeWidthForWidths(uniform)).toBe(planeWidthFor(3, COL));
    expect(columnLeftsFor(uniform)).toEqual([
      columnLeftFor(0, COL),
      columnLeftFor(1, COL),
      columnLeftFor(2, COL),
    ]);
    for (const mode of MODES) {
      expect(maxScrollForWidths(mode, uniform, 2560)).toBe(
        maxScrollFor(mode, 3, COL, 2560),
      );
    }
  });

  test("a mixed plane still carries one more seam than columns", () => {
    const W = previewColumnWidths(1440);
    const LEFTS = columnLeftsFor(W);
    expect(planeWidthForWidths(W)).toBe(W.reduce((sum, w) => sum + w, 0) + (W.length + 1) * JOINT_PX);
    const last = W.length - 1;
    expect(planeWidthForWidths(W) - (LEFTS[last]! + W[last]!)).toBe(JOINT_PX);
  });

  test("the opening pair sits in the window; the third peeks", () => {
    expect(PREVIEW_PAIR_FIT).toBeLessThan(1);
    for (const vp of [1280, 1440, 1512, 1680, 1920, 2560]) {
      const W = previewColumnWidths(vp);
      const L = columnLeftsFor(W);
      expect(L[1]! + W[1]!).toBeLessThanOrEqual(vp);
      expect(L[2]! + W[2]!).toBeGreaterThan(vp);
    }
  });

  test("When needed and Always disagree on a laptop-sized window", () => {
    // The previous 1:1 rungs collapsed these two from 1280px through 1792px —
    // exactly the windows the page is most often opened on.
    for (const vp of [1280, 1440, 1512, 1680, 1792, 1920, 2560]) {
      expect(lapSig("on-overflow", vp)).not.toEqual(lapSig("always", vp));
      expect(lapSig("never", vp)).not.toEqual(lapSig("always", vp));
      expect(lapSig("never", vp)).not.toEqual(lapSig("on-overflow", vp));
    }
  });

  test("at rest, Always recentres column 2 while When needed holds", () => {
    const vp = 1440;
    const W = previewColumnWidths(vp);
    const L = columnLeftsFor(W);
    const args = {
      left: L[1]!,
      width: W[1]!,
      viewport: vp,
      scrollLeft: 0,
    };
    expect(
      resolveScrollTarget({ ...args, mode: "on-overflow", maxScroll: maxScrollForWidths("on-overflow", W, vp) }),
    ).toBeNull();
    expect(
      resolveScrollTarget({ ...args, mode: "never", maxScroll: maxScrollForWidths("never", W, vp) }),
    ).toBeNull();
    expect(
      resolveScrollTarget({ ...args, mode: "always", maxScroll: maxScrollForWidths("always", W, vp) }),
    ).not.toBeNull();
  });

  // What the page needs is not literally "ends where it started" but "no drift":
  // with mixed widths the path-dependent modes can find a window where the inbound
  // leg holds where the outbound leg moved, so a lap may end a few pixels off its
  // start. Drift would be that offset compounding lap over lap; what must hold is
  // that the laps *settle* — after at most one transient lap, every further lap is
  // identical. Pinned per viewport: a future tweak to `previewColumnWidths`
  // that introduces genuine wander fails here instead of shipping a preview whose
  // fifth lap differs from its fourth.
  for (let vp = 320; vp <= 3440; vp += 40) {
    test(`every mode's laps settle at ${vp}px`, () => {
      for (const mode of MODES) {
        const at = (lap: number) => {
          let x = apply(mode, vp, 0, 0); // the page seeds on column 0
          for (let l = 0; l < lap; l += 1) for (const index of WALK) x = apply(mode, vp, index, x);
          return x;
        };
        expect(at(3)).toBe(at(4));
      }
      expect(lapSig("on-overflow", vp)).not.toEqual(lapSig("always", vp));
      expect(lapSig("never", vp)).not.toEqual(lapSig("on-overflow", vp));
    });
  }
});
