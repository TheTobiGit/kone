import { afterEach, describe, expect, test } from "bun:test";
import { effectScope, ref, type EffectScope } from "vue";
import type { GitStatus, KoneGitApi } from "~/types/desktop";
import { useWorktreeBranch } from "./useWorktreeBranch";

function status(branch: string | null): GitStatus {
  return {
    root: "/worktree", branch, detached: branch === null, head: "abc123",
    upstream: null, ahead: 0, behind: 0, changes: [], staged: 0,
    unstaged: 0, untracked: 0, clean: true,
  };
}

const scopes: EffectScope[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));

function harness(initialPath: string | null = null) {
  const worktreePath = ref(initialPath);
  const fallbackBranch = ref("origin/feat/agent-roles");
  const reads: Array<{
    dir: string;
    resolve: (value: GitStatus | null) => void;
    reject: (cause: Error) => void;
  }> = [];
  const watches: Array<{ dir: string; push: (value: GitStatus) => void; stopped: boolean }> = [];
  const git: Pick<KoneGitApi, "status" | "watchStatus"> = {
    status: (dir) => new Promise((resolve, reject) => reads.push({ dir, resolve, reject })),
    watchStatus: (dir, push) => {
      const subscription = { dir, push, stopped: false };
      watches.push(subscription);
      return () => { subscription.stopped = true; };
    },
  };
  const scope = effectScope();
  scopes.push(scope);
  const branch = scope.run(() => useWorktreeBranch({ worktreePath, fallbackBranch, git }))!;
  return { worktreePath, fallbackBranch, reads, watches, branch, scope };
}

describe("useWorktreeBranch", () => {
  test("a draft keeps its selected origin base without reading or watching git", () => {
    const h = harness();
    expect(h.branch.value).toBe("origin/feat/agent-roles");
    expect(h.reads).toHaveLength(0);
    expect(h.watches).toHaveLength(0);
    h.fallbackBranch.value = "main";
    expect(h.branch.value).toBe("main");
  });

  test("after the first send the worktree's branch replaces the project's branch", async () => {
    const h = harness();
    h.fallbackBranch.value = "linux/desktop-shell";
    h.worktreePath.value = "/worktrees/review";
    expect(h.branch.value).toBeUndefined();
    expect(h.reads[0]!.dir).toBe("/worktrees/review");
    h.reads[0]!.resolve(status("kone/review-this-branch-against-dev"));
    await Promise.resolve();
    expect(h.branch.value).toBe("kone/review-this-branch-against-dev");
    h.fallbackBranch.value = "dev";
    expect(h.branch.value).toBe("kone/review-this-branch-against-dev");
  });

  test("a restored worktree follows branch renames", async () => {
    const h = harness("/worktrees/review");
    h.reads[0]!.resolve(status("kone/temp-123"));
    await Promise.resolve();
    h.watches[0]!.push(status("kone/review-origin-branch"));
    expect(h.branch.value).toBe("kone/review-origin-branch");
  });

  test("switching threads drops stale reads and watcher pushes, even when returning", async () => {
    const h = harness("/worktrees/a");
    h.worktreePath.value = "/worktrees/b";
    expect(h.watches[0]!.stopped).toBe(true);
    h.worktreePath.value = "/worktrees/a";
    h.reads[2]!.resolve(status("kone/current-a"));
    await Promise.resolve();
    h.reads[0]!.resolve(status("kone/stale-a"));
    h.reads[1]!.resolve(status("kone/stale-b"));
    h.watches[0]!.push(status("kone/stale-push"));
    await Promise.resolve();
    expect(h.branch.value).toBe("kone/current-a");
  });

  test("a watcher rename outranks an older initial status read", async () => {
    const h = harness("/worktrees/review");
    h.watches[0]!.push(status("kone/renamed"));
    h.reads[0]!.resolve(status("kone/placeholder"));
    await Promise.resolve();
    expect(h.branch.value).toBe("kone/renamed");
  });

  test("unreadable or detached worktrees never display the project's branch", async () => {
    const h = harness("/worktrees/gone");
    h.reads[0]!.reject(new Error("worktree unavailable"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.branch.value).toBeUndefined();
    h.watches[0]!.push(status(null));
    expect(h.branch.value).toBeUndefined();
    h.watches[0]!.push(status("kone/recovered"));
    expect(h.branch.value).toBe("kone/recovered");
    h.worktreePath.value = null;
    expect(h.branch.value).toBe("origin/feat/agent-roles");
  });

  test("disposing the composer releases its watcher and ignores late answers", async () => {
    const h = harness("/worktrees/review");
    h.scope.stop();
    expect(h.watches[0]!.stopped).toBe(true);
    h.reads[0]!.resolve(status("kone/late"));
    h.watches[0]!.push(status("kone/late-push"));
    await Promise.resolve();
    expect(h.branch.value).toBeUndefined();
  });
});
