// Handoff markers, grouped onto the timeline exchanges they precede — the
// same oldest-first march the compaction markers use (see
// utils/compactionMarkers.ts): a marker belongs above the first exchange
// starting at or after it, so later turns keep arriving below it. Pure, so
// placement is pinned by unit tests rather than by scrolling long threads.
import type { MarkerExchange } from "~/utils/compactionMarkers";
import type { BrandKey } from "~/utils/modelCatalog";

/** One handoff marker line: static verb ("Handed from" / "Handed to") plus
 *  the clickable other end. `at` is the handoff's creation time — the point
 *  in the flow the marker sits at. */
export type HandoffMark = {
  key: string;
  at: number;
  kind: "from" | "to";
  threadId: string;
  label: string;
  brand: BrandKey;
};

export type GroupedHandoffMarks = {
  /** Markers keyed by the exchange they precede. A separate bucket below —
   *  never a sentinel string mixed into this map — so no exchange key can
   *  collide with the trailing set. */
  byExchange: Map<string, HandoffMark[]>;
  /** Markers newer than every exchange — these trail the thread. */
  trailing: HandoffMark[];
};

/** Group markers onto the exchange they precede: a marker belongs above the
 *  first exchange starting at or after it. Both sides march oldest-first, so
 *  each marker settles in a single pass — no find-per-marker scan. Grouped
 *  over the FULL exchange list (not the open window) so a marker above the
 *  collapsed window reappears with its exchange on reveal. */
export function groupHandoffMarks(
  marks: readonly HandoffMark[],
  exchanges: readonly MarkerExchange[],
): GroupedHandoffMarks {
  const ordered = [...exchanges].sort(
    (a, b) => (a.firstAt ?? Number.POSITIVE_INFINITY) - (b.firstAt ?? Number.POSITIVE_INFINITY),
  );
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const byExchange = new Map<string, HandoffMark[]>();
  const trailing: HandoffMark[] = [];
  let e = 0;
  for (const mark of sorted) {
    let host = ordered[e];
    while (host && (host.firstAt ?? Number.POSITIVE_INFINITY) < mark.at) {
      e += 1;
      host = ordered[e];
    }
    if (!host) {
      trailing.push(mark);
      continue;
    }
    const list = byExchange.get(host.key);
    if (list) list.push(mark);
    else byExchange.set(host.key, [mark]);
  }
  return { byExchange, trailing };
}
