import { describe, expect, test } from "bun:test";

import {
  WorktreeSetupTracker,
  parseGitProgressPercent,
  type WorktreeSetupSnapshot,
} from "./worktreeSetup.js";

describe("parseGitProgressPercent", () => {
  test("reads git's checkout percentage", () => {
    expect(parseGitProgressPercent("Updating files:  42% (10/24)")).toBe(42);
    expect(parseGitProgressPercent("Receiving objects: 100% (5/5), done.")).toBe(100);
  });

  test("ignores a chunk with no percentage", () => {
    expect(parseGitProgressPercent("Cloning into 'x'...")).toBeNull();
    expect(parseGitProgressPercent("")).toBeNull();
  });
});

describe("WorktreeSetupTracker", () => {
  test("begins a running snapshot with the ordered stages", () => {
    const snapshots: WorktreeSetupSnapshot[] = [];
    const tracker = new WorktreeSetupTracker((s) => snapshots.push(s));
    const snapshot = tracker.begin({ threadId: "t", branch: "kone/abc", baseRef: "main" });
    expect(snapshot.phase).toBe("running");
    expect(snapshot.stages.map((s) => s.id)).toEqual([
      "fetch",
      "checkout",
      "submodules",
      "setup-script",
      "agent",
    ]);
    expect(snapshot.stages.every((s) => s.status === "pending")).toBe(true);
    expect(snapshots.at(-1)?.sequence).toBe(0);
  });

  test("only tracks the stages asked for, in canonical order", () => {
    const tracker = new WorktreeSetupTracker();
    const snapshot = tracker.begin({
      threadId: "t",
      branch: null,
      baseRef: null,
      stages: ["setup-script", "fetch"],
    });
    expect(snapshot.stages.map((s) => s.id)).toEqual(["fetch", "setup-script"]);
  });

  test("stage updates status, percent and tail, and bumps sequence", () => {
    const snapshots: WorktreeSetupSnapshot[] = [];
    const tracker = new WorktreeSetupTracker((s) => snapshots.push(s));
    tracker.begin({ threadId: "t", branch: null, baseRef: null });
    tracker.stage("t", { stage: "checkout", status: "running", percent: 250 });
    tracker.appendTail("t", "setup-script", "installing");
    tracker.appendTail("t", "setup-script", "done");
    const snapshot = tracker.get("t");
    const checkout = snapshot?.stages.find((s) => s.id === "checkout");
    expect(checkout?.status).toBe("running");
    expect(checkout?.percent).toBe(100);
    expect(checkout?.startedAt).not.toBeNull();
    expect(checkout?.endedAt).toBeNull();
    const setup = snapshot?.stages.find((s) => s.id === "setup-script");
    expect(setup?.tail).toEqual(["installing", "done"]);
    expect(snapshot!.sequence).toBeGreaterThan(0);
    expect(snapshots.length).toBeGreaterThan(1);
  });

  test("keeps only the newest tail lines", () => {
    const tracker = new WorktreeSetupTracker();
    tracker.begin({ threadId: "t", branch: null, baseRef: null });
    for (let i = 0; i < 8; i++) tracker.appendTail("t", "setup-script", `line ${i}`);
    expect(tracker.get("t")?.stages.find((s) => s.id === "setup-script")?.tail).toEqual([
      "line 4",
      "line 5",
      "line 6",
      "line 7",
    ]);
  });

  test("finish settles running stages and keeps the snapshot readable once", () => {
    const tracker = new WorktreeSetupTracker();
    tracker.begin({ threadId: "t", branch: null, baseRef: null });
    tracker.stage("t", { stage: "checkout", status: "running" });
    const settled = tracker.finish("t", "failed", "boom");
    expect(settled?.phase).toBe("failed");
    expect(settled?.error).toBe("boom");
    expect(settled?.stages.find((s) => s.id === "checkout")?.status).toBe("failed");
    // finish drops the in-flight entry.
    expect(tracker.get("t")).toBeNull();
  });

  test("sequence rises across re-begun setups for the same thread", () => {
    const tracker = new WorktreeSetupTracker();
    const first = tracker.begin({ threadId: "t", branch: null, baseRef: null });
    tracker.finish("t", "done");
    const second = tracker.begin({ threadId: "t", branch: null, baseRef: null });
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });
});
