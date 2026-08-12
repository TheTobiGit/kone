// Parses Droid session snapshots from `~/.factory/sessions/**/*.settings.json`

import * as fs from "node:fs";
import path from "node:path";

import type { UsageRecord } from "../transcripts/transcripts.js";

type DroidSettings = {
  model?: string;
  providerLock?: string;
  providerLockTimestamp?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    thinkingTokens?: number;
    totalTokens?: number;
  };
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function normalizeDroidModelName(model: string): string {
  const raw = model.startsWith("custom:") ? model.slice("custom:".length) : model;
  let withoutBrackets = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) withoutBrackets += ch;
  }
  const lower = withoutBrackets.trim().replace(/-+$/u, "").toLowerCase();
  let normalized = "";
  let previousDash = false;
  for (const ch of lower) {
    const next = ch === "." || /\s/.test(ch) || ch === "-" ? "-" : ch;
    if (next === "-") {
      if (!previousDash) {
        normalized += "-";
        previousDash = true;
      }
    } else {
      normalized += next;
      previousDash = false;
    }
  }
  return normalized.replace(/^-+|-+$/g, "");
}

function normalizeDroidProvider(value: string | undefined): string {
  if (!value?.trim()) return "unknown";
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  switch (normalized) {
    case "claude":
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "google":
    case "google_ai":
    case "gemini":
    case "vertex":
    case "vertex_ai":
      return "google";
    case "xai":
    case "x_ai":
    case "grok":
      return "xai";
    default:
      return normalized;
  }
}

function inferDroidProviderFromModel(model: string): string {
  if (
    model.includes("claude") ||
    model.includes("opus") ||
    model.includes("sonnet") ||
    model.includes("haiku")
  ) {
    return "anthropic";
  }
  if (
    model.startsWith("gpt-") ||
    model.includes("-gpt-") ||
    model.includes("chatgpt") ||
    (model.startsWith("o") &&
      model.length > 1 &&
      model.charAt(1) >= "0" &&
      model.charAt(1) <= "9")
  ) {
    return "openai";
  }
  if (model.includes("gemini")) return "google";
  if (model.includes("grok")) return "xai";
  return "unknown";
}

function defaultModelFromProvider(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "claude-unknown";
    case "openai":
      return "gpt-unknown";
    case "google":
      return "gemini-unknown";
    case "xai":
      return "grok-unknown";
    default:
      return "unknown";
  }
}

function droidModelCandidates(model: string, provider: string): string[] {
  const candidates = [model];
  const prefixes: string[] = [];
  switch (provider) {
    case "anthropic":
      prefixes.push("anthropic/", "openrouter/anthropic/");
      break;
    case "openai":
      prefixes.push("openai/", "openrouter/openai/");
      break;
    case "google":
      prefixes.push("google/", "vertex_ai/", "openrouter/google/");
      break;
    case "xai":
      prefixes.push("xai/", "openrouter/x-ai/");
      break;
    default:
      if (provider !== "unknown") {
        prefixes.push(`${provider}/`, `openrouter/${provider}/`);
      }
  }
  for (const prefix of prefixes) {
    candidates.push(`${prefix}${model}`);
  }
  return [...new Set(candidates)];
}

function pickPricedModel(model: string, provider: string): string {
  const candidates = droidModelCandidates(model, provider);
  return candidates.find((c) => c.includes("/")) ?? candidates[0] ?? model;
}

function extractModelFromSidecarJsonl(settingsPath: string): string | null {
  const fileName = path.basename(settingsPath);
  const prefix = fileName.endsWith(".settings.json")
    ? fileName.slice(0, -".settings.json".length)
    : null;
  if (!prefix) return null;
  const sidecar = path.join(path.dirname(settingsPath), `${prefix}.jsonl`);
  try {
    const content = fs.readFileSync(sidecar, "utf8");
    for (const line of content.split(/\r?\n/).slice(0, 500)) {
      const tail = line.split("Model:")[1];
      if (!tail) continue;
      const raw = tail.split(/["\\[]/)[0]?.trim();
      if (raw) return normalizeDroidModelName(raw);
    }
  } catch {
    // No sidecar — model may live in settings.
  }
  return null;
}

function settingsTimestampMs(settings: DroidSettings, filePath: string): number | null {
  const ts = settings.providerLockTimestamp?.trim();
  if (ts) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    return Number.isFinite(mtime) ? mtime : null;
  } catch {
    return null;
  }
}

export function parseDroidSettingsFile(filePath: string, raw: string): UsageRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const settings = value as DroidSettings;
  const usage = settings.tokenUsage;
  if (!usage) return null;

  let inputTokens = int(usage.inputTokens);
  let outputTokens = int(usage.outputTokens);
  const cacheCreation = int(usage.cacheCreationTokens);
  const cacheRead = int(usage.cacheReadTokens);
  const thinking = int(usage.thinkingTokens);
  const totalTokens = int(usage.totalTokens);

  const sum = inputTokens + outputTokens + cacheCreation + cacheRead + thinking;
  if (sum === 0 && totalTokens > 0) {
    outputTokens = totalTokens;
  }
  if (inputTokens + outputTokens + cacheCreation + cacheRead + thinking === 0) {
    return null;
  }

  const outputForTotals = outputTokens + thinking;

  let provider = normalizeDroidProvider(settings.providerLock);
  let model = settings.model?.trim()
    ? normalizeDroidModelName(settings.model)
    : extractModelFromSidecarJsonl(filePath) ?? defaultModelFromProvider(provider);
  if (!model) model = defaultModelFromProvider(provider);
  if (provider === "unknown") provider = inferDroidProviderFromModel(model);

  const timestampMs = settingsTimestampMs(settings, filePath);
  if (timestampMs === null) return null;

  const fileName = path.basename(filePath);
  const sessionId = fileName.endsWith(".settings.json")
    ? fileName.slice(0, -".settings.json".length)
    : fileName;

  const pricedModel = pickPricedModel(model, provider);

  return {
    provider: "droid",
    timestampMs,
    model: pricedModel,
    sessionId,
    totals: {
      uncachedInputTokens: inputTokens,
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      outputTokens: outputForTotals,
      reasoningTokens: thinking,
    },
    reportedCostUsd: null,
    dedupeKey: `droid:${sessionId}`,
  };
}
