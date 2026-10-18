import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { killProcessGroup, createOpenCodeServerMarker, inspectProcessMarker, OpenCodeServerLedger, type ProcessGroupMembers, type ProcessIdentity } from "./opencodeServerLedger.js";

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
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
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
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ ...originalLeader, pgid: originalLeader.pid, marker: entryMarker, unverifiableAttempts: 0 }]);
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

test("escalates a live leader despite ordinary process-group child churn", async () => withLedger(async (file) => {
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; /bin/sleep 0.05; echo ready; while :; do /bin/sleep 0.2; done"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const pid = child.pid;
  if (!pid) throw new Error("missing churn test process pid");
  try {
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.stdout.once("data", () => resolve()); });
    const ledger = new OpenCodeServerLedger(file);
    await ledger.record(pid);
    await ledger.reap();
    let alive = true;
    try {
      const state = await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "stat=", "-p", String(pid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
      alive = state !== "" && !state.startsWith("Z");
    } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    killProcessGroup(pid, "SIGKILL");
  }
}, 10_000));

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
  expect(ledger.snapshot()).toEqual([{ ...entry, unverifiableAttempts: 1 }]);
}));

test("expires leaderless entries after repeated unverifiable marker inspections", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 41900, pgid: 41900, marker: "expiry-marker", unverifiableAttempts: 0 };
  writeFileSync(file, JSON.stringify([entry]));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const ledger = new OpenCodeServerLedger(file, async () => ({ state: "gone" }), undefined, async () => [replacementMember], () => "alive", async () => "unknown");
    for (let attempt = 0; attempt < 10; attempt++) await ledger.reap();
    expect(ledger.snapshot()).toEqual([]);
    expect(warnings).toHaveLength(1);
  } finally {
    console.warn = originalWarn;
  }
}));

test("drops a leaderless entry whose group only zombies still hold open", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 41950, pgid: 41950, marker: "zombie-marker", unverifiableAttempts: 0 };
  writeFileSync(file, JSON.stringify([entry]));
  const zombieOnly: ProcessGroupMembers = Object.assign([], { onlyZombiesRemain: true });
  const ledger = new OpenCodeServerLedger(file, async () => ({ state: "gone" }), undefined, async () => zombieOnly, () => "alive", async () => "unknown");
  await ledger.reap();
  expect(ledger.snapshot()).toEqual([]);
}));

test("keeps a leaderless entry whose live group lists no members", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 41951, pgid: 41951, marker: "unlisted-marker", unverifiableAttempts: 0 };
  writeFileSync(file, JSON.stringify([entry]));
  const ledger = new OpenCodeServerLedger(file, async () => ({ state: "gone" }), undefined, async () => [], () => "alive", async () => "unknown");
  await ledger.reap();
  expect(ledger.snapshot()).toEqual([{ ...entry, unverifiableAttempts: 1 }]);
}));

test("escalates to current leaderless members after a member execs", async () => withLedger(async (file) => {
  await verifyLeaderlessChurn(file, (termSent) => termSent ? [{ ...originalMember, command: "/bin/sleep" }] : [originalMember]);
}));

test("escalates to newly spawned marked leaderless members", async () => withLedger(async (file) => {
  const newChild = { pid: 41003, startTime: "new-child-start", command: "/bin/sleep" };
  await verifyLeaderlessChurn(file, (termSent) => termSent ? [originalMember, newChild] : [originalMember]);
}));

async function verifyLeaderlessChurn(file: string, membersFor: (termSent: boolean) => ProcessIdentity[]) {
  const entry = { ...originalLeader, pgid: originalLeader.pid, marker: entryMarker };
  writeFileSync(file, JSON.stringify([entry]));
  let termSent = false;
  let groupAlive = true;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const ledger = new OpenCodeServerLedger(
    file,
    async (pid) => {
      if (pid === originalLeader.pid) return { state: "gone" };
      const member = [...membersFor(termSent)].find((candidate) => candidate.pid === pid);
      return member ? { state: "alive", startTime: member.startTime, command: member.command } : { state: "gone" };
    },
    undefined,
    async () => groupAlive ? membersFor(termSent) : [],
    () => groupAlive ? "alive" : "gone",
    async () => "marked",
    (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGTERM") termSent = true;
      if (signal === "SIGKILL") groupAlive = false;
    },
  );
  await ledger.reap();
  expect(signals.some(({ signal }) => signal === "SIGTERM")).toBe(true);
  expect(signals.some(({ signal }) => signal === "SIGKILL")).toBe(true);
  expect(ledger.snapshot()).toEqual([]);
}

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

test("does not take a macOS argv marker as environment proof", async () => {
  const marker = createOpenCodeServerMarker();
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; echo ready; while :; do /bin/sleep 30; done", `KONE_OPENCODE_SERVER=${marker}`], { env: {}, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const pid = child.pid;
  if (!pid) throw new Error("missing argv marker test pid");
  try {
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.stdout.once("data", () => resolve()); });
    expect(await inspectProcessMarker(pid, marker)).not.toBe("marked");
  } finally {
    killProcessGroup(pid, "SIGKILL");
  }
}, 10_000);

test("counts and expires an entry whose leader inspection stays unknown", async () => withLedger(async (file) => {
  writeFileSync(file, JSON.stringify([{ ...originalLeader, pid: 42000, pgid: 42000, marker: entryMarker }]));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const ledger = new OpenCodeServerLedger(file, async () => ({ state: "unknown" }));
    for (let attempt = 0; attempt < 9; attempt++) await ledger.reap();
    expect(ledger.snapshot()[0]?.unverifiableAttempts).toBe(9);
    await ledger.reap();
    expect(ledger.snapshot()).toEqual([]);
    expect(warnings).toHaveLength(1);
  } finally {
    console.warn = originalWarn;
  }
}));

test("counts and expires an entry whose group probe stays unknown", async () => withLedger(async (file) => {
  writeFileSync(file, JSON.stringify([{ ...originalLeader, pid: 42001, pgid: 42001, marker: entryMarker }]));
  const ledger = new OpenCodeServerLedger(file, async () => ({ state: "gone" }), undefined, undefined, () => "unknown");
  for (let attempt = 0; attempt < 10; attempt++) await ledger.reap();
  expect(ledger.snapshot()).toEqual([]);
}));

test("a verified leader whose TERM fails resets the unverifiable count to zero", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 42002, pgid: 42002, marker: entryMarker, unverifiableAttempts: 9 };
  writeFileSync(file, JSON.stringify([entry]));
  const ledger = new OpenCodeServerLedger(
    file,
    async () => ({ state: "alive", startTime: originalLeader.startTime, command: originalLeader.command }),
    () => { throw new Error("EPERM"); },
    async () => [originalLeader],
    () => "alive",
  );
  await ledger.reap();
  expect(ledger.snapshot()).toEqual([{ ...entry, unverifiableAttempts: 0 }]);
}));

test("does not signal a pid reused while the final marker inspection awaits", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 61000, pgid: 61000, marker: "server-unique-marker", unverifiableAttempts: 0 };
  writeFileSync(file, JSON.stringify([entry]));
  const member: ProcessIdentity = { pid: 61001, startTime: "old-member", command: "worker" };
  let markerReads = 0;
  let replacement = false;
  const signals: Array<{ pid: number; signal: NodeJS.Signals; replacement: boolean }> = [];
  const ledger = new OpenCodeServerLedger(
    file,
    async (pid) => {
      if (pid === entry.pid) return { state: "gone" };
      // SAFETY: the marker read below flips `replacement` mid-await; the ledger
      // must re-read the identity after it and see this replacement.
      return replacement ? { state: "alive", startTime: "new-unrelated", command: "unrelated" } : { state: "alive", startTime: member.startTime, command: member.command };
    },
    () => { throw new Error("unexpected group signal"); },
    async () => [member],
    () => "alive",
    async () => {
      markerReads += 1;
      if (markerReads === 2) replacement = true;
      return "marked";
    },
    (pid, signal) => { signals.push({ pid, signal, replacement }); },
  );
  await ledger.reap();
  expect(signals).toEqual([]);
}, 10_000));

test("resets the unverifiable count for a marked leaderless group that survives both signals", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 42100, pgid: 42100, marker: entryMarker, unverifiableAttempts: 9 };
  writeFileSync(file, JSON.stringify([entry]));
  const signals: NodeJS.Signals[] = [];
  const ledger = new OpenCodeServerLedger(
    file,
    async (pid) => pid === entry.pid ? { state: "gone" } : { state: "alive", startTime: originalMember.startTime, command: originalMember.command },
    () => { throw new Error("unexpected group signal"); },
    async () => [originalMember],
    () => "alive",
    async () => "marked",
    (_pid, signal) => { signals.push(signal); },
  );
  await ledger.reap();
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(ledger.snapshot()).toEqual([{ ...entry, unverifiableAttempts: 0 }]);
}, 10_000));

test("an ownership exclusion in a leaderless reap leaves the retry count untouched", async () => withLedger(async (file) => {
  const entry = { ...originalLeader, pid: 42200, pgid: 42200, marker: entryMarker, unverifiableAttempts: 9 };
  writeFileSync(file, JSON.stringify([entry]));
  const owned = new Set<number>();
  let memberRead = false;
  const ledger = new OpenCodeServerLedger(
    file,
    async (pid) => pid === entry.pid ? { state: "gone" } : { state: "alive", startTime: originalMember.startTime, command: originalMember.command },
    () => { throw new Error("unexpected group signal"); },
    async () => {
      if (!memberRead) { memberRead = true; owned.add(entry.pid); }
      return [originalMember];
    },
    () => "alive",
    async () => "marked",
    () => { throw new Error("unexpected member signal"); },
  );
  await ledger.reap(undefined, owned);
  expect(ledger.snapshot()).toEqual([entry]);
}, 10_000));
