import { describe, expect, test } from "bun:test";

import { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";
import { assistantWorkingDir } from "./assistantWorkspace.js";
import {
  threadEnvMode,
  threadWorkingDir,
  threadWorkspaceState,
} from "./threadWorkspace.js";

describe("threadEnvMode", () => {
  test("only the literal 'worktree' is a worktree", () => {
    expect(threadEnvMode("worktree")).toBe("worktree");
    expect(threadEnvMode("  worktree  ")).toBe("worktree");
  });

  test("absent, empty, and unrecognized all read as local", () => {
    expect(threadEnvMode(null)).toBe("local");
    expect(threadEnvMode(undefined)).toBe("local");
    expect(threadEnvMode("")).toBe("local");
    expect(threadEnvMode("something-a-newer-build-wrote")).toBe("local");
  });
});

describe("threadWorkspaceState", () => {
  test("no mode and no path is local", () => {
    expect(threadWorkspaceState({})).toBe("local");
  });

  test("asked for a worktree but has no path yet is pending", () => {
    expect(threadWorkspaceState({ envMode: "worktree" })).toBe("worktree-pending");
    expect(threadWorkspaceState({ envMode: "worktree", worktreePath: "" })).toBe(
      "worktree-pending",
    );
  });

  test("a materialized path is ready", () => {
    expect(threadWorkspaceState({ envMode: "worktree", worktreePath: "/w/t" })).toBe(
      "worktree-ready",
    );
  });

  test("the path outranks a mode that disagrees with it", () => {
    expect(threadWorkspaceState({ envMode: "local", worktreePath: "/w/t" })).toBe(
      "worktree-ready",
    );
  });
});

describe("threadWorkingDir", () => {
  test("a local thread runs in its project", () => {
    expect(threadWorkingDir({ projectPath: "/code/thing" })).toBe("/code/thing");
  });

  test("a ready thread runs in its worktree, not its project", () => {
    expect(
      threadWorkingDir({
        projectPath: "/code/thing",
        envMode: "worktree",
        worktreePath: "/worktrees/thing-feature",
      }),
    ).toBe("/worktrees/thing-feature");
  });

  test("a pending thread has nowhere to run — never the project", () => {
    expect(
      threadWorkingDir({ projectPath: "/code/thing", envMode: "worktree" }),
    ).toBeNull();
  });

  test("the assistant's sentinel still resolves to its own directory", () => {
    expect(threadWorkingDir({ projectPath: GLOBAL_ASSISTANT_PROJECT_PATH })).toBe(
      assistantWorkingDir(),
    );
  });
});
