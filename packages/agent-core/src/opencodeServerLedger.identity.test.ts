import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerLedger, type ProcessIdentity } from "./opencodeServerLedger.js";

const originalLeader: ProcessIdentity = { pid: 41000, startTime: "old-server-start", command: "opencode" };
const originalMember: ProcessIdentity = { pid: 41001, startTime: "old-worker-start", command: "opencode-worker" };
const replacementMember: ProcessIdentity = { pid: 41002, startTime: "replacement-worker", command: "other-worker" };

async function withLedger(run: (file: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-ledger-identity-"));
  try { await run(path.join(dir, "ledger.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("does not SIGKILL a replacement group after its leader exits", async () => withLedger(async (file) => {
  writeFileSync(file, JSON.stringify([{ ...originalLeader, pgid: originalLeader.pid }]));
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
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ ...originalLeader, pgid: originalLeader.pid }]);
}));

test("rechecks owned pids after final leader inspection before SIGKILL", async () => withLedger(async (file) => {
  writeFileSync(file, JSON.stringify([{ ...originalLeader, pgid: originalLeader.pid }]));
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
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ ...originalLeader, pgid: originalLeader.pid }]);
}));
