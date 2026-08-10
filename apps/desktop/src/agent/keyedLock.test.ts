import { describe, expect, test } from "bun:test";

import { makeKeyedLock } from "./keyedLock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("makeKeyedLock", () => {
  test("serializes callers for one key and releases the entry after the final waiter", async () => {
    const lock = makeKeyedLock<string>();
    const release = deferred();
    const order: string[] = [];

    const first = lock.withLock("thread-1", async () => {
      order.push("first-start");
      await release.promise;
      order.push("first-end");
    });
    // Let the first task reach its await before queueing the second.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = lock.withLock("thread-1", async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lock.activeKeyCount()).toBe(1);
    expect(order).toEqual(["first-start"]);

    release.resolve();
    await first;
    await second;

    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(lock.activeKeyCount()).toBe(0);
  });

  test("releases entries after failures without poisoning the queue", async () => {
    const lock = makeKeyedLock<string>();

    await expect(
      lock.withLock("thread-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.activeKeyCount()).toBe(0);

    // A later caller on the same key still runs.
    let ran = false;
    await lock.withLock("thread-1", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(lock.activeKeyCount()).toBe(0);
  });

  test("different keys run concurrently", async () => {
    const lock = makeKeyedLock<string>();
    const releaseA = deferred();
    const releaseB = deferred();
    let started = 0;

    const a = lock.withLock("a", async () => {
      started += 1;
      await releaseA.promise;
    });
    const b = lock.withLock("b", async () => {
      started += 1;
      await releaseB.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toBe(2);
    expect(lock.activeKeyCount()).toBe(2);

    releaseA.resolve();
    releaseB.resolve();
    await Promise.all([a, b]);
    expect(lock.activeKeyCount()).toBe(0);
  });

  test("count returns to 0 after a burst of sequential callers", async () => {
    const lock = makeKeyedLock<string>();
    let count = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        lock.withLock("burst", async () => {
          count += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );
    expect(count).toBe(10);
    expect(lock.activeKeyCount()).toBe(0);
  });
});
