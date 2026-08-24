// Overlapping IPC/git reads used to each spawn their own subprocess; coalescing
// them into one load per key cuts that fan-out. A naive cache would still let a
// load that started before an invalidate publish a listing that no longer
// matches disk, so each key also carries a generation: invalidate bumps it, and
// a load only publishes if its generation is still current. Generation-fenced
// single-flight is the one structure that joins concurrent callers AND refuses
// to cache a result the caller already declared stale.

export type KeyedSingleFlightCache<T> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  invalidateAll(): void;
  size(): { cached: number; inFlight: number };
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  generation: number;
};

type InFlightEntry<T> = {
  generation: number;
  promise: Promise<T>;
};

/** Keyed cache that coalesces concurrent `get`s for the same key onto a single
 *  `load` and remembers successful loads for `ttlMs`. Call `invalidate` after
 *  the underlying data changes: a load that already started is fenced off from
 *  publishing (and from being joined by a later `get`). */
export function createKeyedSingleFlightCache<T>(opts: {
  ttlMs: number;
  maxEntries: number;
}): KeyedSingleFlightCache<T> {
  const ttlMs = Math.max(0, opts.ttlMs);
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries));

  const cache = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, InFlightEntry<T>>();
  const generations = new Map<string, number>();

  return {
    get(key, load) {
      const generation = generations.get(key) ?? 0;

      const cached = cache.get(key);
      if (
        cached &&
        cached.generation === generation &&
        cached.expiresAt > Date.now()
      ) {
        // delete+set keeps the map in LRU order for eviction.
        cache.delete(key);
        cache.set(key, cached);
        return Promise.resolve(cached.value);
      }

      const existing = inFlight.get(key);
      if (existing && existing.generation === generation) {
        return existing.promise;
      }

      const entry: InFlightEntry<T> = {
        generation,
        promise: Promise.resolve()
          .then(load)
          .then((value) => {
            if (ttlMs > 0 && (generations.get(key) ?? 0) === generation) {
              const now = Date.now();
              for (const [k, cachedEntry] of cache) {
                if (cachedEntry.expiresAt <= now) cache.delete(k);
              }
              while (cache.size >= maxEntries) {
                const oldest = cache.keys().next().value;
                if (oldest === undefined) break;
                cache.delete(oldest);
              }
              cache.set(key, {
                value,
                expiresAt: now + ttlMs,
                generation,
              });
            }
            return value;
          })
          .finally(() => {
            // Identity check: a load fenced by an invalidate must not clear the
            // newer generation's in-flight entry that replaced it.
            if (inFlight.get(key) === entry) inFlight.delete(key);
          }),
      };
      inFlight.set(key, entry);
      return entry.promise;
    },

    invalidate(key) {
      cache.delete(key);
      // Start at 1 so a load begun at the implicit 0 generation is fenced off.
      generations.set(key, (generations.get(key) ?? 0) + 1);
    },

    invalidateAll() {
      const keys = new Set([
        ...cache.keys(),
        ...generations.keys(),
        ...inFlight.keys(),
      ]);
      for (const key of keys) {
        generations.set(key, (generations.get(key) ?? 0) + 1);
      }
      cache.clear();
    },

    size() {
      return { cached: cache.size, inFlight: inFlight.size };
    },
  };
}
