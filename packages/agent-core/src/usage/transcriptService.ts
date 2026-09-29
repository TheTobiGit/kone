// approach) and returns aggregated buckets. This is the source of truth for
// overall Claude + Codex usage — including sessions never driven through kone.

import * as fs from "node:fs/promises";
import { writeFileAtomic } from "@kone/agent-core/lib-atomicWrite.js";
import path from "node:path";

import { resolveClaudeConfigDir } from "../claudeHome.js";
import { resolveCodexHome } from "../codexHome.js";
import { userDataPath } from "../userDataDir.js";
import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
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
import { scanOpenCodeUsage } from "./local/opencodeScan.js";
import { scanAntigravityUsage } from "./local/antigravityScan.js";
import { isWithinProject } from "./projectScope.js";
import { listTranscriptFiles, readTranscriptRecords } from "./transcripts/reader.js";
import type { TranscriptProviderKind } from "./transcripts/types.js";
import type { UsageRecord } from "./transcripts/transcripts.js";

const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

const SCAN_CACHE_PATH = () => userDataPath("usage", "scan-cache.json");

/** Claude Code transcript root for the active config dir. */
function resolveClaudeTranscriptDir(configDir: string): string {
  return path.join(configDir, "projects");
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function windowForRange(
  range: UsageRange,
): Pick<TranscriptScanResult, "sinceDay" | "untilDay" | "timeZone"> {
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
    // SAFETY: asserting JsonValue narrows JSON.parse's any, so every access must
    // survive decodeScanCache below.
    const doc = JSON.parse(raw) as JsonValue;
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

// The machine-wide local logs have no per-file cache: every scan opens each
// OpenCode and Antigravity database and reads each Droid settings file whole,
// whatever the window — hundreds of milliseconds, synchronous for the SQLite
// part. A board that shows four windows at once asks for four reports in a row,
// so the logs are read once at the widest window and every report within
// LOCAL_LOG_TTL_MS filters that copy. Keyed on the window's end so a read
// across midnight starts over.
const LOCAL_LOG_TTL_MS = 30_000;

type LocalLogRead = {
  records: readonly UsageRecord[];
  sources: readonly Pick<ScanSource, "provider" | "dir" | "status" | "skippedFiles">[];
};

let localLogMemo: { at: number; untilMs: number; read: Promise<LocalLogRead> } | null = null;

function readLocalLogs(untilMs: number): Promise<LocalLogRead> {
  const memo = localLogMemo;
  if (memo && memo.untilMs === untilMs && Date.now() - memo.at < LOCAL_LOG_TTL_MS) return memo.read;
  const read = scanLocalLogs(sinceMsForWindow(windowForRange("all").sinceDay), untilMs);
  const entry = { at: Date.now(), untilMs, read };
  localLogMemo = entry;
  // A failed read must not be served to the next report.
  read.catch(() => {
    if (localLogMemo === entry) localLogMemo = null;
  });
  return read;
}

async function scanLocalLogs(sinceMs: number, untilMs: number): Promise<LocalLogRead> {
  const records: UsageRecord[] = [];
  const sources: LocalLogRead["sources"][number][] = [];
  const opencode = await scanOpenCodeUsage({ sinceMs, untilMs });
  const droid = await scanDroidUsage({ sinceMs, untilMs });
  const antigravity = await scanAntigravityUsage({ sinceMs, untilMs });
  const scans = [
    { provider: "opencode", scan: opencode },
    { provider: "droid", scan: droid },
    { provider: "antigravity", scan: antigravity },
  ] as const;
  // One source per provider, not per directory: the per-report counts are
  // taken from the records, which don't say which directory they came from.
  for (const { provider, scan } of scans) {
    records.push(...scan.records);
    const found = scan.sources.find((source) => source.status === "ok") ?? scan.sources[0];
    if (found) sources.push({ provider, dir: found.dir, status: found.status, skippedFiles: 0 });
  }
  return { records, sources };
}

/** Clears transcript scan memoization (in-memory + on-disk). */
export async function clearUsageScanCaches(): Promise<void> {
  fileCache = new Map();
  localLogMemo = null;
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
): Promise<readonly UsageRecord[]> {
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

/** Scan provider CLI transcripts for the requested range.
 *
 *  Scoped to a project, every log is read whole (the per-file cache makes that
 *  the same cost as the global report) and each record is kept when either
 *  - it names a working directory (`cwd`) inside the project — which counts
 *    sessions run outside kone too, and a Claude session that moved into the
 *    project after starting elsewhere — or
 *  - its session is one of `projectSessionIds`, the conversation ids of the
 *    project's kone threads — which catches a kone thread run from a worktree
 *    outside the folder, and logs that record no directory at all.
 *  The numbers are then the same ones the global report shows, just fewer. */
export async function scanTranscriptUsage(options: {
  range: UsageRange;
  projectPath?: string | null;
  projectSessionIds?: ReadonlySet<string> | null;
}): Promise<TranscriptScanResult> {
  const startedAt = Date.now();
  const { sinceDay, untilDay, timeZone } = windowForRange(options.range);
  const windowStartMs = sinceMsForWindow(sinceDay);
  const projectPath = options.projectPath ?? null;
  const projectSessions = options.projectSessionIds ?? new Set<string>();
  /** Whether a machine-wide log's record belongs in this report. */
  const inScope = (record: { sessionId: string; cwd?: string }): boolean =>
    projectPath === null ||
    projectSessions.has(record.sessionId) ||
    (record.cwd !== undefined && isWithinProject(record.cwd, projectPath));

  await ensureScanCacheLoaded();

  const claudeDir = resolveClaudeTranscriptDir(resolveClaudeConfigDir());
  const codexDir = path.join(resolveCodexHome(), "sessions");

  const dirs: { provider: TranscriptProviderKind; dir: string }[] = [
    { provider: "claude", dir: claudeDir },
    { provider: "codex", dir: codexDir },
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
    const files = await listTranscriptFiles(dir, windowStartMs);

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
        if (!inScope(record)) continue;
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

  // OpenCode + Droid + Antigravity are machine-wide local logs (like Codex),
  // narrowed to the window and then to the project when scoped (see inScope).
  const sinceMs = sinceMsForWindow(sinceDay);
  const untilMs = untilMsForWindow(untilDay);
  const localSessions = new Map<TranscriptProviderKind, Set<string>>();
  const localRecords = new Map<TranscriptProviderKind, number>();
  const localLogs = await readLocalLogs(untilMs);
  for (const record of localLogs.records) {
    if (record.timestampMs < sinceMs || record.timestampMs >= untilMs) continue;
    if (!inScope(record)) continue;
    if (!aggregator.add(record)) continue;
    localRecords.set(record.provider, (localRecords.get(record.provider) ?? 0) + 1);
    if (record.sessionId.length === 0) continue;
    const sessions = localSessions.get(record.provider) ?? new Set<string>();
    sessions.add(record.sessionId);
    localSessions.set(record.provider, sessions);
  }
  for (const source of localLogs.sources) {
    sources.push({
      ...source,
      scannedFiles: localRecords.get(source.provider) ?? 0,
      distinctSessions: localSessions.get(source.provider)?.size ?? 0,
    });
  }

  const pruned = pruneScanCache(fileCache, {
    livePaths,
    walkedRoots,
    windowStartMs,
    // Kept as long as the widest window reads them: any shorter and the "all"
    // report re-parses every older transcript, caches it, and prunes it again
    // on every read.
    retentionCutoffMs: sinceMsForWindow(windowForRange("all").sinceDay),
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
