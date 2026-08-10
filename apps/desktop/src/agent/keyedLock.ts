// Serialize work per key without retaining one lock for every key ever seen.
//
// commit 8bacc7475) — same semantics, promise-based instead of Effect-based:
// callers for the same key run strictly one at a time, callers for different
// keys run concurrently, and each key's entry is deleted once the last holder
// or queued waiter has left (the user count includes queued callers, so
// cleanup never deletes a lock a waiter is about to acquire).
//
// Why the entry-counting matters: a naive `new Map(key -> Promise)` leaks one
// settled promise per key forever once every key that ever appeared stays in
// the map. Per-thread locks in a long-lived agent layer would accumulate
// entries for every thread that ever ran.

export interface KeyedLock<Key> {
  /** Run `task` exclusively for `key`. Rejections propagate to the caller and
   *  never poison the queue for later callers of the same key. */
  withLock<T>(key: Key, task: () => Promise<T>): Promise<T>;
  /** Number of keys with at least one holder or queued waiter right now. */
  activeKeyCount(): number;
}

export function makeKeyedLock<Key>(): KeyedLock<Key> {
  const entries = new Map<Key, { queue: Promise<void>; users: number }>();

  return {
    withLock<T>(key: Key, task: () => Promise<T>): Promise<T> {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { queue: Promise.resolve(), users: 0 };
        entries.set(key, entry);
      }
      entry.users += 1;
      const acquiredEntry = entry;
      // Chain the next caller's turn onto this one BEFORE awaiting, so the
      // queue order is the arrival order. The rejection is swallowed on the
      // chain so a failed task doesn't break the queue for later callers.
      const run = acquiredEntry.queue.then(task);
      acquiredEntry.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run.finally(() => {
        acquiredEntry.users -= 1;
        if (acquiredEntry.users === 0 && entries.get(key) === acquiredEntry) {
          entries.delete(key);
        }
      });
    },
    activeKeyCount: () => entries.size,
  };
}
