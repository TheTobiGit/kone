// Scans OpenCode's local SQLite message log and legacy JSON message files.

import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "../../sqlite.js";

import { listOpenCodeDatabasePaths, resolveOpenCodeDataDirs } from "../../quota/opencode.js";
import {
  extractMessageTimestampMs,
  parseOpenCodeMessageJson,
} from "./openCodeMessage.js";
import type { UsageRecord } from "../transcripts/transcripts.js";

const MIN_MILLIS_SCALE = 100_000_000_000;

export type OpenCodeScanStats = {
  dir: string;
  status: "ok" | "missing";
  databases: number;
  messagesFromDb: number;
  messagesFromFiles: number;
  distinctSessions: number;
};

async function collectJsonFiles(root: string): Promise<string[]> {
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
      if (entry.isFile() && entry.name.endsWith(".json")) {
        found.push(child);
      }
    }
  };
  await walk(root);
  return found;
}

function timeCreatedLooksLikeMillis(db: DatabaseSync): boolean {
  try {
    // SAFETY: the SELECT yields a single aggregate row whose one column is the
    // max; node:sqlite types it unknown, and it is undefined on an empty table.
    const row = db
      .prepare("SELECT max(time_created) FROM (SELECT time_created FROM message LIMIT 8)")
      .get() as { "max(time_created)"?: number } | undefined;
    const max = row?.["max(time_created)"];
    return max !== undefined && Number.isFinite(max) && max >= MIN_MILLIS_SCALE;
  } catch {
    return false;
  }
}

function readMessagesFromDatabase(
  dbPath: string,
  sinceMs: number,
  untilMs: number,
): UsageRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const records: UsageRecord[] = [];
  try {
    const useTimeFilter = timeCreatedLooksLikeMillis(db);
    const sql = useTimeFilter
      ? "SELECT id, session_id, data FROM message WHERE id IN (SELECT id FROM message WHERE time_created >= ? AND time_created < ?)"
      : "SELECT id, session_id, data FROM message";
    const stmt = db.prepare(sql);
    // SAFETY: the SELECT names exactly id, session_id and data, so every row
    // carries those three columns; node:sqlite types each row unknown.
    const rows = (useTimeFilter ? stmt.all(sinceMs, untilMs) : stmt.all()) as Array<{
      id: string;
      session_id: string;
      data: string;
    }>;

    for (const row of rows) {
      // String() passes a real string through untouched, so this matches the
      // old branch split while also flattening any stray BLOB or null cell.
      const data = String(row.data ?? "");
      if (!data.includes('"tokens"')) continue;
      if (useTimeFilter) {
        const ts = extractMessageTimestampMs(data);
        if (ts !== null && (ts < sinceMs || ts >= untilMs)) continue;
      } else {
        const ts = extractMessageTimestampMs(data);
        if (ts !== null && (ts < sinceMs || ts >= untilMs)) continue;
      }
      const record = parseOpenCodeMessageJson(data, {
        messageId: row.id,
        sessionId: row.session_id,
      });
      if (record) records.push(record);
    }
  } finally {
    db.close();
  }
  return records;
}

export async function scanOpenCodeUsage(options: {
  sinceMs: number;
  untilMs: number;
}): Promise<{ records: UsageRecord[]; sources: OpenCodeScanStats[] }> {
  const records: UsageRecord[] = [];
  const seenMessageIds = new Set<string>();
  const sources: OpenCodeScanStats[] = [];

  for (const dir of resolveOpenCodeDataDirs()) {
    let exists = false;
    try {
      await fs.access(dir);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      sources.push({
        dir,
        status: "missing",
        databases: 0,
        messagesFromDb: 0,
        messagesFromFiles: 0,
        distinctSessions: 0,
      });
      continue;
    }

    const dbPaths = listOpenCodeDatabasePaths(dir);
    let messagesFromDb = 0;
    const sessionIds = new Set<string>();

    for (const dbPath of dbPaths) {
      try {
        for (const record of readMessagesFromDatabase(dbPath, options.sinceMs, options.untilMs)) {
          if (record.dedupeKey && seenMessageIds.has(record.dedupeKey)) continue;
          if (record.dedupeKey) seenMessageIds.add(record.dedupeKey);
          if (record.sessionId) sessionIds.add(record.sessionId);
          records.push(record);
          messagesFromDb += 1;
        }
      } catch {
        // Locked or unreadable DB — skip this channel file.
      }
    }

    const messagesDir = path.join(dir, "storage", "message");
    let messagesFromFiles = 0;
    const jsonFiles = await collectJsonFiles(messagesDir);
    const filesToRead = jsonFiles.filter((file) => {
      const stem = path.basename(file, ".json");
      return stem.length > 0 && !seenMessageIds.has(`opencode:${stem}`);
    });

    for (const filePath of filesToRead) {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        if (!raw.includes('"tokens"')) continue;
        const ts = extractMessageTimestampMs(raw);
        if (ts !== null && (ts < options.sinceMs || ts >= options.untilMs)) continue;
        const record = parseOpenCodeMessageJson(raw);
        if (!record) continue;
        if (record.dedupeKey && seenMessageIds.has(record.dedupeKey)) continue;
        if (record.dedupeKey) seenMessageIds.add(record.dedupeKey);
        if (record.sessionId) sessionIds.add(record.sessionId);
        records.push(record);
        messagesFromFiles += 1;
      } catch {
      }
    }

    sources.push({
      dir,
      status: "ok",
      databases: dbPaths.length,
      messagesFromDb,
      messagesFromFiles,
      distinctSessions: sessionIds.size,
    });
  }

  return { records, sources };
}
