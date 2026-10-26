/** What the column's floor has to clear, and whether the card is open — the
 *  row lifts the focused column's corner docks onto a rail above an open
 *  card. Kept out of the component so the ask rule is testable. */
export type ColumnComposerDock = { open: boolean; height: number; clear: number };

/** While a pending ask owns the composer's spot, the composer stays mounted
 *  (its draft state has to survive) but reports no floor of its own: the row
 *  brings the corner docks back and the ask card lands where the composer was.
 *  Resolving the ask re-reports the live state. */
export function columnComposerDockState(input: {
  asking: boolean;
  open: boolean;
  height: number;
  clear: number;
}): ColumnComposerDock | null {
  if (input.asking) return null;
  return { open: input.open, height: input.height, clear: input.clear };
}
