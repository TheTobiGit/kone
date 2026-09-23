import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, pathExists } from "@kone/git-core/core.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { setUserDataDir } from "@kone/agent-core/userDataDir.js";
import { provisionWorktree } from "./worktreeProvision.js";
import { worktrees } from "./worktree.js";
import {
  sweepIdleWorktrees,
  worktreeRemovability,
  type IdleWorktree,
  type WorktreeSweepDeps,
} from "./worktreeSweep.js";

const cleanup: Array<{ repo: string; state: string }> = [];

async function makeRepo(): Promise<string> {
  const state = mkdtempSync(path.join(os.tmpdir(), "kone-wt-sweep-state-"));
  setUserDataDir(state);
  const repo = await initTestRepo("kone-wt-sweep-");
  writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n", "utf8");
  writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
  writeFileSync(path.join(repo, ".env"), "SECRET=1\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "one"]);
  cleanup.push({ repo, state });
  return repo;
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

function deps(entries: IdleWorktree[], live: string[] = []) {
  const detached: Array<{ worktreePath: string; branch: string }> = [];
  const cutoffs: number[] = [];
  const sweepDeps: WorktreeSweepDeps = {
    idleWorktrees: (cutoff: number) => {
      cutoffs.push(cutoff);
      return entries;
    },
    isThreadLive: (id: string) => live.includes(id),
    detachWorktree: (worktreePath: string, branch: string) => {
      detached.push({ worktreePath, branch });
    },
    cleanupDays: () => 14,
  };
  return { detached, cutoffs, deps: sweepDeps };
}

describe("what an idle worktree may lose", () => {
  test("a clean worktree with its copied env and installed packages may go", async () => {
    const repo = await makeRepo();
    const made = await provisionWorktree({ projectPath: repo });
    await mkdir(path.join(made.path, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(made.path, "node_modules/pkg/index.js"), "x\n");

    expect(await worktreeRemovability({ worktreePath: made.path, projectPath: repo })).toEqual({
      ok: true,
      branch: made.branch,
    });
  });

  test("uncommitted work, a changed env file or a stray ignored file keeps it", async () => {
    const repo = await makeRepo();
    const made = await provisionWorktree({ projectPath: repo });
    const entry = { worktreePath: made.path, projectPath: repo };

    await writeFile(path.join(made.path, "a.txt"), "two\n");
    expect((await worktreeRemovability(entry)).ok).toBe(false);
    await git(made.path, ["checkout", "--", "a.txt"]);

    await writeFile(path.join(made.path, ".env"), "SECRET=edited\n");
    expect((await worktreeRemovability(entry)).ok).toBe(false);
    await writeFile(path.join(made.path, ".env"), "SECRET=1\n");
    expect((await worktreeRemovability(entry)).ok).toBe(true);

    await writeFile(path.join(repo, ".gitignore"), ".env\nnode_modules/\n*.log\n");
    await writeFile(path.join(made.path, ".gitignore"), ".env\nnode_modules/\n*.log\n");
    await git(made.path, ["commit", "-am", "ignore logs"]);
    await writeFile(path.join(made.path, "debug.log"), "notes\n");
    expect(await worktreeRemovability(entry)).toEqual({ ok: false, reason: "keeps debug.log" });
  });

  test("a directory the project lists comes along whole and does not keep the worktree", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, ".gitignore"), ".env\nnode_modules/\ncerts/\n");
    await writeFile(path.join(repo, ".worktreeinclude"), "certs/\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "certs"]);
    await mkdir(path.join(repo, "certs/nested"), { recursive: true });
    await writeFile(path.join(repo, "certs/nested/a.crt"), "crt\n");
    const made = await provisionWorktree({ projectPath: repo });
    const entry = { worktreePath: made.path, projectPath: repo };

    expect(made.copiedFiles).toContain("certs");
    expect((await worktreeRemovability(entry)).ok).toBe(true);

    await writeFile(path.join(made.path, "certs/nested/a.crt"), "edited\n");
    expect(await worktreeRemovability(entry)).toEqual({ ok: false, reason: "keeps certs/nested/a.crt" });
  });

  test("an env file in a nested folder does not keep the worktree", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, "apps/web"), { recursive: true });
    await writeFile(path.join(repo, "apps/web/.env"), "WEB=1\n");
    await writeFile(path.join(repo, "apps/web/index.ts"), "x\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "web"]);
    const made = await provisionWorktree({ projectPath: repo });

    expect(await worktreeRemovability({ worktreePath: made.path, projectPath: repo })).toEqual({
      ok: true,
      branch: made.branch,
    });
  });

  test("a directory outside kone's worktrees folder is never offered", async () => {
    const repo = await makeRepo();
    expect(await worktreeRemovability({ worktreePath: repo, projectPath: repo })).toEqual({
      ok: false,
      reason: "not kone's",
    });
  });
});

describe("the sweep", () => {
  test("removes an idle worktree, keeps its branch and detaches its threads", async () => {
    const repo = await makeRepo();
    const made = await provisionWorktree({ projectPath: repo });
    const run = deps([{ worktreePath: made.path, projectPath: repo, threadIds: ["t-1"] }]);
    const now = Date.now();

    expect(await sweepIdleWorktrees(run.deps, now)).toBe(1);

    expect(run.cutoffs).toEqual([now - 14 * 24 * 60 * 60 * 1000]);
    expect(await pathExists(made.path)).toBe(false);
    expect(run.detached).toEqual([{ worktreePath: made.path, branch: made.branch }]);
    await git(repo, ["show-ref", "--verify", `refs/heads/${made.branch}`]);
  });

  test("a thread open in a column keeps its worktree, and off means off", async () => {
    const repo = await makeRepo();
    const made = await provisionWorktree({ projectPath: repo });
    const entries = [{ worktreePath: made.path, projectPath: repo, threadIds: ["t-1", "t-2"] }];

    const live = deps(entries, ["t-2"]);
    expect(await sweepIdleWorktrees(live.deps)).toBe(0);

    const off = deps(entries);
    off.deps.cleanupDays = () => null;
    expect(await sweepIdleWorktrees(off.deps)).toBe(0);
    expect(off.cutoffs).toEqual([]);

    expect(await pathExists(made.path)).toBe(true);
  });
});
