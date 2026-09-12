import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  generatedBranchName,
  isGeneratedBranchName,
  isInsideWorktreesRoot,
  sanitizeBranchSegment,
  worktreeDigest,
  worktreeDirFor,
} from "./worktreePaths.js";

describe("sanitizeBranchSegment", () => {
  test("flattens a namespaced branch into one component", () => {
    expect(sanitizeBranchSegment("feature/foo")).toBe("feature-foo");
    expect(sanitizeBranchSegment("feature/foo")).not.toContain(path.sep);
  });

  test("lowercases, strips quotes, and collapses runs", () => {
    expect(sanitizeBranchSegment(`Fix "The" Thing`)).toBe("fix-the-thing");
  });

  test("never returns an empty string", () => {
    expect(sanitizeBranchSegment("///")).toBe("update");
    expect(sanitizeBranchSegment("   ")).toBe("update");
    expect(sanitizeBranchSegment("")).toBe("update");
  });

  test("caps length without leaving a trailing separator", () => {
    const segment = sanitizeBranchSegment(`${"a".repeat(63)}-${"b".repeat(20)}`);
    expect(segment.length).toBeLessThanOrEqual(64);
    expect(segment.endsWith("-")).toBe(false);
  });
});

describe("generated branch names", () => {
  test("a generated name is recognized, a person's is not", () => {
    expect(isGeneratedBranchName(generatedBranchName())).toBe(true);
    expect(isGeneratedBranchName("feature/foo")).toBe(false);
    // Close enough to be dangerous, and deliberately not a match.
    expect(isGeneratedBranchName("kone/feature")).toBe(false);
    expect(isGeneratedBranchName("kone/1234567")).toBe(false);
  });

  test("two calls do not collide", () => {
    const names = new Set(Array.from({ length: 50 }, () => generatedBranchName()));
    expect(names.size).toBe(50);
  });
});

describe("worktreeDirFor", () => {
  const root = "/state/worktrees";
  const project = "/code/thing";

  test("groups by repository and names by branch", () => {
    const dir = worktreeDirFor({ root, projectPath: project, branch: "feature/foo" });

    expect(path.dirname(dir)).toBe(path.join(root, "thing"));
    expect(path.basename(dir)).toStartWith("feature-foo-");
  });

  test("branches that differ only in case get different directories", () => {
    // APFS is case-insensitive, so the sanitized halves are genuinely equal
    // here and only the digest keeps them apart.
    const upper = worktreeDirFor({ root, projectPath: project, branch: "Feature" });
    const lower = worktreeDirFor({ root, projectPath: project, branch: "feature" });

    expect(upper).not.toBe(lower);
    expect(path.basename(upper).split("-")[0]).toBe(path.basename(lower).split("-")[0]);
  });

  test("branches that sanitize alike get different directories", () => {
    expect(worktreeDirFor({ root, projectPath: project, branch: "fix/a b" })).not.toBe(
      worktreeDirFor({ root, projectPath: project, branch: "fix/a-b" }),
    );
  });

  test("the same project and branch always resolve to the same directory", () => {
    expect(worktreeDirFor({ root, projectPath: project, branch: "x" })).toBe(
      worktreeDirFor({ root, projectPath: "/code/thing/", branch: "x" }),
    );
  });

  test("the same branch in two projects does not collide", () => {
    expect(worktreeDigest("/code/one", "main")).not.toBe(worktreeDigest("/code/two", "main"));
  });

  test("aliased spellings of one checkout share a digest and a directory", async () => {
    // Two strings naming one directory (a symlink and its target) must not
    // produce two hashes — otherwise one repo+branch gets two worktrees.
    const real = mkdtempSync(path.join(os.tmpdir(), "kone-wt-digest-"));
    const alias = `${real}-link`;
    symlinkSync(real, alias);
    try {
      expect(worktreeDigest(alias, "feature")).toBe(worktreeDigest(real, "feature"));
      expect(worktreeDirFor({ root, projectPath: alias, branch: "feature" })).toBe(
        worktreeDirFor({ root, projectPath: real, branch: "feature" }),
      );
    } finally {
      await rm(alias, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  test("lands outside the project it came from", () => {
    const dir = worktreeDirFor({ root, projectPath: project, branch: "feature" });

    expect(dir.startsWith(project)).toBe(false);
  });
});

describe("isInsideWorktreesRoot", () => {
  const root = "/state/worktrees";

  test("accepts a directory under the root", () => {
    expect(isInsideWorktreesRoot(root, "/state/worktrees/thing/feature-abc123")).toBe(true);
  });

  test("refuses the root itself", () => {
    expect(isInsideWorktreesRoot(root, root)).toBe(false);
  });

  test("refuses anything outside, including a traversal and a prefix match", () => {
    expect(isInsideWorktreesRoot(root, "/code/thing")).toBe(false);
    expect(isInsideWorktreesRoot(root, "/state/worktrees/../elsewhere")).toBe(false);
    expect(isInsideWorktreesRoot(root, "/state/worktrees-backup/thing")).toBe(false);
  });

  test("an aliased root still contains its directories", async () => {
    // The guard resolves both sides, so naming the root through a symlink (or
    // the target through one) still answers "inside" — a cleanup that did not
    // would silently refuse to remove a directory it owns.
    const real = mkdtempSync(path.join(os.tmpdir(), "kone-wt-guard-"));
    const alias = `${real}-link`;
    symlinkSync(real, alias);
    try {
      expect(isInsideWorktreesRoot(alias, path.join(real, "repo", "branch-abc123"))).toBe(true);
      expect(isInsideWorktreesRoot(real, path.join(alias, "repo", "branch-abc123"))).toBe(true);
      expect(isInsideWorktreesRoot(alias, `${real}-other/thing`)).toBe(false);
    } finally {
      await rm(alias, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
});
