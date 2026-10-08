import { describe, expect, test } from "bun:test";

import { projectThreadStatus } from "./spawnProjection.js";

describe("projectThreadStatus: limited", () => {
  test("a quiet usage limit reads limited, not failed", () => {
    expect(
      projectThreadStatus({ running: false, lastState: "failed", hasLiveSession: false, limited: true }),
    ).toBe("limited");
  });

  test("a parked gate outranks limited", () => {
    expect(
      projectThreadStatus({
        gate: "approval",
        running: false,
        lastState: "failed",
        hasLiveSession: false,
        limited: true,
      }),
    ).toBe("waiting-for-approval");
  });

  test("a running turn with a live session outranks limited", () => {
    expect(
      projectThreadStatus({ running: true, lastState: "running", hasLiveSession: true, limited: true }),
    ).toBe("working");
  });

  test("without the mark a failed turn still reads failed", () => {
    expect(projectThreadStatus({ running: false, lastState: "failed", hasLiveSession: false })).toBe(
      "failed",
    );
  });
});
