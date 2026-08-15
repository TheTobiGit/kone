// approach) and returns aggregated buckets. This is the source of truth for
// overall Claude + Codex usage — including sessions never driven through kone.

import * as fs from "node:fs/promises";
import { writeFileAtomic } from "../../atomicWrite.js";
import path from "node:path";

import { resolveClaudeConfigDir } from "../claudeHome.js";
import { resolveCodexHome } from "../codexHome.js";
import { userDataPath } from "../userDataDir.js";
import type { UsageRange } from "./report.js";
import { rangeStart, localDateLabel, startOfLocalDay } from "./report.js";
import {
  TranscriptAggregator,
  bucketInputTokens,
  bucketTotalTokens,
  type TranscriptBucket,
} from "./transcripts/aggregate.js";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./transcripts/scanCache.js";
import { scanDroidUsage } from "./local/droidScan.js";
import { scanOpenCodeUsage } from "./local/openCodeScan.js";
import { scanAntigravityUsage } from "./local/antigravityScan.js";
import {
  listTranscriptFiles,
  readTranscriptRecords,
  type TranscriptFile,
} from "./transcripts/reader.js";
import type { TranscriptProviderKind } from "./transcripts/types.js";

const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const CACHE_RETENTION_DAYS = 90;

const SCAN_CACHE_PATH = () => userDataPath("usage", "scan-cache.json");

/** Claude Code transcript root for the active config dir. */
function resolveClaudeTranscriptDir(configDir: string): string {
  return path.join(configDir, "projects");
}

/** How Claude Code encodes a workspace path into `projects/<slug>/`. */
export function encodeClaudeProjectSlug(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function windowForRange(range: UsageRange): { sinceDay: string; untilDay: string; timeZone: string } {
  const timeZone = resolveTimeZone();
  const untilDay = localDateLabel(startOfLocalDay(Date.now()));
  const startMs = rangeStart(range);
  if (startMs === null) {
    // "all" — cap transcript scan at one year for performance; still far beyond UI windows.
    const d = startOfLocalDay(Date.now());
    d.setFullYear(d.getFullYear() - 1);
    return { sinceDay: localDateLabel(d), untilDay, timeZone };
  }
  return { sinceDay: localDateLabel(startOfLocalDay(startMs)), untilDay, timeZone };
}

function sinceMsForWindow(sinceDay: string): number {
  const parsed = Date.parse(`${sinceDay}T00:00:00`);
  return Number.isFinite(parsed) ? parsed - MTIME_SLACK_MS : 0;
}

function untilMsForWindow(untilDay: string): number {
  const parsed = Date.parse(`${untilDay}T00:00:00`);
  const end = startOfLocalDay(Number.isFinite(parsed) ? parsed : Date.now());
  end.setDate(end.getDate() + 1);
  return end.getTime();
}

type ScanSource = {
  provider: TranscriptProviderKind;
  dir: string;
  status: "ok" | "missing";
  scannedFiles: number;
  skippedFiles: number;
  distinctSessions: number;
};

export type TranscriptScanResult = {
  buckets: TranscriptBucket[];
  sources: ScanSource[];
  scanDurationMs: number;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
};

let fileCache: ScanCache = new Map();
let cacheLoaded = false;
let cacheDirty = false;

async function ensureScanCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = await fs.readFile(SCAN_CACHE_PATH(), "utf8");
    const doc = JSON.parse(raw) as unknown;
    for (const [p, entry] of decodeScanCache(doc)) fileCache.set(p, entry);
  } catch {
    // Cold start — empty cache.
  }
}

async function persistScanCache(): Promise<void> {
  if (!cacheDirty) return;
  try {
    const serialized = JSON.stringify(encodeScanCache(fileCache));
    await writeFileAtomic(SCAN_CACHE_PATH(), serialized);
    cacheDirty = false;
  } catch {
    // A failed write costs a slower next scan, not a failed read.
  }
}

/** Clears transcript scan memoization (in-memory + on-disk). */
export async function clearUsageScanCaches(): Promise<void> {
  fileCache = new Map();
  cacheLoaded = true;
  cacheDirty = false;
  try {
    await fs.unlink(SCAN_CACHE_PATH());
  } catch {
    // Cold cache is fine.
  }
}

async function readFileRecords(
  filePath: string,
  size: number,
  mtimeMs: number,
  provider: TranscriptProviderKind,
): Promise<readonly import("./transcripts/transcripts.js").UsageRecord[]> {
  const cached = fileCache.get(filePath);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.provider === provider) {
    return cached.records;
  }
  const parsed = await readTranscriptRecords(filePath, provider);
  if (parsed === null) return [];
  const records = dedupeWithinFile(parsed);
  fileCache.set(filePath, { size, mtimeMs, provider, records });
  cacheDirty = true;
  return records;
}

function filterFilesForProject(files: readonly TranscriptFile[], projectPath: string | null): TranscriptFile[] {
  if (!projectPath) return [...files];
  const slug = encodeClaudeProjectSlug(projectPath);
  return files.filter((f) => f.path.includes(slug));
}

/** Scan provider CLI transcripts for the requested range. */
export async function scanTranscriptUsage(options: {
  range: UsageRange;
  projectPath?: string | null;
}): Promise<TranscriptScanResult> {
  const startedAt = Date.now();
  const { sinceDay, untilDay, timeZone } = windowForRange(options.range);
  const windowStartMs = sinceMsForWindow(sinceDay);
  const projectPath = options.projectPath ?? null;

  await ensureScanCacheLoaded();

  const claudeDir = resolveClaudeTranscriptDir(resolveClaudeConfigDir());
  const codexDir = path.join(resolveCodexHome(), "sessions");

  const dirs: { provider: TranscriptProviderKind; dir: string }[] = [
    { provider: "claude", dir: claudeDir },
    // Codex sessions are machine-wide; skip when scoping to one project.
    ...(projectPath ? [] : [{ provider: "codex" as const, dir: codexDir }]),
  ];

  const aggregator = new TranscriptAggregator({ timeZone, sinceDay, untilDay });
  const sources: ScanSource[] = [];
  const livePaths = new Set<string>();
  const walkedRoots: string[] = [];

  for (const { provider, dir } of dirs) {
    let exists = false;
    try {
      await fs.access(dir);
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      sources.push({
        provider,
        dir,
        status: "missing",
        scannedFiles: 0,
        skippedFiles: 0,
        distinctSessions: 0,
      });
      continue;
    }

    walkedRoots.push(dir);
    const allFiles = await listTranscriptFiles(dir, windowStartMs);
    const files =
      provider === "claude" ? filterFilesForProject(allFiles, projectPath) : allFiles;

    let scannedFiles = 0;
    let skippedFiles = 0;
    const sessionIds = new Set<string>();

    for (const file of files) {
      livePaths.add(file.path);
      const records = await readFileRecords(file.path, file.size, file.mtimeMs, provider);
      if (records.length === 0) {
        skippedFiles += 1;
        continue;
      }
      scannedFiles += 1;
      for (const record of records) {
        if (aggregator.add(record) && record.sessionId.length > 0) {
          sessionIds.add(record.sessionId);
        }
      }
    }

    sources.push({
      provider,
      dir,
      status: "ok",
      scannedFiles,
      skippedFiles,
      distinctSessions: sessionIds.size,
    });
  }

  // OpenCode + Droid + Antigravity are machine-wide local logs (like Codex) —
  // skip for project scope.
  if (!projectPath) {
    const sinceMs = sinceMsForWindow(sinceDay);
    const untilMs = untilMsForWindow(untilDay);

    const opencode = await scanOpenCodeUsage({ sinceMs, untilMs });
    for (const source of opencode.sources) {
      sources.push({
        provider: "opencode",
        dir: source.dir,
        status: source.status,
        scannedFiles: source.messagesFromDb + source.messagesFromFiles,
        skippedFiles: 0,
        distinctSessions: source.distinctSessions,
      });
    }
    for (const record of opencode.records) {
      aggregator.add(record);
    }

    const droid = await scanDroidUsage({ sinceMs, untilMs });
    for (const source of droid.sources) {
      sources.push({
        provider: "droid",
        dir: source.dir,
        status: source.status,
        scannedFiles: source.filesScanned,
        skippedFiles: 0,
        distinctSessions: source.sessions,
      });
    }
    for (const record of droid.records) {
      aggregator.add(record);
    }

    const antigravity = await scanAntigravityUsage({ sinceMs, untilMs });
    for (const source of antigravity.sources) {
      sources.push({
        provider: "antigravity",
        dir: source.dir,
        status: source.status,
        scannedFiles: source.filesScanned,
        skippedFiles: 0,
        distinctSessions: source.conversations,
      });
    }
    for (const record of antigravity.records) {
      aggregator.add(record);
    }
  }

  const pruned = pruneScanCache(fileCache, {
    livePaths,
    walkedRoots,
    windowStartMs,
    retentionCutoffMs: startedAt - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  });
  if (pruned > 0) cacheDirty = true;
  await persistScanCache();

  const { buckets } = aggregator.finish();

  return {
    buckets,
    sources,
    scanDurationMs: Math.max(0, Date.now() - startedAt),
    timeZone,
    sinceDay,
    untilDay,
  };
}

export { bucketInputTokens, bucketTotalTokens };
