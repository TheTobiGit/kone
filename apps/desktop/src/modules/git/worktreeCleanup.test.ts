import { describe, expect, test } from "bun:test";

import {
  collectSubtreeWorktrees,
  removeCollectedWorktrees,
  type DoomedWorktree,
  type WorktreeCleanupStore,
} from "./worktreeCleanup.js";

// The delete-time cleanup, without a store or a repository: the store is a
// stub answering the two reads, git is two injected callbacks.

function stubStore(
  owned: Array<{ threadId: string; projectPath: string; worktreePath: string | null }>,
): WorktreeCleanupStore {
  return {
    subtreeWorkspaces: () => owned,
    isWorktreePathReferenced: () => false,
  };
}

describe("collectSubtreeWorktrees", () => {
  test("dedupes a directory siblings share and drops threads with none", () => {
    const store = stubStore([
      { threadId: "parent", projectPath: "/p", worktreePath: "/wt/one" },
      { threadId: "child", projectPath: "/p", worktreePath: "/wt/one" },
      { threadId: "other", projectPath: "/p", worktreePath: "/wt/two" },
      { threadId: "local", projectPath: "/p", worktreePath: null },
      { threadId: "pending", projectPath: "/p", worktreePath: "   " },
    ]);

    expect(collectSubtreeWorktrees(store, "parent")).toEqual([
      { projectPath: "/p", worktreePath: "/wt/one" },
      { projectPath: "/p", worktreePath: "/wt/two" },
    ]);
  });

  test("an unreadable store collects nothing rather than failing the delete", () => {
    const store: WorktreeCleanupStore = {
      subtreeWorkspaces: () => {
        throw new Error("db is gone");
      },
      isWorktreePathReferenced: () => false,
    };

    expect(collectSubtreeWorktrees(store, "parent")).toEqual([]);
  });
});

describe("removeCollectedWorktrees", () => {
  test("removes what nothing references and leaves what something does", async () => {
    const removed: string[] = [];
    const targets: DoomedWorktree[] = [
      { projectPath: "/p", worktreePath: "/wt/free" },
      { projectPath: "/p", worktreePath: "/wt/held" },
    ];

    await removeCollectedWorktrees(targets, {
      isReferenced: (worktreePath) => worktreePath === "/wt/held",
      remove: async (_projectPath, worktreePath) => {
        removed.push(worktreePath);
      },
      isManaged: () => true,
    });

    expect(removed).toEqual(["/wt/free"]);
  });

  test("a failure on one directory never stops the next", async () => {
    const removed: string[] = [];

    await removeCollectedWorktrees(
      [
        { projectPath: "/p", worktreePath: "/wt/first" },
        { projectPath: "/p", worktreePath: "/wt/second" },
      ],
      {
        isReferenced: () => false,
        remove: async (_projectPath, worktreePath) => {
          if (worktreePath === "/wt/first") throw new Error("git said no");
          removed.push(worktreePath);
        },
        isManaged: () => true,
      },
    );

    expect(removed).toEqual(["/wt/second"]);
  });

  test("an unreadable reference check keeps the directory", async () => {
    const removed: string[] = [];

    await removeCollectedWorktrees([{ projectPath: "/p", worktreePath: "/wt/unknown" }], {
      isReferenced: () => {
        throw new Error("db is gone");
      },
      remove: async (_projectPath, worktreePath) => {
        removed.push(worktreePath);
      },
      isManaged: () => true,
    });

    expect(removed).toEqual([]);
  });

  test("a directory outside the managed root is never removed", async () => {
    const removed: string[] = [];

    await removeCollectedWorktrees([{ projectPath: "/p", worktreePath: "/home/user/handmade" }], {
      isReferenced: () => false,
      remove: async (_projectPath, worktreePath) => {
        removed.push(worktreePath);
      },
      // A worktree the user made by hand and kone merely adopted: removing it
      // would delete work that predates the thread.
      isManaged: () => false,
    });

    expect(removed).toEqual([]);
  });

  test("nothing to do resolves without touching git or the root", async () => {
    let touched = false;

    await removeCollectedWorktrees([], {
      isReferenced: () => {
        touched = true;
        return false;
      },
      remove: async () => {
        touched = true;
      },
    });

    expect(touched).toBe(false);
  });
});
