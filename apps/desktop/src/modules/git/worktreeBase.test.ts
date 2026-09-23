import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { freshestBase } from "./worktreeBase.js";

// A project with a remote, and a teammate pushing to that remote: the smallest
// setup where "your copy" and "the latest" can differ.

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function commit(repo: string, file: string, text: string): Promise<string> {
  writeFileSync(path.join(repo, file), text, "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", text]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

async function clone(remote: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  await git(dir, ["clone", remote, "."]);
  await git(dir, ["config", "user.email", "test@kone.app"]);
  await git(dir, ["config", "user.name", "Kone Test"]);
  return dir;
}

async function setup(): Promise<{ project: string; teammate: string }> {
  const seed = await initTestRepo("kone-base-seed-");
  cleanup.push(seed);
  await commit(seed, "a.txt", "one");
  const remote = await mkdtemp(path.join(os.tmpdir(), "kone-base-remote-"));
  cleanup.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "-u", "origin", "main"]);
  return {
    project: await clone(remote, "kone-base-project-"),
    teammate: await clone(remote, "kone-base-teammate-"),
  };
}

describe("freshestBase", () => {
  test("a copy that is only behind starts from the remote's latest", async () => {
    const { project, teammate } = await setup();
    await commit(teammate, "b.txt", "two");
    const latest = await commit(teammate, "c.txt", "three");
    await git(teammate, ["push"]);

    const fresh = await freshestBase(project, "main");

    expect(fresh.base).toBe(latest);
    expect(fresh.note).toBe("Started from the latest origin/main, 2 commits newer than your copy.");
    // The user's own branch is left where it was: only the starting point moved.
    expect((await git(project, ["rev-parse", "main"])).trim()).not.toBe(latest);
  });

  test("with no branch named, the project's current branch is freshened", async () => {
    const { project, teammate } = await setup();
    const latest = await commit(teammate, "b.txt", "two");
    await git(teammate, ["push"]);

    expect((await freshestBase(project)).base).toBe(latest);
  });

  test("a copy with commits the remote lacks keeps them", async () => {
    const { project, teammate } = await setup();
    await commit(teammate, "b.txt", "two");
    await git(teammate, ["push"]);
    await commit(project, "mine.txt", "local work");

    const fresh = await freshestBase(project, "main");

    expect(fresh.base).toBe("main");
    expect(fresh.note).toBe("Your main has commits origin/main doesn't — started from yours.");
  });

  test("an up-to-date copy changes nothing and says nothing", async () => {
    const { project } = await setup();

    expect(await freshestBase(project, "main")).toEqual({ base: "main" });
    expect(await freshestBase(project)).toEqual({});
  });

  test("a branch with no remote copy starts from the local one, quietly", async () => {
    const { project } = await setup();
    await git(project, ["branch", "local-only"]);

    expect(await freshestBase(project, "local-only")).toEqual({ base: "local-only" });
  });

  test("an unreachable remote falls back to the local copy and says why", async () => {
    const { project } = await setup();
    await git(project, ["remote", "set-url", "origin", path.join(os.tmpdir(), "kone-no-such-remote")]);

    const fresh = await freshestBase(project, "main");

    expect(fresh.base).toBe("main");
    expect(fresh.note).toBe("Couldn't reach origin — started from your copy of main.");
  });

  test("outside a repository there is nothing to freshen", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kone-base-plain-"));
    cleanup.push(dir);

    expect(await freshestBase(dir, "main")).toEqual({ base: "main" });
  });
});
