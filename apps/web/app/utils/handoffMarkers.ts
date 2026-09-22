// Handoff markers, grouped onto the timeline exchanges they precede — the
// same oldest-first march the compaction markers use (see
// utils/compactionMarkers.ts): a marker belongs above the first exchange
// starting at or after it, so later turns keep arriving below it. Pure, so
// placement is pinned by unit tests rather than by scrolling long threads.
import type { MarkerExchange } from "~/utils/compactionMarkers";
import type { BrandKey } from "~/utils/modelCatalog";

/** One continuation marker line: a static verb plus the clickable other end.
 *  `at` is the fork's creation time — the point in the flow the marker sits
 *  at. `kind` is the direction (this thread came from it, or led to it) and
 *  `relation` is what happened: a handoff moved the whole conversation to
 *  other hands, a branch took it from one reply onwards. */
export type HandoffMark = {
  key: string;
  at: number;
  kind: "from" | "to";
  relation: "handoff" | "branch";
  threadId: string;
  label: string;
  brand: BrandKey;
};

/** The four verbs the two axes make. Kept beside the type so a new relation
 *  cannot be added without a reader noticing the label it needs. */
export function handoffMarkVerb(mark: Pick<HandoffMark, "kind" | "relation">): string {
  if (mark.relation === "branch") return mark.kind === "from" ? "Forked from" : "Forked to";
  return mark.kind === "from" ? "Handed from" : "Handed to";
}

export type GroupedMarks<T> = {
  /** Markers keyed by the exchange they precede. A separate bucket below —
   *  never a sentinel string mixed into this map — so no exchange key can
   *  collide with the trailing set. */
  byExchange: Map<string, T[]>;
  /** Markers newer than every exchange — these trail the thread. */
  trailing: T[];
};

/** The handoff timeline's own grouping. Every kind of timestamped mark files
 *  onto exchanges the same way, so the march below is generic and this alias
 *  is what the handoff callers read. */
export type GroupedHandoffMarks = GroupedMarks<HandoffMark>;

/** Group markers onto the exchange they precede: a marker belongs above the
 *  first exchange starting at or after it. Both sides march oldest-first, so
 *  each marker settles in a single pass — no find-per-marker scan. Grouped
 *  over the FULL exchange list (not the open window) so a marker above the
 *  collapsed window reappears with its exchange on reveal. */
export function groupHandoffMarks<T extends { at: number }>(
  marks: readonly T[],
  exchanges: readonly MarkerExchange[],
): GroupedMarks<T> {
  const ordered = [...exchanges].sort(
    (a, b) => (a.firstAt ?? Number.POSITIVE_INFINITY) - (b.firstAt ?? Number.POSITIVE_INFINITY),
  );
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const byExchange = new Map<string, T[]>();
  const trailing: T[] = [];
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
