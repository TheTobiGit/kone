// Settled compaction boundaries, grouped onto the timeline exchanges they
// precede — plus the one quiet line each marker renders as. Pure, so marker
// placement is pinned by unit tests rather than by scrolling long threads.
import { formatContextTokens } from "~/utils/formatContextTokens";
import type { CompactionRecord } from "~/types/desktop";

/** The smallest exchange shape grouping reads — a stable key plus the first
 *  block's timestamp. An unknown `firstAt` sorts last: with no time known,
// nothing can precede it, so markers only land above it by recency. */
export type MarkerExchange = {
  key: string;
  firstAt: number | undefined;
};

export type GroupedMarkers = {
  /** Markers keyed by the exchange they precede. A separate bucket below —
   *  never a sentinel string mixed into this map — so no exchange key can
   *  collide with the trailing set. */
  byExchange: Map<string, CompactionRecord[]>;
  /** Markers newer than every exchange — these trail the thread. */
  trailing: CompactionRecord[];
};

/** Group markers onto the exchange they precede: a marker belongs above the
 *  first exchange starting at or after it. Both sides march oldest-first, so
 *  each marker settles in a single pass — no find-per-marker scan. */
export function groupCompactionMarkers(
  markers: readonly CompactionRecord[],
  exchanges: readonly MarkerExchange[],
): GroupedMarkers {
  const ordered = [...exchanges].sort(
    (a, b) => (a.firstAt ?? Number.POSITIVE_INFINITY) - (b.firstAt ?? Number.POSITIVE_INFINITY),
  );
  const sorted = [...markers].sort((a, b) => a.at - b.at);
  const byExchange = new Map<string, CompactionRecord[]>();
  const trailing: CompactionRecord[] = [];
  let e = 0;
  for (const marker of sorted) {
    let host = ordered[e];
    while (host && (host.firstAt ?? Number.POSITIVE_INFINITY) < marker.at) {
      e += 1;
      host = ordered[e];
    }
    if (!host) {
      trailing.push(marker);
      continue;
    }
    const list = byExchange.get(host.key);
    if (list) list.push(marker);
    else byExchange.set(host.key, [marker]);
  }
  return { byExchange, trailing };
}

/** One quiet centered line: counts on both sides read as a range, unknown
 *  counts as a bare fact — both with the time, which is the "when". */
export function compactionMarkerLabel(
  marker: CompactionRecord,
  formatTime: (at: number) => string,
): string {
  const known =
    marker.beforeTokens !== null &&
    marker.beforeTokens !== undefined &&
    marker.afterTokens !== null &&
    marker.afterTokens !== undefined;
  const range = known
    ? ` · ${formatContextTokens(marker.beforeTokens)} → ${formatContextTokens(marker.afterTokens)}`
    : "";
  return `Context compacted${range} · ${formatTime(marker.at)}`;
}
