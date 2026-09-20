import { watch } from "vue";
import type { Pane } from "~/types/studio";
import { useUnreadThreads } from "~/composables/useUnreadThreads";

// The strip's unread marks — one accent dash per background thread with unseen
// activity, beside the breathing live dash.
//
// Which threads those are is not decided here. `useUnreadThreads` holds the one
// definition, shared per project across every row looking at the same
// repository and stamped through the same write the inbox uses — so the two
// surfaces cannot disagree about what "unread" means, cannot settle at
// different times after a turn, and a future event type teaches both at once.
// This owns only the part that is about a strip: which column is a background
// column, and when a column counts as read.
export function useStripUnread(deps: {
  panes: () => Pane[];
  /** The thread a column is showing, if any — the strip's one answer to that
   *  question, owned by `useStripLinking` and handed in rather than re-derived
   *  here from the same pane shape. */
  paneThreadId: (pane: Pane) => string | null;
  projectPath: () => string | undefined;
  focusedId: () => string;
  visible: () => boolean | undefined;
}) {
  const { panes, paneThreadId, projectPath, focusedId, visible } = deps;
  const unread = useUnreadThreads(projectPath);

  // The strip shows unread only on background columns — the focused one is in
  // front of someone, the same reason the live dash hides on focus.
  function isUnread(pane: Pane): boolean {
    if (pane.id === focusedId()) return false;
    const threadId = paneThreadId(pane);
    return threadId ? unread.isUnread(threadId) : false;
  }

  // A column brought to the front has been read — but only once it is on a
  // strip somebody can see, which is the same rule the turn-settle stamp in
  // `useStripLinking` follows. Both halves are watched, and that matters: a
  // column focused behind a hidden strip would otherwise have its visit
  // dropped, and since revealing the strip replays nothing, the dash would
  // stay until focus left the column and came back to it.
  watch(
    [() => focusedId(), () => visible()],
    ([id, shown]) => {
      if (shown === false) return;
      const pane = panes().find((p) => p.id === id);
      const threadId = pane ? paneThreadId(pane) : null;
      if (threadId) unread.markVisited(threadId);
    },
    { immediate: true },
  );

  return { isUnread };
}
