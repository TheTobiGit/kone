import { describe, expect, test } from "bun:test";

import { TerminalManager } from "./TerminalManager.js";
import type { PtyProcess } from "./Pty.js";
import type { TerminalEvent } from "./types.js";

// ── Fake PTY seam ────────────────────────────────────────────────────────────
// The manager accepts `{ spawn }` in its constructor, so tests drive a fake
// node-pty process: `emitData` delivers PTY output, `emitExit` delivers the
// exit event. The manager's tree-kill path (killProcessTree) is a real system
// call, but against the fake's bogus pid it captures nothing and signals
// nothing — cheap and side-effect free.

type FakePty = {
  process: PtyProcess & { paused: boolean; killed: string[] };
  emitData(data: string): void;
  emitExit(exitCode: number | null, signal?: number): void;
};

function fakePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(ev: { exitCode: number; signal?: number }) => void> = [];
  const killed: string[] = [];
  let paused = false;

  const process: PtyProcess & { paused: boolean; killed: string[] } = {
    pid: 4242,
    cols: 80,
    rows: 24,
    paused,
    killed,
    write: () => {},
    resize: () => {},
    pause: () => {
      paused = true;
      process.paused = true;
    },
    resume: () => {
      paused = false;
      process.paused = false;
    },
    kill: (signal?: string) => {
      killed.push(signal ?? "default");
    },
    onData: (cb) => {
      dataListeners.push(cb);
      return () => {
        const i = dataListeners.indexOf(cb);
        if (i >= 0) dataListeners.splice(i, 1);
      };
    },
    onExit: (cb) => {
      exitListeners.push(cb);
      return () => {
        const i = exitListeners.indexOf(cb);
        if (i >= 0) exitListeners.splice(i, 1);
      };
    },
  };

  return {
    process,
    emitData: (data) => {
      for (const cb of [...dataListeners]) cb(data);
    },
    emitExit: (exitCode, signal) => {
      for (const cb of [...exitListeners]) cb({ exitCode: exitCode ?? 0, signal });
    },
  };
}

function makeManager(fake: FakePty): { mgr: TerminalManager; events: TerminalEvent[] } {
  const mgr = new TerminalManager({ spawn: async () => fake.process });
  const events: TerminalEvent[] = [];
  mgr.onEvent((e) => events.push(e));
  return { mgr, events };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("TerminalManager", () => {
  test("open emits a started event with a snapshot and a monotonic sequence", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    const snapshot = await mgr.open({ terminalId: "t1", cwd: "/tmp", cols: 80, rows: 24 });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.sequence).toBe(0);
    expect(snapshot.hasRunningSubprocess).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "started", sequence: 1 });
  });

  test("history is sanitized (queries stripped) while the renderer gets raw bytes", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    fake.emitData("hello \x1b[6n world");
    // Re-attach flushes the pending batch, so the snapshot sees the history.
    const snapshot = await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    expect(snapshot.history).toContain("hello ");
    expect(snapshot.history).toContain("world");
    expect(snapshot.history).not.toContain("\x1b[6n");
    // The live renderer still received the raw query bytes.
    const output = events.find((e) => e.type === "output");
    expect(output).toMatchObject({ type: "output", data: "hello \x1b[6n world" });
  });

  test("snapshot history starts with the mode-replay preamble", async () => {
    const fake = fakePty();
    const { mgr } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    fake.emitData("prompt$ \x1b[?1h");
    const snapshot = await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    expect(snapshot.history.startsWith("\x1b[?1h")).toBe(true);
  });

  test("a query split across chunks is sanitized once complete", async () => {
    const fake = fakePty();
    const { mgr } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    fake.emitData("text \x1b[6");
    fake.emitData("n done");
    const snapshot = await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    expect(snapshot.history).toContain("text ");
    expect(snapshot.history).toContain(" done");
    expect(snapshot.history).not.toContain("\x1b[6n");
  });

  test("sequence increments per event and is carried across restart", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    fake.emitData("one");
    await flush();
    fake.emitData("two");
    await flush();
    expect(events.filter((e) => e.type === "output").map((e) => e.sequence)).toEqual([2, 3]);

    const restartPromise = mgr.restart({ terminalId: "t1" });
    fake.emitExit(0);
    await restartPromise;

    const restarted = events.find((e) => e.type === "restarted");
    expect(restarted).toBeDefined();
    // No spurious `exited` consumed a sequence slot during restart, so the
    // carried snapshot sequence is the last real event's (3) and the
    // `restarted` event itself is strictly next (4).
    expect(restarted!.sequence).toBe(4);
    expect(restarted!.snapshot.sequence).toBe(3);
    expect(restarted!.snapshot.history).toBe("");
  });

  test("restart does not emit an exited event for the deliberate kill", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    const restartPromise = mgr.restart({ terminalId: "t1" });
    fake.emitExit(0);
    await restartPromise;

    expect(events.map((e) => e.type)).toEqual(["started", "restarted"]);
  });

  test("close does not emit an exited event for the deliberate kill", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    const closePromise = mgr.close({ terminalId: "t1" });
    fake.emitExit(0);
    await closePromise;

    expect(events.map((e) => e.type)).toEqual(["started", "closed"]);
  });

  test("backpressure: pauses the PTY past the high watermark, resumes on acks", async () => {
    const fake = fakePty();
    const { mgr } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    // A single 200KB burst trips the 64KB flush cap and crosses the 100KB ack
    // high watermark in one flush.
    fake.emitData("x".repeat(200 * 1024));
    expect(fake.process.paused).toBe(true);

    // Still above the 5KB low watermark after a partial ack.
    mgr.ack({ terminalId: "t1", byteCount: 150 * 1024 });
    expect(fake.process.paused).toBe(true);

    // Drains below the low watermark → resumed.
    mgr.ack({ terminalId: "t1", byteCount: 46 * 1024 });
    expect(fake.process.paused).toBe(false);

    const closePromise = mgr.close({ terminalId: "t1" });
    fake.emitExit(0);
    await closePromise;
  });

  test("restart resets history and re-spawns via the seam", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    fake.emitData("old output");
    await flush();

    const restartPromise = mgr.restart({ terminalId: "t1", cols: 100, rows: 30 });
    fake.emitExit(0);
    const snapshot = await restartPromise;

    expect(snapshot.history).toBe("");
    expect(events.at(-1)).toMatchObject({ type: "restarted" });

    const closePromise = mgr.close({ terminalId: "t1" });
    fake.emitExit(0);
    await closePromise;
  });

  test("exit emits an exited event with code and stops the session", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    fake.emitData("bye");
    await flush();
    fake.emitExit(1);

    const exited = events.find((e) => e.type === "exited");
    expect(exited).toMatchObject({ type: "exited", exitCode: 1 });
  });

  test("close emits closed and a later open spawns fresh", async () => {
    const fake = fakePty();
    const { mgr, events } = makeManager(fake);
    await mgr.open({ terminalId: "t1", cwd: "/tmp" });

    const closePromise = mgr.close({ terminalId: "t1", deleteHistory: true });
    fake.emitExit(0);
    await closePromise;

    expect(events.at(-1)).toMatchObject({ type: "closed" });
    expect(mgr["sessions"].size).toBe(0);

    await mgr.open({ terminalId: "t1", cwd: "/tmp" });
    expect(mgr["sessions"].size).toBe(1);

    const closePromise2 = mgr.close({ terminalId: "t1" });
    fake.emitExit(0);
    await closePromise2;
  });

  test("restart preserves the session's env", async () => {
    const fake = fakePty();
    const spawns: Array<{ env?: Record<string, string> }> = [];
    const mgr = new TerminalManager({ spawn: async (input) => {
      spawns.push(input);
      return fake.process;
    } });
    mgr.onEvent(() => {});
    await mgr.open({ terminalId: "t1", cwd: "/tmp", env: { FOO: "bar" } });
    expect(spawns[0]?.env).toEqual({ FOO: "bar" });

    const restartPromise = mgr.restart({ terminalId: "t1" });
    fake.emitExit(0);
    await restartPromise;

    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.env).toEqual({ FOO: "bar" });
  });

  test("restarting a missing session throws", async () => {
    const fake = fakePty();
    const { mgr } = makeManager(fake);
    expect(mgr.restart({ terminalId: "nope" })).rejects.toThrow();
  });
});
