import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type OpenCodeServerLedgerEntry = { pid: number; pgid: number; startTime: string };
export type ProcessInspection = (pid: number) => string | undefined;
export type ProcessKiller = (pgid: number) => void;

export function inspectProcessStartTime(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function killProcessGroup(pgid: number): void {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
}

export class OpenCodeServerLedger {
  constructor(
    private readonly filePath: string,
    private readonly inspect: ProcessInspection = inspectProcessStartTime,
    private readonly kill: ProcessKiller = killProcessGroup,
  ) {}

  record(pid: number, pgid = pid): OpenCodeServerLedgerEntry | undefined {
    const startTime = this.inspect(pid);
    if (!startTime) return undefined;
    const entry = { pid, pgid, startTime };
    const entries = this.read();
    entries.set(pid, entry);
    this.write(entries);
    return entry;
  }

  remove(pid: number): void {
    const entries = this.read();
    if (!entries.delete(pid)) return;
    this.write(entries);
  }

  reap(): void {
    const entries = this.read();
    for (const entry of entries.values()) {
      if (this.inspect(entry.pid) === entry.startTime) this.kill(entry.pgid);
    }
    this.write(new Map());
  }

  private read(): Map<number, OpenCodeServerLedgerEntry> {
    if (!existsSync(this.filePath)) return new Map();
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(value)) return new Map();
      const entries = new Map<number, OpenCodeServerLedgerEntry>();
      for (const row of value) {
        if (row instanceof Object && "pid" in row && "pgid" in row && "startTime" in row) {
          const pid = Number(row.pid);
          const pgid = Number(row.pgid);
          const startTime = String(row.startTime);
          if (Number.isSafeInteger(pid) && Number.isSafeInteger(pgid) && startTime === row.startTime) {
            entries.set(pid, { pid, pgid, startTime });
          }
        }
      }
      return entries;
    } catch {
      return new Map();
    }
  }

  private write(entries: Map<number, OpenCodeServerLedgerEntry>): void {
    this.ensureParent();
    writeFileSync(this.filePath, JSON.stringify([...entries.values()]), { mode: 0o600 });
  }

  private ensureParent(): void {
    const parent = path.dirname(this.filePath);
    // The user data directory is created by the host before provider startup.
    if (!existsSync(parent)) throw new Error(`OpenCode server ledger directory does not exist: ${parent}`);
  }
}
