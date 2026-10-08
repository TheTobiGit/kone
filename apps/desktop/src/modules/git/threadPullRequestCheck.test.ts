import { describe, expect, test } from "bun:test";

import type { GitHubPullRequestState } from "@kone/git-core/types.js";
import type { ThreadPullRequestLink } from "@kone/agent-core/threadPullRequest.js";
import { checkThreadPullRequest, type PullRequestStateRef } from "./threadPullRequestCheck.js";

const state = (over: Partial<GitHubPullRequestState> = {}): GitHubPullRequestState => ({
  number: 7,
  url: "https://github.com/other/repo/pull/7",
  branch: "feature",
  state: "merged",
  mergedAt: "2026-01-02T03:04:05Z",
  ...over,
});

const foreignLink: ThreadPullRequestLink = {
  repository: "other/repo",
  number: 7,
  url: "https://github.com/other/repo/pull/7",
  state: "open",
  checkedAt: null,
  mergedAt: null,
};

describe("checkThreadPullRequest", () => {
  test("an explicit link is looked up by its full identity, never the local repo", async () => {
    const refs: PullRequestStateRef[] = [];
    let branchChecks = 0;
    const outcome = await checkThreadPullRequest(
      { link: foreignLink, branch: "feature" },
      {
        fetchState: async (ref) => {
          refs.push(ref);
          return state();
        },
        fetchBranchPr: async () => {
          branchChecks++;
          return null;
        },
      },
    );
    expect(refs).toEqual([
      { number: 7, url: "https://github.com/other/repo/pull/7", repository: "other/repo" },
    ]);
    // The branch is NOT consulted for a thread that has its own link.
    expect(branchChecks).toBe(0);
    expect(outcome.link).toMatchObject({
      repository: "other/repo",
      number: 7,
      state: "merged",
      mergedAt: Date.parse("2026-01-02T03:04:05Z"),
    });
    expect(outcome.unavailable).toBe(false);
  });

  test("an explicit link that cannot be resolved is unknown, not the branch PR", async () => {
    let branchChecks = 0;
    const outcome = await checkThreadPullRequest(
      { link: foreignLink, branch: "feature" },
      {
        fetchState: async () => null,
        fetchBranchPr: async () => {
          branchChecks++;
          return state();
        },
      },
    );
    expect(outcome.link).toBeNull();
    expect(outcome.unavailable).toBe(true);
    // Falling back here would settle on the wrong PR.
    expect(branchChecks).toBe(0);
  });

  test("a throwing linked lookup is unknown", async () => {
    const outcome = await checkThreadPullRequest(
      { link: foreignLink, branch: null },
      {
        fetchState: async () => {
          throw new Error("gh down");
        },
        fetchBranchPr: async () => null,
      },
    );
    expect(outcome).toEqual({ link: null, unavailable: true });
  });

  test("a thread with no link uses the branch PR", async () => {
    const outcome = await checkThreadPullRequest(
      { link: null, branch: "feature" },
      { fetchState: async () => null, fetchBranchPr: async () => state({ number: 9, url: "u9" }) },
    );
    expect(outcome.link).toMatchObject({ number: 9, state: "merged" });
    expect(outcome.unavailable).toBe(false);
  });

  test("a branch lookup error is unknown (fail closed)", async () => {
    const outcome = await checkThreadPullRequest(
      { link: null, branch: "feature" },
      {
        fetchState: async () => null,
        fetchBranchPr: async () => {
          throw new Error("gh down");
        },
      },
    );
    expect(outcome).toEqual({ link: null, unavailable: true });
  });

  test("a branch with no PR is known-empty, not unknown", async () => {
    const outcome = await checkThreadPullRequest(
      { link: null, branch: "feature" },
      { fetchState: async () => null, fetchBranchPr: async () => null },
    );
    expect(outcome).toEqual({ link: null, unavailable: false });
  });
});
