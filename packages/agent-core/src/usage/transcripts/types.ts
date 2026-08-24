// contract). Claude/Codex jsonl transcripts plus OpenCode/Droid local logs and
// Antigravity's protobuf-bearing conversation stores.

export type TranscriptProviderKind = "claude" | "codex" | "opencode" | "droid" | "antigravity";

/** Token counts for one parsed transcript record. */
export type UsageTokenTotals = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};
