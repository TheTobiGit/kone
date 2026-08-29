// The studio's data model — the contract every studio consumer shares.
//
// The studio is one plane. Its rows are projects and its columns are panes, so
// travelling sideways moves through one project's work and travelling down
// moves to another project's. A row exists only where work does: it is born
// with its first pane and dies with its last, which is why nothing here can
// describe an empty row.
//
// A pane is a serialisable layout entry; a session is a runtime attachment to
// it. The studio owns the entries (plain JSON, persistable); the three existing
// composables (useAgent / useTerminal / useScratchpad) stay exactly as they are
// and are reached through thin adapters. Separating the two is what lets layout
// persist, lets a restored row cost nothing (entries without sessions are
// dormant), and turns useAgent's MAX_RESIDENT_THREADS eviction from a hidden
// hazard into "the pane goes dormant and re-attaches on focus".

import type { ThreadSession } from "~/composables/useAgent";
import type { TerminalSession } from "~/composables/useTerminal";
import type { ScratchpadSession } from "~/composables/useScratchpad";

/** The three artifacts a studio row can hold. Order here is the order the
 *  seam insert menu lists them in. */
export type PaneKind = "thread" | "terminal" | "scratchpad";

/** Stable pane identity. Minted once when the pane is created, persisted, and
 *  never re-minted — not when a session is evicted, not when a backend id
 *  changes underneath it. It is the DOM key, the focus key and the strip key.
 *  (This is the same lesson useAgent already learned for threads — the stable
 *  registry `key` that never changes even as the provider threadId is
 *  overwritten; now it is the studio's rule for all three kinds.) */
export type PaneId = string;

/** What a pane needs to re-attach to a backend after a restart. Kept as a
 *  discriminated union so a future kind can carry different restore data. */
export type PaneAnchor =
  | { kind: "thread"; threadId: string | null; sideChatSource?: string | null }
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
  /** Whether the pane is maximized to fill the strip rail. */
  zen?: boolean;
}

/** Runtime view of a pane: the entry joined to its live session, if attached.
 *  `session` is `null` for a dormant pane (restored but never focused, or
 *  evicted). Every consumer must handle null. */
export type Pane =
  | { id: PaneId; kind: "thread"; entry: PaneEntry; session: ThreadSession | null }
  | { id: PaneId; kind: "terminal"; entry: PaneEntry; session: TerminalSession | null }
  | { id: PaneId; kind: "scratchpad"; entry: PaneEntry; session: ScratchpadSession | null };

/** One path for every cross-pane action, dispatched through `studio.dispatch`.
 *  `capture-text` lands selected thread text in the scratchpad; `draft-thread`
 *  opens a new thread with the composer pre-filled (already quoted by the caller);
 *  `copy` writes to the clipboard. Everything that used to reach across panes
 *  (sendToScratchpad, onSelectionNewThread, the selection bubble's kind-specific
 *  events) now emits one of these. */
export type StudioIntent =
  | { type: "capture-text"; text: string; from: PaneId }
  | { type: "draft-thread"; draft: string; from?: PaneId }
  | { type: "copy"; text: string };

/** One project's row: its panes in left-to-right order, and which of them the
 *  row was left focused on. Each row keeps its own focus so returning to a row
 *  returns you to the pane you were working in, not to its left edge. */
export interface StudioRow {
  /** The project this row's panes belong to. Also the row's identity — a
   *  project has at most one row, so nothing else needs to key it. */
  projectPath: string;
  panes: PaneEntry[]; // array order IS left-to-right order within the row
  focusedId: PaneId | null;
}

/** Persisted studio document — the whole plane, read and written as one.
 *  Bump `version` when the shape changes and handle the old shape in the loader
 *  (or drop it — a lost layout is not a data loss).
 *
 *  v2 replaced the per-project board blob: rows used to be separate documents
 *  keyed by project path, which could not express their order relative to one
 *  another, and the plane's vertical order is exactly that. */
export interface StudioLayout {
  version: 2;
  rows: StudioRow[]; // array order IS top-to-bottom order of the plane
  /** The project whose row is focused, by path. Null on an empty plane. */
  focusedRow: string | null;
}
