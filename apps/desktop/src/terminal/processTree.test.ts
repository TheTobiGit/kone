import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, test } from "bun:test";

import {
  captureProcessChildrenMap,
  captureProcessTree,
  inspectSubprocessActivity,
  killProcessTree,
} from "./processTree.js";

// Real-process tests against the host's process table: spawn an `sh` with two
// background sleeps, then prove activity detection and tree kill both see the
// grandchildren. POSIX-only — the Windows table scan is only exercised through
// its parse path, never against a live Windows host.

/** True while `pid` still exists — kill(pid, 0) probes without signalling. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `inspectSubprocessActivity` until both sleeps are visible below the
 *  shell, returning their pids (empty on timeout). */
async function waitForSleepPids(rootPid: number, timeoutMs = 2_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let pids: number[] = [];
  while (Date.now() < deadline) {
    const activity = inspectSubprocessActivity(rootPid);
    pids = activity.descendantPids;
    if (pids.length >= 2) return pids;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pids;
}

/** Spawn `sh -c 'sleep 30 & sleep 30'` with stdio ignored. POSIX sh waits for
 *  background jobs before exiting, so the shell stays alive with two sleep
 *  children until killed. */
function spawnSleepTree(): ChildProcess {
  return spawn("sh", ["-c", "sleep 30 & sleep 30"], { stdio: "ignore" });
}

const describePosix = describe.skipIf(process.platform === "win32");

describePosix("process tree", () => {
  test(
    "inspectSubprocessActivity sees the real subprocess under a shell and labels it",
    async () => {
      const child = spawnSleepTree();
      try {
        expect(child.pid).not.toBeNull();
        const sleepPids = await waitForSleepPids(child.pid!);
        expect(sleepPids).toHaveLength(2);

        const activity = inspectSubprocessActivity(child.pid!);
        expect(activity.captureComplete).toBe(true);
        expect(activity.hasRunningSubprocess).toBe(true);
        expect(activity.childCommandLabel).toBe("sleep");
        expect(activity.descendantPids).toHaveLength(2);
        for (const pid of activity.descendantPids) {
          expect(processAlive(pid)).toBe(true);
        }
      } finally {
        killProcessTree(child.pid!, "SIGKILL");
      }
    },
    10_000,
  );

  test("killProcessTree kills the grandchildren below the shell", async () => {
    const child = spawnSleepTree();
    try {
      expect(child.pid).not.toBeNull();
      const sleepPids = await waitForSleepPids(child.pid!);
      expect(sleepPids).toHaveLength(2);

      killProcessTree(child.pid!, "SIGTERM");

      const treePids = [child.pid!, ...sleepPids];
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && treePids.some((pid) => processAlive(pid))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(treePids.some((pid) => processAlive(pid))).toBe(false);
    } finally {
      killProcessTree(child.pid!, "SIGKILL");
    }
  });

  test("a bogus pid yields an empty tree without failing the capture", () => {
    const map = captureProcessChildrenMap();
    expect(map).not.toBeNull();

    const tree = captureProcessTree(999_999_999);
    expect(tree.captureComplete).toBe(true);
    expect(tree.descendants).toEqual([]);

    const activity = inspectSubprocessActivity(999_999_999);
    expect(activity.captureComplete).toBe(true);
    expect(activity.hasRunningSubprocess).toBe(false);
    expect(activity.childCommandLabel).toBeNull();
    expect(activity.descendantPids).toEqual([]);
  });

  test("invalid root pids are rejected up front, never throwing", () => {
    expect(captureProcessTree(0).captureComplete).toBe(false);
    expect(captureProcessTree(NaN).descendants).toEqual([]);

    const activity = inspectSubprocessActivity(-1);
    expect(activity.captureComplete).toBe(false);
    expect(activity.hasRunningSubprocess).toBe(false);
    expect(activity.childCommandLabel).toBeNull();
    expect(activity.descendantPids).toEqual([]);

    expect(() => killProcessTree(0, "SIGTERM")).not.toThrow();
    expect(() => killProcessTree(NaN, "SIGKILL")).not.toThrow();
  });
});
