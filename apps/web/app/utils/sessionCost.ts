import type { SessionSummary } from "~/types/session";

/**
 * Calculates or estimates the USD cost of a session thread.
 * If the session carries an explicit `costUsd` (reported or pre-computed), that is returned directly.
 * Otherwise, estimates the spend from the thread's accumulated tokens and model family rates.
 */
export function sessionCost(s: SessionSummary): number {
  if (s.costUsd !== undefined && s.costUsd !== null && Number.isFinite(s.costUsd) && s.costUsd >= 0) {
    return s.costUsd;
  }
  const tokens = s.tokens ?? 0;
  if (tokens <= 0) return 0;

  const model = (s.model ?? "").toLowerCase();
  const provider = s.provider;

  // Blended average cost per 1,000,000 tokens (accounting for conversational input/cache/output ratios)
  let ratePerMillion = 3.5;

  if (model.includes("opus")) {
    ratePerMillion = 24.0;
  } else if (model.includes("haiku")) {
    ratePerMillion = 1.4;
  } else if (model.includes("sonnet")) {
    ratePerMillion = 4.8;
  } else if (model.includes("flash")) {
    ratePerMillion = 0.2;
  } else if (model.includes("pro") && (model.includes("gemini") || provider === "antigravity")) {
    ratePerMillion = 1.5;
  } else if ((model.includes("mini") && !model.includes("gemini")) || model.includes("deepseek") || model.includes("r1")) {
    ratePerMillion = 0.45;
  } else if (model.includes("o1") || model.includes("o3")) {
    ratePerMillion = 6.0;
  } else if (provider === "claudeAgent") {
    ratePerMillion = 4.8;
  } else if (provider === "codex") {
    ratePerMillion = 3.5;
  } else if (provider === "antigravity") {
    ratePerMillion = 1.5;
  }

  return (tokens / 1_000_000) * ratePerMillion;
}
