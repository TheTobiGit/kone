import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type OpenCodeServerLedgerEntry = { pid: number; pgid: number; startTime: string };
export type ProcessInspectionResult =
  | { state: "alive"; startTime: string }
  | { state: "gone" }
  | { state: "unknown" };
export type ProcessInspection = (pid: number) => Promise<ProcessInspectionResult>;
export type ProcessKiller = (pgid: number, signal: NodeJS.Signals) => void;
const REAP_POLL_MS = 100;
const REAP_WAIT_MS = 2_000;
const PROCESS_INSPECTION_TIMEOUT_MS = 2_000;

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
  }
}

export function inspectProcessStartTime(pid: number): Promise<ProcessInspectionResult> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(processIsGone(pid) ? { state: "gone" } : { state: "unknown" });
        return;
      }
      const startTime = String(stdout).trim();
      resolve(startTime ? { state: "alive", startTime } : { state: "gone" });
    });
  });
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* the group may already be gone */ }
}

export class OpenCodeServerLedger {
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly inspect: ProcessInspection = inspectProcessStartTime,
    private readonly kill: ProcessKiller = killProcessGroup,
  ) {}

  record(pid: number, pgid = pid): Promise<OpenCodeServerLedgerEntry | undefined> {
    return this.serialize(async () => {
      const inspected = await this.inspect(pid);
      if (inspected.state !== "alive") return undefined;
      const entry = { pid, pgid, startTime: inspected.startTime };
      const entries = this.read();
      entries.set(pid, entry);
      this.write(entries);
      return entry;
    });
  }

  remove(pid: number): Promise<void> {
    return this.serialize(async () => {
      const entries = this.read();
      if (!entries.delete(pid)) return;
      this.write(entries);
    });
  }

  snapshot(): OpenCodeServerLedgerEntry[] {
    return [...this.read().values()];
  }

  reap(
    orphanSnapshot: readonly OpenCodeServerLedgerEntry[] = this.snapshot(),
    processOwnedPids: ReadonlySet<number> = new Set(),
  ): Promise<void> {
    return this.serialize(async () => {
      const removed = new Set<number>();
      for (const entry of orphanSnapshot) {
        if (processOwnedPids.has(entry.pid)) continue;
        const initial = await this.inspect(entry.pid);
        if (initial.state === "unknown") continue;
        if (initial.state === "gone" || initial.startTime !== entry.startTime) {
          removed.add(entry.pid);
          continue;
        }
        if (processOwnedPids.has(entry.pid)) continue;
        try { this.kill(entry.pgid, "SIGTERM"); } catch { continue; }
        const afterTerm = await this.waitForExit(entry);
        if (afterTerm === "gone") {
          removed.add(entry.pid);
          continue;
        }
        if (afterTerm === "unknown") continue;
        if (processOwnedPids.has(entry.pid)) continue;
        try { this.kill(entry.pgid, "SIGKILL"); } catch { continue; }
        if (await this.waitForExit(entry) === "gone") removed.add(entry.pid);
      }
      const entries = this.read();
      for (const pid of removed) {
        const current = entries.get(pid);
        const snapshot = orphanSnapshot.find((entry) => entry.pid === pid);
        if (current && snapshot && sameIdentity(current, snapshot) && !processOwnedPids.has(pid)) entries.delete(pid);
      }
      this.write(entries);
    });
  }

  private async waitForExit(entry: OpenCodeServerLedgerEntry): Promise<"gone" | "same" | "unknown"> {
    const deadline = Date.now() + REAP_WAIT_MS;
    while (true) {
      const current = await this.inspect(entry.pid);
      if (current.state === "gone" || (current.state === "alive" && current.startTime !== entry.startTime)) return "gone";
      if (current.state === "unknown") return "unknown";
      if (Date.now() >= deadline) return "same";
      await new Promise((resolve) => setTimeout(resolve, REAP_POLL_MS));
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
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

function sameIdentity(left: OpenCodeServerLedgerEntry, right: OpenCodeServerLedgerEntry): boolean {
  return left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime;
}
