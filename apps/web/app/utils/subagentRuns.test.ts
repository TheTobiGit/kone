import { describe, expect, test } from "bun:test";

import type { ThreadBlock } from "~/composables/useAgent";
import type {
  SpawnedThread,
  SpawnedThreadStatus,
  SubagentRun,
  SubagentStatus,
} from "~/types/desktop";
import { deriveActiveSubagents, deriveDelegates, formatElapsed } from "./subagentRuns";
import type { DelegateState } from "./subagentRuns";

let n = 0;

function run(
  toolUseId: string,
  status: SubagentStatus,
  startedAt: number,
  extra: Partial<SubagentRun> = {},
): SubagentRun {
  return { toolUseId, status, startedAt, items: [], ...extra };
}

function runBlock(r: SubagentRun): ThreadBlock {
  return {
    id: `b${n++}`,
    role: "assistant",
    turnId: `t${n++}`,
    state: "running",
    at: r.startedAt,
    items: [
      { itemId: `i${n++}`, kind: "tool_call", status: "completed", text: "", subagent: r },
    ],
  };
}

function spawn(
  threadId: string,
  status: SpawnedThreadStatus,
  createdAt: number,
  extra: Partial<SpawnedThread> = {},
): SpawnedThread {
  return {
    threadId,
    parentThreadId: "parent-1",
    title: `child ${threadId}`,
    provider: "codex",
    status,
    terminal: false,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

describe("deriveDelegates — nested run projection", () => {
  test("a live run projects working, live, with the running-tool hint", () => {
    const s = deriveDelegates(
      [
        runBlock(
          run("t1", "running", 10, {
            lastToolName: "Edit",
            description: "Explore the repo",
            model: "gpt-5",
            effort: "high",
          }),
        ),
      ],
      [],
    );
    expect(s.rows[0]).toMatchObject({
      id: "run:t1",
      kind: "run",
      title: "Explore the repo",
      state: "working",
      live: true,
      model: "gpt-5",
      effort: "high",
      statusText: "Working",
      thinking: false,
      hint: "Running Edit…",
    });
    expect(s.rows[0]?.target).toEqual({ kind: "run", toolUseId: "t1" });
    expect(s.running).toBe(1);
    expect(s.streaming).toBe(true);
  });

  test("status → state, and a run is never parked", () => {
    const cases: [SubagentStatus, DelegateState, boolean, string][] = [
      ["starting", "working", true, "Starting…"],
      ["running", "working", true, "Working"],
      ["completed", "done", false, "Done"],
      ["failed", "failed", false, "Failed"],
      ["stopped", "failed", false, "Stopped"],
    ];
    for (const [status, state, live, statusText] of cases) {
      const row = deriveDelegates([runBlock(run("t1", status, 1))], []).rows[0];
      expect(row?.state).toBe(state);
      expect(row?.live).toBe(live);
      expect(row?.state).not.toBe("parked");
      expect(row?.statusText).toBe(statusText);
    }
  });

  test("a live run whose tail is reasoning reads Thinking, not Working", () => {
    const r = run("t1", "running", 1);
    r.items = [
      { itemId: "a", kind: "tool_call", status: "completed", text: "" },
      { itemId: "b", kind: "reasoning_text", status: "in-progress", text: "…" },
    ];
    const s = deriveDelegates([runBlock(r)], []);
    expect(s.rows[0]?.statusText).toBe("Thinking");
    expect(s.rows[0]?.thinking).toBe(true);
  });

  test("a settled run carries no hint, even with a lastToolName", () => {
    const row = deriveDelegates(
      [runBlock(run("t1", "completed", 1, { lastToolName: "Edit" }))],
      [],
    ).rows[0];
    expect(row?.hint).toBe("");
    expect(row?.thinking).toBe(false);
  });
});

describe("deriveDelegates — spawned thread projection", () => {
  test("status → state exactly", () => {
    const cases: [SpawnedThreadStatus, DelegateState, boolean][] = [
      ["working", "working", true],
      ["waiting-for-approval", "parked", true],
      ["waiting-for-user-input", "parked", true],
      ["completed", "done", false],
      ["failed", "failed", false],
      ["stillborn", "failed", false],
      ["interrupted", "failed", false],
      ["idle", "idle", false],
    ];
    for (const [status, state, live] of cases) {
      const row = deriveDelegates([], [spawn("c1", status, 1)]).rows[0];
      expect(row?.state).toBe(state);
      expect(row?.live).toBe(live);
    }
  });

  test("identity, model/effort, provider and target come off the value", () => {
    const row = deriveDelegates(
      [],
      [spawn("c1", "working", 5, { title: "Write the docs", model: "claude-4", effort: "high" })],
    ).rows[0];
    expect(row).toMatchObject({
      id: "thread:c1",
      kind: "thread",
      title: "Write the docs",
      startedAt: 5,
      model: "claude-4",
      effort: "high",
      provider: "codex",
    });
    expect(row?.target).toEqual({ kind: "thread", threadId: "c1" });
  });

  test("status words and hint details, verbatim", () => {
    expect(
      deriveDelegates([], [spawn("c1", "working", 1, { elapsedMs: 80_000 })]).rows[0],
    ).toMatchObject({ statusText: "Working", hint: "1m 20s" });
    expect(deriveDelegates([], [spawn("c2", "working", 1)]).rows[0]).toMatchObject({
      statusText: "Working",
      hint: "",
    });
    expect(deriveDelegates([], [spawn("c3", "waiting-for-approval", 1)]).rows[0]).toMatchObject({
      statusText: "Waiting for approval",
      hint: "",
    });
    expect(deriveDelegates([], [spawn("c4", "waiting-for-user-input", 1)]).rows[0]).toMatchObject({
      statusText: "Waiting for your answer",
      hint: "",
    });
    expect(
      deriveDelegates([], [spawn("c5", "completed", 1, { elapsedMs: 52_000 })]).rows[0],
    ).toMatchObject({ statusText: "Done in 52s", hint: "" });
    expect(deriveDelegates([], [spawn("c6", "completed", 1)]).rows[0]).toMatchObject({
      statusText: "Done",
      hint: "",
    });
    expect(deriveDelegates([], [spawn("c7", "failed", 1)]).rows[0]).toMatchObject({
      statusText: "Failed",
      hint: "",
    });
    expect(deriveDelegates([], [spawn("c8", "interrupted", 1)]).rows[0]).toMatchObject({
      statusText: "Interrupted",
      hint: "",
    });
    expect(deriveDelegates([], [spawn("c9", "idle", 1)]).rows[0]).toMatchObject({
      statusText: "Queued",
      hint: "",
    });
  });

  test("a failed thread reads its detail when there is one", () => {
    const row = deriveDelegates([], [spawn("c1", "failed", 1, { detail: "quota exceeded" })]).rows[0];
    expect(row?.hint).toBe("quota exceeded");
    expect(row?.statusText).toBe("Failed");
  });

  test("a whitespace-only detail leaves the status word alone", () => {
    const row = deriveDelegates([], [spawn("c1", "failed", 1, { detail: "   \n  " })]).rows[0];
    expect(row?.hint).toBe("");
    expect(row?.statusText).toBe("Failed");
  });

  test("a long failure detail is capped at 80 chars with hintFull", () => {
    const long = "e".repeat(85);
    const row = deriveDelegates([], [spawn("c1", "failed", 1, { detail: long })]).rows[0];
    expect(row?.hint).toBe(`${"e".repeat(80)}…`);
    expect(row?.hintFull).toBe(long);
  });

  test("truncation trims trailing whitespace before the ellipsis", () => {
    // 79 a's + two spaces + 10 b's: the collapse leaves one space at char 79, so
    // the 80-char slice ends in whitespace that must be trimmed before the `…`.
    const raw = "a".repeat(79) + "  " + "b".repeat(10);
    const row = deriveDelegates([], [spawn("c1", "failed", 1, { detail: raw })]).rows[0];
    expect(row?.hint).toBe(`${"a".repeat(79)}…`);
    expect(row?.hintFull).toBe("a".repeat(79) + " " + "b".repeat(10));
  });

  test("a multi-line detail collapses to one line", () => {
    const row = deriveDelegates([], [spawn("c1", "failed", 1, { detail: "Parse failed\n  at line 3\n\nunexpected token" })]).rows[0];
    expect(row?.hint).toBe("Parse failed at line 3 unexpected token");
  });

  test("no hintFull when nothing was truncated", () => {
    const s = deriveDelegates(
      [runBlock(run("t1", "running", 1))],
      [spawn("c1", "working", 2, { elapsedMs: 5000 }), spawn("c2", "failed", 3, { detail: "short" })],
    );
    for (const row of s.rows) expect(row.hintFull).toBeUndefined();
  });
});

describe("deriveDelegates — timeline and counts", () => {
  test("interleaves a run and a thread chronologically", () => {
    const s = deriveDelegates(
      [runBlock(run("t1", "running", 30)), runBlock(run("t2", "completed", 10))],
      [spawn("c1", "working", 20)],
    );
    expect(s.rows.map((r) => r.id)).toEqual(["run:t2", "thread:c1", "run:t1"]);
  });

  test("a parked thread stays live, counted, and streaming", () => {
    const s = deriveDelegates([], [spawn("c1", "waiting-for-approval", 1)]);
    expect(s.rows[0]?.live).toBe(true);
    expect(s.running).toBe(1);
    expect(s.streaming).toBe(true);
  });

  test("running counts live runs plus parked threads", () => {
    const s = deriveDelegates(
      [runBlock(run("t1", "running", 1)), runBlock(run("t2", "completed", 2))],
      [spawn("c1", "waiting-for-user-input", 3)],
    );
    expect(s.running).toBe(2);
    expect(s.streaming).toBe(true);
  });

  test("streaming goes quiet once nothing is live", () => {
    const s = deriveDelegates(
      [runBlock(run("t1", "completed", 1))],
      [spawn("c1", "completed", 2), spawn("c2", "failed", 3), spawn("c3", "interrupted", 4)],
    );
    expect(s.running).toBe(0);
    expect(s.streaming).toBe(false);
  });

  test("empty input yields an empty, quiet state", () => {
    const s = deriveDelegates([], []);
    expect(s.rows).toEqual([]);
    expect(s.running).toBe(0);
    expect(s.streaming).toBe(false);
  });
});

describe("deriveActiveSubagents", () => {
  test("still derives the runs it always did", () => {
    const blocks = [
      runBlock(run("t1", "running", 1, { lastToolName: "Edit" })),
      runBlock(run("t2", "completed", 2)),
      runBlock(run("t3", "stopped", 3)),
    ];
    const sub = deriveActiveSubagents(blocks);
    expect(sub.runs.map((r) => [r.toolUseId, r.live])).toEqual([
      ["t1", true],
      ["t2", false],
      ["t3", false],
    ]);
    expect(sub.running).toBe(1);
    expect(sub.streaming).toBe(true);
  });
});

describe("formatElapsed", () => {
  test("compacts seconds, minutes, hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(52_000)).toBe("52s");
    expect(formatElapsed(80_000)).toBe("1m 20s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(3_840_000)).toBe("1h 4m");
    expect(formatElapsed(3_600_000)).toBe("1h");
  });
});
