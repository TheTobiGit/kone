import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerLedger } from "./opencodeServerLedger.js";
import { OpenCodeServerPool } from "./opencodeServer.js";
import { setUserDataDir } from "./userDataDir.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledger(inspect: (pid: number) => string | undefined, killed: number[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-opencode-ledger-"));
  dirs.push(dir);
  const filePath = path.join(dir, "servers.json");
  return { subject: new OpenCodeServerLedger(filePath, inspect, (pgid) => killed.push(pgid)), filePath };
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
    const { subject, filePath } = ledger(() => "Mon Oct 11 05:00:00 2026", []);
    subject.record(301, 301);
    subject.remove(301);
    expect(readFileSync(filePath, "utf8")).toBe("[]");
  });

  test("reaps only live entries whose process start time still matches", () => {
    const killed: number[] = [];
    const starts = new Map([[301, "same"], [302, "reused"], [303, undefined]]);
    const { subject } = ledger((pid) => starts.get(pid), killed);
    subject.record(301, 301);
    subject.record(302, 302);
    subject.record(303, 303);
    starts.set(302, "new process");
    subject.reap();
    expect(killed).toEqual([301]);
  });
});
