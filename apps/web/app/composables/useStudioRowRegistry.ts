// useStudioRowRegistry — reach a project's studio row without holding a ref to it.
//
// A row is mounted by the plane (<StudioAppStudio>), but the things that need to drive
// one are elsewhere: the project page's conversation list archives a thread, a
// teardown flushes the layout, a pill opens a thread. Those used to be a
// template ref, which only worked while the row was the page's own child. Now
// that rows live on the plane and pages live under it, a ref would have to be
// drilled back down through the page tree — so the row publishes itself instead
// and callers look it up by project path.
//
// Module scope, keyed by path, exactly like the agent's per-project session
// registry: the plane outlives any one page, and two components asking for the
// same project must get the same row.

/** The thread column a row is focused on, described for the surfaces outside
 *  the row: enough to label a menu row and to decide which actions can run.
 *  A blank thread is not one — there is nothing in it to compact, fork or
 *  archive. */
export interface StudioRowThread {
  paneId: string;
  threadId: string;
  title: string;
  /** Manual compaction can run on it right now. */
  compactable: boolean;
  /** A side chat is already a fork, so it neither forks again nor hands off. */
  forkable: boolean;
}

/** The thread actions a row can run from outside itself. Each one has a control
 *  in the column header or the composer; this is the same call, named. */
export type StudioRowThreadOp = "compact" | "archive" | "side-chat" | "handoff";

/** What a mounted row offers the rest of the app. Declared here rather than
 *  inferred from the component so importing this does not drag in the row (and
 *  so the row cannot quietly narrow the contract). */
export interface StudioRowApi {
  /** Open a persisted conversation as a pane, focusing it if it already is one. */
  openSession: (threadId: string) => void;
  /** Bring a thread's pane on screen, attaching it first if it went dormant. */
  revealThread: (threadId: string) => Promise<void>;
  /** Forget a thread in the live registry too, so a pill can't outlive the row
   *  it came from. Both refuse while the thread is still working. */
  archiveSession: (threadId: string) => void;
  removeSession: (threadId: string) => void;
  /** Whether a thread is mid-turn — the gate the two above answer to. */
  sessionBusy: (threadId: string) => boolean;
  openThread: (threadId: string) => void;
  /** Take a thread that was started somewhere else in the app and put it on this
   *  row as a pane. Unfocused, and it does not bring the plane forward — the
   *  column is waiting when you next travel here. Deduped: a thread the row
   *  already hosts stays where it is. */
  adoptThread: (threadId: string) => void;
  /** Drop a thread pane from this row if one is open/dormant for it. */
  dismissThread: (threadId: string) => void;
  newThread: () => void;
  openTerminal: () => void;
  openScratchpad: () => void;
  playDemo?: () => void;
  captureText?: (text: string) => void;
  focusPane?: (paneId: string) => void;
  shiftPaneFocus?: (delta: number) => void;
  /** Write the row's layout through, past any debounce. */
  flush: () => void;
  /** Stop a turn in flight cleanly before something tears the row down anyway. */
  interruptIfRunning: () => void;
  /** The focused thread column, or null when the focused pane is a terminal, a
   *  scratchpad, or a thread with nothing said in it yet. */
  focusedThread: () => StudioRowThread | null;
  /** Run one of the column's thread actions. The pane is named rather than
   *  re-read from focus: a caller that decided what to offer about one column
   *  must land on that column, even if focus moved in between. */
  runThreadAction: (op: StudioRowThreadOp, paneId: string) => void;
}

/** The other direction: a project page's own conversation list, so a row can
 *  correct it. Archiving from a column header has to drop the row from the list
 *  on screen as well as stamp the store, and the row can no longer be handed
 *  that function as a prop — the list is under the plane, not above the row. */
export interface ProjectHistoryList {
  /** Drop the thread from the on-screen list AND stamp it archived in the store.
   *
   *  Resolves to whether the store took it. The store refuses an archive whose
   *  subtree is still working, and the caller is about to forget the live
   *  session and close the column behind this — so the answer has to come back,
   *  or a refusal tears the row's half down around a thread that never went
   *  anywhere. */
  archive: (threadId: string) => Promise<boolean>;
  remove: (threadId: string) => void;
}

/** The row the plane's camera is standing on. The plane publishes it and the
 *  surfaces outside the plane read it: a gesture over the studio is about one
 *  row, and nothing outside the plane can work out which. Module scope for the
 *  same reason the rows map is — the reader holds no ref to the plane. */
export interface FocusedStudioRow {
  projectPath: string;
  name: string;
}

let focused: FocusedStudioRow | null = null;

const rows = new Map<string, StudioRowApi>();
const historyLists = new Map<string, ProjectHistoryList>();

/** Stamp the store when no page is showing this project's list — a background
 *  row archiving one of its own threads. There is nothing on screen to correct,
 *  so only the durable half of the operation applies. */
function stampOnly(): ProjectHistoryList {
  const api = () =>
    import.meta.client ? window.koneDesktop?.agent?.history : undefined;
  return {
    // No bridge means browser dev, where there is no store to refuse: the caller
    // may proceed.
    archive: async (threadId) => {
      const bridge = api();
      if (!bridge) return true;
      const result = await bridge.archive(threadId, true).catch(() => null);
      return result?.ok === true;
    },
    remove: (threadId) => void api()?.remove(threadId).catch(() => {}),
  };
}

export function useStudioRowRegistry() {
  return {
    register(projectPath: string, api: StudioRowApi): void {
      rows.set(projectPath, api);
    },

    /** Only clears the entry if it is still the one that was registered. A row
     *  remounting for the same project can register before the outgoing one
     *  unregisters, and dropping the newcomer would leave the project with no
     *  reachable row at all. */
    unregister(projectPath: string, api?: StudioRowApi): void {
      if (api && rows.get(projectPath) !== api) return;
      rows.delete(projectPath);
    },

    /** The project's row, or null when the plane has none mounted for it — a
     *  project with no work on it, or one whose row has not been built yet. Every
     *  caller has to handle null: a page can outlive, or precede, its row. */
    rowFor(projectPath: string): StudioRowApi | null {
      return rows.get(projectPath) ?? null;
    },

    /** The plane says which row it is standing on; null while it holds none. */
    publishFocusedRow(row: FocusedStudioRow | null): void {
      focused = row;
    },

    /** The row the plane is standing on, or null when the plane holds none.
     *  Note this is the *camera's* row, which can be one the plane conjured for
     *  a project with no work on it yet — so it may name a project `rowFor`
     *  has no entry for. */
    focusedRow(): FocusedStudioRow | null {
      return focused;
    },

    /** Every row the plane currently has mounted. For work that is thread-shaped
     *  rather than project-shaped — an archive stamp names a thread and nothing
     *  else, so the row hosting it has to be found rather than known. */
    mountedRows(): StudioRowApi[] {
      return [...rows.values()];
    },

    /** A project page publishes its conversation list here for the lifetime of
     *  the page, so its row can drop a row it archived. */
    registerHistoryList(projectPath: string, api: ProjectHistoryList): void {
      historyLists.set(projectPath, api);
    },

    unregisterHistoryList(projectPath: string, api?: ProjectHistoryList): void {
      if (api && historyLists.get(projectPath) !== api) return;
      historyLists.delete(projectPath);
    },

    /** How this project's history should be stamped right now: through the page's
     *  list when one is on screen (so the row disappears from it immediately),
     *  and straight to the store when none is. Never null — archiving must always
     *  reach the store, whatever is or isn't mounted. */
    historyFor(projectPath: string): ProjectHistoryList {
      return historyLists.get(projectPath) ?? stampOnly();
    },

    /** Flush every mounted row. For a window teardown, where each row holds
     *  layout the next launch should come back to — not just the focused one. */
    flushAll(): void {
      for (const api of rows.values()) {
        try {
          api.flush();
        } catch {
          // One row failing to serialise must not cost the others their layout.
        }
      }
    },
  };
}
