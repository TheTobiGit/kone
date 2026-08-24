import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { repoState } from "./state.js";
import { status } from "@kone/git-core/status.js";

/** A repo mid-merge, with `name` conflicted on both sides. */
async function makeConflict(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-state-"));
  const g = (args: string[]) => git(dir, args);
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@kone.app"]);
  await g(["config", "user.name", "Kone Test"]);
  // Quoting on is git's default; set it explicitly so this still proves
  // something on a machine whose global config turned it off.
  await g(["config", "core.quotePath", "true"]);
  await writeFile(path.join(dir, name), "base\n");
  await g(["add", "-A"]);
  await g(["commit", "-m", "base"]);

  await g(["checkout", "-b", "other"]);
  await writeFile(path.join(dir, name), "theirs\n");
  await g(["commit", "-am", "theirs"]);

  await g(["checkout", "main"]);
  await writeFile(path.join(dir, name), "ours\n");
  await g(["commit", "-am", "ours"]);

  // Conflicts, so git exits non-zero — the failure is the setup working.
  await g(["merge", "other"]).catch(() => {});
  return dir;
}

describe("repoState conflicts", () => {
  test("names a conflicted file exactly as the change list does", async () => {
    // The conflict paths are only ever tested for membership against the paths
    // status() reports. Unless both come from -z output, git hands back
    // `"caf\303\251.txt"` here and the conflicted row silently loses its
    // marking while still counting toward the total.
    const name = "café.txt";
    const dir = await makeConflict(name);

    const state = await repoState(dir);
    expect(state?.operation).toBe("merging");
    expect(state?.conflicts).toEqual([name]);

    // The membership test the UI actually performs.
    const conflicted = new Set(state!.conflicts);
    const change = (await status(dir))!.changes.find((c) => c.path === name);
    expect(change?.status).toBe("conflicted");
    expect(conflicted.has(change!.path)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("keeps a filename's leading and trailing spaces", async () => {
    // Legal in a filename, and trimming them would break the same lookup.
    const name = " padded name .txt";
    const dir = await makeConflict(name);

    const state = await repoState(dir);
    expect(state?.conflicts).toEqual([name]);

    await rm(dir, { recursive: true, force: true });
  });

  test("reports no conflicts on a clean repo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-state-"));
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "test@kone.app"]);
    await git(dir, ["config", "user.name", "Kone Test"]);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "one"]);

    const state = await repoState(dir);
    expect(state?.operation).toBe("none");
    expect(state?.conflicts).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});
