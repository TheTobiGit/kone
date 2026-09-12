import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { parseKind } from "@kone/protocol/ipc-error";
import {
  addWorktree,
  isLinkedWorktree,
  parseWorktreePorcelain,
  pruneWorktrees,
  removeWorktree,
  worktrees,
} from "./worktree.js";

// Worktrees outlive the test that made them: the directory is one thing and the
// registration in the shared .git is another, so a suite that only deletes
// directories leaves a repo full of prunable ghosts. Every repo made here is
// torn down through git itself, then pruned, then removed.
const madeRepos: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-worktree-");
  await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "one"]);
  madeRepos.push(dir);
  return dir;
}

/** A path for a worktree that does not exist yet, beside the repo rather than
 *  inside it — a worktree inside the project tree would show up in the
 *  project's own status. */
function worktreePathFor(repo: string, name: string): string {
  return path.join(path.dirname(repo), `${path.basename(repo)}-${name}`);
}

afterEach(async () => {
  for (const repo of madeRepos.splice(0)) {
    for (const worktree of await worktrees(repo).catch(() => [])) {
      if (worktree.main) continue;
      if (worktree.locked) {
        await git(repo, ["worktree", "unlock", worktree.path]).catch(() => undefined);
      }
      await git(repo, ["worktree", "remove", "--force", worktree.path]).catch(
        () => undefined,
      );
      await rm(worktree.path, { recursive: true, force: true });
    }
    await git(repo, ["worktree", "prune"]).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  }
});

/** The kind a classified failure carries, or null. */
async function kindOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (error) {
    return parseKind(error instanceof Error ? error.message : String(error)).kind;
  }
}

describe("parseWorktreePorcelain", () => {
  test("reads a branch record and a detached one", () => {
    const out = "worktree /r\0HEAD abc123\0branch refs/heads/main\0\0worktree /r-d\0HEAD abc123\0detached\0\0";
    const parsed = parseWorktreePorcelain(out);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      path: "/r",
      head: "abc123",
      branch: "main",
      detached: false,
    });
    expect(parsed[1]).toMatchObject({ path: "/r-d", branch: null, detached: true });
  });

  test("keeps a lock reason containing a newline intact", () => {
    const reason = "held by\nanother tool";
    const parsed = parseWorktreePorcelain(
      `worktree /r\0HEAD abc\0branch refs/heads/x\0locked ${reason}\0\0`,
    );

    expect(parsed[0]?.locked).toBe(true);
    expect(parsed[0]?.lockReason).toBe(reason);
  });

  test("a lock with no reason is still locked", () => {
    const parsed = parseWorktreePorcelain("worktree /r\0HEAD abc\0locked\0\0");

    expect(parsed[0]?.locked).toBe(true);
    expect(parsed[0]?.lockReason).toBeNull();
  });

  test("a bare entry carries no HEAD", () => {
    const parsed = parseWorktreePorcelain("worktree /r.git\0bare\0\0");

    expect(parsed[0]).toMatchObject({ bare: true, head: null, branch: null });
  });

  test("records a prunable reason", () => {
    const parsed = parseWorktreePorcelain(
      "worktree /gone\0HEAD abc\0prunable gitdir file points to non-existent location\0\0",
    );

    expect(parsed[0]?.prunableReason).toBe(
      "gitdir file points to non-existent location",
    );
  });
});

describe("worktrees", () => {
  test("lists the primary checkout first", async () => {
    const repo = await makeRepo();
    const listed = await worktrees(repo);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.main).toBe(true);
    expect(listed[0]?.branch).toBe("main");
  });

  test("is empty outside a repository", async () => {
    expect(await worktrees(os.tmpdir())).toEqual([]);
  });
});

describe("addWorktree", () => {
  test("creates a worktree on a new branch", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "feature");

    const created = await addWorktree(repo, { path: target, branch: "feature" });

    expect(created.branch).toBe("feature");
    expect(created.main).toBe(false);
    expect(created.detached).toBe(false);
    expect(await worktrees(repo)).toHaveLength(2);
    // The project's own checkout has not moved.
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  });

  test("the new branch starts from the base ref, not HEAD", async () => {
    const repo = await makeRepo();
    const firstSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repo, "a.txt"), "two\n", "utf8");
    await git(repo, ["commit", "-am", "two"]);

    const created = await addWorktree(repo, {
      path: worktreePathFor(repo, "from-base"),
      branch: "from-base",
      base: firstSha,
    });

    expect(created.head).toBe(firstSha);
  });

  test("refuses a branch another worktree already holds", async () => {
    const repo = await makeRepo();
    await addWorktree(repo, { path: worktreePathFor(repo, "held"), branch: "held" });

    const kind = await kindOf(
      addWorktree(repo, { path: worktreePathFor(repo, "held-2"), branch: "held" }),
    );

    expect(kind).toBe("WORKTREE_BRANCH_IN_USE");
  });

  test("refuses a branch that merely exists", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "already"]);

    const kind = await kindOf(
      addWorktree(repo, { path: worktreePathFor(repo, "already"), branch: "already" }),
    );

    expect(kind).toBe("WORKTREE_BRANCH_EXISTS");
  });

  test("refuses a non-empty directory and leaves no branch behind", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "occupied");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "keep.txt"), "mine\n", "utf8");

    const kind = await kindOf(addWorktree(repo, { path: target, branch: "occupied" }));

    expect(kind).toBe("WORKTREE_PATH_EXISTS");
    const branches = await git(repo, ["branch", "--list", "occupied"]);
    expect(branches.trim()).toBe("");
    await rm(target, { recursive: true, force: true });
  });

  test("accepts an existing empty directory", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "empty");
    await mkdir(target, { recursive: true });

    const created = await addWorktree(repo, { path: target, branch: "empty-dir" });

    expect(created.branch).toBe("empty-dir");
  });

  test("rejects a relative path before touching git", async () => {
    const repo = await makeRepo();

    const kind = await kindOf(addWorktree(repo, { path: "../escape", branch: "x" }));

    expect(kind).toBe("INVALID_INPUT");
    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("rejects a base ref that does not resolve", async () => {
    const repo = await makeRepo();

    const kind = await kindOf(
      addWorktree(repo, {
        path: worktreePathFor(repo, "nobase"),
        branch: "nobase",
        base: "no-such-ref",
      }),
    );

    expect(kind).toBe("NOT_FOUND");
  });
});

describe("removeWorktree", () => {
  test("removes a clean worktree", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "clean");
    await addWorktree(repo, { path: target, branch: "clean" });

    await removeWorktree(repo, { path: target });

    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("refuses a dirty worktree until forced", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "dirty");
    await addWorktree(repo, { path: target, branch: "dirty" });
    await writeFile(path.join(target, "untracked.txt"), "work\n", "utf8");

    expect(await kindOf(removeWorktree(repo, { path: target }))).toBe("WORKTREE_DIRTY");

    await removeWorktree(repo, { path: target, force: true });
    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("a single force does not remove a locked worktree", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "locked");
    await addWorktree(repo, { path: target, branch: "locked" });
    await git(repo, ["worktree", "lock", "--reason", "held", target]);

    expect(await kindOf(removeWorktree(repo, { path: target, force: true }))).toBe(
      "WORKTREE_LOCKED",
    );
    expect(await worktrees(repo)).toHaveLength(2);
  });

  test("refuses the main working tree", async () => {
    const repo = await makeRepo();

    expect(await kindOf(removeWorktree(repo, { path: repo }))).toBe("WORKTREE_IS_MAIN");
  });

  test("works when called from inside the worktree being removed", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "self");
    await addWorktree(repo, { path: target, branch: "self" });

    await removeWorktree(target, { path: target });

    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("reclaims a generated branch, leaving no ref behind", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "generated");
    await addWorktree(repo, { path: target, branch: "kone/deadbeef" });

    await removeWorktree(repo, { path: target, force: true, reclaimGeneratedBranch: true });

    expect(await worktrees(repo)).toHaveLength(1);
    expect((await git(repo, ["branch", "--list", "kone/deadbeef"])).trim()).toBe("");
  });

  test("leaves a user-named branch behind, even when asked to reclaim", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "kept");
    await addWorktree(repo, { path: target, branch: "kept" });

    await removeWorktree(repo, { path: target, force: true, reclaimGeneratedBranch: true });

    expect(await worktrees(repo)).toHaveLength(1);
    // The worktree is gone but the branch a person named survives it.
    expect((await git(repo, ["branch", "--list", "kept"])).trim()).toBe("kept");
  });

  test("leaves a generated branch behind without the reclaim flag", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "unclaimed");
    await addWorktree(repo, { path: target, branch: "kone/a1b2c3d4" });

    await removeWorktree(repo, { path: target, force: true });

    expect(await worktrees(repo)).toHaveLength(1);
    expect((await git(repo, ["branch", "--list", "kone/a1b2c3d4"])).trim()).toBe(
      "kone/a1b2c3d4",
    );
  });

  test("a failed removal never fails on the reclaim", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "dirty-reclaim");
    await addWorktree(repo, { path: target, branch: "kone/1234abcd" });
    await writeFile(path.join(target, "untracked.txt"), "work\n", "utf8");

    // Unforced on a dirty worktree: the removal itself refuses, and the kind
    // is the removal's — not something the reclaim invented.
    expect(
      await kindOf(removeWorktree(repo, { path: target, reclaimGeneratedBranch: true })),
    ).toBe("WORKTREE_DIRTY");
    expect(await worktrees(repo)).toHaveLength(2);
  });
});

describe("pruneWorktrees", () => {
  test("unregisters a worktree whose directory is gone, immediately", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "vanished");
    await addWorktree(repo, { path: target, branch: "vanished" });
    await rm(target, { recursive: true, force: true });

    const pruned = await pruneWorktrees(repo);

    expect(pruned.join("\n")).toContain(path.basename(target));
    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("leaves an intact worktree alone", async () => {
    const repo = await makeRepo();
    await addWorktree(repo, { path: worktreePathFor(repo, "intact"), branch: "intact" });

    await pruneWorktrees(repo);

    expect(await worktrees(repo)).toHaveLength(2);
  });
});

describe("isLinkedWorktree", () => {
  test("true for a linked worktree, false for its primary checkout", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "linked");
    await addWorktree(repo, { path: target, branch: "linked" });

    expect(await isLinkedWorktree(target)).toBe(true);
    expect(await isLinkedWorktree(repo)).toBe(false);
  });

  test("false for a submodule, whose .git file has the same shape", async () => {
    const repo = await makeRepo();
    const inner = path.join(repo, "sub");
    await mkdir(inner, { recursive: true });
    await writeFile(
      path.join(inner, ".git"),
      `gitdir: ../.git/modules/sub\n`,
      "utf8",
    );

    expect(await isLinkedWorktree(inner)).toBe(false);
  });

  test("false for a directory merely named like a worktrees root", async () => {
    const repo = await makeRepo();
    const inner = path.join(repo, "fake");
    await mkdir(inner, { recursive: true });
    await writeFile(
      path.join(inner, ".git"),
      `gitdir: /some/my-worktrees-backup/thing\n`,
      "utf8",
    );

    expect(await isLinkedWorktree(inner)).toBe(false);
  });

  test("false where there is no .git at all", async () => {
    expect(await isLinkedWorktree(os.tmpdir())).toBe(false);
  });
});
