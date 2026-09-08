import { describe, expect, it } from "bun:test";

import {
  indexThreadGates,
  projectStatus,
  projectThreadStatus,
  threadGateFor,
} from "./spawnProjection.js";

describe("projectThreadStatus", () => {
  it("a parked gate outranks a running turn", () => {
    expect(
      projectThreadStatus({
        gate: "approval",
        running: true,
        lastState: "running",
        hasLiveSession: true,
      }),
    ).toBe("waiting-for-approval");
    expect(
      projectThreadStatus({
        gate: "user-input",
        running: true,
        lastState: "running",
        hasLiveSession: true,
      }),
    ).toBe("waiting-for-user-input");
  });

  it("a running turn reads working while a session backs it", () => {
    expect(
      projectThreadStatus({ running: true, lastState: "running", hasLiveSession: true }),
    ).toBe("working");
  });

  it("a running turn without a session reads interrupted, never working", () => {
    expect(
      projectThreadStatus({ running: true, lastState: "running", hasLiveSession: false }),
    ).toBe("interrupted");
  });

  it("a settled last turn surfaces failure", () => {
    expect(
      projectThreadStatus({ running: false, lastState: "failed", hasLiveSession: false }),
    ).toBe("failed");
    expect(
      projectThreadStatus({ running: false, lastState: "interrupted", hasLiveSession: false }),
    ).toBe("interrupted");
  });

  it("a settled-ok thread reads idle, not completed", () => {
    expect(
      projectThreadStatus({ running: false, lastState: "completed", hasLiveSession: false }),
    ).toBe("idle");
  });

  it("no assistant history reads starting while live, idle otherwise", () => {
    expect(projectThreadStatus({ running: false, lastState: null, hasLiveSession: true })).toBe(
      "starting",
    );
    expect(projectThreadStatus({ running: false, lastState: null, hasLiveSession: false })).toBe(
      "idle",
    );
    expect(projectThreadStatus({ running: false, lastState: null, hasLiveSession: false })).toBe(
      "idle",
    );
  });
});

describe("projectStatus terminal kinds", () => {
  it("shares every rung above the quiet divergence", () => {
    for (const terminalKind of ["idle", "completed", "stillborn"] as const) {
      expect(
        projectStatus({
          gate: "approval",
          running: true,
          lastState: "running",
          hasLiveSession: true,
          terminalKind,
        }),
      ).toBe("waiting-for-approval");
      expect(
        projectStatus({
          running: true,
          lastState: "running",
          hasLiveSession: true,
          terminalKind,
        }),
      ).toBe("working");
      expect(
        projectStatus({
          running: true,
          lastState: "running",
          hasLiveSession: false,
          terminalKind,
        }),
      ).toBe("interrupted");
      expect(
        projectStatus({ running: false, lastState: "failed", hasLiveSession: false, terminalKind }),
      ).toBe("failed");
      expect(
        projectStatus({
          running: false,
          lastState: null,
          hasLiveSession: true,
          terminalKind,
        }),
      ).toBe("starting");
    }
  });

  it("reads settled-ok as idle for top-level threads, completed for children", () => {
    expect(
      projectStatus({
        running: false,
        lastState: "completed",
        hasLiveSession: false,
        terminalKind: "idle",
      }),
    ).toBe("idle");
    expect(
      projectStatus({
        running: false,
        lastState: "completed",
        hasLiveSession: false,
        terminalKind: "completed",
      }),
    ).toBe("completed");
  });

  it("reads no-turns-no-session as the caller's quiet kind", () => {
    expect(
      projectStatus({
        running: false,
        lastState: null,
        hasLiveSession: false,
        terminalKind: "idle",
      }),
    ).toBe("idle");
    expect(
      projectStatus({
        running: false,
        lastState: null,
        hasLiveSession: false,
        terminalKind: "stillborn",
      }),
    ).toBe("stillborn");
  });
});

describe("thread gate index", () => {
  it("an approval outranks a question parked on the same thread", () => {
    const gates = indexThreadGates([
      { threadId: "t1", kind: "user-input" },
      { threadId: "t1", kind: "approval" },
      { threadId: "t2", kind: "user-input" },
    ]);

    expect(threadGateFor(gates, "t1")).toBe("approval");
    expect(threadGateFor(gates, "t2")).toBe("user-input");
    expect(threadGateFor(gates, "t3")).toBeNull();
  });

  it("the first approval wins and a later question never demotes it", () => {
    const gates = indexThreadGates([
      { threadId: "t1", kind: "approval" },
      { threadId: "t1", kind: "user-input" },
    ]);

    expect(threadGateFor(gates, "t1")).toBe("approval");
  });

  it("an empty parked list answers null for every thread", () => {
    const gates = indexThreadGates([]);

    expect(threadGateFor(gates, "t1")).toBeNull();
  });
});
