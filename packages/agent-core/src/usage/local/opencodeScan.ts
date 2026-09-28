// Scans OpenCode's local SQLite message log and legacy JSON message files.
// Each record carries its session's working directory where OpenCode kept
// one, so a project report can claim the sessions run in its folder.

import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "../../sqlite.js";

import { listOpenCodeDatabasePaths, resolveOpenCodeDataDirs } from "../../quota/opencode.js";
import {
  extractMessageTimestampMs,
  parseOpenCodeMessageJson,
} from "./opencodeMessage.js";
import { detectOpenCodeLayout } from "./opencodeSchema.js";
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

type MessageRow = {
  id: string;
  session_id: string;
  data: string;
  directory: string | null;
};

/** Every assistant message in the window, from whichever layouts the database
 *  holds (see opencodeSchema.ts), each with its session's working directory
 *  when the session table records one. */
function readMessagesFromDatabase(
  dbPath: string,
  sinceMs: number,
  untilMs: number,
): UsageRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const records: UsageRecord[] = [];
  try {
    const layout = detectOpenCodeLayout(db);
    const rows: MessageRow[] = [];

    if (layout.v2) {
      const directory = layout.v2Sessions ? "s.directory" : "NULL";
      const join = layout.v2Sessions ? "LEFT JOIN session_v2 s ON s.id = m.session_id" : "";
      // SAFETY: the SELECT aliases exactly the four MessageRow columns;
      // node:sqlite types each row unknown.
      rows.push(
        ...(db
          .prepare(
            `SELECT m.id AS id, m.session_id AS session_id, m.data AS data, ${directory} AS directory
               FROM session_message m ${join}
              WHERE m.type = 'assistant' AND m.time_created >= ? AND m.time_created < ?`,
          )
          .all(sinceMs, untilMs) as MessageRow[]),
      );
    }

    if (layout.legacy) {
      const useTimeFilter = timeCreatedLooksLikeMillis(db);
      const directory = layout.legacySessionDirectory ? "s.directory" : "NULL";
      const join = layout.legacySessionDirectory ? "LEFT JOIN session s ON s.id = m.session_id" : "";
      const sql = `SELECT m.id AS id, m.session_id AS session_id, m.data AS data, ${directory} AS directory
                     FROM message m ${join}
                   ${useTimeFilter ? "WHERE m.time_created >= ? AND m.time_created < ?" : ""}`;
      const stmt = db.prepare(sql);
      // SAFETY: the SELECT aliases exactly the four MessageRow columns;
      // node:sqlite types each row unknown.
      rows.push(...((useTimeFilter ? stmt.all(sinceMs, untilMs) : stmt.all()) as MessageRow[]));
    }

    for (const row of rows) {
      // String() passes a real string through untouched, while also flattening
      // any stray BLOB or null cell.
      const data = String(row.data ?? "");
      if (!data.includes('"tokens"')) continue;
      const ts = extractMessageTimestampMs(data);
      if (ts !== null && (ts < sinceMs || ts >= untilMs)) continue;
      const record = parseOpenCodeMessageJson(data, {
        messageId: row.id,
        sessionId: row.session_id,
        cwd: row.directory,
      });
      if (record) records.push(record);
    }
  } finally {
    db.close();
  }
  return records;
}

/** Session id → working directory from the legacy JSON store
 *  (`storage/session/<project>/<session>.json`), for message files whose
 *  session the database doesn't know. Unreadable files are skipped. */
async function readLegacySessionDirectories(dir: string): Promise<Map<string, string>> {
  const directories = new Map<string, string>();
  for (const file of await collectJsonFiles(path.join(dir, "storage", "session"))) {
    try {
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof value !== "object" || value === null) continue;
      // SAFETY: narrowed to a non-null object above; both reads are
      // type-checked before use.
      const { id, directory } = value as { id?: unknown; directory?: unknown };
      if (typeof id === "string" && typeof directory === "string" && directory) {
        directories.set(id, directory);
      }
    } catch {
      // A torn or foreign file costs that session its directory, nothing more.
    }
  }
  return directories;
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
    const legacyDirectories =
      filesToRead.length > 0 ? await readLegacySessionDirectories(dir) : new Map<string, string>();

    for (const filePath of filesToRead) {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        if (!raw.includes('"tokens"')) continue;
        const ts = extractMessageTimestampMs(raw);
        if (ts !== null && (ts < options.sinceMs || ts >= options.untilMs)) continue;
        const parsed = parseOpenCodeMessageJson(raw);
        if (!parsed) continue;
        const cwd = legacyDirectories.get(parsed.sessionId);
        const record = cwd ? { ...parsed, cwd } : parsed;
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
