import type { Pane } from "~/types/board";
import type { ThreadSession } from "~/composables/useAgent";

/** A thread session with no transcript yet and no turn in flight — the blank
 *  slate the composer shows before the first send. Shared by the pane-level and
 *  session-level predicates so "empty" never diverges across useBoard, the strip
 *  and useAgent's resident cap. */
export function isThreadSessionBlank(s: ThreadSession): boolean {
  return s.blocks.value.length === 0 && !s.busy.value;
}

/** A thread column that is a slot, not a conversation. This backs the board's
 *  "one blank thread" invariant, so it must catch a blank slot in EITHER form:
 *   · attached — a live session with no transcript and no turn in flight;
 *   · dormant — no session yet AND an anchor that remembers no thread id (a
 *     restored blank column, deferHeavyAttach left un-attached at project home).
 *  A dormant pane WITH a remembered id is the case people get wrong: that's a
 *  real stored conversation waiting to re-attach, never a blank slot — so it's
 *  excluded. Missing the dormant-blank case is what let a restored empty column
 *  and a freshly-minted one both count as "not blank", landing the project home
 *  with two empty threads. */
export function isBlankThread(pane: Pane | null): boolean {
  if (!pane || pane.kind !== "thread") return false;
  if (pane.session) return isThreadSessionBlank(pane.session);
  return pane.entry.anchor.kind === "thread" && pane.entry.anchor.threadId === null;
}
