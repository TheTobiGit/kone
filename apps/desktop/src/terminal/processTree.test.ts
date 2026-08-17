import { spawn, type ChildProcess } from "node:child_process";

import { beforeEach, describe, expect, test } from "bun:test";

import {
  captureProcessChildrenMap,
  captureProcessTree,
  createProcessTreeKiller,
  inspectSubprocessActivity,
  killProcessTree,
  mergeProcessTreeCaptures,
  resetProcessTreeKillStateForTests,
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

/** Parent shell dies on SIGTERM; the node child ignores SIGTERM and stays
 *  alive, so it is reparented to init once the shell exits.
 *
 *  The child prints its own pid, and only after its handler is installed. The
 *  shell knows the pid the moment it forks and could announce it with `$!`, but
 *  node needs tens of milliseconds to reach the `process.on` call, and a SIGTERM
 *  arriving inside that window is not ignored — it kills the child outright and
 *  the test loses the very thing it set out to prove. */
function spawnTermIgnoringDescendant(): ChildProcess {
  return spawn(
    "sh",
    [
      "-c",
      `node -e 'process.on("SIGTERM",()=>{}); console.log("CHILD:"+process.pid); setInterval(()=>{},1000)' & wait`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

/** Spawn a root that ignores SIGTERM and starts a long-lived child only after a
 *  delay, so the child does not exist when the tree is captured — a stand-in for
 *  a shell that goes on working through the grace period it was handed. */
function spawnLateChildTree(): ChildProcess {
  return spawn(
    "sh",
    ["-c", `trap '' TERM; echo READY; sleep 0.4; sleep 30 & echo LATE:$!; wait`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

/** Collect the root's stdout, resolving each time `pattern` first matches. */
function watchStdout(child: ChildProcess): {
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
} {
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
  });
  return {
    async waitFor(pattern, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = buf.match(pattern);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`${pattern} never matched: ${JSON.stringify(buf)}`);
    },
  };
}

/** Poll until `pid` is gone, or give up after `timeoutMs`. */
async function waitForDeath(pid: number, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const describePosix = describe.skipIf(process.platform === "win32");

describePosix("process tree", () => {
  beforeEach(() => {
    resetProcessTreeKillStateForTests();
  });

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

  test(
    "killProcessTree SIGKILL still reaps a TERM-ignoring child after the root has exited",
    async () => {
      const child = spawnTermIgnoringDescendant();
      const stdout = watchStdout(child);
      let stubbornPid: number | null = null;
      try {
        expect(child.pid).not.toBeNull();
        stubbornPid = Number((await stdout.waitFor(/CHILD:(\d+)/))[1]);
        expect(processAlive(stubbornPid)).toBe(true);

        killProcessTree(child.pid!, "SIGTERM");

        await waitForDeath(child.pid!);
        expect(processAlive(child.pid!)).toBe(false);
        // The premise: SIGTERM did not take this one with it, and it has now been
        // reparented to init, out of reach of any snapshot taken from the root.
        expect(processAlive(stubbornPid)).toBe(true);

        killProcessTree(child.pid!, "SIGKILL");

        await waitForDeath(stubbornPid);
        expect(processAlive(stubbornPid)).toBe(false);
      } finally {
        if (stubbornPid !== null) {
          try {
            process.kill(stubbornPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
      }
    },
    10_000,
  );

  test(
    "killProcessTree SIGKILL reaps a child started during the SIGTERM grace period",
    async () => {
      // The grace period between the two signals is time the root goes on
      // running in, and whatever it starts there is absent from the capture the
      // SIGTERM took. Killing only that capture leaves the newcomer alive and
      // parented to init, which is the orphan this module exists to prevent.
      const child = spawnLateChildTree();
      const stdout = watchStdout(child);
      let latePid: number | null = null;
      try {
        expect(child.pid).not.toBeNull();
        await stdout.waitFor(/READY/);

        killProcessTree(child.pid!, "SIGTERM");
        // The root ignores SIGTERM, so it survives to start the late child.
        latePid = Number((await stdout.waitFor(/LATE:(\d+)/))[1]);
        expect(processAlive(latePid)).toBe(true);

        killProcessTree(child.pid!, "SIGKILL");

        await waitForDeath(latePid);
        expect(processAlive(latePid)).toBe(false);
        expect(processAlive(child.pid!)).toBe(false);
      } finally {
        if (latePid !== null) {
          try {
            process.kill(latePid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
      }
    },
    10_000,
  );

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

// Platform-independent: no processes, just the merge rule the escalation relies on.
describe("mergeProcessTreeCaptures", () => {
  const capture = (
    descendants: Array<{ pid: number; command: string }>,
    rootCommand: string | null = "sh -c root",
    captureComplete = true,
  ) => ({ descendants, captureComplete, rootCommand });

  test("keeps descendants only the remembered capture knows about", () => {
    // Reparented to init after the root died: a fresh snapshot cannot find it.
    const merged = mergeProcessTreeCaptures(
      capture([{ pid: 11, command: "node stubborn" }]),
      capture([]),
    );
    expect(merged.descendants).toEqual([{ pid: 11, command: "node stubborn" }]);
  });

  test("adds descendants that appeared after the remembered capture", () => {
    const merged = mergeProcessTreeCaptures(
      capture([{ pid: 11, command: "sleep 1" }]),
      capture([{ pid: 12, command: "sleep 30" }]),
    );
    expect(merged.descendants).toEqual([
      { pid: 11, command: "sleep 1" },
      { pid: 12, command: "sleep 30" },
    ]);
  });

  test("prefers the fresh command for a pid present in both", () => {
    // Whatever occupies that pid under the root right now is what has to die,
    // and the older reading may name a command already replaced.
    const merged = mergeProcessTreeCaptures(
      capture([{ pid: 11, command: "stale command" }]),
      capture([{ pid: 11, command: "live command" }]),
    );
    expect(merged.descendants).toEqual([{ pid: 11, command: "live command" }]);
  });

  test("keeps the remembered root identity, since that is what is escalated on", () => {
    const merged = mergeProcessTreeCaptures(
      capture([], "sh -c original"),
      capture([], "something-recycled"),
    );
    expect(merged.rootCommand).toBe("sh -c original");
  });

  test("falls back to the fresh root identity when the remembered one is unknown", () => {
    const merged = mergeProcessTreeCaptures(capture([], null), capture([], "sh -c root"));
    expect(merged.rootCommand).toBe("sh -c root");
  });

  test("stays unproven when either capture was unproven", () => {
    expect(
      mergeProcessTreeCaptures(capture([], "sh", false), capture([], "sh", true))
        .captureComplete,
    ).toBe(false);
    expect(
      mergeProcessTreeCaptures(capture([], "sh", true), capture([], "sh", false))
        .captureComplete,
    ).toBe(false);
  });

  test("passes the fresh capture straight through when nothing was remembered", () => {
    const fresh = capture([{ pid: 12, command: "sleep 30" }]);
    expect(mergeProcessTreeCaptures(undefined, fresh)).toBe(fresh);
  });
});

// The merge feeds the SIGKILL, which refuses any captured pid whose command no
// longer matches. Merging must not smuggle a stranger past that check, so both
// halves are exercised together against a fake process table.
describe("merged captures still respect the pid-recycling guard", () => {
  function killerOver(currentCommands: Record<number, string>) {
    const signalled: Array<{ pid: number; signal: string }> = [];
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => new Map(),
      readCurrentCommands: () =>
        new Map(Object.entries(currentCommands).map(([pid, cmd]) => [Number(pid), cmd])),
      signalPid: (pid, signal) => signalled.push({ pid, signal }),
    });
    return { killer, signalled };
  }

  test("skips a remembered pid that a stranger has since recycled", () => {
    // The child died during the grace period and something unrelated took its
    // pid. It is not under the root any more, so the fresh capture never saw it
    // and the merge keeps the older entry — which is exactly what fails the
    // command comparison and spares a process nobody here owns.
    const merged = mergeProcessTreeCaptures(
      { descendants: [{ pid: 11, command: "node our-child" }], captureComplete: true, rootCommand: "sh root" },
      { descendants: [], captureComplete: true, rootCommand: "sh root" },
    );
    const { killer, signalled } = killerOver({ 11: "unrelated-daemon", 999: "sh root" });
    killer.signal({ rootPid: 999, signal: "SIGKILL", tree: merged });

    expect(signalled.map((s) => s.pid)).not.toContain(11);
    expect(signalled.map((s) => s.pid)).toContain(999);
  });

  test("kills a pid the fresh capture found under the root, on its current command", () => {
    // Same pid, different command from the stale reading. It is a live
    // descendant of the root, so it belongs to this tree and must die — taking
    // the fresh command is what lets the comparison succeed.
    const merged = mergeProcessTreeCaptures(
      { descendants: [{ pid: 11, command: "stale reading" }], captureComplete: true, rootCommand: "sh root" },
      { descendants: [{ pid: 11, command: "npm run dev" }], captureComplete: true, rootCommand: "sh root" },
    );
    const { killer, signalled } = killerOver({ 11: "npm run dev", 999: "sh root" });
    killer.signal({ rootPid: 999, signal: "SIGKILL", tree: merged });

    expect(signalled).toContainEqual({ pid: 11, signal: "SIGKILL" });
  });

  test("still refuses the root when its command no longer matches the remembered one", () => {
    const merged = mergeProcessTreeCaptures(
      { descendants: [], captureComplete: true, rootCommand: "sh original-root" },
      { descendants: [], captureComplete: true, rootCommand: "something-else" },
    );
    const { killer, signalled } = killerOver({ 999: "something-else" });
    killer.signal({ rootPid: 999, signal: "SIGKILL", tree: merged });

    expect(signalled).toEqual([]);
  });
});
