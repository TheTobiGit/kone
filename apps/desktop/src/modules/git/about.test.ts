import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readImage } from "./about.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

const repos: string[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await initTestRepo("kone-git-image-");
  repos.push(dir);
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "shot.png"), PNG);
  await writeFile(path.join(dir, "docs", "notes.txt"), "not an image\n");
  return dir;
}

/** A directory outside every test repo, holding a private image. */
async function makeOutside(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-outside-"));
  repos.push(dir);
  await writeFile(path.join(dir, "private.png"), PNG);
  return dir;
}

describe("readImage()", () => {
  test("reads a repo-relative image as a data URL", async () => {
    const dir = await makeRepo();
    const url = await readImage(dir, "docs/shot.png");
    expect(url).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  test("refuses a path that escapes the repo", async () => {
    const dir = await makeRepo();
    expect(await readImage(dir, "../outside.png")).toBeNull();
    expect(await readImage(dir, "/etc/hosts")).toBeNull();
  });

  test("refuses a file whose extension is not an image type", async () => {
    const dir = await makeRepo();
    expect(await readImage(dir, "docs/notes.txt")).toBeNull();
  });

  test("a missing file reads as null, not a throw", async () => {
    const dir = await makeRepo();
    expect(await readImage(dir, "docs/missing.png")).toBeNull();
  });

  test("refuses an image symlinked outside the repo", async () => {
    const dir = await makeRepo();
    const outside = await makeOutside();
    await symlink(path.join(outside, "private.png"), path.join(dir, "docs", "escape.png"));
    expect(await readImage(dir, "docs/escape.png")).toBeNull();
  });

  test("refuses a path through a directory symlinked outside the repo", async () => {
    const dir = await makeRepo();
    const outside = await makeOutside();
    await symlink(outside, path.join(dir, "linked"));
    expect(await readImage(dir, "linked/private.png")).toBeNull();
  });

  test("reads a symlink that resolves to a repo image", async () => {
    const dir = await makeRepo();
    await symlink("docs/shot.png", path.join(dir, "alias.png"));
    const url = await readImage(dir, "alias.png");
    expect(url).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  test("refuses a non-regular file", async () => {
    const dir = await makeRepo();
    await mkdir(path.join(dir, "folder.png"));
    expect(await readImage(dir, "folder.png")).toBeNull();
  });

  test("an aborted signal rejects instead of reading as null", async () => {
    const dir = await makeRepo();
    await expect(readImage(dir, "docs/shot.png", AbortSignal.abort())).rejects.toThrow();
  });
});
