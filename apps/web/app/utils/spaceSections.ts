// Which section of the Space board the camera is on.
//
// It is a plain function of where the camera is, not of what happens to be on
// screen. Several columns are usually in view at once (on a wide window
// Telemetry and Models both are), so "the most visible one" is a coin toss; the
// column at the pane's edge is the one the camera is on, and only one column is
// ever there.

export interface ColumnSpan<S extends string> {
  section: S;
  /** The column's left edge, in the track's own coordinates. */
  left: number;
  /** Its right edge, likewise. */
  right: number;
}

/** How far in from the pane's edge the camera looks. A column becomes current
 *  as its leading edge comes within this of the pane, so the nav answers a beat
 *  before a column lands rather than after. */
export const LOOK_AHEAD = 120;

/**
 * The section whose column sits at the pane's edge when the track is scrolled
 * to `scrollLeft`. Spans run left to right. Scrolled past the last column (the
 * room left after it) is still the last section; a track that has not been
 * measured yet has none.
 */
export function sectionAt<S extends string>(
  spans: readonly ColumnSpan<S>[],
  scrollLeft: number,
  look: number = LOOK_AHEAD,
): S | null {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (!first || !last) return null;
  const x = scrollLeft + look;
  if (x < first.left) return first.section;
  for (const span of spans) {
    if (x >= span.left && x < span.right) return span.section;
  }
  return last.section;
}

/** How far each edge's fade runs into the track, in px. */
export interface EdgeFades {
  left: number;
  right: number;
}

/** The longest an edge fade runs. */
export const EDGE_REACH = 40;

/**
 * How far to run the fade at each edge of the track, for the edges that cut
 * through a column's content. A fade belongs only to the column being cut: it
 * grows as the edge moves into that column, shrinks again as the column's far
 * end nears, and never runs past it, so it can't spill over the column that is
 * arriving. An edge in the gap between columns, or on a column's own edge, gets
 * none, and so a column sent flush against the pane has nothing over it.
 *
 * `inset` is how far a column's content sits in from its edges, so the gap
 * between two columns' content counts as empty. `viewport` is the track's
 * visible width.
 */
export function edgeFades(
  spans: readonly Pick<ColumnSpan<string>, "left" | "right">[],
  scrollLeft: number,
  viewport: number,
  inset = 0,
  reach = EDGE_REACH,
): EdgeFades {
  const end = scrollLeft + viewport;
  let left = 0;
  let right = 0;
  for (const span of spans) {
    const from = span.left + inset;
    const to = span.right - inset;
    if (from < scrollLeft && scrollLeft < to) left = Math.min(reach, scrollLeft - from, to - scrollLeft);
    if (from < end && end < to) right = Math.min(reach, end - from, to - end);
  }
  return { left, right };
}
