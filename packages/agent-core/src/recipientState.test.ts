import { describe, expect, test } from "bun:test";

import { describeRecipientState, recipientState, type ThreadRuntime } from "./recipientState.js";

const NOW = 1_000_000;

function runtime(over: Partial<ThreadRuntime> = {}): ThreadRuntime {
  return {
    live: true,
    starting: false,
    busy: false,
    turnStartedAt: null,
    parked: null,
    parkedSince: null,
    compacting: false,
    steers: true,
    activeTool: null,
    lastActivityAt: NOW - 60_000,
    ...over,
  };
}

const state = (input: Parameters<typeof recipientState>[0]) => recipientState(input);

describe("recipientState", () => {
  test("a running turn is working, since it started, on the tool it is in", () => {
    const s = state({
      runtime: runtime({
        busy: true,
        turnStartedAt: NOW - 240_000,
        activeTool: { name: "Bash", text: "bun test\nmore", startedAt: NOW - 1_000 },
      }),
      unseen: 0,
      oldestUnseenAt: null,
    });
    expect(s).toMatchObject({ state: "working", since: NOW - 240_000, activity: "Bash: bun test", steers: true });
    expect(describeRecipientState(s, NOW)).toBe("working (4 min): Bash: bun test; a message goes into its running turn");
  });

  test("between tool calls a running turn says the step it is on, and nothing when none is known", () => {
    const on = (step: ThreadRuntime["step"]) =>
      state({ runtime: runtime({ busy: true, step }), unseen: 0, oldestUnseenAt: null }).activity;
    expect(on("reasoning_text")).toBe("thinking");
    expect(on("assistant_text")).toBe("writing a reply");
    expect(on("plan_text")).toBe("updating its plan");
    expect(on(null)).toBeNull();
  });

  test("an open tool call outranks the step", () => {
    const s = state({
      runtime: runtime({ busy: true, step: "reasoning_text", activeTool: { name: "read", text: "a.ts", startedAt: NOW } }),
      unseen: 0,
      oldestUnseenAt: null,
    });
    expect(s.activity).toBe("read: a.ts");
  });

  test("a provider that cannot steer says a message interrupts", () => {
    const s = state({ runtime: runtime({ busy: true, steers: false }), unseen: 0, oldestUnseenAt: null });
    expect(describeRecipientState(s, NOW)).toContain("interrupts its turn");
  });

  test("a live thread with no turn is idle since its last activity", () => {
    expect(state({ runtime: runtime(), unseen: 2, oldestUnseenAt: NOW - 5 })).toMatchObject({
      state: "idle",
      since: NOW - 60_000,
      unseen: 2,
      oldestUnseenAt: NOW - 5,
    });
  });

  test("parked on the user outranks a running turn, compaction and a wait", () => {
    const s = state({
      runtime: runtime({ busy: true, compacting: true, parked: "approval", parkedSince: NOW - 30_000 }),
      waitingOn: { threadIds: ["x"], since: NOW },
      unseen: 0,
      oldestUnseenAt: null,
    });
    expect(s).toMatchObject({ state: "waiting-on-user", since: NOW - 30_000, activity: "waiting on the user's approval" });
    expect(state({ runtime: runtime({ parked: "user-input" }), unseen: 0, oldestUnseenAt: null }).activity).toBe(
      "waiting on the user's answer",
    );
  });

  test("a wait on another agent reads before working", () => {
    const s = state({
      runtime: runtime({ busy: true }),
      waitingOn: { threadIds: ["ada", "kofi"], since: NOW - 10_000 },
      unseen: 0,
      oldestUnseenAt: null,
    });
    expect(s).toMatchObject({ state: "waiting-on-agent", waitingOn: ["ada", "kofi"], activity: "waiting on ada, kofi" });
  });

  test("compacting and starting", () => {
    expect(state({ runtime: runtime({ compacting: true }), unseen: 0, oldestUnseenAt: null }).state).toBe("compacting");
    expect(state({ runtime: runtime({ live: false, starting: true }), unseen: 0, oldestUnseenAt: null }).state).toBe(
      "starting",
    );
  });

  test("no session: a hand-off whose work is over has ended; anything else is closed", () => {
    for (const ended of ["completed", "failed", "interrupted", "stillborn"] as const) {
      expect(state({ runtime: null, spawned: ended, unseen: 0, oldestUnseenAt: null })).toMatchObject({
        state: "ended",
        ended,
      });
    }
    expect(state({ runtime: null, spawned: "idle", unseen: 0, oldestUnseenAt: null }).state).toBe("closed");
    expect(
      state({ runtime: runtime({ live: false, steers: null }), providerSteers: false, unseen: 0, oldestUnseenAt: null }),
    ).toMatchObject({ state: "closed", steers: false });
  });

  test("a finished hand-off whose session is still up is idle, so it can be followed up", () => {
    expect(state({ runtime: runtime(), spawned: "completed", unseen: 0, oldestUnseenAt: null }).state).toBe("idle");
  });
});
