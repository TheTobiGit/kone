import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderStatus } from "@kone/agent-core/types.js";
import {
  createProviderSignInController,
  type SignInNavigationDetails,
  type SignInSender,
} from "./providerSignInController.js";
import { TerminalManager } from "../modules/terminal/TerminalManager.js";
import { createTerminalIpc, type TerminalSender } from "../modules/terminal/ipcHandlers.js";
import type { PtyProcess } from "../modules/terminal/Pty.js";
import {
  claimTerminal,
  releaseTerminal,
  terminalOwner,
} from "../modules/terminal/ownership.js";
import type { TerminalEvent } from "../modules/terminal/types.js";

// End-to-end ownership: real TerminalManager + terminal IPC + sign-in
// controller, two fake windows. Window B cannot name, claim, read or control
// window A's live sign-in terminal — including through a refused start such as
// Droid — and failed/stale cleanup cannot release A's claim.

const temp = mkdtempSync(path.join(os.tmpdir(), "kone-signin-own-"));
const binary = path.join(temp, "fake-codex");
writeFileSync(binary, "#!/bin/sh\nexit 0\n");
chmodSync(binary, 0o755);

afterAll(() => rmSync(temp, { recursive: true, force: true }));

const STATUS: ProviderStatus = {
  provider: "codex",
  label: "Codex",
  available: true,
  authStatus: "authenticated",
  readiness: "ready",
};

function fakePty() {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(ev: { exitCode: number; signal?: number }) => void> = [];
  const process: PtyProcess = {
    pid: 4242,
    cols: 80,
    rows: 24,
    write: () => {},
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
    emitData: (data) => {
      for (const cb of Array.from(dataListeners)) cb(data);
    },
    emitExit: (code) => {
      for (const cb of Array.from(exitListeners)) cb({ exitCode: code });
    },
  };
}

type FakeWindow = TerminalSender &
  SignInSender & {
    events: TerminalEvent[];
    reload(): void;
    destroy(): void;
  };

function fakeWindow(): FakeWindow {
  const events: TerminalEvent[] = [];
  const nav = new Set<(details: SignInNavigationDetails) => void>();
  const destroyed = new Set<() => void>();
  let isDestroyed = false;
  return {
    events,
    isDestroyed: () => isDestroyed,
    send: (_channel, event) => {
      events.push(event);
    },
    on: (_event, listener) => {
      nav.add(listener);
    },
    off: (event, listener) => {
      if (event === "destroyed") {
        // SAFETY: the "destroyed" overload's listener is () => void.
        destroyed.delete(listener as () => void);
        return;
      }
      // SAFETY: the navigation overload's listener takes the details object.
      nav.delete(listener as (details: SignInNavigationDetails) => void);
    },
    once: (_event, listener) => {
      destroyed.add(listener);
    },
    reload: () => {
      for (const listener of Array.from(nav)) {
        listener({ isMainFrame: true, isSameDocument: false });
      }
    },
    destroy: () => {
      isDestroyed = true;
      for (const listener of Array.from(destroyed)) listener();
      destroyed.clear();
    },
  };
}

function controllerFor(manager: TerminalManager, terminalIdFactory?: () => string) {
  const base = {
    manager,
    svc: {
      getProviderSettings: () => ({ codex: { binaryPath: binary } }),
      checkProvider: () => Promise.resolve(STATUS),
    },
    buildEnv: () => Promise.resolve({ PATH: temp }),
  };
  return createProviderSignInController(
    terminalIdFactory ? { ...base, terminalIdFactory } : base,
  );
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("sign-in terminal ownership collisions", () => {
  test("a second window cannot steal or read A's sign-in terminal", async () => {
    const pty = fakePty();
    const manager = new TerminalManager({ spawn: async () => pty.process });
    const ipc = createTerminalIpc(manager);
    const a = fakeWindow();
    const b = fakeWindow();
    ipc.handlers.subscribe(a);
    ipc.handlers.subscribe(b);

    const controllerA = controllerFor(manager);
    const started = await controllerA.start({ provider: "codex" }, a);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    const id = started.terminalId;

    pty.emitData("private transcript: a.sarfo@example.com\r\n");
    await flush();
    const aEventsBefore = a.events.length;
    expect(aEventsBefore).toBeGreaterThan(0);
    expect(b.events).toEqual([]);

    // B names A's id through the seeded factory (the main process normally
    // generates a fresh one, so this is the collision the registry must refuse).
    const controllerB = controllerFor(manager, () => id);
    const stolen = await controllerB.start({ provider: "droid" }, b);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.message).toBe("That sign-in terminal is already in use.");

    // The claim is untouched, nothing was spawned for B, and B saw no event.
    expect(terminalOwner(id)).toBe(a);
    expect(b.events).toEqual([]);
    expect(manager["sessions"].size).toBe(1);

    // Every operation on the terminal is refused for B, and none returns the
    // snapshot/history.
    expect(() => ipc.handlers.open(b, { terminalId: id, cwd: "/home/user" })).toThrow(
      "belongs to another window",
    );
    expect(() => ipc.handlers.write(b, { terminalId: id, data: "y\r" })).toThrow(
      "belongs to another window",
    );
    expect(() => ipc.handlers.restart(b, { terminalId: id })).toThrow(
      "belongs to another window",
    );
    await expect(ipc.handlers.close(b, { terminalId: id, deleteHistory: true })).rejects.toThrow(
      "belongs to another window",
    );
    expect(b.events).toEqual([]);

    // A still owns the live stream after B's attempts.
    pty.emitData("still here\r\n");
    await flush();
    expect(a.events.length).toBeGreaterThan(aEventsBefore);

    const closing = ipc.handlers.close(a, { terminalId: id, deleteHistory: true });
    pty.emitExit(0);
    await closing;
    expect(terminalOwner(id)).toBeNull();
  });

  test("a failed or stale run's cleanup cannot release a newer claim", () => {
    const a = fakeWindow();
    const b = fakeWindow();

    expect(claimTerminal("signin-token", a, "token-a")).toBe(true);
    // A conflicting claim is refused atomically and changes nothing.
    expect(claimTerminal("signin-token", b, "token-b")).toBe(false);
    expect(terminalOwner("signin-token")).toBe(a);

    // A refused/stale request cleaning up with its own (never-installed) token
    // is a no-op.
    releaseTerminal("signin-token", "token-b");
    expect(terminalOwner("signin-token")).toBe(a);

    // Even a destroyed owner's claim is held until its run's own cleanup runs,
    // so nobody can race the dying PTY's close and reattach to its transcript.
    a.destroy();
    expect(claimTerminal("signin-token", b, "token-b")).toBe(false);
    expect(terminalOwner("signin-token")).toBe(a);
    releaseTerminal("signin-token", "token-a");
    expect(claimTerminal("signin-token", b, "token-b")).toBe(true);
    releaseTerminal("signin-token", "token-b");
    expect(terminalOwner("signin-token")).toBeNull();
  });

  test("a refused provider cannot reserve a new id either", async () => {
    const pty = fakePty();
    const manager = new TerminalManager({ spawn: async () => pty.process });
    const ipc = createTerminalIpc(manager);
    const b = fakeWindow();
    ipc.handlers.subscribe(b);
    const controller = controllerFor(manager);

    const started = await controller.start({ provider: "droid" }, b);

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.command).toBeNull();
    expect(manager["sessions"].size).toBe(0);
    expect(b.events).toEqual([]);
  });
});
