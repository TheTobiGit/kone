import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, GitError } from "./core.js";
import {
  MAX_QUEUED_REPO_MUTATIONS,
  queuedRepoMutationsForTests,
  withRepoMutation,
} from "./mutationLock.js";

async function emptyDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "kone-mutlock-"));
}

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  ms = 1000,
): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("withRepoMutation", () => {
  test("same cwd: overlapping calls never run fn concurrently, FIFO", async () => {
    const dir = await emptyDir();
    const order: number[] = [];
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = withRepoMutation(dir, async () => {
      order.push(1);
      await holdFirst;
      order.push(1.5);
    });
    await waitUntil(() => order.includes(1));

    const second = withRepoMutation(dir, async () => {
      order.push(2);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([1]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 1.5, 2]);
  });

  test("same-repo subdirectory shares the queue via git-common-dir", async () => {
    const dir = await emptyDir();
    await git(dir, ["init", "-b", "main"]);
    const sub = path.join(dir, "sub");
    await mkdir(sub);

    let inside = 0;
    let maxInside = 0;
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = withRepoMutation(dir, async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await holdFirst;
      inside -= 1;
    });
    await waitUntil(() => inside === 1);

    const second = withRepoMutation(sub, async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      inside -= 1;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(inside).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(maxInside).toBe(1);
  });

  test("different directories overlap in time", async () => {
    const a = await emptyDir();
    const b = await emptyDir();
    let aInside = false;
    let bInside = false;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });
    const holdB = new Promise<void>((r) => {
      releaseB = r;
    });

    const pA = withRepoMutation(a, async () => {
      aInside = true;
      await holdA;
      aInside = false;
    });
    const pB = withRepoMutation(b, async () => {
      bInside = true;
      await holdB;
      bInside = false;
    });
    await waitUntil(() => aInside && bInside);
    expect(aInside && bInside).toBe(true);
    releaseA();
    releaseB();
    await Promise.all([pA, pB]);
  });

  test("a thrown fn still releases the queue", async () => {
    const dir = await emptyDir();
    const first = withRepoMutation(dir, async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    let ran = false;
    await withRepoMutation(dir, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("queue cap refuses the 65th waiter", async () => {
    const dir = await emptyDir();
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = withRepoMutation(dir, async () => {
      await holdFirst;
    });
    await waitUntil(async () => (await queuedRepoMutationsForTests(dir)) >= 1);

    const waiters: Promise<void>[] = [];
    for (let i = 0; i < MAX_QUEUED_REPO_MUTATIONS - 1; i++) {
      waiters.push(withRepoMutation(dir, async () => undefined));
    }
    await waitUntil(
      async () => (await queuedRepoMutationsForTests(dir)) >= MAX_QUEUED_REPO_MUTATIONS,
      2000,
    );

    try {
      await withRepoMutation(dir, async () => undefined);
      throw new Error("expected the overflowing call to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).message).toBe(
        "Too many git operations are already queued for this repository.",
      );
    }

    releaseFirst();
    await first;
    await Promise.all(waiters);
  });
});
