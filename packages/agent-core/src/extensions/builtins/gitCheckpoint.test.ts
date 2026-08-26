import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitCheckpoint } from "@kone/git-core";
import { ExtensionRegistry } from "../ExtensionRegistry.js";
import {
  createGitCheckpointExtension,
  gitCheckpointExtension,
  handleTurnStartCheckpoint,
  listCheckpointsTool,
  resolveTargetDirectory,
  restoreCheckpointTool,
} from "./gitCheckpoint.js";

const execFileAsync = promisify(execFile);

describe("gitCheckpoint - Target Directory Resolution", () => {
  it("resolves context.projectPath as highest priority", () => {
    const dummyStorage = {
      get: () => undefined,
      set: () => {},
      delete: () => true,
      has: () => false,
      clear: () => {},
      entries: () => [],
    };

    const dir = resolveTargetDirectory(
      {
        turnId: "turn-1",
        threadId: "thread-1",
        metadata: { cwd: "/payload/dir" },
      },
      {
        extensionId: "gitCheckpoint",
        projectPath: "/project/dir",
        metadata: { cwd: "/context/dir" },
        storage: dummyStorage,
      },
    );

    expect(dir).toBe("/project/dir");
  });

  it("resolves payload.metadata.cwd when projectPath is absent", () => {
    const dummyStorage = {
      get: () => undefined,
      set: () => {},
      delete: () => true,
      has: () => false,
      clear: () => {},
      entries: () => [],
    };

    const dir = resolveTargetDirectory(
      {
        turnId: "turn-1",
        threadId: "thread-1",
        metadata: { cwd: "/payload/dir" },
      },
      {
        extensionId: "gitCheckpoint",
        storage: dummyStorage,
      },
    );

    expect(dir).toBe("/payload/dir");
  });

  it("resolves context.metadata.cwd when payload metadata is absent", () => {
    const dummyStorage = {
      get: () => undefined,
      set: () => {},
      delete: () => true,
      has: () => false,
      clear: () => {},
      entries: () => [],
    };

    const dir = resolveTargetDirectory(
      {
        turnId: "turn-1",
        threadId: "thread-1",
      },
      {
        extensionId: "gitCheckpoint",
        metadata: { cwd: "/context/dir" },
        storage: dummyStorage,
      },
    );

    expect(dir).toBe("/context/dir");
  });

  it("falls back to process.cwd() when no directory properties are provided", () => {
    const dummyStorage = {
      get: () => undefined,
      set: () => {},
      delete: () => true,
      has: () => false,
      clear: () => {},
      entries: () => [],
    };

    const dir = resolveTargetDirectory(
      {
        turnId: "turn-1",
        threadId: "thread-1",
      },
      {
        extensionId: "gitCheckpoint",
        storage: dummyStorage,
      },
    );

    expect(dir).toBe(process.cwd());
  });
});

describe("gitCheckpoint - Lifecycle and Tools in Git Repository", () => {
  let tempRepoDir: string;

  beforeAll(async () => {
    tempRepoDir = await mkdtemp(path.join(os.tmpdir(), "kone-checkpoint-test-"));

    // Initialize git repository with initial commit
    await execFileAsync("git", ["init"], { cwd: tempRepoDir });
    await execFileAsync("git", ["config", "user.name", "Test Agent"], {
      cwd: tempRepoDir,
    });
    await execFileAsync("git", ["config", "user.email", "agent@test.local"], {
      cwd: tempRepoDir,
    });

    await writeFile(path.join(tempRepoDir, "initial.txt"), "Initial content\n");
    await execFileAsync("git", ["add", "initial.txt"], { cwd: tempRepoDir });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], {
      cwd: tempRepoDir,
    });
  });

  afterAll(async () => {
    if (tempRepoDir) {
      await rm(tempRepoDir, { recursive: true, force: true });
    }
  });

  it("skips checkpoint creation gracefully when directory is not a git repo", async () => {
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), "kone-nongit-test-"));
    try {
      const registry = new ExtensionRegistry();
      const api = await registry.registerExtension(
        "gitCheckpoint",
        gitCheckpointExtension,
      );

      const dispatchResult = await registry.dispatch(
        "turn_start",
        {
          turnId: "turn-nongit",
          threadId: "thread-nongit",
          prompt: "Write some code",
        },
        { projectPath: nonGitDir },
      );

      expect(dispatchResult.errors.length).toBe(0);
      expect(api.storage.get("latestCheckpoint")).toBeUndefined();
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it("creates a git checkpoint on turn_start in a git repository", async () => {
    const registry = new ExtensionRegistry();
    const api = await registry.registerExtension(
      "gitCheckpoint",
      gitCheckpointExtension,
    );

    // Modify a file in working tree before turn
    await writeFile(
      path.join(tempRepoDir, "sample.txt"),
      "Working tree changes\n",
    );

    const dispatchResult = await registry.dispatch(
      "turn_start",
      {
        turnId: "turn-101",
        threadId: "thread-42",
        prompt: "Refactor database queries",
      },
      { projectPath: tempRepoDir },
    );

    expect(dispatchResult.errors.length).toBe(0);

    const latest = api.storage.get<GitCheckpoint>("latestCheckpoint");
    expect(latest).toBeDefined();
    expect(latest?.threadId).toBe("thread-42");
    expect(latest?.turnId).toBe("turn-101");
    expect(typeof latest?.commitHash).toBe("string");
    expect(typeof latest?.id).toBe("string");

    const byTurn = api.storage.get<GitCheckpoint>("checkpoint:turn-101");
    expect(byTurn?.id).toBe(latest?.id);

    const history = api.storage.get<GitCheckpoint[]>("checkpoints");
    expect(Array.isArray(history)).toBe(true);
    expect(history?.length).toBeGreaterThanOrEqual(1);
  });

  it("lists and restores checkpoints using custom tools", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension(
      "gitCheckpoint",
      gitCheckpointExtension,
    );

    expect(registry.hasTool("git_list_checkpoints")).toBe(true);
    expect(registry.hasTool("git_restore_checkpoint")).toBe(true);

    // Make an edit and take a checkpoint
    await writeFile(path.join(tempRepoDir, "version.txt"), "v1.0.0\n");
    await registry.dispatch(
      "turn_start",
      {
        turnId: "turn-200",
        threadId: "thread-tool-test",
        prompt: "Update version to v1",
      },
      { projectPath: tempRepoDir },
    );

    // List checkpoints via custom tool
    const listResult = (await registry.executeTool(
      "git_list_checkpoints",
      { threadId: "thread-tool-test" },
      { projectPath: tempRepoDir },
    )) as { checkpoints: GitCheckpoint[]; count: number };

    expect(listResult.count).toBeGreaterThanOrEqual(1);
    const checkpointToRestore = listResult.checkpoints[0];
    expect(checkpointToRestore).toBeDefined();

    if (checkpointToRestore) {
      // Mutate workspace
      await writeFile(
        path.join(tempRepoDir, "version.txt"),
        "broken mutated content\n",
      );

      // Restore via custom tool
      const restoreResult = (await registry.executeTool(
        "git_restore_checkpoint",
        { checkpointId: checkpointToRestore.id, hard: true },
        { projectPath: tempRepoDir },
      )) as { success: boolean; checkpointId: string };

      expect(restoreResult.success).toBe(true);
      expect(restoreResult.checkpointId).toBe(checkpointToRestore.id);
    }
  });

  it("supports createGitCheckpointExtension with options", async () => {
    const noToolsExtension = createGitCheckpointExtension({
      registerTools: false,
    });

    const registry = new ExtensionRegistry();
    await registry.registerExtension("gitNoTools", noToolsExtension);

    expect(registry.hasTool("git_list_checkpoints")).toBe(false);
    expect(registry.hasTool("git_restore_checkpoint")).toBe(false);
  });
});
