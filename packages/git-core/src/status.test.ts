import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { git } from "./core.js";
import { status } from "./status.js";
import { initTestRepo } from "./testRepo.js";

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-status-");
  const g = (args: string[]) => git(dir, args);
  // Quoting on is git's default; set it explicitly so this still proves
  // something on a machine whose global config turned it off.
  await g(["config", "core.quotePath", "true"]);
  return dir;
}

describe("status line counts", () => {
  test("counts lines for paths git would otherwise quote", async () => {
    // The line counts come from `git diff --numstat` and are looked up by the
    // path `git status --porcelain=v2 -z` reported. Unless both are read from -z
    // output, git quotes and escapes these three and every one reads as +0/−0.
    const dir = await makeRepo();
    const names = [
      "café.txt",
      "plain name with space.txt",
      'quote"and\\backslash.txt',
      "tab\there.txt",
      "new\nline.txt",
    ];
    for (const name of names) {
      await writeFile(path.join(dir, name), "one\ntwo\n");
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "one"]);

    // Two lines added, one removed, in every file.
    for (const name of names) {
      await writeFile(path.join(dir, name), "one\nthree\nfour\nfive\n");
    }

    const result = await status(dir);
    const byPath = new Map(result!.changes.map((c) => [c.path, c]));
    expect(byPath.size).toBe(names.length);
    for (const name of names) {
      const change = byPath.get(name);
      expect(change?.status).toBe("modified");
      expect(change?.added).toBe(3);
      expect(change?.removed).toBe(1);
    }

    await rm(dir, { recursive: true, force: true });
  });

  test("counts a staged edit as well as an unstaged one", async () => {
    // The diff is taken against HEAD precisely so staged work still counts.
    const dir = await makeRepo();
    await writeFile(path.join(dir, "café.txt"), "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "one"]);
    await writeFile(path.join(dir, "café.txt"), "one\ntwo\n");
    await git(dir, ["add", "-A"]);

    const change = (await status(dir))!.changes[0];
    expect(change?.path).toBe("café.txt");
    expect(change?.staged).toBe(true);
    expect(change?.added).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("counts an untracked file's whole contents", async () => {
    // Baseline coverage for the other half of the count, not for the quoting
    // fix: an untracked file has nothing to diff against, so it never goes
    // through numstat at all — its lines are counted by opening the file, which
    // works only because the path came out of `-z` output and is therefore a
    // usable filename rather than git's escaped rendering of one.
    const dir = await makeRepo();
    await writeFile(path.join(dir, "seed.txt"), "x\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "one"]);
    await writeFile(path.join(dir, "café new.txt"), "a\nb\nc\n");

    const change = (await status(dir))!.changes.find(
      (c) => c.path === "café new.txt",
    );
    expect(change?.status).toBe("untracked");
    expect(change?.added).toBe(3);
    expect(change?.removed).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("reports a binary file as 0/0, never NaN", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "one"]);
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 9, 9, 9, 0, 4]));

    const change = (await status(dir))!.changes[0];
    expect(change?.added).toBe(0);
    expect(change?.removed).toBe(0);
    expect(Number.isNaN(change?.added)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("still reports counts on an unborn branch, where there is no HEAD", async () => {
    // No commit yet: the diff against HEAD fails and only staged content can be
    // measured. Reaching for HEAD anyway would leave the first commit's files
    // at +0/−0.
    const dir = await makeRepo();
    await writeFile(path.join(dir, "café.txt"), "one\ntwo\n");
    await git(dir, ["add", "-A"]);

    const result = await status(dir);
    expect(result?.head).toBeNull();
    const change = result!.changes[0];
    expect(change?.path).toBe("café.txt");
    expect(change?.added).toBe(2);

    await rm(dir, { recursive: true, force: true });
  });
});
