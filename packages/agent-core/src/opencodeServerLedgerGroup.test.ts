import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerLedger } from "./opencodeServerLedger.js";

test("reap keeps signaling a verified group after its leader exits on SIGTERM", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "p9-group-"));
  const marker = "group-test-marker";
  const child = spawn("/bin/sh", ["-c", "/bin/sh -c 'trap \"\" TERM; echo CHILD:$$; exec /bin/sleep 30' & trap 'exit 0' TERM; wait"], { detached: true, env: { ...process.env, KONE_OPENCODE_SERVER: marker }, stdio: ["ignore", "pipe", "ignore"] });
  if (!child.pid) throw new Error("no group leader");
  const pid = child.pid;
  let descendantPid = 0;
  try {
    descendantPid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim().split(":")[1])));
    });
    if (!descendantPid) throw new Error("no descendant pid");
    const file = path.join(dir, "ledger.json");
    const ledger = new OpenCodeServerLedger(file, undefined, undefined, undefined, undefined, async (candidatePid, expectedMarker) => candidatePid === descendantPid && expectedMarker === marker ? "marked" : "unmarked");
    await ledger.record(pid, pid, marker);
    await ledger.reap();
    let descendantAlive = true;
    try {
      const state = await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "stat=", "-p", String(descendantPid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
      descendantAlive = !state.startsWith("Z");
    } catch { descendantAlive = false; }
    expect(descendantAlive).toBe(false);
    // A dropped entry means nothing in the group can still run. Zombies may
    // linger where init is slow to reap them, so count only live members.
    const listing = await new Promise<string>((resolve, reject) => execFile("ps", ["-axo", "pgid=,stat="], (error, stdout) => error ? reject(error) : resolve(stdout)));
    const groupAlive = listing.split("\n").some((line) => {
      const [rowPgid, stat] = line.trim().split(/\s+/);
      return Number(rowPgid) === pid && !stat?.startsWith("Z");
    });
    const entries: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(entries) && entries.length === 0) expect(groupAlive).toBe(false);
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* group already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
