import { describe, expect, test } from "bun:test";

import {
  LOCAL_WORKSPACE,
  hasOwnWorkspace,
  isWorkspacePending,
  workspaceMark,
  workspaceRequest,
} from "./threadWorkspace";

describe("workspaceMark", () => {
  test("a thread in the project's checkout has no mark", () => {
    expect(workspaceMark({})).toBeNull();
    expect(workspaceMark({ worktreePath: null })).toBeNull();
    expect(workspaceMark({ worktreePath: "   " })).toBeNull();
  });

  test("a worktree thread shows its basename and keeps the path for the tooltip", () => {
    const mark = workspaceMark({ worktreePath: "/state/worktrees/kone/feature-foo-ab12cd" });

    expect(mark).toEqual({
      label: "feature-foo-ab12cd",
      title: "/state/worktrees/kone/feature-foo-ab12cd",
      pending: false,
    });
  });

  test("a trailing separator does not empty the label", () => {
    expect(workspaceMark({ worktreePath: "/state/worktrees/kone/feature/" })?.label).toBe(
      "feature",
    );
  });

  test("reads a windows path too", () => {
    expect(workspaceMark({ worktreePath: "C:\\state\\worktrees\\kone\\feature" })?.label).toBe(
      "feature",
    );
  });

  test("pending is its own mark", () => {
    const mark = workspaceMark({ envMode: "worktree" });

    expect(mark?.label).toBe("Worktree pending");
    expect(mark?.pending).toBe(true);
  });

  test("a built worktree outranks a stale pending intent", () => {
    const mark = workspaceMark({ worktreePath: "/w/t/done", envMode: "worktree" });

    expect(mark?.pending).toBe(false);
    expect(mark?.label).toBe("done");
  });
});

describe("isWorkspacePending", () => {
  test("intent without a place", () => {
    expect(isWorkspacePending({ envMode: "worktree" })).toBe(true);
    expect(isWorkspacePending({ envMode: "worktree", worktreePath: null })).toBe(true);
    // A blank path carries nothing to open.
    expect(isWorkspacePending({ envMode: "worktree", worktreePath: "   " })).toBe(true);
  });

  test("a place, or no intent, is not pending", () => {
    expect(isWorkspacePending({ envMode: "worktree", worktreePath: "/w/t/done" })).toBe(false);
    expect(isWorkspacePending({ envMode: "local" })).toBe(false);
    expect(isWorkspacePending({ envMode: null })).toBe(false);
    expect(isWorkspacePending({})).toBe(false);
  });
});

describe("hasOwnWorkspace", () => {
  test("only a materialized directory counts", () => {
    expect(hasOwnWorkspace({ worktreePath: "/w/t" })).toBe(true);
    // Pending has nowhere to open — the whole reason it is its own state.
    expect(hasOwnWorkspace({ envMode: "worktree" })).toBe(false);
    expect(hasOwnWorkspace({})).toBe(false);
  });
});

describe("workspaceRequest", () => {
  test("the project's own checkout asks for nothing", () => {
    expect(workspaceRequest(LOCAL_WORKSPACE)).toBeUndefined();
    expect(workspaceRequest({ mode: "local", base: "main" })).toBeUndefined();
  });

  test("a new worktree from the current branch carries no base", () => {
    expect(workspaceRequest({ mode: "worktree", base: null })).toEqual({ mode: "worktree" });
  });

  test("a new worktree from another branch carries it as the base, never as its own branch", () => {
    expect(workspaceRequest({ mode: "worktree", base: "main" })).toEqual({
      mode: "worktree",
      base: "main",
    });
  });
});
