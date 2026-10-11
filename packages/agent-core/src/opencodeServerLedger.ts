import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProcessIdentity = { pid: number; startTime: string; command: string };
export type OpenCodeServerLedgerEntry = ProcessIdentity & { pgid: number };
export type ProcessInspectionResult =
  | ({ state: "alive" } & Omit<ProcessIdentity, "pid">)
  | { state: "gone" }
  | { state: "unknown" };
export type ProcessInspection = (pid: number) => Promise<ProcessInspectionResult>;
export type ProcessKiller = (pgid: number, signal: NodeJS.Signals) => void;
export type ProcessGroupMembersInspection = (pgid: number) => Promise<ProcessIdentity[] | undefined>;
export type ProcessGroupProbe = (pgid: number) => ProcessGroupInspection;
type ProcessGroupInspection = "alive" | "gone" | "unknown";
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

function inspectProcessGroup(pgid: number): ProcessGroupInspection {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return "gone";
    return "unknown";
  }
}

export function inspectProcessStartTime(pid: number): Promise<ProcessInspectionResult> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(processIsGone(pid) ? { state: "gone" } : { state: "unknown" });
        return;
      }
      const identity = parseProcessIdentity(pid, String(stdout));
      resolve(identity ? { state: "alive", startTime: identity.startTime, command: identity.command } : { state: "gone" });
    });
  });
}

export function inspectProcessGroupMembers(pgid: number): Promise<ProcessIdentity[] | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,pgid=,lstart=,comm="], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const members: ProcessIdentity[] = [];
      for (const line of String(stdout).split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        const pid = match?.[1];
        const candidatePgid = match?.[2];
        const fields = match?.[3];
        if (!pid || !candidatePgid || !fields || Number(candidatePgid) !== pgid) continue;
        const identity = parseProcessIdentity(Number(pid), fields);
        if (!identity) {
          resolve(undefined);
          return;
        }
        members.push(identity);
      }
      resolve(members);
    });
  });
}

function parseProcessIdentity(pid: number, output: string): ProcessIdentity | undefined {
  const fields = output.trim().split(/\s+/);
  if (fields.length < 6) return undefined;
  return { pid, startTime: fields.slice(0, 5).join(" "), command: fields.slice(5).join(" ") };
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
    private readonly inspectGroupMembers: ProcessGroupMembersInspection = inspectProcessGroupMembers,
    private readonly probeGroup: ProcessGroupProbe = inspectProcessGroup,
  ) {}

  record(pid: number, pgid = pid): Promise<OpenCodeServerLedgerEntry | undefined> {
    return this.serialize(async () => {
      const inspected = await this.inspect(pid);
      if (inspected.state !== "alive") return undefined;
      const entry = { pid, pgid, startTime: inspected.startTime, command: inspected.command };
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
        if (processOwnedPids.has(entry.pid)) continue;
        if (initial.state === "unknown") continue;
        if (initial.state === "alive" && !matchesEntry(initial, entry)) {
          removed.add(entry.pid);
          continue;
        }
        if (initial.state === "gone" && this.probeGroup(entry.pgid) === "gone") {
          removed.add(entry.pid);
          continue;
        }
        const originalMembers = await this.inspectGroupMembers(entry.pgid);
        if (processOwnedPids.has(entry.pid)) continue;
        if (!originalMembers?.length || originalMembers.some((member) => member.pid === entry.pid && !matchesEntry(member, entry))) {
          if (originalMembers?.some((member) => member.pid === entry.pid)) removed.add(entry.pid);
          continue;
        }
        if (initial.state === "alive" && !originalMembers.some((member) => member.pid === entry.pid && matchesEntry(member, entry))) continue;
        const leaderBeforeTerm = await this.inspect(entry.pid);
        if (processOwnedPids.has(entry.pid)) continue;
        if (leaderBeforeTerm.state === "alive" && !matchesEntry(leaderBeforeTerm, entry)) {
          removed.add(entry.pid);
          continue;
        }
        if (leaderBeforeTerm.state === "unknown") continue;
        if (this.probeGroup(entry.pgid) !== "alive" || processOwnedPids.has(entry.pid)) continue;
        try { this.kill(entry.pgid, "SIGTERM"); } catch { continue; }
        const afterTerm = await this.waitForGroupExit(entry.pgid);
        if (afterTerm === "gone") {
          removed.add(entry.pid);
          continue;
        }
        if (afterTerm === "unknown") continue;
        if (processOwnedPids.has(entry.pid)) continue;
        const leaderBeforeKill = await this.inspect(entry.pid);
        if (processOwnedPids.has(entry.pid)) continue;
        if (leaderBeforeKill.state === "unknown") continue;
        if (leaderBeforeKill.state === "alive" && !matchesEntry(leaderBeforeKill, entry)) {
          removed.add(entry.pid);
          continue;
        }
        const currentMembers = await this.inspectGroupMembers(entry.pgid);
        if (processOwnedPids.has(entry.pid)) continue;
        if (!currentMembers?.length || !membersBelongToSnapshot(currentMembers, originalMembers)) continue;
        if (this.probeGroup(entry.pgid) !== "alive") continue;
        if (processOwnedPids.has(entry.pid)) continue;
        try { this.kill(entry.pgid, "SIGKILL"); } catch { continue; }
        const afterKill = await this.waitForGroupExit(entry.pgid);
        if (processOwnedPids.has(entry.pid)) continue;
        if (afterKill === "gone") removed.add(entry.pid);
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

  private async waitForGroupExit(pgid: number): Promise<"gone" | "alive" | "unknown"> {
    const deadline = Date.now() + REAP_WAIT_MS;
    while (true) {
      const group = this.probeGroup(pgid);
      if (group === "gone" || group === "unknown") return group;
      if (Date.now() >= deadline) return "alive";
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
          const command = "command" in row ? String(row.command) : "";
          if (Number.isSafeInteger(pid) && Number.isSafeInteger(pgid) && startTime === row.startTime && (!("command" in row) || command === row.command)) {
            entries.set(pid, { pid, pgid, startTime, command });
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
  return left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime && left.command === right.command;
}

function matchesEntry(identity: ProcessIdentity | ({ state: "alive" } & Omit<ProcessIdentity, "pid">), entry: OpenCodeServerLedgerEntry): boolean {
  return identity.startTime === entry.startTime && identity.command === entry.command;
}

function membersBelongToSnapshot(current: readonly ProcessIdentity[], original: readonly ProcessIdentity[]): boolean {
  return current.every((member) => original.some((candidate) => candidate.pid === member.pid && candidate.startTime === member.startTime && candidate.command === member.command));
}
