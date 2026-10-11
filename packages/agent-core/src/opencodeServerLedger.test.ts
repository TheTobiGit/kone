import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { inspectProcessStartTime, OpenCodeServerLedger, type ProcessInspectionResult } from "./opencodeServerLedger.js";
import { OpenCodeServerPool } from "./opencodeServer.js";
import { setUserDataDir } from "./userDataDir.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledger(inspect: (pid: number) => Promise<ProcessInspectionResult>, killed: number[], onKill?: (pgid: number) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-"));
  dirs.push(dir);
  const filePath = path.join(dir, "servers.json");
  return { subject: new OpenCodeServerLedger(filePath, inspect, (pgid) => { killed.push(pgid); onKill?.(pgid); }), filePath };
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
    writeFileSync(binary, "#!/bin/sh\necho 'opencode server listening on http://127.0.0.1:40123'\nexec /bin/sleep 30\n");
    chmodSync(binary, 0o700);
    const priorPath = process.env.PATH;
    process.env.PATH = dir;
    const pool = new OpenCodeServerPool();
    let server: Awaited<ReturnType<OpenCodeServerPool["start"]>> | undefined;
    try {
      const started = Date.now();
      server = await pool.start({ cwd: dir, env: process.env, binary });
      expect(Date.now() - started).toBeLessThan(1_000);
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
    const { subject, filePath } = ledger(async () => ({ state: "alive", startTime: "Mon Oct 11 05:00:00 2026" }), []);
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
      return startTime ? { state: "alive", startTime } : { state: "unknown" };
    }, killed, (pgid) => { if (pgid === 301) pid301Gone = true; });
    await subject.record(301, 301);
    await subject.record(302, 302);
    await subject.record(303, 303);
    starts.set(302, "new process");
    await subject.reap();
    expect(killed).toEqual([301]);
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
      const subject = new OpenCodeServerLedger(filePath);
      await subject.record(pid);
      await subject.reap();
      let alive = true;
      try {
        const state = await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "stat=", "-p", String(pid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
        alive = !state.startsWith("Z");
      } catch { alive = false; }
      expect(alive).toBe(false);
      const entries: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      expect(entries).toHaveLength(1);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* process exited */ }
    }
  });
});
