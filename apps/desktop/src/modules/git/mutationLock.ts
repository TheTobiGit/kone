import { realpath } from "node:fs/promises";
import path from "node:path";

import { GitError, git } from "./core.js";

// Serialize kone-originated git writes per repository.
//
// Git takes `.git/index.lock` for any command that mutates the index (stage,
// unstage, commit, stash, merge, …). Two of those running at once fail with
// "Unable to create '.git/index.lock': File exists" — even when both writes
// are valid, e.g. the file-tree UI staging two files together, or a stage
// overlapping an unstage. Reads are not serialized: they already set
// GIT_OPTIONAL_LOCKS=0 and do not need the index lock.
//
// The queue is keyed by git-common-dir, not the worktree path, so a linked
// worktree and its main checkout share one queue. They share refs; overlapping
// branch or fetch mutations would otherwise interleave.
//
// The cap refuses further enqueue so a hung git cannot accumulate unbounded
// waiters for a repo the user already left.

export const MAX_QUEUED_REPO_MUTATIONS = 64;

interface Gate {
  /** Resolves when the currently running mutation (and every waiter ahead)
   *  has released. The next caller awaits this, then holds its own slot. */
  tail: Promise<void>;
  /** Running mutation plus waiters. Zero means the gate is gone. */
  queued: number;
}

const gates = new Map<string, Gate>();

async function mutationKey(cwd: string): Promise<string> {
  try {
    const raw = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
    if (raw.length > 0) {
      return await realpath(path.resolve(cwd, raw));
    }
  } catch {
    // Not a repo, or git refused — fall through to the directory itself.
  }
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/** One queued mutation's slot: the gate to await before running, and the
 *  release that hands the queue on when the mutation is done. */
type MutationSlot = {
  previous: Promise<void>;
  release: () => void;
};

function enqueue(key: string): MutationSlot {
  let gate = gates.get(key);
  if (!gate) {
    gate = { tail: Promise.resolve(), queued: 0 };
    gates.set(key, gate);
  }
  if (gate.queued >= MAX_QUEUED_REPO_MUTATIONS) {
    throw new GitError(
      "Too many git operations are already queued for this repository.",
      null,
    );
  }
  gate.queued += 1;
  const previous = gate.tail;
  let releaseSlot!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  // Next waiter waits for our slot to be released, even if `previous` threw.
  gate.tail = previous.then(
    () => mine,
    () => mine,
  );
  return {
    previous,
    release: () => {
      gate.queued -= 1;
      if (gate.queued <= 0) gates.delete(key);
      releaseSlot();
    },
  };
}

/** Run `fn` as the sole in-flight git write for `cwd`'s repository. Callers
 *  for the same repo queue FIFO; callers for different repos overlap. A thrown
 *  `fn` still releases the queue. */
export async function withRepoMutation<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = await mutationKey(cwd);
  const slot = enqueue(key);
  try {
    await slot.previous.catch(() => undefined);
    return await fn();
  } finally {
    slot.release();
  }
}

/** Running + waiting mutations for `cwd`. Tests use this to know the cap
 *  waiters have actually enqueued before firing the overflowing call. */
export async function queuedRepoMutationsForTests(cwd: string): Promise<number> {
  const key = await mutationKey(cwd);
  return gates.get(key)?.queued ?? 0;
}
