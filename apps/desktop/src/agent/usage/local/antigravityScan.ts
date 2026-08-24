// Scans Antigravity conversation stores for per-call token usage.
//
// The CLI (and the Antigravity app/IDE) keep one protobuf-bearing SQLite file
// per conversation under ~/.gemini/antigravity{,-cli,-ide}/: a `gen_metadata`
// table whose rows carry the model's per-request usage (input/output/thinking
// tokens) as an encoded protobuf message. The field layout below was
// reverse-engineered from the agy CLI's own usage read with a hand-rolled protobuf
// provider because the .pb format is opaque *without* this schema.
//
// Only the `.db` (SQLite) files are parsed here — they hold the authoritative
// per-call accounting. The `.pb` cascade files need the running language
// server's `GetCascadeTrajectoryGeneratorMetadata` RPC to decode, which is a
// live-process dependency this scan deliberately does not take.

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../../sqlite.js";

import type { UsageRecord } from "../transcripts/transcripts.js";

/** Test override, comma-separated, mirroring droidScan's DROID_SESSIONS_DIR_ENV. */
export const ANTIGRAVITY_CONVERSATIONS_DIR_ENV = "ANTIGRAVITY_CONVERSATIONS_DIR";

export type AntigravityScanStats = {
  dir: string;
  status: "ok" | "missing";
  filesScanned: number;
  conversations: number;
};

/** The five conversation roots the scan covers, in order. */
type AntigravityConversationRoot = {
  dir: string;
  extensions: readonly string[];
};

export function conversationRoots(home = os.homedir()): AntigravityConversationRoot[] {
  return [
    { dir: path.join(home, ".gemini", "antigravity", "conversations"), extensions: [".db"] },
    { dir: path.join(home, ".gemini", "antigravity-cli", "conversations"), extensions: [".db"] },
    { dir: path.join(home, ".gemini", "antigravity-ide", "conversations"), extensions: [".db"] },
  ];
}

export function resolveScanRoots(home = os.homedir()): string[] {
  const raw = process.env[ANTIGRAVITY_CONVERSATIONS_DIR_ENV]?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => path.resolve(part));
  }
  return conversationRoots(home).map((root) => root.dir);
}


type ProtoField = {
  number: number;
  wireType: number;
  value?: bigint;
  bytes?: Uint8Array;
};

type ProtoVarint = { value: bigint; offset: number };

function readProtoVarint(data: Uint8Array, startOffset: number): ProtoVarint | null {
  let value = 0n;
  let shift = 0n;
  let offset = startOffset;
  while (offset < data.length) {
    const byte = data[offset]!;
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const key = readProtoVarint(data, offset);
    if (!key) break;
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) break;

    if (wireType === 0) {
      const value = readProtoVarint(data, offset);
      if (!value) break;
      fields.push({ number: fieldNumber, wireType, value: value.value });
      offset = value.offset;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readProtoVarint(data, offset);
      if (!length) break;
      offset = length.offset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + byteLength) });
      offset += byteLength;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    break;
  }
  return fields;
}

function firstProtoField(fields: readonly ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find((field) => field.number === fieldNumber);
}

function protoFieldText(field: ProtoField | undefined): string | undefined {
  if (!field?.bytes || field.bytes.length === 0) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(field.bytes);
  // eslint-disable-next-line no-control-regex
  if (!text || /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text)) return undefined;
  return text;
}

function protoFieldPositiveInteger(field: ProtoField | undefined): number {
  if (field?.value === undefined) return 0;
  const value = Number(field.value);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function protoFieldBytes(field: ProtoField | undefined): Uint8Array | undefined {
  return field?.bytes;
}

// ── gen_metadata row decoding ────────────────────────────────────────────────

/** `gen_metadata.data` → root fields → chatModel(#1) → usage(#4). */
function usageFieldsOf(rowData: Uint8Array): ProtoField[] {
  const rootFields = parseProtoFields(rowData);
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array());
  return parseProtoFields(protoFieldBytes(firstProtoField(chatFields, 4)) ?? new Uint8Array());
}

/** ChatStartMetadata sits at chatModel(#1).#9; its created_at is #4 — an ISO
 *  string, a google.protobuf.Timestamp submessage (seconds #1, nanos #2), or a
 *  bare unix varint. Returns epoch ms, or null when absent/unparseable. */
function createdAtMsOf(rowData: Uint8Array): number | null {
  const rootFields = parseProtoFields(rowData);
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array());
  const metadataBytes = protoFieldBytes(firstProtoField(chatFields, 9));
  if (!metadataBytes) return null;
  const created = firstProtoField(parseProtoFields(metadataBytes), 4);
  if (!created) return null;

  const text = protoFieldText(created);
  if (text && !Number.isNaN(Date.parse(text))) return Date.parse(text);

  if (created.bytes) {
    const tsFields = parseProtoFields(created.bytes);
    const seconds = firstProtoField(tsFields, 1)?.value;
    if (seconds !== undefined) {
      const nanos = firstProtoField(tsFields, 2)?.value ?? 0n;
      const ms = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6);
      if (Number.isSafeInteger(ms) && ms > 0) return ms;
    }
  }
  if (created.value !== undefined) {
    const raw = Number(created.value);
    const ms = raw < 1e12 ? raw * 1000 : raw;
    if (Number.isSafeInteger(ms) && ms > 0) return ms;
  }
  return null;
}

/** `chatModel(#1).#20` is a repeated attribute pair map (`model_enum`, …). */
function metadataAttributes(rowData: Uint8Array): Map<string, string> {
  const rootFields = parseProtoFields(rowData);
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array());
  const attributes = new Map<string, string>();
  for (const field of chatFields) {
    if (field.number !== 20) continue;
    const pairFields = parseProtoFields(protoFieldBytes(field) ?? new Uint8Array());
    const key = protoFieldText(firstProtoField(pairFields, 1));
    const value = protoFieldText(firstProtoField(pairFields, 2));
    if (key && value) attributes.set(key, value);
  }
  return attributes;
}

/** Map a display label to the canonical slug the pricing catalog understands
  *  (Gemini 3.5 Flash (High) → gemini-3.5-flash-high). */
export function canonicalAntigravityModelId(
  rawModel: string,
  displayName: string | undefined,
): string {
  const lower = displayName?.toLowerCase() ?? "";
  if (lower) {
    if (lower.includes("3.5 flash")) {
      if (lower.includes("high")) return "gemini-3.5-flash-high";
      if (lower.includes("medium")) return "gemini-3.5-flash-medium";
      if (lower.includes("low")) return "gemini-3.5-flash-low";
      return "gemini-3.5-flash";
    }
    if (lower.includes("3.1 pro")) {
      if (lower.includes("high")) return "gemini-3.1-pro-high";
      if (lower.includes("low")) return "gemini-3.1-pro-low";
      return "gemini-3.1-pro";
    }
    if (lower.includes("3.1 flash")) {
      if (lower.includes("image")) return "gemini-3.1-flash-image";
      if (lower.includes("lite")) return "gemini-3.1-flash-lite";
      return "gemini-3.1-flash";
    }
    if (lower.includes("3 flash")) return "gemini-3-flash";
    if (lower.includes("3 pro")) return "gemini-3-pro";
  }
  // Antigravity's model map sometimes hasn't caught up with a new model and
  // carries a placeholder id — never leak it as a model name.
  return rawModel.startsWith("MODEL_PLACEHOLDER_") ? "unknown" : rawModel;
}

const isResponseId = (value: string): boolean => /^[^\s]+$/.test(value);

/** One `gen_metadata` row → a usage record, or null when it carries no tokens. */
export function parseAntigravityGenMetadataRow(
  rowData: Uint8Array,
  rowIndex: number,
): {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  responseId: string;
  model: string;
  createdAtMs: number | null;
} | null {
  const usageFields = usageFieldsOf(rowData);
  if (usageFields.length === 0) return null;

  const inputTokens =
    protoFieldPositiveInteger(firstProtoField(usageFields, 2)) ||
    protoFieldPositiveInteger(firstProtoField(usageFields, 1));
  const totalOutputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 3));
  let responseTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 9));
  let thinkingTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 10));

  if (responseTokens === 0 && thinkingTokens === 0) {
    responseTokens = totalOutputTokens;
  } else if (totalOutputTokens > 0 && responseTokens + thinkingTokens !== totalOutputTokens) {
    const adjusted = totalOutputTokens - thinkingTokens;
    if (adjusted >= 0) responseTokens = adjusted;
  }

  if (inputTokens === 0 && totalOutputTokens === 0) return null;

  const responseIdField = protoFieldText(firstProtoField(usageFields, 11));
  const responseId =
    responseIdField && isResponseId(responseIdField) ? responseIdField : String(rowIndex);

  const rootFields = parseProtoFields(rowData);
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array());
  const displayName = protoFieldText(firstProtoField(chatFields, 21));
  const attributes = metadataAttributes(rowData);
  const rawModel =
    protoFieldText(firstProtoField(chatFields, 19)) ??
    attributes.get("model_enum") ??
    displayName ??
    "unknown";
  const model = canonicalAntigravityModelId(rawModel, displayName);

  return {
    inputTokens,
    // Output is the whole generated text: reasoning (thinking) plus the plain
    // response. Reasoning tokens are a subset of output everywhere else in this
    // codebase (totalTokens()/pricing deliberately do NOT add reasoningTokens
    // again), so folding thinking into output here keeps a Gemini thinking turn
    // from silently undercounting its tokens and undercharging its cost.
    outputTokens: responseTokens + thinkingTokens,
    thinkingTokens,
    responseId,
    model,
    createdAtMs: createdAtMsOf(rowData),
  };
}

/** The conversation id a file belongs to — the file name minus its extension. */
export function antigravityCascadeIdFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.(pb|db)$/i, "");
}

// ── scan ─────────────────────────────────────────────────────────────────────

type GenMetadataRow = { idx: number; data: Uint8Array | string };

function parseDbFile(filePath: string, cascadeId: string, mtimeMs: number): UsageRecord[] {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    // SAFETY: the projection names exactly idx and data, the two columns of
    // GenMetadataRow.
    const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all() as GenMetadataRow[];
    const records: UsageRecord[] = [];
    const seenResponseIds = new Set<string>();
    for (const row of rows) {
      const data = row.data instanceof Uint8Array ? row.data : new TextEncoder().encode(String(row.data));
      const parsed = parseAntigravityGenMetadataRow(data, row.idx);
      if (!parsed) continue;
      const dedupeKey = `antigravity:${cascadeId}:${parsed.responseId}`;
      if (seenResponseIds.has(dedupeKey)) continue;
      seenResponseIds.add(dedupeKey);
      records.push({
        provider: "antigravity",
        // A row without a real created_at gets the file's mtime — stable
        // within a scan, and honest enough to land in the right day.
        timestampMs: parsed.createdAtMs ?? mtimeMs,
        model: parsed.model,
        sessionId: cascadeId,
        totals: {
          uncachedInputTokens: parsed.inputTokens,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: parsed.outputTokens,
          reasoningTokens: parsed.thinkingTokens,
        },
        reportedCostUsd: null,
        dedupeKey,
      });
    }
    return records;
  } finally {
    db.close();
  }
}

async function listDbFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".db"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export async function scanAntigravityUsage(options: {
  sinceMs: number;
  untilMs: number;
}): Promise<{ records: UsageRecord[]; sources: AntigravityScanStats[] }> {
  const sources: AntigravityScanStats[] = [];
  const records: UsageRecord[] = [];

  for (const dir of resolveScanRoots()) {
    let exists = false;
    try {
      await fs.access(dir);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      sources.push({ dir, status: "missing", filesScanned: 0, conversations: 0 });
      continue;
    }

    const files = await listDbFiles(dir);
    let filesScanned = 0;
    const conversations = new Set<string>();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const cascadeId = antigravityCascadeIdFromPath(filePath);
        const fileRecords = parseDbFile(filePath, cascadeId, stat.mtimeMs);
        let kept = 0;
        for (const record of fileRecords) {
          if (record.timestampMs < options.sinceMs || record.timestampMs >= options.untilMs) continue;
          records.push(record);
          kept += 1;
        }
        if (kept > 0) {
          filesScanned += 1;
          conversations.add(cascadeId);
        }
      } catch {
        // A locked/unreadable conversation file — skip it this scan.
      }
    }

    sources.push({
      dir,
      status: "ok",
      filesScanned,
      conversations: conversations.size,
    });
  }

  return { records, sources };
}

export const DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW = 1_000_000;

export function resolveAntigravityContextWindow(modelId?: string): number {
  if (!modelId) return DEFAULT_ANTIGRAVITY_CONTEXT_WINDOW;
  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gpt-oss")) return 128_000;
  return 1_000_000;
}

export type AntigravityConversationUsage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  latestContextUsed?: number;
  model?: string;
};

/** Reads usage records across one or more conversation IDs (e.g. parent conversation
 *  plus any subagent runs) from on-disk SQLite conversation databases. */
export function readAntigravityConversationUsage(
  conversationIds: readonly string[],
  homeDir?: string,
): AntigravityConversationUsage | undefined {
  if (conversationIds.length === 0) return undefined;

  let totalInput = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let latestContextUsed: number | undefined;
  let latestModel: string | undefined;
  let foundAny = false;

  const roots = resolveScanRoots(homeDir);

  for (const cid of conversationIds) {
    if (!cid) continue;
    let dbPath: string | undefined;
    for (const root of roots) {
      const candidate = path.join(root, `${cid}.db`);
      if (existsSync(candidate)) {
        dbPath = candidate;
        break;
      }
    }
    if (!dbPath) continue;

    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        // SAFETY: the projection names exactly idx and data, the two columns of
        // GenMetadataRow.
        const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all() as GenMetadataRow[];
        const seenResponseIds = new Set<string>();
        for (const row of rows) {
          const data = row.data instanceof Uint8Array ? row.data : new TextEncoder().encode(String(row.data));
          const parsed = parseAntigravityGenMetadataRow(data, row.idx);
          if (!parsed) continue;
          const dedupeKey = `antigravity:${cid}:${parsed.responseId}`;
          if (seenResponseIds.has(dedupeKey)) continue;
          seenResponseIds.add(dedupeKey);

          totalInput += parsed.inputTokens;
          totalOutput += parsed.outputTokens;
          totalThinking += parsed.thinkingTokens;
          latestContextUsed = parsed.inputTokens + parsed.outputTokens;
          if (parsed.model && parsed.model !== "unknown") latestModel = parsed.model;
          foundAny = true;
        }
      } finally {
        db.close();
      }
    } catch {
      // Best-effort read: unreadable/locked file is skipped
    }
  }

  if (!foundAny) return undefined;

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    thinkingTokens: totalThinking,
    totalTokens: totalInput + totalOutput,
    latestContextUsed,
    model: latestModel,
  };
}
