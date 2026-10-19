import type { TurnTraceRecord } from "~/types/desktop";

// The demo world's per-turn traces. The scripted turn runner has no provider
// reporting usage, so it files a plausible row here as each turn settles, and
// the dev history hands them back the way the store would.

const traces = new Map<string, TurnTraceRecord[]>();

function demoModel(provider: string): string | null {
  if (provider === "claude" || provider === "claudeAgent") return "claude-sonnet-4-5";
  if (provider === "codex") return "gpt-5-codex";
  return null;
}

/** File a settled demo turn's trace. The prompt grows with the thread, as a
 *  real one does, and most of it comes back from the cache after the first
 *  turn. */
export function recordDevTurnTrace(input: {
  threadId: string;
  turnId: string;
  provider: string | null;
  turnsBefore: number;
  promptChars: number;
}): void {
  const fresh = 9_400 + Math.round(input.promptChars / 4);
  const history = input.turnsBefore * 3_800;
  const inputTokens = fresh + history;
  const cacheReadTokens = input.turnsBefore === 0 ? 0 : Math.round(history * 0.92);
  const cacheCreationTokens = input.turnsBefore === 0 ? 8_900 : 2_100;
  const outputTokens = 640 + ((input.promptChars * 37) % 1_400);
  const reasoningTokens = Math.round(outputTokens * 0.35);
  const uncached = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  const costUsd =
    (uncached * 3 + cacheCreationTokens * 3.75 + cacheReadTokens * 0.3 + outputTokens * 15) / 1_000_000;
  const provider = input.provider ?? "claude";
  const row: TurnTraceRecord = {
    turnId: input.turnId,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    provider,
    model: demoModel(provider),
    costUsd,
    at: Date.now(),
  };
  traces.set(input.threadId, [...(traces.get(input.threadId) ?? []), row]);
}

export function devTurnTraces(threadId: string): TurnTraceRecord[] {
  return traces.get(threadId) ?? [];
}
