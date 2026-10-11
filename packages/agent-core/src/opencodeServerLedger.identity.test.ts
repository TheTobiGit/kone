import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerLedger, type ProcessIdentity } from "./opencodeServerLedger.js";

const originalLeader: ProcessIdentity = { pid: 41000, startTime: "old-server-start", command: "opencode" };
const originalMember: ProcessIdentity = { pid: 41001, startTime: "old-worker-start", command: "opencode-worker" };
const replacementMember: ProcessIdentity = { pid: 41002, startTime: "replacement-worker", command: "other-worker" };
const entryMarker = "server-entry-marker";

async function withLedger(run: (file: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-ledger-identity-"));
  try { await run(path.join(dir, "ledger.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("does not SIGKILL a replacement group after its leader exits", async () => withLedger(async (file) => {
  writeFileSync(file, JSON.stringify([{ ...originalLeader, pgid: originalLeader.pid, marker: entryMarker }]));
  const signals: NodeJS.Signals[] = [];
  const members = () => signals.length === 0 ? [originalLeader, originalMember] : [replacementMember];
  let inspections = 0;
  const ledger = new OpenCodeServerLedger(
    file,
    async () => ++inspections <= 2 ? { state: "alive", startTime: originalLeader.startTime, command: originalLeader.command } : { state: "gone" },
    (_pgid, signal) => { signals.push(signal); },
    async () => members(),
    () => "alive",
  );
  await ledger.reap();
  expect(signals).toEqual(["SIGTERM"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ ...originalLeader, pgid: originalLeader.pid, marker: entryMarker }]);
}));

test("rechecks owned pids after final leader inspection before SIGKILL", async () => withLedger(async (file) => {
  writeFileSync(file, JSON.stringify([{ ...originalLeader, pgid: originalLeader.pid, marker: entryMarker }]));
  const owned = new Set<number>();
  const signals: NodeJS.Signals[] = [];
  let inspections = 0;
  const ledger = new OpenCodeServerLedger(
    file,
    async () => {
      inspections++;
      if (inspections <= 2) return { state: "alive", startTime: originalLeader.startTime, command: originalLeader.command };
      owned.add(originalLeader.pid);
      return { state: "gone" };
    },
    (_pgid, signal) => { signals.push(signal); },
    async () => [originalLeader],
    () => "alive",
  );
  await ledger.reap(undefined, owned);
  expect(signals).toEqual(["SIGTERM"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ ...originalLeader, pgid: originalLeader.pid, marker: entryMarker }]);
}));

test("does not signal an unmarked replacement group after the recorded leader is gone", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pgid: originalLeader.pid, marker: entryMarker };
  writeFileSync(file, JSON.stringify([entry]));
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const ledger = new OpenCodeServerLedger(
    file,
    async () => ({ state: "gone" }),
    undefined,
    async () => [replacementMember],
    () => "alive",
    async () => "unmarked",
    (pid, signal) => { signals.push({ pid, signal }); },
  );
  await ledger.reap();
  expect(signals).toEqual([]);
  expect(ledger.snapshot()).toEqual([]);
}));

test("reaps marked orphan members after the recorded leader is gone", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pgid: originalLeader.pid, marker: entryMarker };
  writeFileSync(file, JSON.stringify([entry]));
  let markerAlive = true;
  let groupAlive = true;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const ledger = new OpenCodeServerLedger(
    file,
    async (pid) => pid === originalLeader.pid ? { state: "gone" } : { state: "alive", startTime: originalMember.startTime, command: originalMember.command },
    undefined,
    async () => markerAlive ? [originalMember] : [],
    () => groupAlive ? "alive" : "gone",
    async () => markerAlive ? "marked" : "unmarked",
    (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") {
        markerAlive = false;
        groupAlive = false;
      }
    },
  );
  await ledger.reap();
  expect(signals).toEqual([
    { pid: originalMember.pid, signal: "SIGTERM" },
    { pid: originalMember.pid, signal: "SIGKILL" },
  ]);
  expect(ledger.snapshot()).toEqual([]);
}));

test("keeps an orphan ledger entry when member environments cannot be read", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pgid: originalLeader.pid, marker: entryMarker };
  writeFileSync(file, JSON.stringify([entry]));
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const ledger = new OpenCodeServerLedger(
    file,
    async () => ({ state: "gone" }),
    undefined,
    async () => [replacementMember],
    () => "alive",
    async () => "unknown",
    (pid, signal) => { signals.push({ pid, signal }); },
  );
  await ledger.reap();
  expect(signals).toEqual([]);
  expect(ledger.snapshot()).toEqual([entry]);
}));

test("reaps a real marked orphan after its process-group leader exits", async () => withLedger(async (file) => {
  const marker = "real-orphan-test-marker";
  const child = spawn(process.execPath, ["-e", "const { spawn } = require('node:child_process'); process.on('SIGUSR1', () => process.exit(0)); const orphan = spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); console.log(orphan.pid + ':' + process.env.KONE_OPENCODE_SERVER);"], {
    detached: true,
    env: { ...process.env, KONE_OPENCODE_SERVER: marker },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const leaderPid = child.pid;
  if (!leaderPid) throw new Error("missing orphan test leader pid");
  const leaderExited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  let orphanPid = 0;
  try {
    orphanPid = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (chunk) => {
        const [pid, printedMarker] = String(chunk).trim().split(":");
        expect(printedMarker).toBe(marker);
        resolve(Number(pid));
      });
      child.stdout.once("error", reject);
    });
    if (!orphanPid) throw new Error("missing orphan process pid");
    const ledger = new OpenCodeServerLedger(file, undefined, undefined, undefined, undefined, async (pid, expectedMarker) => {
      return pid === orphanPid && expectedMarker === marker ? "marked" : "unknown";
    });
    const entry = await ledger.record(leaderPid, leaderPid, marker);
    if (!entry) throw new Error("failed to record orphan test leader");
    process.kill(leaderPid, "SIGUSR1");
    await leaderExited;
    await ledger.reap();
    const state = await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "stat=", "-p", String(orphanPid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim()))).catch(() => "");
    expect(state === "" || state.startsWith("Z")).toBe(true);
    expect(ledger.snapshot()).toEqual([]);
  } finally {
    try { process.kill(-leaderPid, "SIGKILL"); } catch { /* the process group is already gone */ }
  }
}));

test("leaves a real unmarked replacement group running after its leader exits", async () => withLedger(async (file) => {
  const marker = "recorded-server-marker";
  const child = spawn(process.execPath, ["-e", "const { spawn } = require('node:child_process'); process.on('SIGUSR1', () => process.exit(0)); const orphan = spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); console.log(orphan.pid);"], {
    detached: true,
    env: { ...process.env, KONE_OPENCODE_SERVER: "replacement-server-marker" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const leaderPid = child.pid;
  if (!leaderPid) throw new Error("missing replacement test leader pid");
  const leaderExited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  let orphanPid = 0;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  try {
    orphanPid = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
      child.stdout.once("error", reject);
    });
    if (!orphanPid) throw new Error("missing replacement process pid");
    const ledger = new OpenCodeServerLedger(file, undefined, undefined, undefined, undefined, async () => "unmarked", (pid, signal) => { signals.push({ pid, signal }); });
    const entry = await ledger.record(leaderPid, leaderPid, marker);
    if (!entry) throw new Error("failed to record replacement test leader");
    process.kill(leaderPid, "SIGUSR1");
    await leaderExited;
    await ledger.reap();
    const state = await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "stat=", "-p", String(orphanPid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    expect(state.startsWith("Z")).toBe(false);
    expect(signals).toEqual([]);
    expect(ledger.snapshot()).toEqual([]);
  } finally {
    try { process.kill(-leaderPid, "SIGKILL"); } catch { /* the process group is already gone */ }
  }
}));
