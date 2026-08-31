import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { createBranch, stage } from "./mutations.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";

// repos' worktree setup: the branch is created before the (risky) checkout and
// rolled back when the checkout fails, so "create and switch" is atomic.

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-mut-");
  await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "one"]);
  await writeFile(path.join(dir, "a.txt"), "two\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "two"]);
  return dir;
}

async function branchExists(dir: string, name: string): Promise<boolean> {
  const out = (await git(dir, ["branch", "--list", name])).trim();
  return out.length > 0;
}

async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["branch", "--show-current"])).trim();
}

describe("createBranch", () => {
  test("creates the branch and switches to it", async () => {
    const dir = await makeRepo();
    await createBranch(dir, "feature", { checkout: true });
    expect(await branchExists(dir, "feature")).toBe(true);
    expect(await currentBranch(dir)).toBe("feature");
  });

  test("rolls the branch back when the checkout fails", async () => {
    const dir = await makeRepo();
    // Dirty the working tree: switching to a branch at HEAD~1 would have to
    // overwrite a.txt's local edit, so git refuses the checkout.
    await writeFile(path.join(dir, "a.txt"), "three\n", "utf8");

    await expect(
      createBranch(dir, "feature", { from: "HEAD~1", checkout: true }),
    ).rejects.toThrow();
    // The create+switch unit failed — the branch must not be left behind.
    expect(await branchExists(dir, "feature")).toBe(false);
    expect(await currentBranch(dir)).toBe("main");
  });

  test("without checkout the branch stays (nothing to roll back)", async () => {
    const dir = await makeRepo();
    await createBranch(dir, "feature", { from: "HEAD~1" });
    expect(await branchExists(dir, "feature")).toBe(true);
    expect(await currentBranch(dir)).toBe("main");
  });

  test("never rolls back a branch it did not create", async () => {
    const dir = await makeRepo();
    await createBranch(dir, "feature");
    // The branch already exists, so `git branch feature` fails before any
    // checkout runs — the pre-existing branch must survive untouched.
    await expect(
      createBranch(dir, "feature", { checkout: true }),
    ).rejects.toThrow();
    expect(await branchExists(dir, "feature")).toBe(true);
  });
});

describe("stage", () => {
  async function stagedNames(dir: string): Promise<string[]> {
    const out = (await git(dir, ["diff", "--cached", "--name-only"])).trim();
    return out.length === 0 ? [] : out.split("\n");
  }

  test("overlapping stages of two untracked files both land", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "b.txt"), "be\n", "utf8");
    await writeFile(path.join(dir, "c.txt"), "ce\n", "utf8");

    await Promise.all([stage(dir, ["b.txt"]), stage(dir, ["c.txt"])]);

    const staged = await stagedNames(dir);
    expect(staged).toContain("b.txt");
    expect(staged).toContain("c.txt");
  });

  test("overlapping stages of eight distinct files all land", async () => {
    const dir = await makeRepo();
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    for (const name of names) {
      await writeFile(path.join(dir, name), `${name}\n`, "utf8");
    }

    await Promise.all(names.map((name) => stage(dir, [name])));

    const staged = await stagedNames(dir);
    expect(staged).toHaveLength(8);
    for (const name of names) expect(staged).toContain(name);
  });
});
