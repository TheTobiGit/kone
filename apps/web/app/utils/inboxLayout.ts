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

/** The portal's own padding, around the panes. Shared with the stylesheet
 *  through the `--inbox-pad` custom property, so the gutter's absolute offset
 *  and the grid's padding are one token instead of two copies of `20px`. The
 *  measuring reads the content box, which already excludes this, so the value
 *  only has to stay in step on the drawing side. */
export const INBOX_PADDING = 20;

/** What the list opens at with nothing stored. */
export const DEFAULT_LIST_WIDTH = 380;

/** Narrower than this and a row's title has nowhere to go. */
export const MIN_LIST_WIDTH = 280;

/** Wider than this the list stops being a list and starts being the surface. */
export const MAX_LIST_WIDTH = 560;

/** The reading pane never goes below this, whatever the list wants. */
export const MIN_READ_WIDTH = 420;

/** One tap of the arrow keys. Small enough to feel like nudging the split. */
export const GUTTER_KEY_STEP = 12;

/** The same nudge with Shift held. Four taps in one, for crossing the range. */
export const GUTTER_KEY_STEP_LARGE = 48;

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

/**
 * The space the two panes share, from the observed content width.
 *
 * The observer reports the content box, so the portal's padding is already
 * out of it — only the rail and the gaps still have to come off. Before the
 * first measurement there is nothing to subtract from, so this stays wide
 * enough that a stored width is honoured as-is; the observer corrects it on
 * the same frame the element appears.
 */
export function availablePaneWidth(contentWidth: number): number {
  if (!(contentWidth > 0)) return MAX_LIST_WIDTH * 2;
  return contentWidth - CHROME_WIDTH;
}

/**
 * The width the list should actually take, from what is stored and what is
 * observed. Every read goes through here, so a width stored in a wide window
 * is squeezed by a narrow one without being written down small.
 */
export function resolveListWidth(stored: number, contentWidth: number): number {
  return clampListWidth(stored, availablePaneWidth(contentWidth));
}

/**
 * The drag's pixel maths, with no pointer in it: where the list should be
 * stored after the cursor has moved from `startX` to `clientX`. The caller
 * wires the pointer capture and feeds each move's clientX here, so tests can
 * drive the same arithmetic with plain numbers.
 */
export function dragListWidth(
  startWidth: number,
  startX: number,
  clientX: number,
  contentWidth: number,
): number {
  return clampListWidth(startWidth + (clientX - startX), availablePaneWidth(contentWidth));
}

/**
 * The keyboard's version of the drag. Returns the width to store, or null
 * when the key is not the gutter's business so the caller can leave the event
 * alone. Arrows nudge from the width on screen; Home and End jump through the
 * same clamp, so no key bypasses the reading pane's floor.
 */
export function gutterKeyWidth(
  current: number,
  key: string,
  shiftKey: boolean,
  contentWidth: number,
): number | null {
  const available = availablePaneWidth(contentWidth);
  if (key === "ArrowLeft") {
    const step = shiftKey ? GUTTER_KEY_STEP_LARGE : GUTTER_KEY_STEP;
    return clampListWidth(current - step, available);
  }
  if (key === "ArrowRight") {
    const step = shiftKey ? GUTTER_KEY_STEP_LARGE : GUTTER_KEY_STEP;
    return clampListWidth(current + step, available);
  }
  if (key === "Home") return clampListWidth(MIN_LIST_WIDTH, available);
  if (key === "End") return clampListWidth(MAX_LIST_WIDTH, available);
  return null;
}
