import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "./core.js";
import { branches } from "./history.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-history-"));
  const g = (args: string[]) => git(dir, args);
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@kone.app"]);
  await g(["config", "user.name", "Kone Test"]);
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await g(["add", "-A"]);
  await g(["commit", "-m", "one"]);

  // A remote so `main` gains an upstream and an origin/main tracking ref exists.
  const bare = await mkdtemp(path.join(os.tmpdir(), "kone-git-bare-"));
  await git(bare, ["init", "--bare"]);
  await g(["remote", "add", "origin", bare]);
  await g(["push", "-u", "origin", "main"]);

  // A local-only branch with a slash in its name (no upstream), and a plain one.
  await g(["checkout", "-b", "feature/login"]);
  await g(["checkout", "main"]);
  await g(["branch", "local-plain"]);

  return dir;
}

describe("branches", () => {
  test("marks a local branch with a slash as local, not remote", async () => {
    const dir = await makeRepo();
    const all = await branches(dir);
    const byName = new Map(all.map((b) => [b.name, b]));

    // `remote` means "a remote-tracking ref (under refs/remotes)". A local
    // branch named feature/login has a slash but lives under refs/heads —
    // it must not be filtered out of the local-branch switcher.
    expect(byName.get("feature/login")?.remote).toBe(false);
    expect(byName.get("local-plain")?.remote).toBe(false);
    expect(byName.get("main")?.remote).toBe(false);

    // The genuine remote-tracking ref is still marked remote.
    expect(byName.get("origin/main")?.remote).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
