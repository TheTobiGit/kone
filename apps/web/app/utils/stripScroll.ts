// The thread strip's scroll geometry: the rule that decides where the rail lands
// when a column takes focus, and the constants that rule is built on.
//
// This is a leaf module on purpose, and it exists for one reason. ThreadStrip.vue
// calls `resolveScrollTarget` with numbers it measured off the live DOM;
// SettingsThreadStripPane.vue calls it with numbers it models, to show you what
// each setting will do before you pick one. Both go through this function, so the
// settings preview cannot describe behaviour the board doesn't have. Change the
// rule here and the preview changes with it — or fails to compile. A hand-copied
// port would instead drift silently, and a settings page that lies about the
// setting is worse than one that says nothing.

// niri's `center-focused-column`. `never` keeps the strip anchored and only nudges
// the focused column into view; `on-overflow` does the same but lands it centred
// when it does have to move; `always` recentres the world on every focus change.
export type CenterMode = "never" | "on-overflow" | "always";

export interface CenterModeMeta {
  value: CenterMode;
  /** Root-list and radio label. Also the value trailing the drawer's row. */
  label: string;
  /** What the strip does, in one line. The settings page shows this to assistive
   *  technology rather than on screen — sighted readers get the live preview and its
   *  caption instead, which say the same thing more precisely. */
  description: string;
}

// One list, three readers: the drawer's root row (which shows the active label
// trailing the row), the settings page's radio group, and that page's simulation.
// The descriptions are deliberately parallel — each says what happens to the strip
// first and what happens to the column second — because they're read one after
// another. They also map one-to-one onto the branches of `resolveScrollTarget`
// below; if you change a branch, the line describing it is directly underneath in
// this file.
export const CENTER_MODES: readonly CenterModeMeta[] = [
  {
    value: "never",
    label: "Never",
    description:
      "Hold the strip still. A column out of view is nudged in by the smallest move that reveals it.",
  },
  {
    value: "on-overflow",
    label: "When needed",
    description:
      "Hold the strip still while the focused column already fits. When it doesn't, bring it to the middle.",
  },
  {
    value: "always",
    label: "Always",
    description:
      "Bring the focused column to the middle every time — even when it was already in view.",
  },
] as const;

/** The column width rungs, narrowest first. `LADDER_PX[0]` is what a new column
 *  opens at, so it's also the width the settings preview models. */
export const LADDER_PX = [840, 960, 1120, 1240] as const;

/** Every column carries a seam to its right, and the leftmost mirrors one on its
 *  left, so an N-column plane holds N+1 of them. They're real elements in the
 *  plane's flex row (which runs at `gap: 0`), so they carry weight in every
 *  offsetLeft the scroll maths reads. Matches `.col-joint` width in CSS. */
export const JOINT_PX = 14;

/** In `never`, leave a sliver of the neighbour the focus came from showing, rather
 *  than guillotining it at the frame edge. */
export const PEEK_PX = 24;

/** Sub-pixel layout noise; don't scroll for half a pixel. */
export const VISIBILITY_EPS = 1;

/** Under this distance a *smooth* scroll isn't worth firing: the glide draws more
 *  attention than the movement is worth, so the board declines it and the rail
 *  stays where it is.
 *
 *  Deliberately not folded into `resolveScrollTarget`. It's a property of the
 *  animation rather than of the centring rule — an instant scroll (reduced motion,
 *  or mid-zoom, where a glide would swim against the zoom's own FLIP) still makes
 *  the move. It lives here anyway so the settings preview, whose rails glide, can
 *  report the same held-still outcome the board will actually show instead of
 *  captioning a nudge that never fires. */
export const MIN_ANIMATED_PX = 6;

/** The trailing pad exists so the *last* column can still reach the middle of the
 *  viewport. `never` never centres, so for it that pad would just be scrollable
 *  emptiness past the end of the strip — it gets a peek instead. This is why, on
 *  the last column, `never` parks the strip at its end while the centring modes sit
 *  it on the centre line. Shared because it sets `maxScroll`, and a preview that
 *  clamped differently from the board would disagree with it exactly at the edges,
 *  where the modes are most visibly different. */
export function padEndFor(mode: CenterMode, viewport: number): number {
  return mode === "never" ? PEEK_PX : viewport / 2;
}

export interface ScrollTargetInput {
  mode: CenterMode;
  /** The focused column's left edge, in the rail's scroll coordinates. */
  left: number;
  /** The focused column's width, in the same coordinates. */
  width: number;
  /** The rail's visible width — `clientWidth` on the board. */
  viewport: number;
  /** Where the rail sits right now. The two non-`always` modes are path-dependent:
   *  they decide from here, so the same focus change has different outcomes
   *  depending on where you already were. */
  scrollLeft: number;
  /** The furthest the rail can scroll — `scrollWidth - clientWidth` on the board. */
  maxScroll: number;
}

/** Where the rail should sit for this column to be usable, or `null` for "don't
 *  move". Returning `null` — rather than the current position — is what makes the
 *  strip actually *stay put*: callers treat it as a no-op, so nothing programmatic
 *  fires and no smooth-scroll animation is queued. */
export function resolveScrollTarget({
  mode,
  left,
  width,
  viewport,
  scrollLeft,
  maxScroll,
}: ScrollTargetInput): number | null {
  const clamp = (n: number) => Math.max(0, Math.min(maxScroll, n));
  const right = left + width;
  const centred = clamp(left + width / 2 - viewport / 2);

  if (mode === "always") return centred;

  // A column wider than the viewport can never be "fully visible" — centring it
  // would hide its left edge, which is where reading starts. Pin its left edge.
  // Reachable in earnest: the widest rung is 1240px, so any window narrower than
  // that lands here on every focus change, and all three modes converge.
  if (width >= viewport) return clamp(left);

  const viewL = scrollLeft;
  const viewR = viewL + viewport;
  if (left >= viewL - VISIBILITY_EPS && right <= viewR + VISIBILITY_EPS) return null;

  if (mode === "on-overflow") return centred;

  // `never`: the smallest move that brings it in, plus a peek.
  return clamp(left < viewL ? left - PEEK_PX : right - viewport + PEEK_PX);
}

/** Where the rail should settle after a free swipe. Unlike `resolveScrollTarget`
 *  this always returns a position: a released swipe must land on a column boundary
 *  rather than wherever the fingers stopped. In the centring modes that boundary is
 *  the viewport centre; in `never` it's the column's left edge (its right edge, if
 *  it's the last one and the strip has run out of room — `clamp` handles that). */
export function resolveSnapTarget({
  mode,
  left,
  width,
  viewport,
  maxScroll,
}: Omit<ScrollTargetInput, "scrollLeft">): number {
  const clamp = (n: number) => Math.max(0, Math.min(maxScroll, n));
  if (mode === "never") return clamp(left);
  return clamp(left + width / 2 - viewport / 2);
}

// ── modelling the plane ───────────────────────────────────────────────────────
// The board never needs these: it has a real DOM and measures it. They're here for
// the callers that have to *predict* a strip they can't see — the settings preview,
// and any test that wants to assert the rule without mounting a rail. They live
// next to the constants they're built from so that a change to the plane's
// structure (another seam, a pad, a gap) is one edit, not two files to remember.

/** Every column's left edge in a modelled plane of mixed widths: the leading seam,
 *  then each column's own width plus a seam. The general form of `columnLeftFor`,
 *  which is this with every width equal — kept as separate functions rather than a
 *  union parameter so each call site reads as what it means. */
export function columnLeftsFor(widths: readonly number[]): number[] {
  const lefts: number[] = [];
  let at = JOINT_PX;
  for (const width of widths) {
    lefts.push(at);
    at += width + JOINT_PX;
  }
  return lefts;
}

/** The plane's own width for mixed widths: N columns and their N+1 seams. */
export function planeWidthForWidths(widths: readonly number[]): number {
  let total = JOINT_PX;
  for (const width of widths) total += width + JOINT_PX;
  return total;
}

/** `scrollWidth - clientWidth` for a modelled plane of mixed widths. */
export function maxScrollForWidths(
  mode: CenterMode,
  widths: readonly number[],
  viewport: number,
): number {
  return Math.max(0, planeWidthForWidths(widths) + padEndFor(mode, viewport) - viewport);
}

/** A column's left edge in a modelled plane of equal columns: the leading seam, then
 *  a seam-and-column pitch for each column before it. Assumes the multi-column
 *  layout, where the start pad is zero — the solo case centres its one column with a
 *  start pad instead, and never scrolls at all. */
export function columnLeftFor(index: number, columnWidth: number): number {
  return JOINT_PX + index * (columnWidth + JOINT_PX);
}

/** The plane's own width: N equal columns, N trailing seams, and the leading seam. */
export function planeWidthFor(count: number, columnWidth: number): number {
  return planeWidthForWidths(Array.from({ length: count }, () => columnWidth));
}

/** `scrollWidth - clientWidth` for a modelled plane of equal columns. Delegates to
 *  the mixed-width form so the two can't disagree about what a plane weighs. */
export function maxScrollFor(
  mode: CenterMode,
  count: number,
  columnWidth: number,
  viewport: number,
): number {
  return maxScrollForWidths(mode, Array.from({ length: count }, () => columnWidth), viewport);
}

/** The rungs the settings preview assigns to its five columns, in walk order.
 *  Ratios match the board's ladder; magnitudes come from `previewColumnWidths`. */
export const PREVIEW_RUNGS: readonly number[] = [
  LADDER_PX[0],
  LADDER_PX[1],
  LADDER_PX[2],
  LADDER_PX[3],
  LADDER_PX[0],
] as const;

/** Fraction of the viewport the preview's opening pair occupies at rest.
 *  Under 1 so rounding can't push column 1 out of view; high enough that a
 *  third column still peeks — if the pair sat much smaller, `never` and
 *  `on-overflow` would both hold for most of the walk and the page would only
 *  be demonstrating `always`. */
export const PREVIEW_PAIR_FIT = 0.94;

/** Column widths for the settings preview at a given viewport.
 *
 *  The board's rungs start at 840px. Two of those don't fit a laptop window,
 *  so a 1:1 model leaves `on-overflow` with nothing to hold for and the two
 *  centring modes become the same picture — which is the distinction the page
 *  exists to teach. These keep the ladder's proportions but size the opening
 *  pair (columns 0 and 1) to `PREVIEW_PAIR_FIT` of the window, so at rest
 *  When needed holds and Always still recentres. */
export function previewColumnWidths(viewport: number): number[] {
  const vp = Math.max(320, viewport);
  const pair = PREVIEW_RUNGS[0]! + PREVIEW_RUNGS[1]!;
  const scale = (vp * PREVIEW_PAIR_FIT - 2 * JOINT_PX) / pair;
  return PREVIEW_RUNGS.map((w) => Math.max(1, Math.round(w * scale)));
}

/** How many whole columns are visible at once — the number that decides whether
 *  the three modes can even differ. `on-overflow` only diverges from `always` when
 *  a column can already be fully in view without scrolling, so at fewer than two
 *  the two centring modes collapse into the same behaviour. */
export function columnsInView(viewport: number, columnWidth: number): number {
  const pitch = columnWidth + JOINT_PX;
  if (pitch <= 0) return 0;
  return Math.max(0, Math.floor((viewport + VISIBILITY_EPS) / pitch));
}
