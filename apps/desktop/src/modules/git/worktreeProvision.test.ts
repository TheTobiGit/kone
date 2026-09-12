import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, pathExists } from "@kone/git-core/core.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { setUserDataDir } from "@kone/agent-core/userDataDir.js";
import { parseKind } from "@kone/protocol/ipc-error";
import { provisionWorktree, rollbackDirectory } from "./worktreeProvision.js";
import {
  isGeneratedBranchName,
  worktreeDirFor,
  worktreesRoot,
} from "./worktreePaths.js";
import { worktrees } from "./worktree.js";

// The managed root is the state directory's, so each test gets a throwaway one
// and every worktree this suite creates lands inside it.
function useStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-wt-state-"));
  setUserDataDir(dir);
  return dir;
}

const cleanup: Array<{ repo: string; state: string }> = [];

async function makeRepo(): Promise<{ repo: string; state: string }> {
  const state = useStateDir();
  const repo = await initTestRepo("kone-git-provision-");
  writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "one"]);
  const made = { repo, state };
  cleanup.push(made);
  return made;
}

afterEach(async () => {
  for (const { repo, state } of cleanup.splice(0)) {
    for (const worktree of await worktrees(repo).catch(() => [])) {
      if (worktree.main) continue;
      await git(repo, ["worktree", "remove", "--force", worktree.path]).catch(
        () => undefined,
      );
    }
    await git(repo, ["worktree", "prune"]).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

async function kindOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (error) {
    return parseKind(error instanceof Error ? error.message : String(error)).kind;
  }
}

describe("provisionWorktree", () => {
  test("creates the worktree outside the project and leaves its branch alone", async () => {
    const { repo, state } = await makeRepo();

    const made = await provisionWorktree({ projectPath: repo, branch: "feature/foo" });

    expect(made.branch).toBe("feature/foo");
    expect(made.generatedBranch).toBe(false);
    // Under the app's own state directory, never inside the user's repository.
    expect(made.path.startsWith(repo)).toBe(false);
    expect(made.path).toContain(path.basename(worktreesRoot()));
    expect(made.path).toContain(state.replace(/^\/private/, "").split(path.sep).pop() ?? "");
    // The project's own checkout has not moved.
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect((await git(made.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(
      "feature/foo",
    );
  });

  test("two conversations get two branches, and the project stays where it was", async () => {
    const { repo } = await makeRepo();

    const one = await provisionWorktree({ projectPath: repo, branch: "one" });
    const two = await provisionWorktree({ projectPath: repo, branch: "two" });

    expect(one.path).not.toBe(two.path);
    expect((await git(one.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("one");
    expect((await git(two.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("two");
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect(await worktrees(repo)).toHaveLength(3);
  });

  test("asking twice for the same branch gives the same worktree", async () => {
    const { repo } = await makeRepo();

    const first = await provisionWorktree({ projectPath: repo, branch: "again" });
    const second = await provisionWorktree({ projectPath: repo, branch: "again" });

    expect(second.path).toBe(first.path);
    expect(await worktrees(repo)).toHaveLength(2);
  });

  test("invents a branch when none is named, and marks it as ours", async () => {
    const { repo } = await makeRepo();

    const made = await provisionWorktree({ projectPath: repo });

    expect(isGeneratedBranchName(made.branch)).toBe(true);
    expect(made.generatedBranch).toBe(true);
  });

  test("starts the branch from an explicit base", async () => {
    const { repo } = await makeRepo();
    const firstSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repo, "a.txt"), "two\n", "utf8");
    await git(repo, ["commit", "-am", "two"]);

    const made = await provisionWorktree({
      projectPath: repo,
      branch: "from-base",
      base: firstSha,
    });

    expect((await git(made.path, ["rev-parse", "HEAD"])).trim()).toBe(firstSha);
  });

  test("adopts a worktree the user already made on that branch", async () => {
    const { repo } = await makeRepo();
    const held = path.join(path.dirname(repo), `${path.basename(repo)}-held`);
    await git(repo, ["branch", "taken"]);
    await git(repo, ["worktree", "add", held, "taken"]);

    // Git would refuse a second worktree for one branch, and this directory is
    // exactly what the thread asked for — so it is opened, not duplicated.
    const made = await provisionWorktree({ projectPath: repo, branch: "taken" });

    expect(made.branch).toBe("taken");
    expect(await realpath(made.path)).toBe(await realpath(held));
    expect(await worktrees(repo)).toHaveLength(2);
  });

  test("moves an existing branch into a worktree instead of refusing it", async () => {
    const { repo } = await makeRepo();
    await git(repo, ["branch", "dormant"]);

    const made = await provisionWorktree({ projectPath: repo, branch: "dormant" });

    expect(made.attachedExisting).toBe(true);
    expect(made.generatedBranch).toBe(false);
    expect((await git(made.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(
      "dormant",
    );
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  });

  test("refuses the branch the project itself is sitting on", async () => {
    const { repo } = await makeRepo();

    // Handing back the project's own checkout would give a thread that asked for
    // isolation the shared tree, recorded as a worktree. Refuse and say where
    // the branch is instead.
    expect(await kindOf(provisionWorktree({ projectPath: repo, branch: "main" }))).toBe(
      "WORKTREE_BRANCH_IN_USE",
    );
    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("refuses when something is already in the way, and creates nothing", async () => {
    const { repo } = await makeRepo();
    // Derive the same target the provisioner will, and occupy it.
    const probe = await provisionWorktree({ projectPath: repo, branch: "occupied" });
    await git(repo, ["worktree", "remove", "--force", probe.path]);
    await mkdir(probe.path, { recursive: true });
    await writeFile(path.join(probe.path, "mine.txt"), "keep\n", "utf8");

    expect(await kindOf(provisionWorktree({ projectPath: repo, branch: "occupied" }))).toBe(
      "WORKTREE_PATH_EXISTS",
    );
    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("refuses a directory that is not a repository", async () => {
    useStateDir();
    const plain = mkdtempSync(path.join(os.tmpdir(), "kone-not-a-repo-"));

    expect(await kindOf(provisionWorktree({ projectPath: plain, branch: "x" }))).toBe(
      "NOT_A_REPO",
    );
    await rm(plain, { recursive: true, force: true });
  });
});

describe("rollbackDirectory", () => {
  test("unregisters a registered worktree instead of stranding it", async () => {
    const { repo } = await makeRepo();
    const root = worktreesRoot();
    const target = worktreeDirFor({ root, projectPath: repo, branch: "doomed" });
    await mkdir(path.dirname(target), { recursive: true });
    // The shape a failed reconciliation leaves: git added the worktree, then
    // the provision threw — the directory exists AND git lists it.
    await git(repo, ["worktree", "add", "-b", "doomed", target, "HEAD"]);

    await rollbackDirectory(repo, root, target);

    // The registration goes with the directory; a bare delete would leave the
    // branch reading as taken by a worktree that is gone.
    expect((await worktrees(repo)).some((worktree) => worktree.branch === "doomed")).toBe(
      false,
    );
    expect(await pathExists(target)).toBe(false);
  });

  test("deletes a directory git has no record of", async () => {
    const { repo } = await makeRepo();
    const root = worktreesRoot();
    const target = worktreeDirFor({ root, projectPath: repo, branch: "half-made" });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "junk.txt"), "x\n", "utf8");

    await rollbackDirectory(repo, root, target);

    expect(await pathExists(target)).toBe(false);
    expect(await worktrees(repo)).toHaveLength(1);
  });

  test("leaves anything outside the managed root alone", async () => {
    const { repo } = await makeRepo();
    const outside = path.join(path.dirname(repo), "kone-not-managed");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "x\n", "utf8");

    await rollbackDirectory(repo, worktreesRoot(), outside);

    expect(await pathExists(path.join(outside, "keep.txt"))).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });
});
