import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderStatus } from "@kone/agent-core/types.js";
import {
  createProviderSignInController,
  type SignInNavigationDetails,
  type SignInSender,
  type SignInTerminalManager,
} from "./providerSignInController.js";
import { terminalOwner } from "../modules/terminal/ownership.js";
import type { TerminalOpenInput, TerminalSessionSnapshot } from "../modules/terminal/types.js";

// The sign-in request lifecycle, driven through fake WebContents and a fake
// terminal manager: ownership is claimed at acceptance, a queued request that
// loses its document never spawns, and every listener is released on every
// outcome.

const temp = mkdtempSync(path.join(os.tmpdir(), "kone-signin-ipc-"));
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

function snapshot(terminalId: string): TerminalSessionSnapshot {
  return {
    terminalId,
    pid: 1,
    cols: 80,
    rows: 24,
    cwd: "/home/user",
    status: "ready",
    history: "",
    sequence: 0,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    childCommandLabel: null,
  };
}

type FakeSender = SignInSender & {
  reload(): void;
  destroy(): void;
  navigationListeners(): number;
  destroyedListeners(): number;
};

function fakeSender(): FakeSender {
  const nav = new Set<(details: SignInNavigationDetails) => void>();
  const destroyed = new Set<() => void>();
  let isDestroyed = false;
  return {
    isDestroyed: () => isDestroyed,
    on: (_event, listener) => {
      nav.add(listener);
    },
    off: (event, listener) => {
      if (event === "destroyed") {
        // SAFETY: the "destroyed" overload's listener is () => void; this
        // branch is only reached for that event.
        destroyed.delete(listener as () => void);
        return;
      }
      // SAFETY: the navigation overload's listener takes the details object;
      // this branch is only reached for did-start-navigation.
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
    navigationListeners: () => nav.size,
    destroyedListeners: () => destroyed.size,
  };
}

type Spawn = { input: TerminalOpenInput; completeEnv: boolean | undefined };

function fakeManager(): SignInTerminalManager & {
  spawns: Spawn[];
  closes: string[];
  endSession(terminalId: string): void;
} {
  const spawns: Spawn[] = [];
  const closes: string[] = [];
  const ended = new Set<(terminalId: string) => void>();
  return {
    spawns,
    closes,
    openCommand: (input, launch) => {
      spawns.push({ input, completeEnv: launch.completeEnv });
      return Promise.resolve(snapshot(input.terminalId));
    },
    close: ({ terminalId }) => {
      closes.push(terminalId);
      return Promise.resolve();
    },
    onSessionEnded: (listener) => {
      ended.add(listener);
      return () => ended.delete(listener);
    },
    endSession: (terminalId) => {
      for (const listener of ended) listener(terminalId);
    },
  };
}

function controllerFor(manager: SignInTerminalManager) {
  return createProviderSignInController({
    manager,
    svc: {
      getProviderSettings: () => ({ codex: { binaryPath: binary } }),
      checkProvider: () => Promise.resolve(STATUS),
    },
    // Skip the login-shell probe; the resolver only needs PATH.
    buildEnv: () => Promise.resolve({ PATH: temp }),
  });
}

function start(controller: ReturnType<typeof controllerFor>, terminalId: string, sender: SignInSender) {
  return controller.start({ provider: "codex", terminalId }, sender);
}

describe("provider sign-in request lifecycle", () => {
  test("accepting a start claims the terminal for its window before the spawn", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    const controller = controllerFor(manager);

    const pending = start(controller, "signin-1", sender);
    expect(terminalOwner("signin-1")).toBe(sender);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(manager.spawns).toHaveLength(1);
    // Sign-in's env is complete: it must replace, not merge.
    expect(manager.spawns[0]?.completeEnv).toBe(true);
    // The run keeps its lifecycle listeners until the session ends.
    expect(sender.navigationListeners()).toBe(1);
    expect(sender.destroyedListeners()).toBe(1);

    manager.endSession("signin-1");
    expect(sender.navigationListeners()).toBe(0);
    expect(sender.destroyedListeners()).toBe(0);
    // The exited terminal — and its in-memory transcript — still belongs to
    // its window until that window closes it.
    expect(terminalOwner("signin-1")).toBe(sender);
    sender.destroy();
    expect(terminalOwner("signin-1")).toBeNull();
  });

  test("a reload after the spawn kills the live login immediately", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    const controller = controllerFor(manager);
    const result = await start(controller, "signin-1", sender);
    expect(result.ok).toBe(true);

    sender.reload();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.closes).toEqual(["signin-1"]);
    expect(terminalOwner("signin-1")).toBeNull();
    expect(sender.navigationListeners()).toBe(0);
    expect(sender.destroyedListeners()).toBe(0);
  });

  test("a queued start cancelled by a reload never spawns or keeps listeners", async () => {
    const manager = fakeManager();
    const first = fakeSender();
    const second = fakeSender();
    let releaseEnv = (): void => {};
    const envGate = new Promise<void>((resolve) => {
      releaseEnv = resolve;
    });
    let firstEnv = true;
    const controller = createProviderSignInController({
      manager,
      svc: {
        getProviderSettings: () => ({ codex: { binaryPath: binary } }),
        checkProvider: () => Promise.resolve(STATUS),
      },
      buildEnv: async () => {
        if (firstEnv) {
          firstEnv = false;
          await envGate;
        }
        return { PATH: temp };
      },
    });

    // The first start holds the queue inside its env read; the second is
    // accepted (and watched) while it waits.
    const one = start(controller, "signin-1", first);
    const two = start(controller, "signin-2", second);
    expect(terminalOwner("signin-2")).toBe(second);
    expect(second.navigationListeners()).toBe(1);

    // The waiting document reloads before it ever launches.
    second.reload();
    releaseEnv();

    const [firstResult, secondResult] = await Promise.all([one, two]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.message).toBe("The window that asked to sign in went away.");
      expect(secondResult.command?.display).toBe(`${binary} login`);
    }
    expect(manager.spawns.map((spawn) => spawn.input.terminalId)).toEqual(["signin-1"]);
    expect(terminalOwner("signin-2")).toBeNull();
    expect(second.navigationListeners()).toBe(0);
    expect(second.destroyedListeners()).toBe(0);

    manager.endSession("signin-1");
    first.destroy();
  });

  test("a destroyed sender spawns nothing, even when destroyed during the queue", async () => {
    const manager = fakeManager();
    const first = fakeSender();
    const second = fakeSender();
    let releaseEnv = (): void => {};
    const envGate = new Promise<void>((resolve) => {
      releaseEnv = resolve;
    });
    let firstEnv = true;
    const controller = createProviderSignInController({
      manager,
      svc: {
        getProviderSettings: () => ({ codex: { binaryPath: binary } }),
        checkProvider: () => Promise.resolve(STATUS),
      },
      buildEnv: async () => {
        if (firstEnv) {
          firstEnv = false;
          await envGate;
        }
        return { PATH: temp };
      },
    });

    const one = start(controller, "signin-1", first);
    const two = start(controller, "signin-2", second);
    second.destroy();
    releaseEnv();

    await one;
    const secondResult = await two;
    expect(secondResult.ok).toBe(false);
    expect(manager.spawns.map((spawn) => spawn.input.terminalId)).toEqual(["signin-1"]);
    expect(terminalOwner("signin-2")).toBeNull();
    expect(second.navigationListeners()).toBe(0);
    expect(second.destroyedListeners()).toBe(0);

    manager.endSession("signin-1");
    first.destroy();
  });

  test("an already-destroyed sender is refused without claiming anything", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    sender.destroy();
    const controller = controllerFor(manager);

    const result = await start(controller, "signin-1", sender);

    expect(result.ok).toBe(false);
    expect(manager.spawns).toEqual([]);
    expect(terminalOwner("signin-1")).toBeNull();
    expect(sender.navigationListeners()).toBe(0);
    expect(sender.destroyedListeners()).toBe(0);
  });
});
