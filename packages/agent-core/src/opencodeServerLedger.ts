import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ProcessIdentity = { pid: number; startTime: string; command: string };
export type OpenCodeServerLedgerEntry = ProcessIdentity & { pgid: number; marker: string; unverifiableAttempts: number };
export type ProcessInspectionResult =
  | ({ state: "alive" } & Omit<ProcessIdentity, "pid">)
  | { state: "gone" }
  | { state: "unknown" };
export type ProcessInspection = (pid: number) => Promise<ProcessInspectionResult>;
export type ProcessKiller = (pgid: number, signal: NodeJS.Signals) => void;
/** Live members of a group. `onlyZombiesRemain` marks a group the listing saw
 *  with nothing but zombies left in it: nothing can run there any more, even
 *  though the group still answers a signal probe until they are reaped. */
export type ProcessGroupMembers = ProcessIdentity[] & { onlyZombiesRemain?: boolean };
export type ProcessGroupMembersInspection = (pgid: number) => Promise<ProcessGroupMembers | undefined>;
export type ProcessGroupProbe = (pgid: number) => ProcessGroupInspection;
export type ProcessMarkerInspection = "marked" | "unmarked" | "gone" | "unknown";
export type ProcessEnvironmentInspector = (pid: number, marker: string) => Promise<ProcessMarkerInspection>;
export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;
type ProcessGroupInspection = "alive" | "gone" | "unknown";
const REAP_POLL_MS = 100;
const REAP_WAIT_MS = 2_000;
const PROCESS_INSPECTION_TIMEOUT_MS = 2_000;
const SERVER_MARKER_ENV = "KONE_OPENCODE_SERVER";
const MAX_UNVERIFIABLE_ATTEMPTS = 10;
const warnedUnverifiableEntries = new Set<string>();

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

export function inspectProcessGroupMembers(pgid: number): Promise<ProcessGroupMembers | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,pgid=,lstart=,comm=,stat="], { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const members: ProcessGroupMembers = [];
      let zombies = 0;
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
        if (row.zombie) zombies += 1;
        else members.push(row.identity);
      }
      if (members.length === 0 && zombies > 0) members.onlyZombiesRemain = true;
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
    return inspectDarwinProcessMarker(pid, marker);
  }
  return "unknown";
}

async function inspectDarwinProcessMarker(pid: number, marker: string): Promise<ProcessMarkerInspection> {
  const [argvOutput, combinedOutput] = await Promise.all([readDarwinCommandLine(pid, false), readDarwinCommandLine(pid, true)]);
  if (argvOutput === undefined || combinedOutput === undefined) return processIsGone(pid) ? "gone" : "unknown";
  const argvText = argvOutput.replace(/\r?\n$/, "");
  const combinedText = combinedOutput.replace(/\r?\n$/, "");
  // Without an environment section there is nothing to match against: the
  // marker may live only in argv, which is not ownership proof.  `ps -E`
  // prints argv and the environment with no delimiter, so the only way to
  // tell them apart is to strip the argv text this process actually has.
  if (argvText.length === 0 || combinedText === argvText) return "unknown";
  if (!combinedText.startsWith(`${argvText} `)) return "unknown";
  const environmentText = combinedText.slice(argvText.length + 1);
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${SERVER_MARKER_ENV}=${escapedMarker}(?:\\s|$)`).test(environmentText) ? "marked" : "unmarked";
}

function readDarwinCommandLine(pid: number, withEnvironment: boolean): Promise<string | undefined> {
  const args = withEnvironment ? ["-p", String(pid), "-Eww", "-o", "command="] : ["-p", String(pid), "-ww", "-o", "command="];
  return new Promise((resolve) => {
    execFile("ps", args, { encoding: "utf8", timeout: PROCESS_INSPECTION_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? undefined : String(stdout));
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
    private readonly inspectGroupMembers: ProcessGroupMembersInspection = inspectProcessGroupMembers,
    private readonly probeGroup: ProcessGroupProbe = inspectProcessGroup,
    private readonly inspectMarker: ProcessEnvironmentInspector = inspectProcessMarker,
    private readonly signalProcess: ProcessSignalSender = (pid, signal) => { process.kill(pid, signal); },
  ) {}

  record(pid: number, pgid = pid, marker = ""): Promise<OpenCodeServerLedgerEntry | undefined> {
    return this.serialize(async () => {
      const inspected = await this.inspect(pid);
      if (inspected.state !== "alive") return undefined;
      const entry = { pid, pgid, startTime: inspected.startTime, command: inspected.command, marker, unverifiableAttempts: 0 };
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
      const verified = new Set<number>();
      for (const entry of orphanSnapshot) {
        if (processOwnedPids.has(entry.pid)) continue;
        let outcome: "verified" | "unverifiable" | "none" = "none";
        entryReap: {
          const initial = await this.inspect(entry.pid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (initial.state === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (initial.state === "gone") {
            const orphanResult = await this.reapOrphanedGroup(entry, processOwnedPids);
            if (orphanResult === "gone") removed.add(entry.pid);
            else if (orphanResult === "unknown") outcome = "unverifiable";
            else if (orphanResult === "verified") outcome = "verified";
            else outcome = "none";
            break entryReap;
          }
          if (!matchesEntry(initial, entry)) { removed.add(entry.pid); break entryReap; }
          const groupState = this.probeGroup(entry.pgid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (groupState === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (groupState !== "alive") break entryReap;
          outcome = "verified";
          const leaderAtSignal = await this.inspect(entry.pid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (leaderAtSignal.state === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (leaderAtSignal.state === "gone") {
            const orphanResult = await this.reapOrphanedGroup(entry, processOwnedPids);
            if (orphanResult === "gone") removed.add(entry.pid);
            else if (orphanResult === "unknown") outcome = "unverifiable";
            else if (orphanResult === "verified") outcome = "verified";
            else outcome = "none";
            break entryReap;
          }
          if (!matchesEntry(leaderAtSignal, entry)) { removed.add(entry.pid); break entryReap; }
          try { this.kill(entry.pgid, "SIGTERM"); } catch { break entryReap; }
          const afterTerm = await this.waitForGroupExit(entry.pgid);
          if (afterTerm === "gone") { removed.add(entry.pid); break entryReap; }
          if (afterTerm === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (processOwnedPids.has(entry.pid)) break entryReap;
          const leaderBeforeKill = await this.inspect(entry.pid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (leaderBeforeKill.state === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (leaderBeforeKill.state === "alive" && !matchesEntry(leaderBeforeKill, entry)) { removed.add(entry.pid); break entryReap; }
          if (leaderBeforeKill.state === "gone") {
            const orphanResult = await this.reapOrphanedGroup(entry, processOwnedPids);
            if (orphanResult === "gone") removed.add(entry.pid);
            else if (orphanResult === "unknown") outcome = "unverifiable";
            else if (orphanResult === "verified") outcome = "verified";
            else outcome = "none";
            break entryReap;
          }
          const groupBeforeKill = this.probeGroup(entry.pgid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (groupBeforeKill === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (groupBeforeKill !== "alive") break entryReap;
          const leaderAtKill = await this.inspect(entry.pid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (leaderAtKill.state === "unknown") { outcome = "unverifiable"; break entryReap; }
          if (leaderAtKill.state === "gone") {
            const orphanResult = await this.reapOrphanedGroup(entry, processOwnedPids);
            if (orphanResult === "gone") removed.add(entry.pid);
            else if (orphanResult === "unknown") outcome = "unverifiable";
            else if (orphanResult === "verified") outcome = "verified";
            else outcome = "none";
            break entryReap;
          }
          if (!matchesEntry(leaderAtKill, entry)) { removed.add(entry.pid); break entryReap; }
          try { this.kill(entry.pgid, "SIGKILL"); } catch { break entryReap; }
          const afterKill = await this.waitForGroupExit(entry.pgid);
          if (processOwnedPids.has(entry.pid)) break entryReap;
          if (afterKill === "gone") removed.add(entry.pid);
          else if (afterKill === "unknown") outcome = "unverifiable";
        }
        if (outcome === "unverifiable") {
          if (this.recordUnverifiableAttempt(entry)) removed.add(entry.pid);
        } else if (outcome === "verified") {
          // A verified attempt clears the retry count: whatever ran before, the
          // entry is unambiguously ours right now.
          entry.unverifiableAttempts = 0;
          verified.add(entry.pid);
        }
      }
      const entries = this.read();
      for (const entry of orphanSnapshot) {
        const current = entries.get(entry.pid);
        if (!current || !sameIdentity(current, entry)) continue;
        // A verified attempt resets to 0 and must outrank both the persisted
        // count and a concurrent writer's increment; only unverifiable passes
        // keep the running maximum.
        current.unverifiableAttempts = verified.has(entry.pid) ? 0 : Math.max(current.unverifiableAttempts, entry.unverifiableAttempts);
      }
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
  ): Promise<"gone" | "unknown" | "verified" | "none"> {
    const groupState = this.probeGroup(entry.pgid);
    if (groupState === "gone") return "gone";
    if (groupState === "unknown") return "unknown";
    const initial = await this.inspectMarkedGroupMembers(entry);
    if (processOwnedPids.has(entry.pid)) return "none";
    if (initial.state === "unknown") return "unknown";
    if (initial.members.length === 0) return "gone";
    const termResult = await this.signalMarkedMembers(entry, initial.members, "SIGTERM", processOwnedPids);
    if (termResult === "unknown") return "unknown";
    if (termResult === "owned") return "none";
    const afterTerm = await this.waitForMarkedMembers(entry, processOwnedPids);
    if (afterTerm === "gone") return "gone";
    if (afterTerm === "unknown") return "unknown";
    if (processOwnedPids.has(entry.pid)) return "none";
    const current = await this.inspectMarkedGroupMembers(entry);
    if (processOwnedPids.has(entry.pid)) return "none";
    if (current.state === "unknown") return "unknown";
    if (current.members.length === 0) return "gone";
    const killResult = await this.signalMarkedMembers(entry, current.members, "SIGKILL", processOwnedPids);
    if (killResult === "unknown") return "unknown";
    if (killResult === "owned") return "none";
    const afterKill = await this.waitForMarkedMembers(entry, processOwnedPids);
    if (afterKill === "gone") return "gone";
    if (afterKill === "unknown") return "unknown";
    // Members were inspected as marked and matching and both signals were sent:
    // ownership is verified even though the group outlived the polls (a task in
    // uninterruptible I/O can hold SIGKILL pending). A verified attempt resets
    // the retry count; only an ownership exclusion is left untouched.
    return "verified";
  }

  private recordUnverifiableAttempt(entry: OpenCodeServerLedgerEntry): boolean {
    const key = `${entry.pid}:${entry.startTime}:${entry.command}:${entry.marker}`;
    if (!warnedUnverifiableEntries.has(key)) {
      warnedUnverifiableEntries.add(key);
      console.warn(`OpenCode orphan server group could not be verified (pid ${entry.pid})`);
    }
    entry.unverifiableAttempts += 1;
    return entry.unverifiableAttempts >= MAX_UNVERIFIABLE_ATTEMPTS;
  }

  private async inspectMarkedGroupMembers(entry: OpenCodeServerLedgerEntry): Promise<{ state: "known"; members: ProcessIdentity[] } | { state: "unknown" }> {
    const members = await this.inspectGroupMembers(entry.pgid);
    if (!members) return { state: "unknown" };
    // An empty listing for a group that still answers the probe is unproven,
    // unless the listing saw that only zombies hold the group open.
    if (members.length === 0) return members.onlyZombiesRemain || this.probeGroup(entry.pgid) === "gone" ? { state: "known", members: [] } : { state: "unknown" };
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
  ): Promise<"sent" | "unknown" | "owned"> {
    for (const member of members) {
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return "owned";
      const current = await this.inspect(member.pid);
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return "owned";
      if (current.state === "unknown") return "unknown";
      if (current.state === "gone" || !matchesProcess(current, member)) continue;
      const markerState = await this.inspectMarker(member.pid, entry.marker);
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return "owned";
      if (markerState === "unknown") return "unknown";
      if (markerState !== "marked") continue;
      // The marker read may resolve after this pid was released and reused.
      // Re-read the identity last, with no await between it and the signal.
      const identityBeforeSignal = await this.inspect(member.pid);
      if (processOwnedPids.has(entry.pid) || processOwnedPids.has(member.pid)) return "owned";
      if (identityBeforeSignal.state === "unknown") return "unknown";
      if (identityBeforeSignal.state === "gone" || !matchesProcess(identityBeforeSignal, member)) continue;
      try { this.signalProcess(member.pid, signal); } catch { return "unknown"; }
    }
    return "sent";
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
          const unverifiableAttempts = "unverifiableAttempts" in row ? Number(row.unverifiableAttempts) : 0;
          if (Number.isSafeInteger(pid) && Number.isSafeInteger(pgid) && startTime === row.startTime && (!("command" in row) || command === row.command) && (!("marker" in row) || marker === row.marker) && Number.isSafeInteger(unverifiableAttempts) && unverifiableAttempts >= 0) {
            entries.set(pid, { pid, pgid, startTime, command, marker, unverifiableAttempts });
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

function matchesProcess(left: ProcessIdentity | ({ state: "alive" } & Omit<ProcessIdentity, "pid">), right: ProcessIdentity): boolean {
  return left.startTime === right.startTime && left.command === right.command;
}
