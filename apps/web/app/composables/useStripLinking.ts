import { computed, watch } from "vue";

import type { Pane } from "~/types/studio";
import { isBlankThread } from "~/utils/panes";
import { markThreadVisited } from "~/utils/sessionList";
import { latestAssistant, type ThreadSession } from "./useAgent";

// Side-chat linkage and blank-pane predicates, plus the read-stamp watcher.
// `isLinkedToNext` decides whether a seam renders as a linked joint
// (`.col-joint--linked`) — it is read by the template *and* is the DOM
// contract `stripScroll.test.ts` models, so it moves verbatim. The watcher
// moves with the state it watches: it stamps a thread visited whenever one
// of its turns settles while the column is on screen.
export function useStripLinking(deps: {
  panes: () => Pane[];
  visible: () => boolean | undefined;
}) {
  const { panes, visible } = deps;

  /** Every column is closeable: the board is a desktop, so closing the last window
   *  leaves it bare and the chooser takes over. Nothing is respawned behind it. */
  function canClose(): boolean {
    return true;
  }

  /** Is any blank thread column on the board? Drives the seam menu's greyed
   *  "New thread" row (L3) — board-wide, not only when it's the lone column. */
  const hasBlankThread = computed(() => panes().some((p) => isBlankThread(p)));

  function paneThreadId(p: Pane): string | null {
    if (p.kind !== "thread") return null;
    return p.session?.threadId.value ?? (p.entry.anchor.kind === "thread" ? p.entry.anchor.threadId : null);
  }

  function paneSideChatSource(p: Pane): string | null {
    if (p.kind !== "thread") return null;
    return (
      p.session?.sideChatSource.value ??
      (p.entry.anchor.kind === "thread" ? p.entry.anchor.sideChatSource ?? null : null)
    );
  }

  function isLinkedToNext(i: number): boolean {
    if (i < 0 || i >= panes().length - 1) return false;
    const current = panes()[i];
    const next = panes()[i + 1];
    if (!current || !next) return false;
    if (current.kind !== "thread" || next.kind !== "thread") return false;

    const nextSource = paneSideChatSource(next);
    if (!nextSource) return false;

    const currentId = paneThreadId(current);
    const currentSource = paneSideChatSource(current);

    return nextSource === currentId || (Boolean(currentSource) && currentSource === nextSource);
  }

  // Reading a thread here is reading it, the same as reading it in the inbox: a
  // thread on screen in a column is not one you have to be told about later. So a
  // visible column stamps its thread visited whenever a turn of it settles under
  // the user's eyes, and the inbox's unread mark answers to that write rather than
  // to which surface made it.
  //
  // Every visible column, not only the focused one — a strip is several threads
  // side by side, and they are all in front of you. The stamp is keyed by the turn
  // it acknowledges, so a settle costs one write however many columns saw it, and
  // a re-render costs none.
  watch(
    () =>
      panes()
        .filter((p) => p.kind === "thread" && p.session)
        .map((p) => {
          // SAFETY: the filter above keeps only thread panes, whose session is a
          // ThreadSession.
          const session = p.session as ThreadSession;
          const block = latestAssistant(session.timelineBlocks.value);
          return `${session.threadId.value}:${block?.turnId ?? ""}:${block?.state ?? ""}`;
        })
        .join("|"),
    () => {
      if (visible() === false) return;
      for (const pane of panes()) {
        if (pane.kind !== "thread" || !pane.session) continue;
        const threadId = pane.session.threadId.value;
        if (!threadId) continue;
        const block = latestAssistant(pane.session.timelineBlocks.value);
        // A running turn has not said anything yet — the visit that matters is the
        // one that sees how it ended.
        if (!block || block.state === "running") continue;
        markThreadVisited(threadId, block.turnId);
      }
    },
    { immediate: true },
  );

  return { canClose, hasBlankThread, paneThreadId, paneSideChatSource, isLinkedToNext };
}
