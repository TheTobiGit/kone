import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { checkout, checkoutCarrying, createBranch, deleteBranch, setUpstream, stage } from "./mutations.js";
import { fastForward, push } from "./sync.js";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
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

describe("checkout", () => {
  const repos: string[] = [];
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function withRemote(rev = "HEAD"): Promise<string> {
    const dir = await makeRepo();
    repos.push(dir);
    await git(dir, ["remote", "add", "origin", dir]);
    await git(dir, ["update-ref", "refs/remotes/origin/feature/login", rev]);
    return dir;
  }

  test("creates an attached local branch tracking the selected remote", async () => {
    const dir = await withRemote("HEAD~1");
    // Explicit tracking must work even when automatic tracking is disabled.
    await git(dir, ["config", "branch.autoSetupMerge", "false"]);
    await checkout(dir, "origin/feature/login");
    expect(await currentBranch(dir)).toBe("feature/login");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim()).toBe("origin/feature/login");
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
  });

  test("preserves an existing local branch and its commits", async () => {
    const dir = await withRemote("HEAD~1");
    await git(dir, ["branch", "feature/login"]);
    const original = (await git(dir, ["rev-parse", "feature/login"])).trim();
    await checkout(dir, "origin/feature/login");
    expect(await currentBranch(dir)).toBe("feature/login");
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(original);
  });

  test("won't land on a same-named branch that tracks another remote", async () => {
    const dir = await withRemote();
    await git(dir, ["remote", "add", "upstream", dir]);
    await git(dir, ["update-ref", "refs/remotes/upstream/feature/login", "HEAD~1"]);
    await checkout(dir, "origin/feature/login");
    await checkout(dir, "main");
    await expect(checkout(dir, "upstream/feature/login")).rejects.toThrow("already tracks origin/feature/login");
    expect(await currentBranch(dir)).toBe("main");
  });

  test("a conflicting edit blocks the switch without creating a local branch", async () => {
    const dir = await withRemote("HEAD~1");
    await writeFile(path.join(dir, "a.txt"), "unsaved\n");
    await expect(checkout(dir, "origin/feature/login")).rejects.toThrow();
    expect(await branchExists(dir, "feature/login")).toBe(false);
    expect(await currentBranch(dir)).toBe("main");
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("unsaved\n");
  });

  test("uses the selected remote when multiple remotes have the same branch", async () => {
    const dir = await withRemote();
    await git(dir, ["remote", "add", "upstream", dir]);
    await git(dir, ["update-ref", "refs/remotes/upstream/feature/login", "HEAD~1"]);
    await checkout(dir, "upstream/feature/login");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim()).toBe("upstream/feature/login");
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
  });

  test("switches local branches with slashes and rejects missing branches", async () => {
    const dir = await withRemote();
    await git(dir, ["branch", "feature/local"]);
    await checkout(dir, "feature/local");
    expect(await currentBranch(dir)).toBe("feature/local");
    await expect(checkout(dir, "origin/missing")).rejects.toThrow("no longer exists");
    expect(await currentBranch(dir)).toBe("feature/local");
  });
});

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

describe("checkoutCarrying", () => {
  test("brings uncommitted work along to the other branch", async () => {
    const dir = await makeRepo();
    await git(dir, ["branch", "other"]);
    await writeFile(path.join(dir, "a.txt"), "edited\n", "utf8");
    await writeFile(path.join(dir, "new.txt"), "fresh\n", "utf8");
    await checkoutCarrying(dir, "other");
    expect(await currentBranch(dir)).toBe("other");
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(path.join(dir, "new.txt"), "utf8")).toBe("fresh\n");
    expect((await git(dir, ["stash", "list"])).trim()).toBe("");
    await rm(dir, { recursive: true, force: true });
  });

  test("keeps clashing work in the stash and leaves the tree clean", async () => {
    const dir = await makeRepo();
    // `old` holds a.txt at "one"; editing it on main to "mine" can't be
    // carried onto a branch where a.txt was changed differently.
    await git(dir, ["checkout", "-b", "old", "HEAD~1"]);
    await writeFile(path.join(dir, "a.txt"), "theirs\n", "utf8");
    await git(dir, ["commit", "-am", "theirs"]);
    await git(dir, ["checkout", "main"]);
    await writeFile(path.join(dir, "a.txt"), "mine\n", "utf8");
    await expect(checkoutCarrying(dir, "old")).rejects.toThrow("safe in the stash");
    expect(await currentBranch(dir)).toBe("old");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["stash", "list"])).trim()).toContain("kone: carried to old");
    await rm(dir, { recursive: true, force: true });
  });

  test("with nothing to carry, just switches", async () => {
    const dir = await makeRepo();
    await git(dir, ["branch", "other"]);
    await checkoutCarrying(dir, "other");
    expect(await currentBranch(dir)).toBe("other");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("upstreams", () => {
  test("tracks a remote branch, and fast-forwards a branch you're not on", async () => {
    const dir = await makeRepo();
    const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
    await git(bare, ["init", "--bare"]);
    await git(dir, ["remote", "add", "origin", bare]);
    await git(dir, ["push", "origin", "main", "main:side"]);
    await git(dir, ["fetch", "origin"]);
    await git(dir, ["branch", "side", "HEAD~1"]);

    await setUpstream(dir, "side", "origin/side");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "side@{upstream}"])).trim()).toBe("origin/side");

    await fastForward(dir, "side");
    expect((await git(dir, ["rev-parse", "side"])).trim()).toBe((await git(dir, ["rev-parse", "main"])).trim());
    expect(await currentBranch(dir)).toBe("main");

    await expect(setUpstream(dir, "side", "origin/nope")).rejects.toThrow("isn't on the remote");
    await rm(dir, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });
});

describe("a local branch spelled like a remote one", () => {
  test("checks out whichever one the full ref names", async () => {
    const dir = await makeRepo();
    const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
    await git(bare, ["init", "--bare"]);
    await git(dir, ["remote", "add", "origin", bare]);
    await git(dir, ["push", "origin", "main:topic"]);
    await git(dir, ["fetch", "origin"]);
    await git(dir, ["branch", "origin/topic", "HEAD~1"]);

    await checkout(dir, "refs/remotes/origin/topic");
    expect(await currentBranch(dir)).toBe("topic");
    expect((await git(dir, ["for-each-ref", "--format=%(upstream)", "refs/heads/topic"])).trim()).toBe(
      "refs/remotes/origin/topic",
    );

    await checkout(dir, "refs/heads/origin/topic");
    expect(await currentBranch(dir)).toBe("origin/topic");
    for (const d of [dir, bare]) await rm(d, { recursive: true, force: true });
  });
});

describe("a remote whose name has a slash", () => {
  test("catches up, pushes and deletes against the whole remote name", async () => {
    const dir = await makeRepo();
    const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
    await git(bare, ["init", "--bare"]);
    await git(dir, ["remote", "add", "team/up", bare]);
    await git(dir, ["push", "team/up", "main", "main:side"]);
    await git(dir, ["fetch", "team/up"]);
    await git(dir, ["branch", "side", "HEAD~1"]);
    await setUpstream(dir, "side", "team/up/side");

    await fastForward(dir, "side");
    expect((await git(dir, ["rev-parse", "side"])).trim()).toBe((await git(dir, ["rev-parse", "main"])).trim());

    await git(dir, ["branch", "extra"]);
    await push(dir, { branch: "extra", setUpstream: true, remote: "team/up" });
    expect((await git(bare, ["branch", "--list", "extra"])).trim()).toBe("extra");
    await push(dir, { branch: "side" });

    await deleteBranch(dir, "team/up/extra", { remote: true });
    expect((await git(bare, ["branch", "--list", "extra"])).trim()).toBe("");
    for (const d of [dir, bare]) await rm(d, { recursive: true, force: true });
  });
});

describe("push of a branch you're not on", () => {
  test("goes to that branch's own remote, not the checked-out one's", async () => {
    const dir = await makeRepo();
    const make = async () => {
      const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
      await git(bare, ["init", "--bare"]);
      return bare;
    };
    const up = await make();
    const mine = await make();
    await git(dir, ["remote", "add", "upstream", up]);
    await git(dir, ["remote", "add", "origin", mine]);
    await git(dir, ["push", "-u", "upstream", "main"]);
    await git(dir, ["branch", "topic"]);
    await git(dir, ["push", "-u", "origin", "topic"]);
    await git(dir, ["checkout", "topic"]);
    await writeFile(path.join(dir, "b.txt"), "b\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "topic work"]);
    await git(dir, ["checkout", "main"]);

    await push(dir, { branch: "topic" });
    expect((await git(mine, ["rev-parse", "topic"])).trim()).toBe((await git(dir, ["rev-parse", "topic"])).trim());
    expect((await git(up, ["branch", "--list", "topic"])).trim()).toBe("");
    for (const d of [dir, up, mine]) await rm(d, { recursive: true, force: true });
  });

  test("onto another remote, goes up under its own name", async () => {
    const dir = await makeRepo();
    const make = async () => {
      const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
      await git(bare, ["init", "--bare"]);
      return bare;
    };
    const up = await make();
    const mine = await make();
    await git(dir, ["remote", "add", "upstream", up]);
    await git(dir, ["remote", "add", "origin", mine]);
    await git(dir, ["branch", "topic"]);
    await git(dir, ["push", "-u", "upstream", "topic"]);

    await push(dir, { branch: "topic", setUpstream: true, remote: "origin" });
    expect((await git(mine, ["branch", "--list", "topic"])).trim()).toBe("topic");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "topic@{upstream}"])).trim()).toBe("origin/topic");
    for (const d of [dir, up, mine]) await rm(d, { recursive: true, force: true });
  });
});
