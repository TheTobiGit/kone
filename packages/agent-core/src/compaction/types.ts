export interface CompactionSettings {
  /** Maximum context tokens allowed before compaction triggers */
  maxContextTokens: number;
  /** Tokens to preserve from recent conversation turns */
  keepRecentTokens: number;
  /** Maximum token budget for the generated summary */
  summaryTokenBudget: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  maxContextTokens: 100_000,
  keepRecentTokens: 20_000,
  summaryTokenBudget: 4_000,
};

export interface ContextUsageEstimate {
  /** Estimated token count */
  tokens: number;
  /** Total characters across text and tool items */
  characters: number;
  /** Total count of tool calls/results */
  toolItemCount: number;
}

export interface CutPointResult {
  /** Index in the blocks/entries array where the cut occurs */
  cutIndex: number;
  /** Tokens preserved in the recent window */
  preservedTokens: number;
  /** Tokens in the prefix eligible for compaction/summarization */
  compactedTokens: number;
}

export interface ExtractedBlockOperations {
  filesRead: string[];
  filesModified: string[];
  commandsRun: string[];
  keyPoints: string[];
}

export interface SemanticBranchSummary {
  summary: string;
  operations: ExtractedBlockOperations;
  estimatedTokens: number;
}
