import { describe, expect, test } from "bun:test";

import {
  pullRequestMerged,
  resolveThreadPullRequest,
  samePullRequest,
  toThreadPullRequestLink,
  type ThreadPullRequestLink,
} from "./threadPullRequest.js";

const link = (over: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({
  repository: "acme/site",
  number: 42,
  url: "https://github.com/acme/site/pull/42",
  state: "open",
  checkedAt: null,
  mergedAt: null,
  ...over,
});

describe("toThreadPullRequestLink", () => {
  test("keeps a URL-only link", () => {
    expect(toThreadPullRequestLink({ url: "https://x/pull/1" })).toEqual({
      repository: "",
      number: 0,
      url: "https://x/pull/1",
      state: "unknown",
      checkedAt: null,
      mergedAt: null,
    });
  });

  test("drops a non-positive number and coerces an unknown state", () => {
    expect(toThreadPullRequestLink({ url: "u", number: -3, state: "weird" as never })?.number).toBe(0);
    expect(toThreadPullRequestLink({ url: "u", state: "weird" as never })?.state).toBe("unknown");
  });

  test("refuses an input naming no PR", () => {
    expect(toThreadPullRequestLink({ url: "   " })).toBeNull();
    expect(toThreadPullRequestLink({ url: "", number: 0 })).toBeNull();
  });
});

describe("samePullRequest", () => {
  test("matches repository and number case-insensitively", () => {
    expect(
      samePullRequest(link(), link({ repository: "ACME/Site", url: "https://other/pull/42" })),
    ).toBe(true);
  });

  test("falls back to URL when a number is unknown", () => {
    expect(samePullRequest(link({ number: 0 }), link({ number: 0, repository: "z/z" }))).toBe(true);
    expect(samePullRequest(link({ number: 0 }), link({ number: 0, url: "https://x/pull/9" }))).toBe(
      false,
    );
  });

  test("different numbers do not match", () => {
    expect(samePullRequest(link(), link({ number: 43 }))).toBe(false);
  });
});

describe("pullRequestMerged", () => {
  test("a merged state or a merge stamp is terminal", () => {
    expect(pullRequestMerged(link({ state: "merged" }))).toBe(true);
    expect(pullRequestMerged(link({ mergedAt: 123 }))).toBe(true);
  });

  test("open and closed-unmerged are not", () => {
    expect(pullRequestMerged(link())).toBe(false);
    expect(pullRequestMerged(link({ state: "closed" }))).toBe(false);
  });
});

describe("resolveThreadPullRequest", () => {
  test("the explicit link wins over the branch PR", () => {
    const linked = link({ number: 1 });
    const branch = link({ number: 2 });
    expect(resolveThreadPullRequest(linked, branch)?.number).toBe(1);
    expect(resolveThreadPullRequest(null, branch)?.number).toBe(2);
    expect(resolveThreadPullRequest(null, null)).toBeNull();
  });
});
