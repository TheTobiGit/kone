/** The bench portal's own padding, between the window and the pane it holds.
 *
 *  Shared with the stylesheet through the `--bench-pad` custom property so the
 *  number lives in one place. It matches the inbox's portal padding on purpose:
 *  the two portals are siblings, and a shelf of a different depth in each would
 *  read as a mistake rather than a distinction.
 */
export const BENCH_PADDING = 20;

/** The depth of the portal's shelf along the top edge.
 *
 *  On macOS the window keeps its native traffic lights but hides the title
 *  bar, so they float over the renderer's own top-left corner rather than over
 *  a strip reserved for them. That strip belongs to the window, so the pane
 *  starts below it and everything inside the pane keeps its ordinary spacing —
 *  the alternative, padding the first row down instead, leaves the row hanging
 *  off the top of a band with nothing above it.
 */
export const BENCH_TITLEBAR_CLEARANCE = 46;
