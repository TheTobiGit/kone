import { ref, type Ref } from "vue";
import type { CompactionRecord, KoneAgentApi } from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";

/** One bridge re-seed: run the query, keep the result only when the thread
 *  still carries the id it was asked for, and swallow failures. Every seed
 *  (compactions, spawned children, queued turns) shares this shape — a
 *  missing bridge or method, a rejected query, or a thread id that moved on
 *  while the query was in flight all leave the target as it is. */
export function seedFromBridge<T>(
  query: ((id: string) => Promise<T>) | undefined | null,
  threadId: Ref<string>,
  apply: (result: T) => void,
): void {
  if (!query) return;
  const id = threadId.value;
  void query(id)
    .then((result) => {
      // Dropped on re-home: another thread's rows must never land here.
      if (threadId.value !== id) return;
      apply(result);
    })
    .catch(() => {
      // Annotation state only — a failed seed is never worth an error; live
      // events still fill it in as they land.
    });
}

/** Manual-compaction tracking for one thread: settled boundary markers plus
 *  the pending flag and last failure for the meter's Compact control. The
 *  session owns the thread id and the bridge; this unit owns everything the
 *  `CompactSnapshot | CompactSessionLike` shapes read (see
 *  compactAvailability.ts, which this file never imports — callers unwrap at
 *  the boundary so the adapter keeps working off either shape). */
export function useCompaction(deps: {
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | null;
}) {
  /** Settled compaction boundaries, oldest first — the timeline's markers.
   *  Seeded from the store when a stored identity is adopted, appended live
   *  as boundaries land. */
  const compactions = ref<CompactionRecord[]>([]);
  /** A manual compaction asked for from this session is still in flight. Set
   *  around the `agent:compact-thread` round-trip — the backend sends no
   *  "started" event, so this flag is the control's pending state. */
  const compacting = ref(false);
  /** The last manual compaction's failure, peeled for display. Set on reject,
   *  cleared when a new attempt starts. */
  const compactError = ref<string | null>(null);

  /** Re-seed markers from the store for a thread that just adopted a stored
   *  identity — boundaries are journaled as rows, not blocks, so the timeline
   *  rebuilds them by an explicit query. Best-effort via seedFromBridge. */
  function seedCompactions(): void {
    seedFromBridge(deps.bridge()?.history?.compactions, deps.threadId, (rows) => {
      compactions.value = [...(rows ?? [])].sort((a, b) => a.at - b.at);
    });
  }

  /** Mirror one settled boundary into the markers without a re-read. */
  function noteCompactedBoundary(marker: CompactionRecord): void {
    compactions.value = [...compactions.value, marker].sort((a, b) => a.at - b.at);
  }

  /** Trigger manual context compaction for this thread. Gating (capability,
   *  compactable, working) belongs to the surface offering it — this only
   *  runs the call and tracks it. */
  async function compactThread(): Promise<void> {
    if (compacting.value) return;
    compacting.value = true;
    compactError.value = null;
    try {
      const api = deps.bridge();
      if (!api?.compactThread) {
        compactError.value = "Compaction isn't available here.";
        return;
      }
      await api.compactThread(deps.threadId.value);
    } catch (e) {
      compactError.value = peelIpcError(e, "Could not compact the conversation");
    } finally {
      compacting.value = false;
    }
  }

  return {
    compactions,
    compacting,
    compactError,
    seedCompactions,
    noteCompactedBoundary,
    compactThread,
  };
}
