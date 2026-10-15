// Handing the caret between columns when the studio's focus moves.
//
// A click on another column has already put focus where the user aimed, so the
// column losing focus no longer contains the caret and nothing has to move. A
// keyboard step (⌘⌥⇧←/→) leaves the caret exactly where it was — still inside
// the column being left — so it must be carried to the column gaining focus, or
// the next keystroke would write into a draft the user is no longer looking at.
//
// The losing column is the one that knows which of those happened: it is the
// only side that can still see the caret. The gaining column decides whether to
// take it — a resting orb (closed composer) stays closed and wakes on the next
// keystroke by the user's own type-to-wake preference; only an open card takes
// the caret.
//
// The rule lives here, apart from the components, so it can be stated once and
// checked rather than re-derived from two watchers racing on a boolean.

/** One side of a caret hand-off: a column's composer, as the row drives it. */
export interface CaretPane {
  /** Blur the caret if this column's composer holds it right now, answering
   *  whether it did. That answer is the single fact separating a keyboard step
   *  (still holds it) from a click (it already moved on). */
  releaseCaret: () => boolean;
  /** Take the caret, but only if this column's composer is open. A no-op on a
   *  closed one, which is deliberately left resting. */
  takeCaret: () => void;
}

/** Carry the caret from the column losing focus to the one gaining it. Returns
 *  whether it moved at all. */
export function handOffCaret(losing: CaretPane | null, gaining: CaretPane | null): boolean {
  if (!losing?.releaseCaret()) return false;
  gaining?.takeCaret();
  return true;
}
