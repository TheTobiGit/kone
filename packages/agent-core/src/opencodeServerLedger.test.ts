import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerLedger, type ProcessInspectionResult } from "./opencodeServerLedger.js";
import { OpenCodeServerPool } from "./opencodeServer.js";
import { setUserDataDir } from "./userDataDir.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledger(inspect: (pid: number) => ProcessInspectionResult, killed: number[], onKill?: (pgid: number) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-"));
  dirs.push(dir);
  const filePath = path.join(dir, "servers.json");
  return { subject: new OpenCodeServerLedger(filePath, inspect, (pgid) => { killed.push(pgid); onKill?.(pgid); }), filePath };
}

describe("OpenCodeServerLedger", () => {
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

  test("records process identity and removes it on clean dispose", () => {
    const { subject, filePath } = ledger(() => ({ state: "alive", startTime: "Mon Oct 11 05:00:00 2026" }), []);
    subject.record(301, 301);
    subject.remove(301);
    expect(readFileSync(filePath, "utf8")).toBe("[]");
  });

  test("reaps only live entries whose process start time still matches", async () => {
    const killed: number[] = [];
    const starts = new Map([[301, "same"], [302, "reused"], [303, undefined]]);
    let pid301Gone = false;
    const { subject } = ledger((pid) => {
      if (pid === 301 && pid301Gone) return { state: "gone" };
      const startTime = starts.get(pid);
      return startTime ? { state: "alive", startTime } : { state: "unknown" };
    }, killed, (pgid) => { if (pgid === 301) pid301Gone = true; });
    subject.record(301, 301);
    subject.record(302, 302);
    subject.record(303, 303);
    starts.set(302, "new process");
    await subject.reap();
    expect(killed).toEqual([301]);
  });

  test("reap escalates for a process group that ignores SIGTERM", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-term-"));
    dirs.push(dir);
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    const pid = child.pid;
    if (!pid) throw new Error("server test process did not start");
    const filePath = path.join(dir, "servers.json");
    try {
      const subject = new OpenCodeServerLedger(filePath);
      subject.record(pid);
      await subject.reap();
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
      expect(readFileSync(filePath, "utf8")).toBe("[]");
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* process exited */ }
    }
  });
});
