import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, GitError } from "@kone/git-core/core.js";
import { classifyNetworkError, fetch, isAuthFailure, rewordNetworkError } from "./sync.js";
import { remoteExists } from "./state.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-sync-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@kone.app"]);
  await git(dir, ["config", "user.name", "Kone Test"]);
  await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "one"]);
  return dir;
}

describe("fetch", () => {
  test("skips a repo with no remotes instead of failing", async () => {
    const dir = await makeRepo();
    expect(await remoteExists(dir, "origin")).toBe(false);
    // A repo without an origin has nothing to fetch — the guard turns the
    // doomed `git fetch origin` into a clean no-op, never an error.
    await expect(fetch(dir)).resolves.toBeUndefined();
    await expect(fetch(dir, "origin")).resolves.toBeUndefined();
  });

  test("fetches from an existing origin", async () => {
    const dir = await makeRepo();
    const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
    await git(bare, ["init", "--bare"]);
    await git(dir, ["remote", "add", "origin", bare]);
    await git(dir, ["push", "-u", "origin", "main"]);
    // Drop the remote-tracking ref so the fetch has real work to do.
    await git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);

    expect(await remoteExists(dir, "origin")).toBe(true);
    await expect(fetch(dir)).resolves.toBeUndefined();
    // The pruned fetch restored the remote-tracking ref.
    const refs = (await git(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])).trim();
    expect(refs).toContain("refs/remotes/origin/main");
  });
});

describe("isAuthFailure", () => {
  test("classifies credential errors", () => {
    expect(isAuthFailure("fatal: Authentication failed for 'https://github.com/owner/repo.git/'")).toBe(true);
    expect(isAuthFailure("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(
      isAuthFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe(true);
    expect(
      isAuthFailure("fatal: unable to access 'https://github.com/x': The requested URL returned error: 403"),
    ).toBe(true);
  });

  test("does not classify non-credential errors", () => {
    expect(isAuthFailure("fatal: couldn't find remote ref main")).toBe(false);
    expect(isAuthFailure("CONFLICT (content): Merge conflict in a.txt")).toBe(false);
    expect(
      isAuthFailure("fatal: unable to access 'https://github.com/x': Could not resolve host: github.com"),
    ).toBe(false);
    expect(isAuthFailure("fatal: The current branch main has no upstream branch.")).toBe(false);
  });
});

describe("classifyNetworkError", () => {
  test("classifies credential errors as AUTH_FAILURE", () => {
    expect(
      classifyNetworkError("fatal: Authentication failed for 'https://github.com/owner/repo.git/'"),
    ).toBe("AUTH_FAILURE");
    expect(classifyNetworkError("git@github.com: Permission denied (publickey).")).toBe(
      "AUTH_FAILURE",
    );
  });

  test("classifies transport/offline errors as NETWORK", () => {
    expect(
      classifyNetworkError("fatal: unable to access 'https://github.com/x': Could not resolve host: github.com"),
    ).toBe("NETWORK");
    expect(classifyNetworkError("fatal: could not read from remote repository.")).toBe("NETWORK");
    expect(classifyNetworkError("fatal: Connection reset by peer")).toBe("NETWORK");
  });

  test("leaves non-network, non-auth errors unclassified", () => {
    expect(classifyNetworkError("CONFLICT (content): Merge conflict in a.txt")).toBeNull();
    expect(classifyNetworkError("fatal: couldn't find remote ref main")).toBeNull();
  });
});

describe("rewordNetworkError", () => {
  test("rewrites an auth GitError with an AUTH_FAILURE kind", () => {
    const err = new GitError(
      "fatal: Authentication failed for 'https://github.com/owner/repo.git/'",
      128,
    );
    const out = rewordNetworkError(err, "origin");
    expect(out).toBeInstanceOf(GitError);
    expect(out.kind).toBe("AUTH_FAILURE");
    expect(out.message).toBe(
      "[kone:AUTH_FAILURE] Authentication failed while talking to origin — check your git credentials.",
    );
  });

  test("rewrites a network GitError with a NETWORK kind", () => {
    const err = new GitError(
      "fatal: unable to access 'https://github.com/x': Could not resolve host: github.com",
      128,
    );
    const out = rewordNetworkError(err, "origin");
    expect(out).toBeInstanceOf(GitError);
    expect(out.kind).toBe("NETWORK");
    expect(out.message).toBe("[kone:NETWORK] Can't reach origin — check your connection.");
  });

  test("passes an unclassified GitError through unchanged", () => {
    const err = new GitError("CONFLICT (content): Merge conflict in a.txt", 1);
    const out = rewordNetworkError(err, "origin");
    expect(out).toBe(err);
    expect(out.kind).toBeNull();
    expect(out.message).toBe("CONFLICT (content): Merge conflict in a.txt");
  });

  test("rewraps a non-GitError without a kind", () => {
    const out = rewordNetworkError(new Error("boom"), "origin");
    expect(out).toBeInstanceOf(GitError);
    expect(out.kind).toBeNull();
    expect(out.message).toBe("boom");

    const outRaw = rewordNetworkError("not an error", "origin");
    expect(outRaw).toBeInstanceOf(GitError);
    expect(outRaw.kind).toBeNull();
    expect(outRaw.message).toBe("git failed.");
  });
});
