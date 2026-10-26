import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { initTestRepo } from "@kone/git-core/testRepo.js";
import { git } from "@kone/git-core/core.js";
import type { GitHubMergeMethod, GitHubPullRequestSection } from "@kone/git-core/types.js";

import { classifyGhError } from "./ghError.js";

// github.ts imports electron's shell at module top (used only on PR-link
// clicks); stand in for it before the module loads.
mock.module("electron", () => ({ shell: { openExternal: () => {} } }));

// SAFETY: the dynamically imported module is exactly ./github's own exports.
const {
  branchPullRequest,
  canTriageWith,
  commitAuthors,
  contributors,
  issueActionArgs,
  issueDetail,
  issues,
  me,
  mergeSettingsOf,
  prActionArgs,
  prDetail,
  prs,
  repo,
  status,
} =
  (await import("./github.js")) as typeof import("./github.js");

describe("branchPullRequest outcome", () => {
  test("a repo with no GitHub remote reports the lookup unavailable, not no-PR", async () => {
    const dir = await initTestRepo("kone-gh-branch-");
    try {
      const outcome = await branchPullRequest(dir, "feature");
      // gh is missing, unauthenticated, or has no remote here — all of which are
      // "unknown", never "there is no PR".
      expect(outcome.available).toBe(false);
      expect(outcome.pullRequest).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed repository resolution is unavailable, not a known-empty PR list", async () => {
    const dir = await initTestRepo("kone-gh-branch-");
    try {
      // A remote gh cannot resolve: `gh pr list` fails with NOT_FOUND, which
      // also covers a removed/inaccessible repository — never "no PR".
      await git(dir, [
        "remote",
        "add",
        "origin",
        "https://github.com/kone-nonexistent-org-xyz/nonexistent-repo-xyz.git",
      ]);
      const outcome = await branchPullRequest(dir, "feature");
      expect(outcome.available).toBe(false);
      expect(outcome.pullRequest).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyGhError", () => {
  test("maps gh auth failures to NOT_AUTHENTICATED", () => {
    expect(classifyGhError("gh: To get started with GitHub CLI, please run:  gh auth login")).toBe(
      "NOT_AUTHENTICATED",
    );
    expect(classifyGhError("HTTP 401: Bad credentials")).toBe("NOT_AUTHENTICATED");
    expect(classifyGhError("not logged in to any servers")).toBe("NOT_AUTHENTICATED");
    expect(classifyGhError("HTTP 403: forbidden")).toBe("NOT_AUTHENTICATED");
  });

  test("maps missing-remote failures to NO_GITHUB_REMOTE", () => {
    expect(classifyGhError("gh: no git remotes found")).toBe("NO_GITHUB_REMOTE");
    expect(classifyGhError("the 'origin' remote do not point to a known GitHub host")).toBe(
      "NO_GITHUB_REMOTE",
    );
    expect(classifyGhError("could not determine the default repository to query")).toBe(
      "NO_GITHUB_REMOTE",
    );
  });

  test("maps missing-PR failures to NOT_FOUND", () => {
    expect(classifyGhError("could not resolve to a pull request with the number '999'")).toBe(
      "NOT_FOUND",
    );
    expect(classifyGhError("no pull requests found")).toBe("NOT_FOUND");
    expect(classifyGhError("could not resolve to a repository with the name 'foo/bar'")).toBe(
      "NOT_FOUND",
    );
  });

  test("maps connection failures to NETWORK", () => {
    expect(classifyGhError("gh: could not resolve host api.github.com")).toBe("NETWORK");
    expect(classifyGhError("dial tcp: connect: connection refused")).toBe("NETWORK");
    expect(classifyGhError("connection reset by peer")).toBe("NETWORK");
    expect(classifyGhError("connection timed out")).toBe("NETWORK");
    expect(classifyGhError("network is unreachable")).toBe("NETWORK");
    expect(classifyGhError("Temporary failure in name resolution")).toBe("NETWORK");
    expect(classifyGhError("operation timed out")).toBe("NETWORK");
    expect(classifyGhError("early EOF")).toBe("NETWORK");
    expect(classifyGhError("failed to connect to github.com port 443")).toBe("NETWORK");
  });

  test("returns null for unrecognized stderr lines", () => {
    expect(classifyGhError("Some unrelated stderr line")).toBeNull();
    expect(classifyGhError("gh: fork must be created first")).toBeNull();
    expect(classifyGhError("")).toBeNull();
  });
});

// The JSON-record parsing behind every gh surface, exercised through `me()`
// with a fake `gh` on PATH — the same trick clone.test.ts plays on `git`.
const savedPath = process.env.PATH;
const tempDirs: string[] = [];
let restoreFetch: () => void;

beforeEach(() => {
  // These tests exercise CLI record parsing. Avatar requests must also be
  // deterministic: an offline fetch lasts as long as the test's timeout.
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  restoreFetch = () => fetchSpy.mockRestore();
});

afterEach(() => {
  restoreFetch();
  if (savedPath !== undefined) process.env.PATH = savedPath;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** Put a fake `gh` first on PATH; it answers every invocation with `stdout`. */
function installFakeGh(stdout: string): void {
  const bin = mkdtempSync(path.join(os.tmpdir(), "kone-gh-bin-"));
  tempDirs.push(bin);
  const ghPath = path.join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${stdout}));\n`);
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

/** Put a fake `gh` first on PATH; outputs raw string verbatim without JSON.stringify wrapping. */
function installFakeGhRaw(rawStdout: string): void {
  const bin = mkdtempSync(path.join(os.tmpdir(), "kone-gh-bin-"));
  tempDirs.push(bin);
  const ghPath = path.join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(rawStdout)});\n`);
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

describe("status (record parsing)", () => {
  test("handles empty stdout and corrupt JSON without crashing", async () => {
    installFakeGhRaw("");
    expect(await status()).toMatchObject({ installed: true, authenticated: false, user: null });

    installFakeGhRaw("corrupted { json");
    expect(await status()).toMatchObject({ installed: true, authenticated: false, user: null });
  });

  test("parses active user from hosts payload", async () => {
    installFakeGh(`{
      hosts: {
        "github.com": [
          { state: "success", active: true, login: "octocat" }
        ]
      }
    }`);
    expect(await status()).toMatchObject({ installed: true, authenticated: true, user: "octocat" });
  });
});

describe("me (record parsing)", () => {
  test("maps a gh user record onto the flat shape", async () => {
    installFakeGh(`{ login: "octo", name: "Octo Cat", bio: null }`);
    expect(await me()).toMatchObject({ login: "octo", name: "Octo Cat" });
  });

  test("a non-object answer reads as no user, never a crash", async () => {
    installFakeGh(`[1, 2]`);
    expect(await me()).toBeNull();
  });

  test("a record without a login reads as no user", async () => {
    installFakeGh(`{ name: "Ghost" }`);
    expect(await me()).toBeNull();
  });

  test("empty or corrupt stdout reads as null, never throws", async () => {
    installFakeGhRaw("");
    expect(await me()).toBeNull();

    installFakeGhRaw("{ corrupt json");
    expect(await me()).toBeNull();
  });
});

describe("repo (record parsing)", () => {
  test("maps stargazerCount and forkCount to stars and forks", async () => {
    installFakeGh(`{
      nameWithOwner: "owner/repo",
      stargazerCount: 42,
      forkCount: 7,
      licenseInfo: { name: "MIT License", nickname: "MIT" },
      primaryLanguage: { name: "TypeScript" },
      repositoryTopics: [{ name: "git" }, { name: "electron" }],
      visibility: "PUBLIC",
      isFork: false,
      defaultBranchRef: { name: "main" },
      url: "https://github.com/owner/repo"
    }`);
    const res = await repo(process.cwd());
    expect(res).toMatchObject({
      nameWithOwner: "owner/repo",
      stars: 42,
      forks: 7,
      license: "MIT",
      language: "TypeScript",
      topics: ["git", "electron"],
      visibility: "public",
    });
  });

  test("empty stdout reads as null", async () => {
    installFakeGhRaw("");
    expect(await repo(process.cwd())).toBeNull();
  });
});

describe("prs (record parsing)", () => {
  test("maps headRefName and baseRefName to branch and base", async () => {
    installFakeGh(`[{
      number: 101,
      title: "Add feature",
      state: "OPEN",
      isDraft: false,
      author: { login: "alice" },
      headRefName: "feature-branch",
      baseRefName: "main",
      url: "https://github.com/owner/repo/pull/101",
      createdAt: "2026-08-24T10:00:00Z",
      additions: 15,
      deletions: 3,
      statusCheckRollup: [],
      reviewDecision: "APPROVED",
      comments: 2
    }]`);
    const list = await prs(process.cwd());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      number: 101,
      title: "Add feature",
      branch: "feature-branch",
      base: "main",
      author: "alice",
      state: "open",
      reviewDecision: "approved",
    });
  });

  test("folds reviews, requests, checks and mergeability into the row", async () => {
    installFakeGh(`[{
      number: 102,
      title: "Review me",
      state: "OPEN",
      author: { login: "alice", name: "Alice" },
      updatedAt: "2026-08-25T10:00:00Z",
      changedFiles: 4,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      labels: [{ name: "bug", color: "D73A4A" }],
      latestReviews: [
        { author: { login: "bob" }, state: "APPROVED", commit: { oid: "abc" } },
        { author: { login: "bob" }, state: "COMMENTED" },
        { author: { login: "dave" }, state: "CHANGES_REQUESTED" }
      ],
      reviewRequests: [{ login: "bob" }, { login: "carol" }],
      statusCheckRollup: [
        { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "e2e", status: "IN_PROGRESS", conclusion: "" },
        { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" }
      ]
    }]`);
    const [pr] = await prs(process.cwd());
    expect(pr).toMatchObject({
      author: "alice",
      authorPerson: { login: "alice", name: "Alice" },
      updatedAt: "2026-08-25T10:00:00Z",
      changedFiles: 4,
      mergeability: "conflicting",
      labels: [{ name: "bug", color: "d73a4a" }],
      checks: "failing",
      checkCounts: { passing: 1, failing: 1, pending: 1, skipped: 1 },
    });
    // One entry per person. Bob approved but was asked to look again, so the
    // open request wins; Dave's verdict stands because nobody re-asked him.
    expect(pr?.reviewers.map((r) => [r.person.login, r.state])).toEqual([
      ["bob", "pending"],
      ["dave", "changes-requested"],
      ["carol", "pending"],
    ]);
  });

  test("empty stdout returns empty list", async () => {
    installFakeGhRaw("");
    expect(await prs(process.cwd())).toEqual([]);
  });

  test("throws GitError on non-array responses", async () => {
    installFakeGh(`{ message: "Not Found" }`);
    await expect(prs(process.cwd())).rejects.toThrow("The GitHub CLI returned unexpected pull request data.");
  });
});

/** Record every CLI invocation while controlling individual command failures. */
function installSectionGh(failure?: "checks" | "merge-settings"): string {
  const bin = mkdtempSync(path.join(os.tmpdir(), "kone-gh-sections-"));
  tempDirs.push(bin);
  const calls = path.join(bin, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "repo") {
  if (${JSON.stringify(failure)} === "merge-settings") {
    process.stderr.write("connection reset by peer"); process.exit(1);
  }
  process.stdout.write(JSON.stringify({ viewerPermission: "READ", squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false }));
} else {
  const fields = args[args.indexOf("--json") + 1].split(",");
  if (${JSON.stringify(failure)} === "checks" && fields.includes("statusCheckRollup")) {
    process.stderr.write("connection reset by peer"); process.exit(1);
  }
  const full = {
    number: 42, title: "Independent regions", author: {login: "alice"}, isDraft: false,
    state: "OPEN", additions: 12, deletions: 2, changedFiles: 1,
    files: [{path: "main.ts", additions: 12, deletions: 2}],
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    comments: [{body: "Loaded activity", author: {login: "bob"}}],
    statusCheckRollup: [{__typename: "StatusContext", context: "test", state: "SUCCESS"}]
  };
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map(field => [field, full[field]]))));
}
`;
  const executable = path.join(bin, "gh");
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  return calls;
}

function recordedCalls(file: string): string[][] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("prDetail (independent regions)", () => {
  const expectedFields = {
    summary: ["number", "title", "body", "url", "author", "state", "isDraft", "headRefName", "headRepositoryOwner", "baseRefName", "labels", "assignees", "milestone", "createdAt", "updatedAt", "mergedAt", "closedAt", "mergedBy", "headRefOid"],
    conversation: ["number", "reviewRequests", "latestReviews", "comments", "commits"],
    checks: ["number", "statusCheckRollup"],
    files: ["number", "additions", "deletions", "changedFiles", "files"],
    merge: ["number", "isDraft", "mergeable", "mergeStateStatus", "reviewDecision"],
  } satisfies Record<GitHubPullRequestSection, string[]>;

  for (const section of Object.keys(expectedFields)) {
    // SAFETY: this key is read directly from the complete section-to-fields record.
    const region = section as GitHubPullRequestSection;
    test(`${region} requests only its fields and avoids decorative avatar fetches`, async () => {
      const calls = installSectionGh();
      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        const detail = await prDetail(process.cwd(), 42, region);
        expect(detail?.number).toBe(42);
        const invocations = recordedCalls(calls);
        const prCall = invocations.find((args) => args[0] === "pr");
        expect(prCall?.at(-1)?.split(",")).toEqual(expectedFields[region]);
        expect(invocations.filter((args) => args[0] === "repo")).toHaveLength(region === "merge" ? 1 : 0);
        expect(fetchSpy).not.toHaveBeenCalled();
        if (region === "summary") {
          expect(detail?.title).toBe("Independent regions");
          expect(detail?.files).toEqual([]);
          expect(detail?.comments).toEqual([]);
          expect(detail?.checkRuns).toEqual([]);
        }
        if (region === "merge") {
          expect(detail).toMatchObject({ canWrite: false, canTriage: false, mergeMethods: ["squash"] });
        }
      } finally {
        fetchSpy.mockRestore();
      }
    });
  }

  test("malformed permissions cannot mark the merge region ready", async () => {
    installFakeGh("{ number: 42 }");
    await expect(prDetail(process.cwd(), 42, "merge")).rejects.toThrow("unparseable repository data");
  });

  test("a failed checks read does not prevent other regions from loading", async () => {
    installSectionGh("checks");
    await expect(prDetail(process.cwd(), 42, "checks")).rejects.toThrow();
    expect(await prDetail(process.cwd(), 42, "summary")).toMatchObject({ title: "Independent regions" });
    expect((await prDetail(process.cwd(), 42, "conversation"))?.comments[0]?.body).toBe("Loaded activity");
  });

  test("section permission failures surface while full reads retain the fallback", async () => {
    installSectionGh("merge-settings");
    await expect(prDetail(process.cwd(), 42, "merge")).rejects.toThrow();
    expect(await prDetail(process.cwd(), 42)).toMatchObject({ canWrite: true, mergeMethods: ["merge", "squash", "rebase"] });
  });
});

describe("prDetail (record parsing)", () => {
  test("maps milestone title and handles nullable isMinimized comments", async () => {
    installFakeGh(`{
      number: 42,
      title: "Fix bug",
      body: "Details",
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      headRefName: "fix",
      baseRefName: "main",
      author: { login: "bob", name: "Bob" },
      milestone: { title: "v1.0.0" },
      comments: [
        { author: { login: "charlie" }, body: "Looks good", isMinimized: null },
        { author: { login: "spammer" }, body: "Spam", isMinimized: true }
      ],
      latestReviews: [],
      statusCheckRollup: [],
      commits: [],
      files: [],
      labels: [],
      assignees: [],
      reviewRequests: [],
      createdAt: "2026-08-24T10:00:00Z"
    }`);
    const detail = await prDetail(process.cwd(), 42);
    expect(detail).not.toBeNull();
    expect(detail?.milestone).toBe("v1.0.0");
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.comments[0]).toMatchObject({
      author: { login: "charlie" },
      body: "Looks good",
    });
  });

  test("takes the head from GitHub and keeps re-requested reviewers waiting", async () => {
    installFakeGh(`{
      number: 7,
      title: "Tie",
      state: "OPEN",
      headRefName: "tie",
      headRefOid: "tip",
      baseRefName: "main",
      latestReviews: [
        { author: { login: "bob" }, state: "APPROVED", submittedAt: "2026-08-24T11:00:00Z", commit: { oid: "tip" } }
      ],
      reviewRequests: [{ login: "bob" }],
      // Same second on both: dates can't tell which one is the head.
      commits: [
        { oid: "parent", messageHeadline: "a", committedDate: "2026-08-24T10:00:00Z", authors: [] },
        { oid: "tip", messageHeadline: "b", committedDate: "2026-08-24T10:00:00Z", authors: [] }
      ],
      createdAt: "2026-08-24T09:00:00Z"
    }`);
    const detail = await prDetail(process.cwd(), 7);
    expect(detail?.headOid).toBe("tip");
    // The approval stays on record, and the open request follows it.
    expect(detail?.reviews.map((r) => [r.author?.login, r.state])).toEqual([
      ["bob", "approved"],
      ["bob", "pending"],
    ]);
  });

  test("empty stdout reads as null", async () => {
    installFakeGhRaw("");
    expect(await prDetail(process.cwd(), 42)).toBeNull();
  });
});

describe("contributors & commitAuthors (tolerant decoding)", () => {
  test("contributors tolerates malformed rows and filters non-users", async () => {
    installFakeGh(`[
      { login: "alice", type: "User", contributions: 50, avatar_url: "" },
      null,
      "invalid-entry",
      { login: "dependabot[bot]", type: "Bot", contributions: 100 }
    ]`);
    const res = await contributors(process.cwd());
    expect(res).not.toBeNull();
    expect(res?.people).toHaveLength(1);
    expect(res?.people[0].login).toBe("alice");
  });

  test("contributors returns null on empty stdout", async () => {
    installFakeGhRaw("");
    expect(await contributors(process.cwd())).toBeNull();
  });

  test("commitAuthors tolerates malformed rows", async () => {
    installFakeGh(`[
      { commit: { author: { email: "alice@example.com", name: "Alice" } }, author: { login: "alice", avatar_url: "" } },
      null,
      { bad: "row" }
    ]`);
    const res = await commitAuthors(process.cwd());
    expect(res).not.toBeNull();
    expect(res?.["alice@example.com"]).toMatchObject({
      login: "alice",
      name: "Alice",
    });
  });

  test("commitAuthors returns null on empty stdout", async () => {
    installFakeGhRaw("");
    expect(await commitAuthors(process.cwd())).toBeNull();
  });
});

describe("pull request actions", () => {
  test("each action maps to its gh command", () => {
    expect(prActionArgs(7, "merge", "squash")).toEqual(["pr", "merge", "7", "--squash"]);
    expect(prActionArgs(7, "merge")).toEqual(["pr", "merge", "7", "--merge"]);
    expect(prActionArgs(7, "ready")).toEqual(["pr", "ready", "7"]);
    expect(prActionArgs(7, "draft")).toEqual(["pr", "ready", "7", "--undo"]);
    expect(prActionArgs(7, "close")).toEqual(["pr", "close", "7"]);
    expect(prActionArgs(7, "reopen")).toEqual(["pr", "reopen", "7"]);
    const oid = "a".repeat(40);
    expect(prActionArgs(7, "merge", "rebase", oid)).toEqual(["pr", "merge", "7", "--rebase", "--match-head-commit", oid]);
  });

  test("a bad number is refused before gh runs", () => {
    expect(() => prActionArgs(0, "close")).toThrow();
    expect(() => prActionArgs(1.5, "merge")).toThrow();
    expect(() => prActionArgs(7, "merge", "merge", "--admin")).toThrow();
    // SAFETY: a value only IPC could deliver, which the type rules out.
    expect(() => prActionArgs(7, "merge", "admin" as GitHubMergeMethod)).toThrow();
  });

  test("merge settings keep only allowed methods and read write access", () => {
    expect(
      mergeSettingsOf({
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        viewerPermission: "WRITE",
      }),
    ).toEqual({ mergeMethods: ["squash"], canWrite: true, canTriage: true });
    expect(
      mergeSettingsOf({
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        viewerPermission: "READ",
      }).canWrite,
    ).toBe(false);
    // A repository reporting no method at all is a misread, not a ban on merging.
    expect(
      mergeSettingsOf({
        mergeCommitAllowed: false,
        squashMergeAllowed: false,
        rebaseMergeAllowed: false,
        viewerPermission: "",
      }),
    ).toEqual({ mergeMethods: ["merge", "squash", "rebase"], canWrite: true, canTriage: true });
    // Triage can close and reopen, but not merge.
    expect(
      mergeSettingsOf({
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        viewerPermission: "TRIAGE",
      }),
    ).toMatchObject({ canWrite: false, canTriage: true });
  });
});

describe("issues", () => {
  test("close and reopen map to gh, with the reason spelled as gh wants it", () => {
    expect(issueActionArgs(12, "close")).toEqual(["issue", "close", "12", "--reason", "completed"]);
    expect(issueActionArgs(12, "close", "not-planned")).toEqual(["issue", "close", "12", "--reason", "not planned"]);
    expect(issueActionArgs(12, "reopen")).toEqual(["issue", "reopen", "12"]);
    expect(() => issueActionArgs(-1, "reopen")).toThrow();
  });

  test("read access can't triage; anything else, or an unknown answer, can", () => {
    expect(canTriageWith("READ")).toBe(false);
    expect(canTriageWith("TRIAGE")).toBe(true);
    expect(canTriageWith("WRITE")).toBe(true);
    expect(canTriageWith("")).toBe(true);
  });

  test("a list row keeps its people, labels, comment count and close reason", async () => {
    installFakeGh(`[{
      number: 31,
      title: "Crash on start",
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
      author: { login: "alice", name: "Alice" },
      assignees: [{ login: "bob" }, { login: "" }],
      labels: [{ name: "bug", color: "#D73A4A" }],
      comments: [{}, {}, {}],
      milestone: { title: "v1" },
      createdAt: "2026-08-20T10:00:00Z",
      closedAt: "2026-08-21T10:00:00Z"
    }, { title: "no number" }]`);
    const list = await issues(process.cwd(), { state: "all" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      number: 31,
      state: "closed",
      stateReason: "not-planned",
      author: { login: "alice", name: "Alice" },
      assignees: [{ login: "bob" }],
      labels: [{ name: "bug", color: "d73a4a" }],
      commentCount: 3,
      milestone: "v1",
      isPinned: false,
    });
  });

  test("an open issue drops a leftover reason; the detail keeps visible comments only", async () => {
    installFakeGh(`{
      number: 32,
      title: "Reopened",
      state: "OPEN",
      stateReason: "REOPENED",
      body: "Steps to reproduce",
      comments: [
        { author: { login: "carol" }, body: "Same here", createdAt: "2026-08-22T10:00:00Z", url: "u1" },
        { author: { login: "spam" }, body: "buy now", createdAt: "2026-08-22T11:00:00Z", url: "u2", isMinimized: true }
      ]
    }`);
    const detail = await issueDetail(process.cwd(), 32);
    expect(detail).toMatchObject({ state: "open", stateReason: null, body: "Steps to reproduce", commentCount: 1 });
    expect(detail?.comments.map((c) => c.author?.login)).toEqual(["carol"]);
  });
});
