// What the inbox's reading pane is showing, as one value.
//
// Picking the pane used to be a joint decision spread across the portal: whether
// a message was being composed, which thread was selected, whether the portal
// had ever been entered, and a handed-over session key — read in two places at
// once, with the template choosing between the composer and the reader while
// the read-marking derived whether anyone was actually looking. Every branch
// had to agree on what the others meant, and the fall-through rendered nothing
// at all. The pieces still live as portal-owned state in AppInbox, which reads
// paneState.selected directly (the list v-model, the read-marking watcher, the
// child-thread parent lookup) and assigns the single-field steps directly
// (visited, composing). What lives here is the one resolver the template
// switches on, plus the multi-field transitions where more than one field has
// to move together — threadStarted, pickThread, openThread.

import type { SessionSummary } from "~/types/session";

/** Everything the reading-pane decision reads. Owned by the portal; the
 *  multi-field transitions below move it together, while the single-field
 *  steps (visited, composing) are assigned directly where they happen. */
export interface InboxReadingPaneState {
  /** Latched on the portal's first activation and never cleared: the portal
   *  hides rather than unmounts, so once you have been in, the surface stays
   *  put across visits instead of throwing away a half-written message every
   *  time the inbox is dismissed. */
  visited: boolean;
  /** A message is being composed, taking over the reading pane rather than
   *  opening beside it: the inbox is one thing at a time, and a half-written
   *  message you cannot see is a message you lose. */
  composing: boolean;
  /** Which thread the reading pane is showing. Portal-level rather than
   *  per-view, so switching between the inbox and the archive does not throw
   *  away what you were reading — the resolver takes no view, which is what
   *  makes that structural rather than something every caller must remember. */
  selected: SessionSummary | null;
  /** The live session behind a thread the composer just started, so the reading
   *  pane attaches to that very session instead of looking one up by id. Only
   *  ever set by the handover, and dropped as soon as you read something else —
   *  every other thread is opened the ordinary way. */
  handedKey: string | null;
}

export function createInboxReadingPaneState(): InboxReadingPaneState {
  return { visited: false, composing: false, selected: null, handedKey: null };
}

/** The pane descriptor the template switches on. `composer` covers both the
 *  half-written message and the empty state: with nothing picked there is
 *  nothing to read, so the empty state IS the composer. `idle` is the portal
 *  before its first visit with nothing picked — deliberately blank, because
 *  mounting the composer would claim a session at boot for a project nobody
 *  has opened. */
export type InboxReadingPane =
  | { kind: "composer" }
  | { kind: "reader"; row: SessionSummary; sessionKey: string | null }
  | { kind: "idle" };

export function resolveInboxReadingPane(state: InboxReadingPaneState): InboxReadingPane {
  if (state.visited && (state.composing || state.selected === null)) {
    return { kind: "composer" };
  }
  if (state.selected !== null) {
    return { kind: "reader", row: state.selected, sessionKey: state.handedKey };
  }
  return { kind: "idle" };
}

/** The composer's thread has started. From here it is read the way a picked
 *  row is read, and the pane attaches to the live session behind it. */
export function threadStarted(
  state: InboxReadingPaneState,
  row: SessionSummary,
  sessionKey: string,
): void {
  state.selected = row;
  state.handedKey = sessionKey;
  state.composing = false;
}

/** A thread picked out of the list. This only drops what belonged to the
 *  composer: the composer itself, and its session key, which must not leak
 *  onto a thread that opens the ordinary way. */
export function pickThread(state: InboxReadingPaneState): void {
  state.composing = false;
  state.handedKey = null;
}

/** A thread opened by id — resolved to a row first, then shown the ordinary
 *  way, like a picked row. */
export function openThread(state: InboxReadingPaneState, summary: SessionSummary): void {
  state.selected = summary;
  state.composing = false;
  state.handedKey = null;
}
