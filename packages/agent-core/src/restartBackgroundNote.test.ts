import { describe, expect, test } from "bun:test";

import {
  compactBackgroundLabel,
  mergeRestartCancelledBackgroundWork,
  planTaskRestartWork,
  restartCancelledBackgroundWorkNote,
  subagentRestartWork,
  type RestartCancelledBackgroundWork,
} from "./restartBackgroundNote.js";

describe("compactBackgroundLabel", () => {
  test("collapses whitespace and trims", () => {
    expect(compactBackgroundLabel("  fix\n the\tbug  ")).toBe("fix the bug");
  });

  test("bounds long labels with an ellipsis", () => {
    const label = compactBackgroundLabel("x".repeat(400));
    expect(label).toHaveLength(160);
    expect(label?.endsWith("…")).toBe(true);
  });

  test("blank and absent labels have none", () => {
    expect(compactBackgroundLabel("   ")).toBeUndefined();
    expect(compactBackgroundLabel(null)).toBeUndefined();
    expect(compactBackgroundLabel(undefined)).toBeUndefined();
  });
});

describe("mergeRestartCancelledBackgroundWork", () => {
  const entry = (id: string, label = id): RestartCancelledBackgroundWork => ({
    kind: "subagent",
    label,
    id,
  });

  test("keeps first-seen order and drops duplicate identities", () => {
    expect(mergeRestartCancelledBackgroundWork([entry("a")], [entry("b"), entry("a", "again")])).toEqual([
      entry("a"),
      entry("b"),
    ]);
  });
});

describe("restartCancelledBackgroundWorkNote", () => {
  test("lists work with its kind", () => {
    const note = restartCancelledBackgroundWorkNote([
      { kind: "subagent", label: "review auth.ts", id: "s1" },
      { kind: "task", label: "write tests", id: "t1" },
    ]);
    expect(note).toContain("kone restarted");
    expect(note).toContain("- subagent: review auth.ts");
    expect(note).toContain("- task: write tests");
  });

  test("bounds the number of entries", () => {
    const work = Array.from({ length: 13 }, (_, i) => ({
      kind: "subagent" as const,
      label: `agent ${i}`,
      id: `s${i}`,
    }));
    const note = restartCancelledBackgroundWorkNote(work);
    expect(note).toContain("- and 3 more");
    expect(note.split("\n").filter((line) => line.startsWith("- subagent:"))).toHaveLength(10);
  });

  test("always says shells and monitors cannot be listed", () => {
    const note = restartCancelledBackgroundWorkNote([
      { kind: "subagent", label: "review auth.ts", id: "s1" },
    ]);
    expect(note).toContain("Background shells and monitors cannot be listed");
  });

  test("an empty list still yields the shells-and-monitors note", () => {
    const note = restartCancelledBackgroundWorkNote([]);
    expect(note).toContain("Background shells and monitors cannot be listed");
    expect(note).not.toContain("- subagent:");
  });
});

describe("subagentRestartWork", () => {
  test("prefers the description, then the agent type", () => {
    expect(
      subagentRestartWork([
        { threadId: "t1", toolUseId: "s1", description: "trace the caller", agentType: "explore" },
        { threadId: "t1", toolUseId: "s2", description: "   ", agentType: "reviewer" },
        { threadId: "t2", toolUseId: "s3", description: null, agentType: null },
      ]),
    ).toEqual([
      { threadId: "t1", work: { kind: "subagent", label: "trace the caller", id: "s1" } },
      { threadId: "t1", work: { kind: "subagent", label: "reviewer", id: "s2" } },
      { threadId: "t2", work: { kind: "subagent", label: "subagent", id: "s3" } },
    ]);
  });
});

describe("planTaskRestartWork", () => {
  test("keeps only unfinished tasks, using the task id when it has one", () => {
    const work = planTaskRestartWork([
      {
        threadId: "t1",
        itemId: "plan-1",
        tasksJson: JSON.stringify([
          { id: "a", content: "done", status: "completed" },
          { id: "b", content: "in flight", status: "in-progress" },
          { content: "queued", status: "pending" },
        ]),
      },
    ]);
    expect(work).toEqual([
      { threadId: "t1", work: { kind: "task", label: "in flight", id: "plan-1:b" } },
      { threadId: "t1", work: { kind: "task", label: "queued", id: "plan-1:2" } },
    ]);
  });

  test("ignores null and unparseable payloads", () => {
    expect(
      planTaskRestartWork([
        { threadId: "t1", itemId: "p1", tasksJson: null },
        { threadId: "t1", itemId: "p2", tasksJson: "not json" },
      ]),
    ).toEqual([]);
  });
});
