import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { inspectProcessStartTime, OpenCodeServerLedger, type ProcessGroupMembersInspection, type ProcessGroupProbe, type ProcessInspectionResult } from "./opencodeServerLedger.js";
import { OpenCodeServerPool } from "./opencodeServer.js";
import { setUserDataDir } from "./userDataDir.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledger(inspect: (pid: number) => Promise<ProcessInspectionResult>, killed: number[], onKill?: (pgid: number) => void, inspectGroupMembers?: ProcessGroupMembersInspection, probeGroup?: ProcessGroupProbe) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-"));
  dirs.push(dir);
  const filePath = path.join(dir, "servers.json");
  return { subject: new OpenCodeServerLedger(filePath, inspect, (pgid) => { killed.push(pgid); onKill?.(pgid); }, inspectGroupMembers, probeGroup), filePath };
}

describe("OpenCodeServerLedger", () => {
  test("process inspection does not block the event loop and times out", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ps-timeout-"));
    dirs.push(dir);
    const shim = path.join(dir, "ps");
    writeFileSync(shim, "#!/bin/sh\n/bin/sleep 2\necho start-time\n");
    chmodSync(shim, 0o700);
    const priorPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const started = Date.now();
      let eventLoopAdvanced = false;
      const timer = setTimeout(() => { eventLoopAdvanced = true; }, 25);
      await inspectProcessStartTime(process.pid);
      clearTimeout(timer);
      expect(eventLoopAdvanced).toBe(true);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      process.env.PATH = priorPath;
    }
  });

  test("first server start does not wait for the orphan reap or pid inspection", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-first-start-"));
    dirs.push(dir);
    setUserDataDir(dir);
    const shim = path.join(dir, "ps");
    writeFileSync(shim, "#!/bin/sh\n/bin/sleep 2\necho start-time\n");
    chmodSync(shim, 0o700);
    const binary = path.join(dir, "fake-opencode");
    const markerFile = path.join(dir, "server-marker.txt");
    writeFileSync(binary, "#!/bin/sh\necho \"$KONE_OPENCODE_SERVER\" > " + markerFile + "\necho 'opencode server listening on http://127.0.0.1:40123'\nexec /bin/sleep 30\n");
    chmodSync(binary, 0o700);
    const priorPath = process.env.PATH;
    process.env.PATH = dir;
    const pool = new OpenCodeServerPool();
    let server: Awaited<ReturnType<OpenCodeServerPool["start"]>> | undefined;
    try {
      const started = Date.now();
      server = await pool.start({ cwd: dir, env: process.env, binary });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(readFileSync(markerFile, "utf8").trim()).not.toBe("");
    } finally {
      process.env.PATH = priorPath;
      if (server) await server.dispose();
      await pool.dispose();
    }
  });

  test("ledger I/O failures do not poison later server starts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-recovery-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "opencode-servers.json"));
    setUserDataDir(dir);
    const pool = new OpenCodeServerPool();
    const input = { cwd: dir, env: process.env, binary: "/missing-opencode-for-ledger-test" };
    let firstError = "";
    try { await pool.start(input); } catch (error) { firstError = String(error); }
    rmSync(path.join(dir, "opencode-servers.json"), { recursive: true, force: true });
    let secondError = "";
    try { await pool.start(input); } catch (error) { secondError = String(error); }
    expect(firstError).not.toContain("EISDIR");
    expect(secondError).not.toContain("EISDIR");
    expect(secondError).toContain("ENOENT");
  });

  test("records process identity and removes it on clean dispose", async () => {
    const { subject, filePath } = ledger(async () => ({ state: "alive", startTime: "Mon Oct 11 05:00:00 2026", command: "opencode" }), []);
    await subject.record(301, 301);
    await subject.remove(301);
    expect(readFileSync(filePath, "utf8")).toBe("[]");
  });

  test("reaps only live entries whose process start time still matches", async () => {
    const killed: number[] = [];
    const starts = new Map([[301, "same"], [302, "reused"], [303, undefined]]);
    let pid301Gone = false;
    const { subject } = ledger(async (pid) => {
      if (pid === 301 && pid301Gone) return { state: "gone" };
      const startTime = starts.get(pid);
      return startTime ? { state: "alive", startTime, command: "opencode" } : { state: "unknown" };
    }, killed, (pgid) => { if (pgid === 301) pid301Gone = true; }, async (pgid) => [{ pid: pgid, startTime: "same", command: "opencode" }], () => "alive");
    await subject.record(301, 301);
    await subject.record(302, 302);
    await subject.record(303, 303);
    starts.set(302, "new process");
    await subject.reap();
    expect(killed).toEqual([301, 301]);
  });

  test("reap escalates for a process group that ignores SIGTERM", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-term-"));
    dirs.push(dir);
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; echo ready; exec /bin/sleep 30"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    const pid = child.pid;
    if (!pid) throw new Error("server test process did not start");
    const filePath = path.join(dir, "servers.json");
    try {
      let lastGroupProbe: "alive" | "gone" | "unknown" = "unknown";
      const subject = new OpenCodeServerLedger(filePath, undefined, undefined, undefined, (pgid) => {
        try {
          process.kill(-pgid, 0);
          lastGroupProbe = "alive";
        } catch (cause) {
          lastGroupProbe = cause instanceof Error && "code" in cause && cause.code === "ESRCH" ? "gone" : "unknown";
        }
        return lastGroupProbe;
      });
      await subject.record(pid);
      await subject.reap();
      let alive = true;
      try {
        const state = await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "stat=", "-p", String(pid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
        alive = !state.startsWith("Z");
      } catch { alive = false; }
      expect(alive).toBe(false);
      const entries: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      expect(entries).toHaveLength(lastGroupProbe === "gone" ? 0 : 1);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* process exited */ }
    }
  });

  test("retains an entry when group liveness cannot be confirmed", async () => {
    const { subject, filePath } = ledger(async () => ({ state: "alive", startTime: "start", command: "opencode" }), [], undefined, async (pgid) => [{ pid: pgid, startTime: "start", command: "opencode" }]);
    await subject.record(41001, 41001);
    const originalKill = process.kill;
    const denyProcessKill: typeof process.kill = (pid, signal) => {
      void pid;
      void signal;
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    process.kill = denyProcessKill;
    try {
      await subject.reap();
      expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual([{ pid: 41001, pgid: 41001, startTime: "start", command: "opencode", marker: "" }]);
    } finally {
      process.kill = originalKill;
    }
  });
});
