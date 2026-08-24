import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { files, resetFileIndexForTests } from "./files.js";
import { watchStatus } from "./watch.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-watch-"));
  const g = (args: string[]) => git(dir, args);
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@kone.app"]);
  await g(["config", "user.name", "Kone Test"]);
  await writeFile(path.join(dir, "alpha.ts"), "a\n");
  await g(["add", "-A"]);
  await g(["commit", "-m", "init"]);
  return dir;
}

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  ms = 2000,
): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the watcher");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const repos: string[] = [];
let stopWatch: (() => void) | null = null;

afterEach(async () => {
  stopWatch?.();
  stopWatch = null;
  resetFileIndexForTests();
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("watchStatus invalidates the file index", () => {
  test("a newly created file is visible to files() after the watcher fires, without waiting out the index TTL", async () => {
    const dir = await makeRepo();
    repos.push(dir);

    // Prime the 8s index cache with an empty listing for the "delta" query.
    const before = await files(dir, "delta");
    expect(before).toEqual([]);

    let fired = false;
    stopWatch = await watchStatus(dir, () => {
      fired = true;
    });

    // Untracked is fine: ls-files --others sees it once the index rebuilds.
    await writeFile(path.join(dir, "delta.ts"), "d\n");

    // schedule() drops the index before the debounce fires the status callback,
    // so once onStatus has run the stale entry is already gone.
    await waitUntil(() => fired);

    const after = await files(dir, "delta");
    expect(after.map((f) => f.path)).toEqual(["delta.ts"]);
  });

  test("a write inside node_modules does not fire onStatus", async () => {
    const dir = await makeRepo();
    repos.push(dir);

    // Create the dir before watching so no event is raised for the directory
    // itself; only the file write below is in scope.
    await mkdir(path.join(dir, "node_modules"));

    let calls = 0;
    stopWatch = await watchStatus(dir, () => {
      calls += 1;
    });

    // Prove the watcher is live so the negative assertion can't pass
    // vacuously: a relevant write must deliver a callback.
    await writeFile(path.join(dir, "note.ts"), "n\n");
    await waitUntil(() => calls > 0);

    const before = calls;
    await writeFile(path.join(dir, "node_modules", "dep.ts"), "d\n");

    // The debounce is 180ms plus a status read, so any callback for the
    // node_modules write would have landed well inside this window.
    await new Promise((r) => setTimeout(r, 700));
    expect(calls).toBe(before);
  });
});
