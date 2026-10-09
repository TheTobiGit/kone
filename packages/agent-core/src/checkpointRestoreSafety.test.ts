import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkpointRestoreIsolation,
  claimRestoreDir,
  isRestoreActive,
} from "./checkpointRestoreSafety.js";

// Real temp directories (and one real symlink) rather than a mocked fs: the
// whole point of the guard is what the filesystem actually resolves to, so the
// test uses one.

const root = mkdtempSync(path.join(tmpdir(), "kone-restore-safety-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dir(...parts: string[]): string {
  const target = path.join(root, ...parts);
  mkdirSync(target, { recursive: true });
  return target;
}

describe("checkpointRestoreIsolation", () => {
  test("a thread in the project checkout is never isolated", () => {
    const project = dir("p-local");
    expect(
      checkpointRestoreIsolation({ cwd: project, worktreePath: null, otherPaths: [] }),
    ).toEqual({
      isolated: false,
      detail: "this thread runs in its project's shared checkout, not an isolated worktree",
    });
  });

  test("a worktree no other thread names is isolated", () => {
    const worktree = dir("p-solo", "wt");
    expect(
      checkpointRestoreIsolation({ cwd: worktree, worktreePath: worktree, otherPaths: [] }),
    ).toEqual({ isolated: true });
  });

  test("a checkpoint directory that is not the declared worktree is refused", () => {
    const worktree = dir("p-mismatch", "wt");
    const checkout = dir("p-mismatch", "checkout");
    const result = checkpointRestoreIsolation({
      cwd: checkout,
      worktreePath: worktree,
      otherPaths: [],
    });
    expect(result.isolated).toBe(false);
    if (!result.isolated) expect(result.detail).toContain("is not its worktree");
  });

  test("another thread's identical directory is refused, naming it", () => {
    const worktree = dir("p-equal", "wt");
    const result = checkpointRestoreIsolation({
      cwd: worktree,
      worktreePath: worktree,
      otherPaths: [{ threadId: "t-other", path: worktree }],
    });
    expect(result.isolated).toBe(false);
    if (!result.isolated) {
      expect(result.detail).toContain("t-other");
      expect(result.detail).toContain(worktree);
    }
  });

  test("nesting is caught in both directions", () => {
    const worktree = dir("p-nest", "wt");
    const inside = dir("p-nest", "wt", "inner");
    const parent = dir("p-nest");
    // Another thread's directory inside this worktree.
    expect(
      checkpointRestoreIsolation({
        cwd: worktree,
        worktreePath: worktree,
        otherPaths: [{ threadId: "t-in", path: inside }],
      }).isolated,
    ).toBe(false);
    // This worktree inside another thread's directory.
    expect(
      checkpointRestoreIsolation({
        cwd: worktree,
        worktreePath: worktree,
        otherPaths: [{ threadId: "t-out", path: parent }],
      }).isolated,
    ).toBe(false);
  });

  test("a symlinked worktree resolves to the same directory", () => {
    const real = dir("p-symlink", "real");
    const link = path.join(root, "p-symlink", "link");
    symlinkSync(real, link);
    // The store names the link, the checkpoint ran in the real path.
    expect(
      checkpointRestoreIsolation({ cwd: real, worktreePath: link, otherPaths: [] }),
    ).toEqual({ isolated: true });
    // And an overlapping thread that only exists via the link is still caught.
    expect(
      checkpointRestoreIsolation({
        cwd: real,
        worktreePath: link,
        otherPaths: [{ threadId: "t-link", path: link }],
      }).isolated,
    ).toBe(false);
  });

  test("a sibling worktree and a null claim do not count as overlaps", () => {
    const worktree = dir("p-clean", "wt-a");
    const sibling = dir("p-clean", "wt-b");
    expect(
      checkpointRestoreIsolation({
        cwd: worktree,
        worktreePath: worktree,
        otherPaths: [
          { threadId: "t-sibling", path: sibling },
          { threadId: "t-pending", path: null },
          { threadId: "t-gone", path: path.join(root, "p-clean", "does-not-exist") },
        ],
      }),
    ).toEqual({ isolated: true });
  });

  test("a checkpoint directory that cannot be resolved is refused", () => {
    const missing = path.join(root, "p-missing", "wt");
    expect(
      checkpointRestoreIsolation({ cwd: missing, worktreePath: missing, otherPaths: [] }).isolated,
    ).toBe(false);
  });
});

describe("claimRestoreDir and isRestoreActive", () => {
  test("tracks active restore directory and detects overlap in both directions", () => {
    const worktree = dir("p-claim", "wt");
    const inside = dir("p-claim", "wt", "inside");
    const parent = dir("p-claim");
    const sibling = dir("p-claim-sibling");

    expect(isRestoreActive(worktree)).toBe(false);
    expect(isRestoreActive(inside)).toBe(false);
    expect(isRestoreActive(parent)).toBe(false);

    const release = claimRestoreDir(worktree);
    try {
      expect(isRestoreActive(worktree)).toBe(true);
      expect(isRestoreActive(inside)).toBe(true);
      expect(isRestoreActive(parent)).toBe(true);
      expect(isRestoreActive(sibling)).toBe(false);
    } finally {
      release();
    }

    expect(isRestoreActive(worktree)).toBe(false);
    expect(isRestoreActive(inside)).toBe(false);
    expect(isRestoreActive(parent)).toBe(false);
  });
});

