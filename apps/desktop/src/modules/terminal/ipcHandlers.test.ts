import { describe, expect, test } from "bun:test";

import { TerminalManager } from "./TerminalManager.js";
import { createTerminalIpc, type TerminalSender } from "./ipcHandlers.js";
import { claimTerminal, terminalOwner } from "./ownership.js";
import type { PtyProcess } from "./Pty.js";
import type { TerminalEvent } from "./types.js";

// The terminal IPC boundary, with two real fake windows: only the claimed
// (sign-in) window may see the transcript or touch the PTY. The manager is the
// real one, driven through its fake-PTY seam.

function fakePty() {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(ev: { exitCode: number; signal?: number }) => void> = [];
  const writes: string[] = [];
  const process: PtyProcess = {
    pid: 4242,
    cols: 80,
    rows: 24,
    write: (data) => writes.push(data),
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    onData: (cb) => {
      dataListeners.push(cb);
      return () => {
        const index = dataListeners.indexOf(cb);
        if (index >= 0) dataListeners.splice(index, 1);
      };
    },
    onExit: (cb) => {
      exitListeners.push(cb);
      return () => {
        const index = exitListeners.indexOf(cb);
        if (index >= 0) exitListeners.splice(index, 1);
      };
    },
  };
  return {
    process,
    writes,
    emitData: (data) => {
      for (const cb of Array.from(dataListeners)) cb(data);
    },
    emitExit: (code) => {
      for (const cb of Array.from(exitListeners)) cb({ exitCode: code ?? 0 });
    },
  };
}

function fakeWindow(): TerminalSender & {
  events: TerminalEvent[];
  destroy(): void;
} {
  const events: TerminalEvent[] = [];
  const destroyedListeners = new Set<() => void>();
  let destroyed = false;
  return {
    events,
    isDestroyed: () => destroyed,
    send: (_channel, event) => {
      events.push(event);
    },
    once: (_event, listener) => {
      destroyedListeners.add(listener);
    },
    destroy: () => {
      destroyed = true;
      for (const listener of Array.from(destroyedListeners)) listener();
      destroyedListeners.clear();
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const BANNER = "\x1b[2m~\x1b[0m\r\n\x1b[32m❯\x1b[0m cursor-agent login\r\n\r\n";

describe("terminal IPC ownership", () => {
  test("a sign-in terminal's events and operations belong to its window only", async () => {
    const pty = fakePty();
    const mgr = new TerminalManager({ spawn: async () => pty.process });
    const ipc = createTerminalIpc(mgr);
    const owner = fakeWindow();
    const stranger = fakeWindow();
    ipc.handlers.subscribe(owner);
    ipc.handlers.subscribe(stranger);

    claimTerminal("signin", owner, "run-token");
    await mgr.openCommand(
      { terminalId: "signin", cwd: "/home/user", env: { PATH: "/usr/bin" } },
      { command: { file: "cursor-agent", args: ["login"] }, banner: BANNER, completeEnv: true },
    );
    pty.emitData("Open this URL in your browser:\r\nhttps://cursor.com/login\r\n");
    await flush();

    // No event — including the `started` snapshot with its history — reached
    // the other window.
    expect(owner.events.map((event) => event.type)).toEqual(["started", "output"]);
    expect(stranger.events).toEqual([]);
    expect(
      owner.events.some(
        (event) => event.type === "started" && event.snapshot.history.includes("cursor-agent login"),
      ),
    ).toBe(true);

    // Reattach is an open() under the same id: refused before the manager can
    // hand over the history.
    expect(() => ipc.handlers.open(stranger, { terminalId: "signin", cwd: "/home/user" })).toThrow(
      "belongs to another window",
    );
    // The owner may reattach and gets the transcript.
    const snapshot = await ipc.handlers.open(owner, { terminalId: "signin", cwd: "/home/user" });
    expect(snapshot.history).toContain("cursor-agent login");
    expect(snapshot.history).toContain("https://cursor.com/login");
    expect(owner.events.filter((event) => event.type === "started")).toHaveLength(2);
    expect(stranger.events).toEqual([]);

    // Every mutating operation is refused for the stranger.
    expect(() =>
      ipc.handlers.write(stranger, { terminalId: "signin", data: "y\r" }),
    ).toThrow("belongs to another window");
    expect(() =>
      ipc.handlers.resize(stranger, { terminalId: "signin", cols: 100, rows: 30 }),
    ).toThrow("belongs to another window");
    expect(() =>
      ipc.handlers.ack(stranger, { terminalId: "signin", byteCount: 10 }),
    ).toThrow("belongs to another window");
    expect(() => ipc.handlers.restart(stranger, { terminalId: "signin" })).toThrow(
      "belongs to another window",
    );
    await expect(ipc.handlers.close(stranger, { terminalId: "signin" })).rejects.toThrow(
      "belongs to another window",
    );
    expect(pty.writes).toEqual([]);

    // The owner still can — and when it closes, the claim goes with the
    // transcript.
    ipc.handlers.write(owner, { terminalId: "signin", data: "y\r" });
    expect(pty.writes).toEqual(["y\r"]);
    const closing = ipc.handlers.close(owner, { terminalId: "signin", deleteHistory: true });
    pty.emitExit(0);
    await closing;
    expect(terminalOwner("signin")).toBeNull();
  });

  test("an ordinary terminal stays shared between windows", async () => {
    const pty = fakePty();
    const mgr = new TerminalManager({ spawn: async () => pty.process });
    const ipc = createTerminalIpc(mgr);
    const one = fakeWindow();
    const two = fakeWindow();
    ipc.handlers.subscribe(one);
    ipc.handlers.subscribe(two);

    await ipc.handlers.open(one, { terminalId: "shell", cwd: "/tmp" });
    pty.emitData("hello");
    await flush();

    expect(one.events.map((event) => event.type)).toEqual(["started", "output"]);
    expect(two.events.map((event) => event.type)).toEqual(["started", "output"]);
    // Either window may act on it, as before.
    ipc.handlers.write(two, { terminalId: "shell", data: "ls\r" });
    expect(pty.writes).toEqual(["ls\r"]);

    const closing = ipc.handlers.close(one, { terminalId: "shell" });
    pty.emitExit(0);
    await closing;
  });

  test("a destroyed window stops receiving events", async () => {
    const pty = fakePty();
    const mgr = new TerminalManager({ spawn: async () => pty.process });
    const ipc = createTerminalIpc(mgr);
    const owner = fakeWindow();
    ipc.handlers.subscribe(owner);

    claimTerminal("signin", owner, "run-token");
    await mgr.openCommand(
      { terminalId: "signin", cwd: "/home/user" },
      { command: { file: "codex", args: ["login"] } },
    );
    const before = owner.events.length;
    owner.destroy();
    pty.emitData("late bytes");
    await flush();

    expect(owner.events).toHaveLength(before);
    const closing = ipc.handlers.close(owner, { terminalId: "signin" });
    pty.emitExit(0);
    await closing;
  });
});
