import { describe, expect, test } from "bun:test";
import { matchesPullRequestRepository, parsePullRequestLink } from "./pullRequestLink";

describe("PR reply links", () => {
  const link = { repository: "Owner/Repo", number: 42, href: "https://github.com/Owner/Repo/pull/42" };

  test("matches the CLI's repository without depending on name casing", () => {
    expect(matchesPullRequestRepository(link, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" })).toBe(true);
  });

  test.each([
    null,
    { nameWithOwner: "other/repo", url: "https://github.com/other/repo" },
    { nameWithOwner: "Owner/Repo", url: "https://github.enterprise/Owner/Repo" },
    { nameWithOwner: "Owner/Repo", url: "invalid" },
  ])("keeps an unavailable or different repository external: %j", (repo) => {
    expect(matchesPullRequestRepository(link, repo)).toBe(false);
  });

  test("recognizes PR roots with a trailing slash or query", () => {
    const href = "https://github.com/owner/repo.name/pull/42/?source=reply";
    expect(parsePullRequestLink(href)).toEqual({ repository: "owner/repo.name", number: 42, href });
  });

  test.each([
    "https://github.com/owner/repo/pull/42/files",
    "https://github.com/owner/repo/pull/42#discussion_r123",
    "https://github.com/owner/repo/issues/42",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/pull/9007199254740992",
    "https://github.com.example.org/owner/repo/pull/42",
    "https://github.com:444/owner/repo/pull/42",
    "https://someone@github.com/owner/repo/pull/42",
    "http://github.com/owner/repo/pull/42",
    "/owner/repo/pull/42",
    "not a URL",
  ])("leaves specific destinations and unsupported URLs external: %s", (href) => {
    expect(parsePullRequestLink(href)).toBeNull();
  });
});
