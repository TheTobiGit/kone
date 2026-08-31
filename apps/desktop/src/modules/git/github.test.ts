import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyGhError } from "./ghError.js";

// github.ts imports electron's shell at module top (used only on PR-link
// clicks); stand in for it before the module loads.
mock.module("electron", () => ({ shell: { openExternal: () => {} } }));

// SAFETY: the dynamically imported module is exactly ./github's own exports.
const { commitAuthors, contributors, me, prDetail, prs, repo, status } = (await import(
  "./github.js"
)) as typeof import("./github.js");

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

afterEach(() => {
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

  test("empty stdout returns empty list", async () => {
    installFakeGhRaw("");
    expect(await prs(process.cwd())).toEqual([]);
  });

  test("throws GitError on non-array responses", async () => {
    installFakeGh(`{ message: "Not Found" }`);
    await expect(prs(process.cwd())).rejects.toThrow("The GitHub CLI returned unexpected pull request data.");
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
