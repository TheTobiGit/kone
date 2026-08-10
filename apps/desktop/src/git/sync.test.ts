import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "./core.js";
import { fetch } from "./sync.js";
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
