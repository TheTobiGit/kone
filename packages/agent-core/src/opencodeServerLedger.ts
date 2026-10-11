import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ProcessIdentity = { pid: number; startTime: string; command: string };
export type OpenCodeServerLedgerEntry = ProcessIdentity & { pgid: number; marker: string };
export type ProcessInspectionResult =
  | ({ state: "alive" } & Omit<ProcessIdentity, "pid">)
  | { state: "gone" }
  | { state: "unknown" };
export type ProcessInspection = (pid: number) => Promise<ProcessInspectionResult>;
export type ProcessKiller = (pgid: number, signal: NodeJS.Signals) => void;
export type ProcessGroupMembersInspection = (pgid: number) => Promise<ProcessIdentity[] | undefined>;
export type ProcessGroupProbe = (pgid: number) => ProcessGroupInspection;
export type ProcessMarkerInspection = "marked" | "unmarked" | "gone" | "unknown";
export type ProcessEnvironmentInspector = (pid: number, marker: string) => Promise<ProcessMarkerInspection>;
export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;
type ProcessGroupInspection = "alive" | "gone" | "unknown";
const REAP_POLL_MS = 100;
const REAP_WAIT_MS = 2_000;
const PROCESS_INSPECTION_TIMEOUT_MS = 2_000;
const SERVER_MARKER_ENV = "KONE_OPENCODE_SERVER";

export function createOpenCodeServerMarker(): string {
  return randomUUID();
}

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
    execFile("ps", ["-o", "lstart=,comm=,stat=", "-p", String(pid)], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(processIsGone(pid) ? { state: "gone" } : { state: "unknown" });
        return;
      }
      const row = parseProcessRow(pid, String(stdout));
      resolve(row && !row.zombie ? { state: "alive", startTime: row.identity.startTime, command: row.identity.command } : { state: "gone" });
    });
  });
}

export function inspectProcessGroupMembers(pgid: number): Promise<ProcessIdentity[] | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,pgid=,lstart=,comm=,stat="], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
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
        const row = parseProcessRow(Number(pid), fields);
        if (!row) {
          resolve(undefined);
          return;
        }
        if (!row.zombie) members.push(row.identity);
      }
      resolve(members);
    });
  });
}

function parseProcessRow(pid: number, output: string): { identity: ProcessIdentity; zombie: boolean } | undefined {
  const fields = output.trim().split(/\s+/);
  if (fields.length < 6) return undefined;
  const command = fields[5];
  if (!command) return undefined;
  return { identity: { pid, startTime: fields.slice(0, 5).join(" "), command }, zombie: fields[6]?.startsWith("Z") ?? false };
}

export async function inspectProcessMarker(pid: number, marker: string): Promise<ProcessMarkerInspection> {
  if (process.platform === "linux") {
    try {
      const environment = await readFile(`/proc/${pid}/environ`, "utf8");
      return environment.split("\0").includes(`${SERVER_MARKER_ENV}=${marker}`) ? "marked" : "unmarked";
    } catch {
      return processIsGone(pid) ? "gone" : "unknown";
    }
  }
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("ps", ["-p", String(pid), "-Eww"], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          resolve(processIsGone(pid) ? "gone" : "unknown");
          return;
        }
        const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const environmentOutput = String(stdout);
        if (!/\b[A-Za-z_][A-Za-z0-9_]*=/.test(environmentOutput)) {
          resolve("unknown");
          return;
        }
        resolve(new RegExp(`(?:^|\\s)${SERVER_MARKER_ENV}=${escapedMarker}(?:\\s|$)`).test(environmentOutput) ? "marked" : "unmarked");
      });
    });
  }
  return "unknown";
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
    private readonly inspectMarker: ProcessEnvironmentInspector = inspectProcessMarker,
    private readonly signalProcess: ProcessSignalSender = (pid, signal) => { process.kill(pid, signal); },
  ) {}

  record(pid: number, pgid = pid, marker = ""): Promise<OpenCodeServerLedgerEntry | undefined> {
    return this.serialize(async () => {
      const inspected = await this.inspect(pid);
      if (inspected.state !== "alive") return undefined;
      const entry = { pid, pgid, startTime: inspected.startTime, command: inspected.command, marker };
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
        if (initial.state === "gone") {
          const orphanResult = await this.reapOrphanedGroup(entry, processOwnedPids);
          if (orphanResult === "gone") removed.add(entry.pid);
          continue;
        }
        if (initial.state === "alive" && !matchesEntry(initial, entry)) {
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

  private async reapOrphanedGroup(
    entry: OpenCodeServerLedgerEntry,
    processOwnedPids: ReadonlySet<number>,
  ): Promise<"gone" | "keep"> {
    const groupState = this.probeGroup(entry.pgid);
    if (groupState === "gone") return "gone";
    if (groupState === "unknown") return "keep";
    const initial = await this.inspectMarkedGroupMembers(entry);
    if (processOwnedPids.has(entry.pid) || initial.state === "unknown") return "keep";
    if (initial.members.length === 0) return "gone";
    if (!await this.signalMarkedMembers(entry, initial.members, "SIGTERM", processOwnedPids)) return "keep";
    const afterTerm = await this.waitForMarkedMembers(entry, processOwnedPids);
    if (afterTerm === "gone") return "gone";
    if (afterTerm === "unknown" || processOwnedPids.has(entry.pid)) return "keep";
    const current = await this.inspectMarkedGroupMembers(entry);
    if (processOwnedPids.has(entry.pid) || current.state === "unknown") return "keep";
    if (current.members.length === 0) return "gone";
    if (!await this.signalMarkedMembers(entry, current.members, "SIGKILL", processOwnedPids)) return "keep";
    return await this.waitForMarkedMembers(entry, processOwnedPids) === "gone" ? "gone" : "keep";
  }

  private async inspectMarkedGroupMembers(entry: OpenCodeServerLedgerEntry): Promise<{ state: "known"; members: ProcessIdentity[] } | { state: "unknown" }> {
    const members = await this.inspectGroupMembers(entry.pgid);
    if (!members) return { state: "unknown" };
    if (members.length === 0) return this.probeGroup(entry.pgid) === "gone" ? { state: "known", members: [] } : { state: "unknown" };
    if (!entry.marker) return { state: "known", members: [] };
    const marked: ProcessIdentity[] = [];
    for (const member of members) {
      const markerState = await this.inspectMarker(member.pid, entry.marker);
      if (markerState === "unknown") return { state: "unknown" };
      if (markerState === "marked") marked.push(member);
    }
    return { state: "known", members: marked };
  }

  private async signalMarkedMembers(
    entry: OpenCodeServerLedgerEntry,
    members: readonly ProcessIdentity[],
    signal: NodeJS.Signals,
    processOwnedPids: ReadonlySet<number>,
  ): Promise<boolean> {
    for (const member of members) {
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return false;
      const current = await this.inspect(member.pid);
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return false;
      if (current.state === "unknown") return false;
      if (current.state === "gone" || !matchesProcess(current, member)) continue;
      const markerState = await this.inspectMarker(member.pid, entry.marker);
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return false;
      if (markerState === "unknown") return false;
      if (markerState !== "marked") continue;
      try { this.signalProcess(member.pid, signal); } catch { return false; }
    }
    return true;
  }

  private async waitForMarkedMembers(
    entry: OpenCodeServerLedgerEntry,
    processOwnedPids: ReadonlySet<number>,
  ): Promise<"gone" | "alive" | "unknown"> {
    const deadline = Date.now() + REAP_WAIT_MS;
    while (true) {
      if (processOwnedPids.has(entry.pid)) return "unknown";
      const current = await this.inspectMarkedGroupMembers(entry);
      if (processOwnedPids.has(entry.pid) || current.state === "unknown") return "unknown";
      if (current.members.length === 0) return "gone";
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
          const marker = "marker" in row ? String(row.marker) : "";
          if (Number.isSafeInteger(pid) && Number.isSafeInteger(pgid) && startTime === row.startTime && (!("command" in row) || command === row.command) && (!("marker" in row) || marker === row.marker)) {
            entries.set(pid, { pid, pgid, startTime, command, marker });
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
  return left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime && left.command === right.command && left.marker === right.marker;
}

function matchesEntry(identity: ProcessIdentity | ({ state: "alive" } & Omit<ProcessIdentity, "pid">), entry: OpenCodeServerLedgerEntry): boolean {
  return identity.startTime === entry.startTime && identity.command === entry.command;
}

function membersBelongToSnapshot(current: readonly ProcessIdentity[], original: readonly ProcessIdentity[]): boolean {
  return current.every((member) => original.some((candidate) => candidate.pid === member.pid && candidate.startTime === member.startTime && candidate.command === member.command));
}

function matchesProcess(left: ProcessIdentity | ({ state: "alive" } & Omit<ProcessIdentity, "pid">), right: ProcessIdentity): boolean {
  return left.startTime === right.startTime && left.command === right.command;
}
