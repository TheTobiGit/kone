import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { stashes, stashDrop, stashPush } from "./stash.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-stash-");
  await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
  await writeFile(path.join(dir, "b.txt"), "two\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "one"]);
  return dir;
}

describe("stash", () => {
  test("push saves a stash, drop removes it", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "a.txt"), "edited\n", "utf8");

    await stashPush(dir, { message: "wip thing" });
    const entries = await stashes(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("wip thing");

    await stashDrop(dir, 0);
    expect(await stashes(dir)).toHaveLength(0);
  });

  test("message with a colon survives untouched", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "a.txt"), "edited\n", "utf8");

    await stashPush(dir, { message: "fix: colon in message" });
    expect((await stashes(dir))[0].message).toBe("fix: colon in message");
  });

  test("overlapping pushes serialize without an index.lock error", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "a.txt"), "edited a\n", "utf8");
    await writeFile(path.join(dir, "b.txt"), "edited b\n", "utf8");

    const results = await Promise.allSettled([
      stashPush(dir, { message: "a" }),
      stashPush(dir, { message: "b" }),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason.message).not.toContain("index.lock");
      }
    }
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // The first push stashes the whole dirty tree; the second may find nothing
    // left to save and become a no-op, so 1 or 2 entries are both fine.
    const count = (await stashes(dir)).length;
    expect(count === 1 || count === 2).toBe(true);
  });
});
