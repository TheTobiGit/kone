/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Both parsers are line-at-a-time reducers so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { TranscriptProviderKind, UsageTokenTotals } from "./types.js";

export interface UsageRecord {
  readonly provider: TranscriptProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};


/** One decoded transcript-line value. Each parser line is parsed once at its
 *  boundary; everything downstream branches on these domain values. */
type TranscriptValue =
  | string
  | number
  | boolean
  | null
  | TranscriptValue[]
  | { [key: string]: TranscriptValue };

type TranscriptRecord = { [key: string]: TranscriptValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isTranscriptNumber(value: TranscriptValue | undefined): value is number {
  return Number.isFinite(value);
}

function isTranscriptRecord(value: TranscriptValue | undefined): value is TranscriptRecord {
  return value instanceof Object && !Array.isArray(value);
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  value — booleans by identity, numbers by finiteness, composites by their
 *  constructors. */
function transcriptText(value: TranscriptValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isTranscriptNumber(value)) return null;
  return value;
}

/** The named field as a record, or null when absent or not an object. */
function recordAt(record: TranscriptRecord, key: string): TranscriptRecord | null {
  const value: TranscriptValue | undefined = record[key];
  return isTranscriptRecord(value) ? value : null;
}

function int(value: TranscriptValue | undefined): number {
  return isTranscriptNumber(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: TranscriptValue | undefined): number | null {
  const text = transcriptText(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: TranscriptProviderKind): boolean {
  return provider === "claude" ? line.includes('"usage"') : line.includes('"token_count"');
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: TranscriptValue;
  try {
    // SAFETY: the transcript line hands back arbitrary JSON; every field is
    // revalidated through the decoders before use.
    parsed = JSON.parse(line) as TranscriptValue;
  } catch {
    return null;
  }
  const record = isTranscriptRecord(parsed) ? parsed : null;
  if (!record) return null;
  if (record["type"] !== "assistant") return null;

  const messageRecord = recordAt(record, "message");
  if (!messageRecord) return null;

  const usageRecord = recordAt(messageRecord, "usage");
  if (!usageRecord) return null;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = transcriptText(messageRecord["model"]) ?? "";
  if (model.length === 0) return null;

  const messageId = transcriptText(messageRecord["id"]);
  const requestId = transcriptText(record["requestId"]);
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: transcriptText(record["sessionId"]) ?? "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: isTranscriptNumber(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+). One second of
 */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: TranscriptRecord): boolean {
  if (transcriptText(payload["forked_from_id"]) !== null) return true;
  const source = recordAt(payload, "source");
  if (!source) return false;
  const subagent = recordAt(source, "subagent");
  if (!subagent) return false;
  const spawn = recordAt(subagent, "thread_spawn");
  return spawn !== null && transcriptText(spawn["parent_thread_id"]) !== null;
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: TranscriptValue;
  try {
    // SAFETY: the transcript line hands back arbitrary JSON; every field is
    // revalidated through the decoders before use.
    parsed = JSON.parse(line) as TranscriptValue;
  } catch {
    return null;
  }
  const record = isTranscriptRecord(parsed) ? parsed : null;
  if (!record) return null;
  const payloadRecord = recordAt(record, "payload");
  if (!payloadRecord) return null;
  const payloadType = transcriptText(payloadRecord["type"]);

  if (transcriptText(record["type"]) === "session_meta") {
    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = transcriptText(payloadRecord["id"]) ?? transcriptText(payloadRecord["session_id"]);
    if (id !== null) state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (transcriptText(record["type"]) === "turn_context") {
    const model = transcriptText(payloadRecord["model"]);
    if (model !== null) state.model = model;
    return null;
  }

  if (payloadType !== "token_count") return null;

  const infoRecord = recordAt(payloadRecord, "info");
  const lastRecord = infoRecord ? recordAt(infoRecord, "last_token_usage") : null;
  if (!lastRecord) return null;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Events surviving the fork-copy suppression above are unique to this
    // rollout, so they need no global dedup.
    dedupeKey: null,
  };
}

export { EMPTY_TOTALS };
