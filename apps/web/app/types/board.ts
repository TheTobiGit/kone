// The project board's data model — the contract every board consumer shares.
//
// A pane is a serialisable layout entry; a session is a runtime attachment to
// it. The board owns the entries (plain JSON, persistable); the three existing
// composables (useAgent / useTerminal / useScratchpad) stay exactly as they are
// and are reached through thin adapters. Separating the two is what lets layout
// persist, lets a restored board cost nothing (entries without sessions are
// dormant), and turns useAgent's MAX_RESIDENT_THREADS eviction from a hidden
// hazard into "the pane goes dormant and re-attaches on focus".

import type { ThreadSession } from "~/composables/useAgent";
import type { TerminalSession } from "~/composables/useTerminal";
import type { ScratchpadSession } from "~/composables/useScratchpad";

/** The three artifacts a project board can hold. Order here is the order the
 *  seam insert menu lists them in. */
export type PaneKind = "thread" | "terminal" | "scratchpad";

/** Stable pane identity. Minted once when the pane is created, persisted, and
 *  never re-minted — not when a session is evicted, not when a backend id
 *  changes underneath it. It is the DOM key, the focus key and the strip key.
 *  (This is the same lesson useAgent already learned for threads — the stable
 *  registry `key` that never changes even as the provider threadId is
 *  overwritten; now it is the board's rule for all three kinds.) */
export type PaneId = string;

/** What a pane needs to re-attach to a backend after a restart. Kept as a
 *  discriminated union so a future kind can carry different restore data. */
export type PaneAnchor =
  | { kind: "thread"; threadId: string | null }
  | { kind: "terminal"; terminalId: string | null }
  | { kind: "scratchpad"; scratchpadId: string | null };

/** Pure layout. Serialisable: no refs, no session objects, no functions.
 *  This is exactly what gets written to the store. */
export interface PaneEntry {
  id: PaneId;
  kind: PaneKind;
  anchor: PaneAnchor;
  /** Index into ThreadStrip's LADDER_PX presets. */
  width: number;
}

/** Runtime view of a pane: the entry joined to its live session, if attached.
 *  `session` is `null` for a dormant pane (restored but never focused, or
 *  evicted). Every consumer must handle null. */
export type Pane =
  | { id: PaneId; kind: "thread"; entry: PaneEntry; session: ThreadSession | null }
  | { id: PaneId; kind: "terminal"; entry: PaneEntry; session: TerminalSession | null }
  | { id: PaneId; kind: "scratchpad"; entry: PaneEntry; session: ScratchpadSession | null };

/** One path for every cross-pane action, dispatched through `board.dispatch`.
 *  `capture-text` lands selected thread text in the scratchpad; `draft-thread`
 *  opens a new thread with the composer pre-filled (already quoted by the caller);
 *  `copy` writes to the clipboard. Everything that used to reach across panes
 *  (sendToScratchpad, onSelectionNewThread, the selection bubble's kind-specific
 *  events) now emits one of these. */
export type BoardIntent =
  | { type: "capture-text"; text: string; from: PaneId }
  | { type: "draft-thread"; draft: string; from?: PaneId }
  | { type: "copy"; text: string };

/** Persisted board document. Bump `version` when the shape changes and handle
 *  the old shape in the loader (or drop it — a lost layout is not a data loss). */
export interface BoardLayout {
  version: 1;
  panes: PaneEntry[]; // array order IS left-to-right strip order
  focusedId: PaneId | null;
}
