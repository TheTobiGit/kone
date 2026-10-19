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
});
