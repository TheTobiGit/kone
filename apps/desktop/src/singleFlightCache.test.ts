import { describe, expect, test } from "bun:test";

import { createKeyedSingleFlightCache } from "./singleFlightCache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createKeyedSingleFlightCache", () => {
  test("concurrent get for the same key calls load once and shares the value", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    const gate = deferred<number>();
    let loadCalls = 0;
    const load = async () => {
      loadCalls += 1;
      return gate.promise;
    };

    const p1 = cache.get("a", load);
    const p2 = cache.get("a", load);
    await tick();

    expect(loadCalls).toBe(1);

    gate.resolve(42);
    await expect(p1).resolves.toBe(42);
    await expect(p2).resolves.toBe(42);
  });

  test("different keys load independently", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    const aGate = deferred<number>();
    const bGate = deferred<number>();
    let loadCalls = 0;
    const loadFor = (gate: { promise: Promise<number> }) => async () => {
      loadCalls += 1;
      return gate.promise;
    };

    const pa = cache.get("a", loadFor(aGate));
    const pb = cache.get("b", loadFor(bGate));
    await tick();

    expect(loadCalls).toBe(2);

    aGate.resolve(1);
    bGate.resolve(2);
    await expect(pa).resolves.toBe(1);
    await expect(pb).resolves.toBe(2);
  });

  test("a cached value within its TTL is served without a second load", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    let loadCalls = 0;
    const load = async () => {
      loadCalls += 1;
      return 1;
    };

    await expect(cache.get("a", load)).resolves.toBe(1);
    await expect(cache.get("a", load)).resolves.toBe(1);

    expect(loadCalls).toBe(1);
    expect(cache.size()).toEqual({ cached: 1, inFlight: 0 });
  });

  test("ttlMs 0 never caches but still coalesces while in flight", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 0,
      maxEntries: 10,
    });
    const gate = deferred<number>();
    let loadCalls = 0;
    const load = async () => {
      loadCalls += 1;
      return gate.promise;
    };

    const p1 = cache.get("a", load);
    const p2 = cache.get("a", load);
    await tick();

    expect(loadCalls).toBe(1);

    gate.resolve(1);
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(1);

    // Settled means single-flight is gone, and ttl 0 means nothing was cached:
    // a new get must load again.
    const p3 = cache.get("a", load);
    await expect(p3).resolves.toBe(1);
    expect(loadCalls).toBe(2);
    expect(cache.size()).toEqual({ cached: 0, inFlight: 0 });
  });

  test("invalidate during an in-flight load fences the stale result", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    const firstGate = deferred<number>();
    const secondGate = deferred<number>();
    let loadCalls = 0;

    const oldValue = cache.get("a", async () => {
      loadCalls += 1;
      return firstGate.promise;
    });
    await tick();

    cache.invalidate("a");

    const newValue = cache.get("a", async () => {
      loadCalls += 1;
      return secondGate.promise;
    });
    await tick();

    // The get after invalidate did not join the fenced load.
    expect(loadCalls).toBe(2);

    // Old waiters still receive the old value.
    firstGate.resolve(1);
    await expect(oldValue).resolves.toBe(1);

    secondGate.resolve(2);
    await expect(newValue).resolves.toBe(2);

    // The old load was fenced: the cache holds the new value, and a later get
    // is served from cache rather than triggering yet another load.
    const again = cache.get("a", async () => {
      loadCalls += 1;
      return 99;
    });
    await expect(again).resolves.toBe(2);
    expect(loadCalls).toBe(2);
  });

  test("invalidateAll prevents a subsequent get from hitting the previous cache", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });

    await expect(cache.get("a", async () => 1)).resolves.toBe(1);
    cache.invalidateAll();

    let loadCalls = 0;
    const fresh = cache.get("a", async () => {
      loadCalls += 1;
      return 2;
    });
    await expect(fresh).resolves.toBe(2);
    expect(loadCalls).toBe(1);
    expect(cache.size()).toEqual({ cached: 1, inFlight: 0 });
  });

  test("invalidateAll fences a load already in flight", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    const oldGate = deferred<number>();
    const newGate = deferred<number>();
    let loadCalls = 0;

    const oldValue = cache.get("a", async () => {
      loadCalls += 1;
      return oldGate.promise;
    });
    await tick();

    cache.invalidateAll();

    const newValue = cache.get("a", async () => {
      loadCalls += 1;
      return newGate.promise;
    });
    await tick();
    expect(loadCalls).toBe(2);

    oldGate.resolve(1);
    await expect(oldValue).resolves.toBe(1);

    newGate.resolve(2);
    await expect(newValue).resolves.toBe(2);

    const again = cache.get("a", async () => {
      loadCalls += 1;
      return 99;
    });
    await expect(again).resolves.toBe(2);
    expect(loadCalls).toBe(2);
  });

  test("maxEntries evicts the oldest entry in LRU order", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 2,
    });

    await expect(cache.get("a", async () => 1)).resolves.toBe(1);
    await expect(cache.get("b", async () => 2)).resolves.toBe(2);

    // A cache hit on "a" makes it the most-recently-used, so "b" becomes the
    // eviction target when "c" is inserted.
    await expect(cache.get("a", async () => 99)).resolves.toBe(1);

    await expect(cache.get("c", async () => 3)).resolves.toBe(3);

    let loadCalls = 0;
    const reloaded = cache.get("b", async () => {
      loadCalls += 1;
      return 4;
    });
    await expect(reloaded).resolves.toBe(4);
    expect(loadCalls).toBe(1);
    expect(cache.size()).toEqual({ cached: 2, inFlight: 0 });
  });

  test("a rejected load is not cached and a later get retries", async () => {
    const cache = createKeyedSingleFlightCache<number>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    let loadCalls = 0;

    const first = cache.get("a", async () => {
      loadCalls += 1;
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    const second = cache.get("a", async () => {
      loadCalls += 1;
      return 5;
    });
    await expect(second).resolves.toBe(5);
    expect(loadCalls).toBe(2);

    // The successful load is now cached.
    const third = cache.get("a", async () => {
      loadCalls += 1;
      return 6;
    });
    await expect(third).resolves.toBe(5);
    expect(loadCalls).toBe(2);
  });
});
