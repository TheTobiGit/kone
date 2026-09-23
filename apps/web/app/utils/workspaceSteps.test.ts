import { describe, expect, test } from "bun:test";

import {
  applyWorkspaceStep,
  failedWorkspaceStep,
  initialWorkspaceSteps,
  isWorkspaceCancellable,
  settledWorkspaceNote,
  workspaceStepsSettled,
} from "./workspaceSteps";

describe("workspace steps", () => {
  test("start from four pending steps in a fixed order", () => {
    const rows = initialWorkspaceSteps();

    expect(rows.map((r) => r.step)).toEqual(["fetch", "create", "link", "start"]);
    expect(rows.map((r) => r.label)).toEqual([
      "Getting latest changes",
      "Creating branch and worktree",
      "Linking thread workspace",
      "Starting session",
    ]);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });

  test("a report changes one step and moves none", () => {
    const rows = applyWorkspaceStep(initialWorkspaceSteps(), {
      step: "link",
      state: "running",
    });

    expect(rows.map((r) => r.step)).toEqual(["fetch", "create", "link", "start"]);
    expect(rows.map((r) => r.state)).toEqual(["pending", "pending", "running", "pending"]);
  });

  test("a failure stays put, and what comes after it stays pending", () => {
    let rows = applyWorkspaceStep(initialWorkspaceSteps(), {
      step: "create",
      state: "running",
    });
    rows = applyWorkspaceStep(rows, {
      step: "create",
      state: "failed",
      error: "a branch named 'foo' already exists",
    });

    expect(failedWorkspaceStep(rows)?.step).toBe("create");
    expect(failedWorkspaceStep(rows)?.error).toBe("a branch named 'foo' already exists");
    expect(rows.map((r) => r.state)).toEqual(["pending", "failed", "pending", "pending"]);
    expect(workspaceStepsSettled(rows)).toBe(false);
  });

  test("a later report without a sentence clears the earlier one", () => {
    let rows = applyWorkspaceStep(initialWorkspaceSteps(), {
      step: "create",
      state: "failed",
      error: "gone wrong",
    });
    rows = applyWorkspaceStep(rows, { step: "create", state: "done" });

    expect(rows[1]?.error).toBeUndefined();
    expect(failedWorkspaceStep(rows)).toBeNull();
  });

  test("a settled build's summary is the first note in step order", () => {
    let rows = initialWorkspaceSteps();
    rows = applyWorkspaceStep(rows, { step: "fetch", state: "done", note: "Started from origin/main." });
    rows = applyWorkspaceStep(rows, { step: "create", state: "done", note: "Copied .env." });

    expect(settledWorkspaceNote(rows)).toBe("Started from origin/main.");
    expect(settledWorkspaceNote(initialWorkspaceSteps())).toBe("");
  });

  test("settled only when every step is done", () => {
    let rows = initialWorkspaceSteps();
    for (const step of ["fetch", "create", "link", "start"] as const) {
      expect(workspaceStepsSettled(rows)).toBe(false);
      rows = applyWorkspaceStep(rows, { step, state: "done" });
    }

    expect(workspaceStepsSettled(rows)).toBe(true);
  });

  test("does not mutate what it is given", () => {
    const before = initialWorkspaceSteps();
    applyWorkspaceStep(before, { step: "create", state: "done" });

    expect(before[1]?.state).toBe("pending");
  });
});

describe("isWorkspaceCancellable", () => {
  test("cancellable while the worktree is not yet linked", () => {
    expect(isWorkspaceCancellable(initialWorkspaceSteps())).toBe(true);
    const creating = applyWorkspaceStep(initialWorkspaceSteps(), {
      step: "create",
      state: "running",
    });
    expect(isWorkspaceCancellable(creating)).toBe(true);
    const linking = applyWorkspaceStep(creating, { step: "create", state: "done" });
    expect(isWorkspaceCancellable(linking)).toBe(true);
  });

  test("not cancellable once the start step runs — nothing left to undo", () => {
    let rows = initialWorkspaceSteps();
    rows = applyWorkspaceStep(rows, { step: "fetch", state: "done" });
    rows = applyWorkspaceStep(rows, { step: "create", state: "done" });
    rows = applyWorkspaceStep(rows, { step: "link", state: "done" });
    rows = applyWorkspaceStep(rows, { step: "start", state: "running" });
    expect(isWorkspaceCancellable(rows)).toBe(false);
  });

  test("not cancellable once settled or failed", () => {
    let rows = initialWorkspaceSteps();
    for (const step of ["fetch", "create", "link", "start"] as const) {
      rows = applyWorkspaceStep(rows, { step, state: "done" });
    }
    expect(isWorkspaceCancellable(rows)).toBe(false);
    const failed = applyWorkspaceStep(initialWorkspaceSteps(), {
      step: "create",
      state: "failed",
      error: "gone wrong",
    });
    expect(isWorkspaceCancellable(failed)).toBe(false);
  });
});
