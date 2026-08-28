// How wide the inbox's list pane is allowed to be.
//
// A leaf module so the rule can be stated once and tested, rather than living
// inline in a pointer handler where the only way to exercise it is to drag with
// a mouse. The awkward part is not the drag — it is that a stored width has to
// survive a window that has since become narrower than the width it was stored
// at, and it must never leave the reading pane too small to read.

/** The gap between the panes, which the drag handle sits in. Shared with the
 *  stylesheet through the `--inbox-gutter-w` custom property, so the measuring
 *  and the drawing cannot drift apart. */
export const GUTTER_WIDTH = 12;

/** The view rail, standing on the ground to the left of both panes. Fixed: it
 *  holds icons, so it never has an opinion about how much room it wants. */
export const RAIL_WIDTH = 34;

/** What the columns cost before either pane gets a pixel: the rail, plus the
 *  two gaps around it and between the panes. */
export const CHROME_WIDTH = RAIL_WIDTH + GUTTER_WIDTH * 2;

/** What the list opens at with nothing stored. */
export const DEFAULT_LIST_WIDTH = 380;

/** Narrower than this and a row's title has nowhere to go. */
export const MIN_LIST_WIDTH = 280;

/** Wider than this the list stops being a list and starts being the surface. */
export const MAX_LIST_WIDTH = 560;

/** The reading pane never goes below this, whatever the list wants. */
export const MIN_READ_WIDTH = 420;

/**
 * The width the list should actually take, given what it asked for and how much
 * room the two panes have between them.
 *
 * `available` is the space the panes share — the portal minus its padding and
 * the gutter between them. When it is too tight to honour both minimums the
 * list yields first: the reading pane is the one being read.
 */
export function clampListWidth(want: number, available: number): number {
  const wanted = Number.isFinite(want) ? want : DEFAULT_LIST_WIDTH;
  // What is left for the list once the reading pane has its floor. Below the
  // list's own minimum this goes negative, and the Math.max under it wins.
  const roomFor = available - MIN_READ_WIDTH;
  const ceiling = Math.min(MAX_LIST_WIDTH, roomFor);
  return Math.round(Math.max(MIN_LIST_WIDTH, Math.min(wanted, ceiling)));
}
