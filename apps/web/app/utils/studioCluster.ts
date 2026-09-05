// studioCluster — a thread and its side chats move as one.
//
// The strip keeps a thread's side chats glued to it: opening beside a thread
// lands after its chats, and dragging a thread carries the whole cluster. This
// module computes the cluster's contiguous index range. It takes its two id
// reads as arguments so the range logic stays pure — callers bind them to the
// live registry (attached sessions) with the dormant-anchor fallback.

import type { PaneEntry } from "~/types/studio";

/** A contiguous run of strip positions, inclusive at both ends. */
export type ClusterRange = { start: number; end: number };

/** The contiguous strip index range `[start, end]` of a thread and all its
 *  attached side chats. If `index` points at a standalone pane, returns
 *  `{ start: index, end: index }`. The resolvers read through whatever mapping
 *  the caller holds (live join, or reconcile's staged copy). */
export function clusterRangeFor(
  index: number,
  list: PaneEntry[],
  threadIdOf: (e: PaneEntry) => string | null,
  sideChatSourceOf: (e: PaneEntry) => string | null,
): ClusterRange {
  if (index < 0 || index >= list.length) return { start: index, end: index };
  const current = list[index]!;
  if (current.kind !== "thread") return { start: index, end: index };

  const currentSource = sideChatSourceOf(current);
  const rootId = currentSource ?? threadIdOf(current);
  if (!rootId) return { start: index, end: index };

  let start = index;
  while (start > 0) {
    const prev = list[start - 1]!;
    if (prev.kind !== "thread") break;
    const prevId = threadIdOf(prev);
    const prevSource = sideChatSourceOf(prev);
    if (prevId === rootId || (prevSource && prevSource === rootId)) {
      start -= 1;
    } else {
      break;
    }
  }

  let end = index;
  while (end < list.length - 1) {
    const next = list[end + 1]!;
    if (next.kind !== "thread") break;
    const nextId = threadIdOf(next);
    const nextSource = sideChatSourceOf(next);
    if (nextId === rootId || (nextSource && nextSource === rootId)) {
      end += 1;
    } else {
      break;
    }
  }

  return { start, end };
}
