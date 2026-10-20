import { describe, expect, test } from "bun:test";
import type { TurnUsageRecord } from "./conversationStoreTypes.js";
import { turnTraces } from "./turnTraces.js";

function row(change: Partial<TurnUsageRecord>): TurnUsageRecord {
  return {
    turnId: "turn-1",
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    provider: "claude",
    model: "claude-sonnet-4-5",
    at: 1,
    ...change,
  };
}

describe("turnTraces", () => {
  test("keeps every usage field and adds a cost", () => {
    const [trace] = turnTraces({ listTurnUsage: () => [row({})] }, "t");
    expect(trace?.turnId).toBe("turn-1");
    expect(trace?.provider).toBe("claude");
    expect(trace?.inputTokens).toBe(1000);
    expect(trace).toHaveProperty("costUsd");
  });

  test("a turn with no known counts has no cost", () => {
    const [trace] = turnTraces({ listTurnUsage: () => [row({ inputTokens: null, outputTokens: null })] }, "t");
    expect(trace?.costUsd).toBeNull();
  });

  test("a turn whose model was never recorded has no cost", () => {
    const [trace] = turnTraces({ listTurnUsage: () => [row({ model: null })] }, "t");
    expect(trace?.costUsd).toBeNull();
  });

  test("a model without a price has no cost", () => {
    const [trace] = turnTraces({ listTurnUsage: () => [row({ model: "no-such-model-xyz" })] }, "t");
    expect(trace?.costUsd).toBeNull();
  });

  test("a running-total provider's turn is its step from the turn before", () => {
    const traces = turnTraces(
      {
        listTurnUsage: () => [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, outputTokens: 200, totalTokens: 1200, at: 1 }),
          row({ turnId: "turn-2", provider: "codex", inputTokens: 2500, outputTokens: 500, totalTokens: 3000, at: 2 }),
        ],
      },
      "t",
    );
    expect(traces[0]?.inputTokens).toBe(1000);
    expect(traces[1]?.inputTokens).toBe(1500);
    expect(traces[1]?.outputTokens).toBe(300);
    expect(traces[1]?.totalTokens).toBe(1800);
  });

  test("a running total that fell is read as that turn's own", () => {
    const traces = turnTraces(
      {
        listTurnUsage: () => [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 5000, at: 1 }),
          row({ turnId: "turn-2", provider: "codex", inputTokens: 800, at: 2 }),
        ],
      },
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(800);
  });

  test("a per-turn provider's rows are left as they are", () => {
    const traces = turnTraces(
      { listTurnUsage: () => [row({ turnId: "turn-1", at: 1 }), row({ turnId: "turn-2", at: 2 })] },
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1000);
  });

  test("a hand-off to another running-total provider starts its own tally", () => {
    const traces = turnTraces(
      {
        listTurnUsage: () => [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: "cursor", inputTokens: 1800, at: 2 }),
        ],
      },
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
  });

  test("a provider back after another one starts a fresh tally", () => {
    const traces = turnTraces(
      {
        listTurnUsage: () => [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: "claude", inputTokens: 400, at: 2 }),
          row({ turnId: "turn-3", provider: "codex", inputTokens: 1500, at: 3 }),
        ],
      },
      "t",
    );
    expect(traces[2]?.inputTokens).toBe(1500);
  });
});
