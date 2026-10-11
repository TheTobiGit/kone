import { describe, expect, test } from "bun:test";

import { freezeSubagentDuration } from "./subagentDuration.js";
import type { SubagentRunSnapshot } from "./types.js";

describe("freezeSubagentDuration", () => {
  test("keeps the first terminal duration when a run resumes and settles again", () => {
    const snapshot: SubagentRunSnapshot = {
      toolUseId: "run-1",
      status: "running",
      startedAt: 100,
    };

    freezeSubagentDuration(snapshot, 145);
    snapshot.status = "running";
    snapshot.startedAt = 100;
    freezeSubagentDuration(snapshot, 220);

    expect(snapshot.durationMs).toBe(45);
  });
});
