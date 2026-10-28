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
    usageSessionId: null,
    at: 1,
    ...change,
  };
}

function storeOf(
  rows: TurnUsageRecord[],
  handIns: ReadonlyArray<{ at: number }> = [],
) {
  return {
    listTurnUsage: () => rows,
    handInsForThread: () => handIns,
  };
}

describe("turnTraces", () => {
  test("keeps every usage field and adds a cost", () => {
    const [trace] = turnTraces(storeOf([row({})]), "t");
    expect(trace?.turnId).toBe("turn-1");
    expect(trace?.provider).toBe("claude");
    expect(trace?.inputTokens).toBe(1000);
    expect(trace).toHaveProperty("costUsd");
  });

  test("a turn with no known counts has no cost", () => {
    const [trace] = turnTraces(storeOf([row({ inputTokens: null, outputTokens: null })]), "t");
    expect(trace?.costUsd).toBeNull();
  });

  test("a turn whose model was never recorded has no cost", () => {
    const [trace] = turnTraces(storeOf([row({ model: null })]), "t");
    expect(trace?.costUsd).toBeNull();
  });

  test("a model without a price has no cost", () => {
    const [trace] = turnTraces(storeOf([row({ model: "no-such-model-xyz" })]), "t");
    expect(trace?.costUsd).toBeNull();
  });

  test("a running-total provider's turn is its step from the turn before", () => {
    const traces = turnTraces(
      storeOf([
        row({
          turnId: "turn-1",
          provider: "codex",
          usageSessionId: "session-a",
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          at: 1,
        }),
        row({
          turnId: "turn-2",
          provider: "codex",
          usageSessionId: "session-a",
          inputTokens: 2500,
          outputTokens: 500,
          totalTokens: 3000,
          at: 2,
        }),
      ]),
      "t",
    );
    expect(traces[0]?.inputTokens).toBe(1000);
    expect(traces[1]?.inputTokens).toBe(1500);
    expect(traces[1]?.outputTokens).toBe(300);
    expect(traces[1]?.totalTokens).toBe(1800);
  });

  test("a fresh same-provider session with no hand-in and a larger first count starts its own tally", () => {
    const traces = turnTraces(
      storeOf([
        row({
          turnId: "turn-1",
          provider: "codex",
          model: "gpt-5",
          usageSessionId: "session-a",
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          at: 1,
        }),
        row({
          turnId: "turn-2",
          provider: "codex",
          model: "gpt-5",
          usageSessionId: "session-b",
          inputTokens: 1800,
          outputTokens: 200,
          totalTokens: 2000,
          at: 2,
        }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
    expect(traces[1]?.outputTokens).toBe(200);
    expect(traces[1]?.totalTokens).toBe(2000);
  });

  test("the session id decides, not the provider, model or clock", () => {
    const traces = turnTraces(
      storeOf(
        [
          row({ turnId: "turn-1", provider: "codex", model: "gpt-5", usageSessionId: "session-a", inputTokens: 1000, at: 2 }),
          row({ turnId: "turn-2", provider: "codex", model: "gpt-5", usageSessionId: "session-b", inputTokens: 1800, at: 2 }),
          row({ turnId: "turn-3", provider: "codex", model: "gpt-5", usageSessionId: "session-b", inputTokens: 2400, at: 2 }),
        ],
        [{ at: 2 }],
      ),
      "t",
    );
    // session-b is a new counter even though provider, model and millisecond
    // are all identical to session-a's row.
    expect(traces[1]?.inputTokens).toBe(1800);
    expect(traces[2]?.inputTokens).toBe(600);
  });

  test("a model change inside one session continues the same tally", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", provider: "codex", model: "gpt-5", usageSessionId: "session-a", inputTokens: 1000, at: 1 }),
        row({
          turnId: "turn-2",
          provider: "codex",
          model: "gpt-5-mini",
          usageSessionId: "session-a",
          inputTokens: 2500,
          at: 2,
        }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1500);
  });

  test("a legacy hand-in still starts a fresh tally for rows with no session id", () => {
    const traces = turnTraces(
      storeOf(
        [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: "codex", inputTokens: 1800, at: 3 }),
        ],
        [{ at: 2 }],
      ),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
  });

  test("a hand-in after every legacy usage row leaves the earlier tally alone", () => {
    const traces = turnTraces(
      storeOf(
        [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: "codex", inputTokens: 2500, at: 2 }),
        ],
        [{ at: 3 }],
      ),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1500);
  });

  test("several hand-ins before the next legacy row still start one fresh tally", () => {
    const traces = turnTraces(
      storeOf(
        [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: "codex", inputTokens: 1800, at: 5 }),
        ],
        [{ at: 2 }, { at: 3 }],
      ),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
  });

  test("an identified row after an unidentified one is not subtracted across the unknown boundary", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", provider: "codex", usageSessionId: null, inputTokens: 1000, at: 1 }),
        row({ turnId: "turn-2", provider: "codex", usageSessionId: "session-a", inputTokens: 1800, at: 2 }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
  });

  test("an unidentified row after an identified one is not subtracted across the unknown boundary", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", provider: "codex", usageSessionId: "session-a", inputTokens: 1000, at: 1 }),
        row({ turnId: "turn-2", provider: "codex", usageSessionId: null, inputTokens: 1800, at: 2 }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
  });

  test("rows without a recorded provider are left as stored", () => {
    const traces = turnTraces(
      storeOf(
        [
          row({ turnId: "turn-1", provider: null, inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: null, inputTokens: 2000, at: 3 }),
        ],
        [{ at: 2 }],
      ),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(2000);
  });

  test("a running total that fell is read as that turn's own", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", provider: "codex", usageSessionId: "session-a", inputTokens: 5000, at: 1 }),
        row({ turnId: "turn-2", provider: "codex", usageSessionId: "session-a", inputTokens: 800, at: 2 }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(800);
  });

  test("a per-turn provider's rows are left as they are", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", usageSessionId: "session-a", at: 1 }),
        row({ turnId: "turn-2", usageSessionId: "session-a", at: 2 }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1000);
  });

  test("a hand-off to another running-total provider starts its own tally", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", provider: "codex", usageSessionId: "session-a", inputTokens: 1000, at: 1 }),
        row({ turnId: "turn-2", provider: "cursor", usageSessionId: "session-b", inputTokens: 1800, at: 2 }),
      ]),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(1800);
  });

  test("a provider back after another one starts a fresh tally", () => {
    const traces = turnTraces(
      storeOf([
        row({ turnId: "turn-1", provider: "codex", usageSessionId: "session-a", inputTokens: 1000, at: 1 }),
        row({ turnId: "turn-2", provider: "claude", usageSessionId: "session-b", inputTokens: 400, at: 2 }),
        row({ turnId: "turn-3", provider: "codex", usageSessionId: "session-c", inputTokens: 1500, at: 3 }),
      ]),
      "t",
    );
    expect(traces[2]?.inputTokens).toBe(1500);
  });

  test("legacy providers around a hand-in keep their old boundary reading", () => {
    const traces = turnTraces(
      storeOf(
        [
          row({ turnId: "turn-1", provider: "codex", inputTokens: 1000, at: 1 }),
          row({ turnId: "turn-2", provider: "claude", inputTokens: 400, at: 2 }),
          row({ turnId: "turn-3", provider: "codex", inputTokens: 1500, at: 3 }),
        ],
        [{ at: 1.5 }, { at: 2.5 }],
      ),
      "t",
    );
    expect(traces[1]?.inputTokens).toBe(400);
    expect(traces[2]?.inputTokens).toBe(1500);
  });
});
