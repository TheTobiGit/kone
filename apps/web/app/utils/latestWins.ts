//
// The bug class both fix: concurrent refreshes race — they spawn redundant
// subprocesses and, worse, an older read that settles after a newer one can
// overwrite fresher state with stale data. The fix is a queue with two rules:
//  1. Capacity: at most one read runs at a time per runner/section, plus at
//     most one queued follow-up — no unbounded fan-out.
//  2. Latest-wins: a call joins an existing read while that read is still
//     queued; once its reads have begun they may predate whatever triggered
//     the new call, so a fresh run is queued behind it instead. N calls while
//     a run is in flight coalesce into exactly one follow-up.

/** A serialized, latest-wins runner for one operation (e.g. a project's
 *  git-status refresh). `run()` invokes `fn` at most one-at-a-time; calls that
 *  arrive while a run is executing resolve with that run's outcome when the
 *  run is still queued, or with a fresh follow-up's outcome once the run's
 *  reads have started. */
export type LatestWinsRun<T> = {
  run: () => Promise<T>;
};

export function createLatestWinsRun<T>(fn: () => Promise<T>): LatestWinsRun<T> {
  type Entry = {
    /** False only while queued behind another run — joinable. */
    started: boolean;
    promise: Promise<T>;
  };
  let active: Entry | null = null;

  function run(): Promise<T> {
    if (active) {
      // Still queued (not yet executing): the outcome is identical, join it.
      if (!active.started) return active.promise;
      // Reads already began — they may predate whatever triggered this call,
      // so queue one fresh run behind the current one. Further calls during
      // this window join that queued run (latest-wins coalescing).
      const queued: Entry = { started: false, promise: Promise.resolve() as Promise<T> };
      queued.promise = active.promise
        .catch(() => undefined)
        .then(() => {
          queued.started = true;
          return fn();
        })
        .finally(() => {
          if (active === queued) active = null;
        });
      active = queued;
      return queued.promise;
    }
    const entry: Entry = { started: true, promise: Promise.resolve() as Promise<T> };
    entry.promise = fn().finally(() => {
      if (active === entry) active = null;
    });
    active = entry;
    return entry.promise;
  }

  return { run };
}

/** One section's in-flight read. A section is the part of a key before the
 *  first colon (`prs:open` and `prs:all` are two reads of section `prs`). */
export interface SectionReadEntry {
  key: string;
  started: boolean;
  /** A newer read for this section superseded this one — it can no longer be
   *  joined. If it was still queued when superseded, it skips its run entirely
   *  (only the newest parameters' read executes); if its reads had already
   *  begun it finishes, and the newer read runs strictly after it settles, so
   *  its result can never overwrite fresher state. */
  superseded: boolean;
  /** The promise this entry waits for before running: the previous entry's
   *  promise once its reads began, or the previous entry's own anchor while
   *  the previous was still queued — so a superseded queued read is skipped
   *  rather than executed and then out-ordered. */
  anchor: Promise<void>;
  promise: Promise<void>;
}

/** A per-section serializer for parameterized reads: identical keys are
 *  de-duped (join while in flight, same outcome), while a different key for
 *  the same section supersedes the in-flight read and queues behind it — a
 *  superseded queued read is skipped entirely (latest-wins), and any read that
 *  did execute lands its result before its successor's, so results always
 *  reflect the newest request. */
export type SectionSerializer = {
  schedule: (key: string, run: () => Promise<void>) => Promise<void>;
  /** The live entries, keyed by section — for tests. */
  entries: () => ReadonlyMap<string, SectionReadEntry>;
};

export function createSectionSerializer(): SectionSerializer {
  const inflight = new Map<string, SectionReadEntry>();

  function schedule(key: string, run: () => Promise<void>): Promise<void> {
    const tag = key.split(":")[0]!;
    const existing = inflight.get(tag);
    if (existing && !existing.superseded) {
      // Same key: same params, same outcome — join (even once started).
      if (existing.key === key) return existing.promise;
      // Newer parameters for the same section: the older read is superseded.
      // The newer one waits on the older's own anchor when the older is still
      // queued (skipping it), or on its promise once its reads have begun.
      existing.superseded = true;
      const entry: SectionReadEntry = {
        key,
        started: false,
        superseded: false,
        anchor: existing.started ? existing.promise : existing.anchor,
        promise: Promise.resolve(),
      };
      entry.promise = entry.anchor
        .catch(() => undefined)
        .then(() => {
          // Superseded while still queued: a newer request owns this section
          // now — skip rather than run a read whose parameters are stale.
          if (entry.superseded) return;
          entry.started = true;
          return run();
        })
        .finally(() => {
          if (inflight.get(tag) === entry) inflight.delete(tag);
        });
      inflight.set(tag, entry);
      return entry.promise;
    }
    const entry: SectionReadEntry = {
      key,
      started: true,
      superseded: false,
      anchor: Promise.resolve(),
      promise: Promise.resolve(),
    };
    entry.promise = run().finally(() => {
      if (inflight.get(tag) === entry) inflight.delete(tag);
    });
    inflight.set(tag, entry);
    return entry.promise;
  }

  return { schedule, entries: () => inflight };
}
