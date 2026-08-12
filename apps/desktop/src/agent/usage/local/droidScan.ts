// Scans Droid cumulative session snapshots from ~/.factory/sessions.

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseDroidSettingsFile } from "./droidSettings.js";
import type { UsageRecord } from "../transcripts/transcripts.js";

export const DROID_SESSIONS_DIR_ENV = "DROID_SESSIONS_DIR";

export type DroidScanStats = {
  dir: string;
  status: "ok" | "missing";
  filesScanned: number;
  sessions: number;
};

function resolveDroidSessionDirs(): string[] {
  const raw = process.env[DROID_SESSIONS_DIR_ENV]?.trim();
  const paths = raw
    ? raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => path.resolve(part))
    : [path.join(os.homedir(), ".factory", "sessions")];
  return paths;
}

async function collectSettingsFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".settings.json")) {
        found.push(child);
      }
    }
  };
  await walk(root);
  found.sort();
  return found;
}

/** Latest snapshot wins when the same session id appears in multiple paths. */
function dedupeLatestSessions(parsed: UsageRecord[]): UsageRecord[] {
  const bySession = new Map<string, UsageRecord>();
  const sorted = [...parsed].sort((a, b) => a.timestampMs - b.timestampMs);
  for (const record of sorted) {
    bySession.set(record.sessionId, record);
  }
  return [...bySession.values()];
}

export async function scanDroidUsage(options: {
  sinceMs: number;
  untilMs: number;
}): Promise<{ records: UsageRecord[]; sources: DroidScanStats[] }> {
  const sources: DroidScanStats[] = [];
  const parsed: UsageRecord[] = [];

  for (const dir of resolveDroidSessionDirs()) {
    let exists = false;
    try {
      await fs.access(dir);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      sources.push({ dir, status: "missing", filesScanned: 0, sessions: 0 });
      continue;
    }

    const files = await collectSettingsFiles(dir);
    let filesScanned = 0;
    for (const filePath of files) {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const record = parseDroidSettingsFile(filePath, raw);
        if (!record) continue;
        if (record.timestampMs < options.sinceMs || record.timestampMs >= options.untilMs) continue;
        parsed.push(record);
        filesScanned += 1;
      } catch {
        // Unreadable settings snapshot.
      }
    }

    sources.push({
      dir,
      status: "ok",
      filesScanned,
      sessions: filesScanned,
    });
  }

  const records = dedupeLatestSessions(parsed);
  return { records, sources };
}
