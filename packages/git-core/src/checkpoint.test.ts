import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, GitError } from "./core.js";
import {
  createCheckpoint,
  dropCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "./checkpoint.js";

describe("git-core checkpoint", () => {
  let tempDir: string;
  let initialHead: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "kone-checkpoint-test-"));
    await git(tempDir, ["init", "-b", "main"]);
    await git(tempDir, ["config", "user.name", "Test User"]);
    await git(tempDir, ["config", "user.email", "test@example.com"]);

    writeFileSync(path.join(tempDir, "file1.txt"), "initial content\n");
    await git(tempDir, ["add", "."]);
    await git(tempDir, ["commit", "-m", "Initial commit"]);
    initialHead = (await git(tempDir, ["rev-parse", "HEAD"])).trim();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates a checkpoint on clean repo and lists it with exact metadata", async () => {
    const cp = await createCheckpoint(tempDir, {
      name: "clean-point",
      message: "before experiment",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(cp.id).toBeDefined();
    expect(cp.name).toBe("clean-point");
    expect(cp.threadId).toBe("thread-1");
    expect(cp.commitHash).toBeDefined();

    const list = await listCheckpoints(tempDir);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(cp.id);
    expect(list[0].threadId).toBe("thread-1");
    expect(list[0].name).toBe("clean-point");
  });

  it("creates a checkpoint on a dirty worktree with untracked files and preserves metadata", async () => {
    // Modify tracked file
    writeFileSync(path.join(tempDir, "file1.txt"), "modified tracked\n");
    // Add untracked file
    writeFileSync(path.join(tempDir, "untracked.txt"), "fresh untracked\n");

    const cp = await createCheckpoint(tempDir, {
      name: "dirty-point",
      threadId: "thread-dirty",
      includeUntracked: true,
    });

    const list = await listCheckpoints(tempDir);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(cp.id);
    expect(list[0].name).toBe("dirty-point");
    expect(list[0].threadId).toBe("thread-dirty");

    // Introduce bad changes and bad new file
    writeFileSync(path.join(tempDir, "file1.txt"), "corrupted\n");
    writeFileSync(path.join(tempDir, "bad-extra.txt"), "bad file\n");

    // Hard restore should recover the checkpoint state
    const restored = await restoreCheckpoint(tempDir, cp.id, { hard: true });
    expect(restored).toBe(true);

    expect(readFileSync(path.join(tempDir, "file1.txt"), "utf8")).toBe("modified tracked\n");
    expect(readFileSync(path.join(tempDir, "untracked.txt"), "utf8")).toBe("fresh untracked\n");
    expect(existsSync(path.join(tempDir, "bad-extra.txt"))).toBe(false);

    // Branch HEAD must NOT have been moved by the hard restore
    const currentHead = (await git(tempDir, ["rev-parse", "HEAD"])).trim();
    expect(currentHead).toBe(initialHead);
  });

  it("filters checkpoints by threadId", async () => {
    await createCheckpoint(tempDir, { name: "cp-t1", threadId: "t1" });
    await createCheckpoint(tempDir, { name: "cp-t2", threadId: "t2" });

    const forT1 = await listCheckpoints(tempDir, { threadId: "t1" });
    expect(forT1.length).toBe(1);
    expect(forT1[0].name).toBe("cp-t1");

    const forT2 = await listCheckpoints(tempDir, { threadId: "t2" });
    expect(forT2.length).toBe(1);
    expect(forT2[0].name).toBe("cp-t2");
  });

  it("drops a checkpoint and returns accurate boolean", async () => {
    const cp = await createCheckpoint(tempDir, { name: "drop-me" });
    let list = await listCheckpoints(tempDir);
    expect(list.length).toBe(1);

    const dropped = await dropCheckpoint(tempDir, cp.id);
    expect(dropped).toBe(true);

    list = await listCheckpoints(tempDir);
    expect(list.length).toBe(0);

    const droppedAgain = await dropCheckpoint(tempDir, cp.id);
    expect(droppedAgain).toBe(false);
  });

  it("handles non-existent checkpoint error on restore", async () => {
    await expect(restoreCheckpoint(tempDir, "non-existent-id")).rejects.toThrow(GitError);
  });

  it("preserves staged index changes across soft and hard restore", async () => {
    // Stage a change in the user's real index
    writeFileSync(path.join(tempDir, "staged.txt"), "staged content\n");
    await git(tempDir, ["add", "staged.txt"]);

    // Create a checkpoint
    const cp = await createCheckpoint(tempDir, { name: "index-test" });

    // Mutate the working tree
    writeFileSync(path.join(tempDir, "staged.txt"), "corrupted in worktree\n");
    writeFileSync(path.join(tempDir, "extra.txt"), "extra\n");

    // Hard restore
    await restoreCheckpoint(tempDir, cp.id, { hard: true });

    // Staged change in real index should still be staged
    const diffCached = await git(tempDir, ["diff", "--cached", "--name-only"]);
    expect(diffCached.trim()).toBe("staged.txt");
    expect(readFileSync(path.join(tempDir, "staged.txt"), "utf8")).toBe("staged content\n");
    expect(existsSync(path.join(tempDir, "extra.txt"))).toBe(false);
  });

  it("works seamlessly from a subdirectory cwd", async () => {
    const subDir = path.join(tempDir, "nested", "subpkg");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, "code.ts"), "export const x = 1;\n");

    const cp = await createCheckpoint(subDir, { name: "sub-cp" });
    expect(cp.id).toBeDefined();

    writeFileSync(path.join(subDir, "code.ts"), "export const x = 99;\n");
    writeFileSync(path.join(subDir, "temp.ts"), "temp\n");

    await restoreCheckpoint(subDir, cp.id, { hard: true });

    expect(readFileSync(path.join(subDir, "code.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(existsSync(path.join(subDir, "temp.ts"))).toBe(false);
  });

  it("handles later commits before hard restore without corrupting git history or index", async () => {
    // Take checkpoint cp1
    const cp1 = await createCheckpoint(tempDir, { name: "cp1" });

    // Later commit introduces a new file
    writeFileSync(path.join(tempDir, "file2.txt"), "second commit\n");
    await git(tempDir, ["add", "file2.txt"]);
    await git(tempDir, ["commit", "-m", "Second commit"]);
    const secondHead = (await git(tempDir, ["rev-parse", "HEAD"])).trim();

    // Introduce an uncommitted edit and untracked file
    writeFileSync(path.join(tempDir, "file1.txt"), "bad edit\n");
    writeFileSync(path.join(tempDir, "untracked.txt"), "untracked\n");

    // Hard restore cp1
    await restoreCheckpoint(tempDir, cp1.id, { hard: true });

    // HEAD remains at secondHead
    const currentHead = (await git(tempDir, ["rev-parse", "HEAD"])).trim();
    expect(currentHead).toBe(secondHead);

    // file1.txt restored to cp1 state
    expect(readFileSync(path.join(tempDir, "file1.txt"), "utf8")).toBe("initial content\n");
    // untracked.txt deleted
    expect(existsSync(path.join(tempDir, "untracked.txt"))).toBe(false);

    // file2.txt is deleted from worktree (not in checkpoint) but still present in index/HEAD
    expect(existsSync(path.join(tempDir, "file2.txt"))).toBe(false);
    const lsFiles = await git(tempDir, ["ls-files"]);
    expect(lsFiles.split("\n").filter(Boolean)).toContain("file2.txt");
    const diffNames = await git(tempDir, ["diff", "--name-only"]);
    expect(diffNames.split("\n").filter(Boolean)).toContain("file2.txt");
  });
});
