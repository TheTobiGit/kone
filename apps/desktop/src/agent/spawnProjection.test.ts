import { describe, expect, test } from "bun:test";

import {
  SPAWN_SUMMARY_TRUNCATION_MARKER,
  projectSpawnedThread,
} from "./spawnProjection.js";
import type { SpawnProjectionInput, SpawnProjectionTurn } from "./spawnProjection.js";
import { SPAWN_SUMMARY_CHAR_CAP } from "./types.js";

describe("projectSpawnedThread", () => {
  function base(overrides: Partial<SpawnProjectionInput> = {}): SpawnProjectionInput {
    return {
      thread: {
        threadId: "child-1",
        parentThreadId: "root-1",
        title: "Fix the flaky test",
        provider: "opencode",
        createdAt: 100,
        updatedAt: 200,
      },
      turns: [],
      hasLiveSession: true,
      now: 500,
      ...overrides,
    };
  }

  function turn(partial: Partial<SpawnProjectionTurn> & Pick<SpawnProjectionTurn, "at">): SpawnProjectionTurn {
    return { turnId: "t", state: "completed", ...partial };
  }

  test("an approval gate beats a running turn, even with no live session", () => {
    const result = projectSpawnedThread(
      base({
        turns: [turn({ at: 10, state: "running" })],
        gate: { kind: "approval", detail: "Run the script?" },
        hasLiveSession: false,
      }),
    );
    expect(result.status).toBe("waiting-for-approval");
    expect(result.terminal).toBe(false);
    expect(result.detail).toBe("Run the script?");
  });

  test("a user-input gate reports waiting-for-user-input with its detail", () => {
    const result = projectSpawnedThread(
      base({
        turns: [turn({ at: 10, state: "running" })],
        gate: { kind: "user-input", detail: "Which framework?" },
      }),
    );
    expect(result.status).toBe("waiting-for-user-input");
    expect(result.terminal).toBe(false);
    expect(result.detail).toBe("Which framework?");
  });

  test("an approval gate carries its requestId + ask for an in-place decide", () => {
    const result = projectSpawnedThread(
      base({
        turns: [turn({ at: 10, state: "running" })],
        gate: {
          kind: "approval",
          detail: "Run the script?",
          requestId: "ap-7",
          approval: { kind: "command", title: "Run the script?" },
        },
      }),
    );
    expect(result.status).toBe("waiting-for-approval");
    expect(result.terminal).toBe(false);
    expect(result.detail).toBe("Run the script?");
    expect(result.gate).toEqual({
      requestId: "ap-7",
      approval: { kind: "command", title: "Run the script?" },
    });
  });

  test("a gate without requestId/approval carries no decide payload", () => {
    const result = projectSpawnedThread(
      base({
        turns: [turn({ at: 10, state: "running" })],
        gate: { kind: "approval", detail: "Run it?" },
      }),
    );
    expect(result.status).toBe("waiting-for-approval");
    expect(result.gate).toBeUndefined();
  });

  test("a running turn with no live session reads interrupted and terminal", () => {
    const result = projectSpawnedThread(
      base({ turns: [turn({ at: 10, state: "running" })], hasLiveSession: false }),
    );
    expect(result.status).toBe("interrupted");
    expect(result.terminal).toBe(true);
  });

  test("a running turn with a live session reads working, not terminal", () => {
    const result = projectSpawnedThread(
      base({ turns: [turn({ at: 10, state: "running" })], hasLiveSession: true }),
    );
    expect(result.status).toBe("working");
    expect(result.terminal).toBe(false);
  });

  test("the last turn's failure decides, carrying its error as the detail", () => {
    const result = projectSpawnedThread(
      base({
        turns: [
          turn({ turnId: "t1", at: 10, state: "completed", endedAt: 50 }),
          turn({ turnId: "t2", at: 60, state: "failed", endedAt: 90, error: "No more retries" }),
        ],
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.terminal).toBe(true);
    expect(result.detail).toBe("No more retries");
  });

  test("a failed turn without an error carries no detail key", () => {
    const result = projectSpawnedThread(base({ turns: [turn({ at: 10, state: "failed", endedAt: 20 })] }));
    expect(result.status).toBe("failed");
    expect(result.detail).toBeUndefined();
  });

  test("a settled completed turn is terminal", () => {
    const result = projectSpawnedThread(
      base({ turns: [turn({ at: 10, state: "completed", endedAt: 30 })] }),
    );
    expect(result.status).toBe("completed");
    expect(result.terminal).toBe(true);
  });

  test("a settled interrupted turn is terminal", () => {
    const result = projectSpawnedThread(
      base({ turns: [turn({ at: 10, state: "interrupted", endedAt: 30 })] }),
    );
    expect(result.status).toBe("interrupted");
    expect(result.terminal).toBe(true);
  });

  test("no turns with a live session reads starting, not terminal (F8)", () => {
    const result = projectSpawnedThread(base());
    expect(result.status).toBe("starting");
    expect(result.terminal).toBe(false);
    expect(result.elapsedMs).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  test("no turns and no live session reads stillborn, terminal (F8)", () => {
    const result = projectSpawnedThread(base({ hasLiveSession: false }));
    expect(result.status).toBe("stillborn");
    expect(result.terminal).toBe(true);
    expect(result.elapsedMs).toBeUndefined();
  });

  test("summary is trimmed and omitted when blank", () => {
    const trimmed = projectSpawnedThread(
      base({ latestAssistantText: "  Done.  \n" }),
    );
    expect(trimmed.summary).toBe("Done.");

    for (const text of [undefined, null, "", "   "]) {
      const result = projectSpawnedThread(base({ latestAssistantText: text }));
      expect(result.summary).toBeUndefined();
    }
  });

  test("a summary over the cap is cut and marked, one at the cap passes through", () => {
    const long = "x".repeat(SPAWN_SUMMARY_CHAR_CAP + 10);
    const capped = projectSpawnedThread(base({ latestAssistantText: long }));
    expect(capped.summary).toBe(`${"x".repeat(SPAWN_SUMMARY_CHAR_CAP)}${SPAWN_SUMMARY_TRUNCATION_MARKER}`);
    expect(SPAWN_SUMMARY_TRUNCATION_MARKER).toContain("kone_read_thread");

    const exact = projectSpawnedThread(
      base({ latestAssistantText: "y".repeat(SPAWN_SUMMARY_CHAR_CAP) }),
    );
    expect(exact.summary).toBe("y".repeat(SPAWN_SUMMARY_CHAR_CAP));
  });

  test("elapsedMs sums finished turns to ended_at and running turns to now", () => {
    const result = projectSpawnedThread(
      base({
        turns: [
          turn({ turnId: "t1", at: 100, state: "completed", endedAt: 300 }),
          turn({ turnId: "t2", at: 400, state: "running" }),
        ],
        now: 500,
      }),
    );
    expect(result.elapsedMs).toBe(300);
  });

  test("elapsedMs is floored at zero per turn against clock skew", () => {
    const result = projectSpawnedThread(
      base({
        turns: [
          turn({ turnId: "t1", at: 300, state: "completed", endedAt: 100 }),
          turn({ turnId: "t2", at: 200, state: "running" }),
        ],
        now: 150,
      }),
    );
    expect(result.elapsedMs).toBe(0);
  });

  test("a completed turn missing ended_at still projects sanely", () => {
    const result = projectSpawnedThread(
      base({ turns: [turn({ at: 100, state: "completed" })], now: 500 }),
    );
    expect(result.status).toBe("completed");
    expect(result.terminal).toBe(true);
    expect(result.elapsedMs).toBe(400);
  });

  test("tokens, model, effort and updatedAt pass through when present", () => {
    const result = projectSpawnedThread(
      base({
        thread: {
          threadId: "child-1",
          parentThreadId: "root-1",
          title: "T",
          provider: "opencode",
          model: "deepseek-v4",
          effort: "high",
          createdAt: 100,
          updatedAt: 250,
        },
        tokens: 42,
      }),
    );
    expect(result.tokens).toBe(42);
    expect(result.model).toBe("deepseek-v4");
    expect(result.effort).toBe("high");
    expect(result.updatedAt).toBe(250);

    const bare = projectSpawnedThread(base());
    expect(bare.tokens).toBeUndefined();
    expect(bare.model).toBeUndefined();
    expect(bare.effort).toBeUndefined();
  });
});
