import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { setUserDataDir } from "@kone/agent-core/userDataDir.js";
import { branchSlugFromTitle, isKoneOwnedBranch, renameGeneratedBranch } from "./worktreeBranchName.js";
import { provisionWorktree } from "./worktreeProvision.js";
import { removeWorktree, worktrees } from "./worktree.js";

const cleanup: Array<{ repo: string; state: string }> = [];

async function makeRepo(): Promise<string> {
  const state = mkdtempSync(path.join(os.tmpdir(), "kone-wt-name-state-"));
  setUserDataDir(state);
  const repo = await initTestRepo("kone-wt-name-");
  writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "one"]);
  cleanup.push({ repo, state });
  return repo;
}

async function branchAt(dir: string): Promise<string> {
  return (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
}

async function hasBranch(repo: string, branch: string): Promise<boolean> {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  for (const { repo, state } of cleanup.splice(0)) {
    for (const worktree of await worktrees(repo).catch(() => [])) {
      if (worktree.main) continue;
      await git(repo, ["worktree", "remove", "--force", worktree.path]).catch(() => undefined);
    }
    await rm(repo, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

describe("branch names from titles", () => {
  test("a title becomes a branch-safe slug", () => {
    expect(branchSlugFromTitle("Fix the login redirect!")).toBe("fix-the-login-redirect");
  });

  test("a title with nothing a branch can carry gives no slug", () => {
    expect(branchSlugFromTitle("???")).toBeNull();
    expect(branchSlugFromTitle("Update docs")).toBe("update-docs");
  });
});

describe("renaming a worktree's placeholder branch", () => {
  test("the placeholder takes the title's name, and stays kone's", async () => {
    const repo = await makeRepo();
    const made = await provisionWorktree({ projectPath: repo });

    const named = await renameGeneratedBranch(made.path, "Fix login redirect");

    expect(named).toBe("kone/fix-login-redirect");
    expect(await branchAt(made.path)).toBe("kone/fix-login-redirect");
    expect(await hasBranch(repo, made.branch)).toBe(false);
    expect(await isKoneOwnedBranch(repo, "kone/fix-login-redirect")).toBe(true);
  });

  test("a name already taken gets a number", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "kone/fix-login-redirect"]);
    const made = await provisionWorktree({ projectPath: repo });

    expect(await renameGeneratedBranch(made.path, "Fix login redirect")).toBe(
      "kone/fix-login-redirect-2",
    );
  });

  test("a branch someone named, or one already renamed, is left alone", async () => {
    const repo = await makeRepo();
    const mine = await provisionWorktree({ projectPath: repo, branch: "feature/mine" });
    expect(await renameGeneratedBranch(mine.path, "Something else")).toBeNull();
    expect(await branchAt(mine.path)).toBe("feature/mine");
    expect(await isKoneOwnedBranch(repo, "feature/mine")).toBe(false);

    const made = await provisionWorktree({ projectPath: repo });
    await renameGeneratedBranch(made.path, "First title");
    expect(await renameGeneratedBranch(made.path, "Second title")).toBeNull();
    expect(await branchAt(made.path)).toBe("kone/first-title");
  });

  test("removing the worktree reclaims the renamed branch like the placeholder", async () => {
    const repo = await makeRepo();
    const made = await provisionWorktree({ projectPath: repo });
    await renameGeneratedBranch(made.path, "Tidy the readme");

    await removeWorktree(repo, { path: made.path, reclaimGeneratedBranch: true });

    expect(await hasBranch(repo, "kone/tidy-the-readme")).toBe(false);
    expect(await isKoneOwnedBranch(repo, "kone/tidy-the-readme")).toBe(false);
  });
});
