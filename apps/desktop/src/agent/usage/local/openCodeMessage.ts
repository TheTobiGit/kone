// Parses OpenCode assistant messages from its local SQLite log or message JSON

import type { TranscriptProviderKind, UsageTokenTotals } from "../transcripts/types.js";
import type { UsageRecord } from "../transcripts/transcripts.js";

type OpenCodeMessagePayload = {
  id?: string;
  sessionID?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number };
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function resolveOpenCodeModelName(model: string): string {
  if (model === "gemini-3-pro-high") return "gemini-3-pro-preview";
  if (model === "k2p6") return "kimi-k2.6";
  return model;
}

function normalizeOpenCodeModelName(model: string): string {
  for (const family of ["claude-haiku-", "claude-opus-", "claude-sonnet-"]) {
    if (model.startsWith(family)) {
      const rest = model.slice(family.length);
      const match = rest.match(/^(\d+)-(\d+)/);
      if (match) {
        return `${family}${match[1]}-${match[2]}${rest.slice(match[0].length)}`;
      }
    }
  }
  return model;
}

/** Model ids kone's pricing resolver may recognize for an OpenCode row. */
export function openCodeModelCandidates(model: string, provider: string): string[] {
  const resolved = resolveOpenCodeModelName(model);
  const normalized = normalizeOpenCodeModelName(resolved);
  const base = normalized !== resolved ? [resolved, normalized] : [resolved];
  const candidates = [...base];
  if (provider && provider !== "unknown") {
    const slug = provider.replace(/-/g, "_");
    for (const entry of base) {
      candidates.push(`${slug}/${entry}`);
    }
    candidates.push(`${provider}/${resolved}`);
    if (normalized !== resolved) candidates.push(`${provider}/${normalized}`);
  }
  return [...new Set(candidates)];
}

function pickPricedModel(model: string, provider: string): string {
  const candidates = openCodeModelCandidates(model, provider);
  return candidates.find((c) => c.includes("/")) ?? candidates[0] ?? model;
}

function totalsFromPayload(tokens: OpenCodeMessagePayload["tokens"]): UsageTokenTotals | null {
  if (!tokens) return null;
  const cache = tokens.cache;
  const reasoning = int(tokens.reasoning);
  // opencode counts reasoning outside `output` — a message's own total is
  // input + output + reasoning + cache.read + cache.write. Fold reasoning into
  // output so the record reconciles with that total, while the report still
  // carries the reasoning share of output separately without double counting.
  const output = int(tokens.output) + reasoning;
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(tokens.input),
    cachedInputTokens: int(cache?.read),
    cacheCreationTokens: int(cache?.write),
    outputTokens: output,
    reasoningTokens: reasoning,
  };
  const explicitTotal = int(tokens.total);
  const sum =
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens;
  if (sum === 0 && explicitTotal > 0) {
    totals.outputTokens = explicitTotal;
    totals.reasoningTokens = 0;
  }
  if (
    totals.uncachedInputTokens +
      totals.cachedInputTokens +
      totals.cacheCreationTokens +
      totals.outputTokens ===
    0
  ) {
    return null;
  }
  return totals;
}

export function parseOpenCodeMessageJson(
  raw: string,
  ids?: { messageId?: string; sessionId?: string },
): UsageRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  // SAFETY: value passed the object check above; every field read off payload
  // is individually guarded (totalsFromPayload returns null otherwise).
  const payload = value as OpenCodeMessagePayload;
  const totals = totalsFromPayload(payload.tokens);
  if (!totals) return null;

  const modelRaw = typeof payload.modelID === "string" ? payload.modelID.trim() : "";
  const providerRaw = typeof payload.providerID === "string" ? payload.providerID.trim() : "";
  if (!modelRaw) return null;

  const timestampMs =
    typeof payload.time?.created === "number" && Number.isFinite(payload.time.created)
      ? payload.time.created
      : extractMessageTimestampMs(raw) ?? 0;
  if (timestampMs <= 0) return null;

  const messageId = ids?.messageId ?? (typeof payload.id === "string" ? payload.id.trim() : "");
  const sessionId =
    ids?.sessionId ??
    (typeof payload.sessionID === "string" ? payload.sessionID.trim() : "") ??
    "";

  const reportedCostUsd =
    typeof payload.cost === "number" && Number.isFinite(payload.cost) && payload.cost > 0
      ? payload.cost
      : null;

  const model = pickPricedModel(modelRaw, providerRaw);

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd,
    dedupeKey: messageId.length > 0 ? `opencode:${messageId}` : null,
  };
}

/** Fast timestamp extraction from raw JSON without full parse. */
export function extractMessageTimestampMs(data: string): number | null {
  const timeKey = '"time":';
  const timeIdx = data.indexOf(timeKey);
  if (timeIdx < 0) return null;
  const createdKey = '"created":';
  const slice = data.slice(timeIdx);
  const createdIdx = slice.indexOf(createdKey);
  if (createdIdx < 0) return null;
  const after = slice.slice(createdIdx + createdKey.length).trimStart();
  let end = 0;
  while (end < after.length) {
    const ch = after.charAt(end);
    if (ch < "0" || ch > "9") break;
    end += 1;
  }
  if (end === 0) return null;
  const parsed = Number(after.slice(0, end));
  return Number.isFinite(parsed) ? parsed : null;
}

export const OPENCODE_PROVIDER: TranscriptProviderKind = "opencode";
