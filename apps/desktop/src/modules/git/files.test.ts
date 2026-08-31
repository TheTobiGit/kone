import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { files, invalidateFileIndex, resetFileIndexForTests } from "./files.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-files-");
  const g = (args: string[]) => git(dir, args);
  await writeFile(path.join(dir, "alpha.ts"), "a\n");
  await writeFile(path.join(dir, "beta.ts"), "b\n");
  await writeFile(path.join(dir, "gamma.ts"), "c\n");
  await g(["add", "-A"]);
  await g(["commit", "-m", "init"]);
  return dir;
}

function countLsFilesStarts(trace: string): number {
  let n = 0;
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev: { event?: string; argv?: unknown } = JSON.parse(line);
      if (ev.event !== "start" || !Array.isArray(ev.argv)) continue;
      if (ev.argv.some((part) => part === "ls-files")) n += 1;
    } catch {
      // A truncated last line is fine — we only count complete start events.
    }
  }
  return n;
}

const repos: string[] = [];
const traces: string[] = [];

afterEach(async () => {
  resetFileIndexForTests();
  delete process.env.GIT_TRACE2_EVENT;
  await Promise.all([
    ...repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    ...traces.splice(0).map((file) => rm(file, { force: true })),
  ]);
});

describe("files()", () => {
  test("eight overlapping queries of the same repo spawn one git ls-files, not eight", async () => {
    const dir = await makeRepo();
    repos.push(dir);
    const trace = path.join(os.tmpdir(), `kone-files-trace-${Date.now()}.event`);
    traces.push(trace);
    process.env.GIT_TRACE2_EVENT = trace;

    const results = await Promise.all([
      files(dir, "alp"),
      files(dir, "bet"),
      files(dir, "gam"),
      files(dir, "alpha"),
      files(dir, "beta"),
      files(dir, "gamma"),
      files(dir, "ts"),
      files(dir, ""),
    ]);

    const body = await readFile(trace, "utf8");
    expect(countLsFilesStarts(body)).toBe(1);

    expect(results[0]!.map((f) => f.path)).toEqual(["alpha.ts"]);
    expect(results[1]!.map((f) => f.path)).toEqual(["beta.ts"]);
    expect(results[7]!.map((f) => f.path).sort()).toEqual(["alpha.ts", "beta.ts", "gamma.ts"]);
  });

  test("a later query within the TTL does not spawn another ls-files", async () => {
    const dir = await makeRepo();
    repos.push(dir);
    const trace = path.join(os.tmpdir(), `kone-files-trace-${Date.now()}.event`);
    traces.push(trace);
    process.env.GIT_TRACE2_EVENT = trace;

    await files(dir, "alpha");
    await files(dir, "beta");

    const body = await readFile(trace, "utf8");
    expect(countLsFilesStarts(body)).toBe(1);
  });

  test("invalidateFileIndex drops the cached listing so a new file is visible", async () => {
    const dir = await makeRepo();
    repos.push(dir);

    const before = await files(dir, "delta");
    expect(before).toEqual([]);

    await writeFile(path.join(dir, "delta.ts"), "d\n");
    const stillCached = await files(dir, "delta");
    expect(stillCached).toEqual([]);

    invalidateFileIndex(dir);
    const after = await files(dir, "delta");
    expect(after.map((f) => f.path)).toEqual(["delta.ts"]);
  });

  test("indexes for two repos do not coalesce", async () => {
    const a = await makeRepo();
    const b = await makeRepo();
    repos.push(a, b);
    await writeFile(path.join(b, "only-b.ts"), "x\n");
    invalidateFileIndex(b);

    const trace = path.join(os.tmpdir(), `kone-files-trace-${Date.now()}.event`);
    traces.push(trace);
    process.env.GIT_TRACE2_EVENT = trace;

    const [fromA, fromB] = await Promise.all([files(a, "only-b"), files(b, "only-b")]);
    expect(fromA).toEqual([]);
    expect(fromB.map((f) => f.path)).toEqual(["only-b.ts"]);

    const body = await readFile(trace, "utf8");
    // Both roots ran ls-files; the trace file is only attached to repo `a`'s
    // env, but git inherits process.env so both processes append here.
    expect(countLsFilesStarts(body)).toBe(2);
  });
});
