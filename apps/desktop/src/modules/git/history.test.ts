import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { branches, commitDetail } from "./history.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-history-");
  const g = (args: string[]) => git(dir, args);
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

describe("commitDetail files", () => {
  test("pairs statuses with line counts across awkward paths", async () => {
    // The per-file rows merge two commands: --name-status for the letter and
    // --numstat for the counts, matched by path. Both are read from -z output so
    // that a path git would otherwise quote still lines up between them.
    const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-detail-"));
    const g = (args: string[]) => git(dir, args);
    await g(["init", "-b", "main"]);
    await g(["config", "user.email", "test@kone.app"]);
    await g(["config", "user.name", "Kone Test"]);
    await g(["config", "core.quotePath", "true"]);
    await writeFile(path.join(dir, "café.txt"), "one\ntwo\nthree\nfour\n");
    await writeFile(path.join(dir, "gone.txt"), "x\n");
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    await g(["add", "-A"]);
    await g(["commit", "-m", "one"]);

    await writeFile(path.join(dir, "café.txt"), "one\ntwo\nthree\nfour\nfive\n");
    await g(["rm", "-q", "gone.txt"]);
    await writeFile(path.join(dir, "added ünicode.txt"), "a\nb\n");
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 9, 9, 9, 0]));
    await g(["add", "-A"]);
    await g(["commit", "-m", "two"]);

    const detail = await commitDetail(dir, "HEAD");
    const byPath = new Map(detail!.files.map((f) => [f.path, f]));

    expect(byPath.get("café.txt")).toEqual({
      path: "café.txt",
      status: "modified",
      added: 1,
      removed: 0,
      binary: false,
    });
    expect(byPath.get("added ünicode.txt")?.status).toBe("added");
    expect(byPath.get("added ünicode.txt")?.added).toBe(2);
    expect(byPath.get("gone.txt")?.status).toBe("deleted");
    expect(byPath.get("gone.txt")?.removed).toBe(1);
    // A binary file contributes no lines rather than a NaN to the total.
    expect(byPath.get("bin.dat")?.binary).toBe(true);
    expect(byPath.get("bin.dat")?.added).toBe(0);
    expect(Number.isNaN(detail!.added)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("reports a rename with the path it came from", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-detail-"));
    const g = (args: string[]) => git(dir, args);
    await g(["init", "-b", "main"]);
    await g(["config", "user.email", "test@kone.app"]);
    await g(["config", "user.name", "Kone Test"]);
    await g(["config", "core.quotePath", "true"]);
    await writeFile(path.join(dir, "café old.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    await g(["add", "-A"]);
    await g(["commit", "-m", "one"]);

    await g(["mv", "café old.txt", "renamed ünicode.txt"]);
    await g(["commit", "-m", "two"]);

    const detail = await commitDetail(dir, "HEAD");
    expect(detail!.files).toEqual([
      {
        path: "renamed ünicode.txt",
        from: "café old.txt",
        status: "renamed",
        added: 0,
        removed: 0,
        binary: false,
      },
    ]);

    await rm(dir, { recursive: true, force: true });
  });
});
