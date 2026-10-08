import { describe, expect, test } from "bun:test";

import { canReadThread } from "./readScope.js";

const thread = (projectPath: string, sourceThreadId?: string | null): { projectPath: string; sourceThreadId: string | null } => ({
  projectPath,
  sourceThreadId: sourceThreadId ?? null,
});

describe("canReadThread", () => {
  test("a thread always reads itself", () => {
    expect(
      canReadThread({
        callerThreadId: "a",
        targetThreadId: "a",
        caller: thread("/p"),
        target: thread("/p"),
      }),
    ).toBe(true);
  });

  test("same-project threads read each other", () => {
    expect(
      canReadThread({
        callerThreadId: "a",
        targetThreadId: "b",
        caller: thread("/p"),
        target: thread("/p"),
      }),
    ).toBe(true);
  });

  test("a fork reads its source across projects, and the source reads the fork", () => {
    expect(
      canReadThread({
        callerThreadId: "fork",
        targetThreadId: "source",
        caller: thread("/fork-project", "source"),
        target: thread("/other-project"),
      }),
    ).toBe(true);
    expect(
      canReadThread({
        callerThreadId: "source",
        targetThreadId: "fork",
        caller: thread("/other-project"),
        target: thread("/fork-project", "source"),
      }),
    ).toBe(true);
  });

  test("an unrelated cross-project thread is refused", () => {
    expect(
      canReadThread({
        callerThreadId: "a",
        targetThreadId: "b",
        caller: thread("/p1"),
        target: thread("/p2"),
      }),
    ).toBe(false);
  });

  test("a user-attached reference allows the read", () => {
    expect(
      canReadThread({
        callerThreadId: "a",
        targetThreadId: "b",
        caller: thread("/p1"),
        target: thread("/p2"),
        attachedReferences: new Set(["b"]),
      }),
    ).toBe(true);
  });

  test("an unknown target is refused", () => {
    expect(
      canReadThread({
        callerThreadId: "a",
        targetThreadId: "gone",
        caller: thread("/p1"),
        target: null,
      }),
    ).toBe(false);
  });
});
