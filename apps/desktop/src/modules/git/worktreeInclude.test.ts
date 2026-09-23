import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, pathExists } from "@kone/git-core/core.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { copyPrivateFiles, isIncluded, parseIncludeRules, privateFilesToCopy } from "./worktreeInclude.js";

const made: string[] = [];

async function write(root: string, rel: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text, "utf8");
}

async function makeRepo(gitignore: string): Promise<string> {
  const repo = await initTestRepo("kone-wt-include-");
  made.push(repo);
  await write(repo, ".gitignore", gitignore);
  await write(repo, "a.txt", "one\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "one"]);
  return repo;
}

function emptyDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-wt-include-dest-"));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("include rules", () => {
  test("a bare name matches at any depth, a slashed one only from the root", () => {
    const rules = parseIncludeRules(".env\nconfig/local.json\n");
    expect(isIncluded(rules, ".env", false)).toBe(true);
    expect(isIncluded(rules, "apps/web/.env", false)).toBe(true);
    expect(isIncluded(rules, "config/local.json", false)).toBe(true);
    expect(isIncluded(rules, "apps/config/local.json", false)).toBe(false);
  });

  test("globs, comments, directories and a later ! taking one back", () => {
    const rules = parseIncludeRules("# secrets\n*.pem\ncerts/\n!dev.pem\n\n**/fixtures/*.key\n");
    expect(isIncluded(rules, "keys/prod.pem", false)).toBe(true);
    expect(isIncluded(rules, "dev.pem", false)).toBe(false);
    expect(isIncluded(rules, "certs", true)).toBe(true);
    expect(isIncluded(rules, "certs", false)).toBe(false);
    expect(isIncluded(rules, "fixtures/a.key", false)).toBe(true);
    expect(isIncluded(rules, "test/fixtures/a.key", false)).toBe(true);
  });
});

describe("private files", () => {
  test("ignored env files come along with no list at all", async () => {
    const repo = await makeRepo(".env\n.env.*\nnode_modules/\n");
    await write(repo, ".env", "SECRET=1\n");
    await write(repo, "apps/web/.env.local", "LOCAL=1\n");
    await write(repo, "node_modules/pkg/.env", "no\n");

    expect((await privateFilesToCopy(repo)).sort()).toEqual([".env", "apps/web/.env.local"]);
  });

  test("a file git would track is never a candidate", async () => {
    const repo = await makeRepo("node_modules/\n");
    // Not ignored: an unsaved change, which is not this feature's to carry.
    await write(repo, ".env", "SECRET=1\n");

    expect(await privateFilesToCopy(repo)).toEqual([]);
  });

  test(".worktreeinclude adds files, directories and paths inside ignored directories", async () => {
    const repo = await makeRepo("*.pem\ncerts/\nconfig/local/\n");
    await write(repo, ".worktreeinclude", "*.pem\ncerts/\nconfig/local/*.json\n");
    await write(repo, "server.pem", "pem\n");
    await write(repo, "certs/a.crt", "crt\n");
    await write(repo, "config/local/db.json", "{}\n");
    await write(repo, "config/local/notes.txt", "skip\n");

    expect((await privateFilesToCopy(repo)).sort()).toEqual([
      "certs",
      "config/local/db.json",
      "server.pem",
    ]);
  });

  test("copies into the new directory and leaves what is already there alone", async () => {
    const repo = await makeRepo(".env\n.env.*\n");
    await write(repo, ".env", "SECRET=1\n");
    await write(repo, "apps/web/.env.local", "LOCAL=1\n");
    const dest = emptyDir();
    await write(dest, ".env", "KEEP=me\n");

    const copied = await copyPrivateFiles(repo, dest);

    expect(copied).toEqual(["apps/web/.env.local"]);
    expect(await readFile(path.join(dest, "apps/web/.env.local"), "utf8")).toBe("LOCAL=1\n");
    expect(await readFile(path.join(dest, ".env"), "utf8")).toBe("KEEP=me\n");
  });

  test("a directory that is not a repository copies nothing and does not throw", async () => {
    const dest = emptyDir();
    expect(await copyPrivateFiles(emptyDir(), dest)).toEqual([]);
    expect(await pathExists(path.join(dest, ".env"))).toBe(false);
  });
});
