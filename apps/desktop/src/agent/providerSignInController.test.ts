import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderKind, ProviderStatus } from "@kone/agent-core/types.js";
import {
  createProviderSignInController,
  type SignInNavigationDetails,
  type SignInSender,
  type SignInTerminalManager,
} from "./providerSignInController.js";
import { releaseClosedTerminal, terminalOwner } from "../modules/terminal/ownership.js";
import type { TerminalOpenInput, TerminalSessionSnapshot } from "../modules/terminal/types.js";

// The sign-in request lifecycle, driven through fake WebContents and a fake
// terminal manager: ids are main-generated, ownership is claimed at acceptance
// under a per-run token, a queued request that loses its document never spawns,
// and every listener is released on every outcome.

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

/** A deterministic id factory for one controller; tests that assert on ids use
 *  this, while the "main generates ids" test uses the real default. */
function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `signin-extra-${index}`;
}

function controllerFor(manager: SignInTerminalManager, terminalIdFactory?: () => string) {
  const base = {
    manager,
    svc: {
      getProviderSettings: () => ({ codex: { binaryPath: binary } }),
      checkProvider: () => Promise.resolve(STATUS),
    },
    // Skip the login-shell probe; the resolver only needs PATH.
    buildEnv: () => Promise.resolve({ PATH: temp }),
  };
  return createProviderSignInController(
    terminalIdFactory ? { ...base, terminalIdFactory } : base,
  );
}

function start(
  controller: ReturnType<typeof controllerFor>,
  sender: SignInSender,
  provider: ProviderKind = "codex",
) {
  return controller.start({ provider }, sender);
}

describe("provider sign-in request lifecycle", () => {
  test("accepting a start claims the terminal for its window before the spawn", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    const controller = controllerFor(manager, ids("signin-1"));

    const pending = start(controller, sender);
    expect(terminalOwner("signin-1")).toBe(sender);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.terminalId).toBe("signin-1");
    expect(manager.spawns).toHaveLength(1);
    expect(manager.spawns[0]?.input.terminalId).toBe("signin-1");
    // Sign-in's env is complete: it must replace, not merge.
    expect(manager.spawns[0]?.completeEnv).toBe(true);
    // The run keeps its lifecycle listeners until the session ends.
    expect(sender.navigationListeners()).toBe(1);
    expect(sender.destroyedListeners()).toBe(1);

    manager.endSession("signin-1");
    expect(sender.navigationListeners()).toBe(0);
    // One self-removing claim-release watcher remains for the kept claim.
    expect(sender.destroyedListeners()).toBe(1);
    // The exited terminal — and its in-memory transcript — still belongs to
    // its window until that window closes it.
    expect(terminalOwner("signin-1")).toBe(sender);
    sender.destroy();
    expect(terminalOwner("signin-1")).toBeNull();
    expect(sender.destroyedListeners()).toBe(0);
  });

  test("an exited sign-in closed through the terminal path leaves no destroyed listener", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    const controller = controllerFor(manager);

    // Past Node's default listener budget: the repro left one `destroyed`
    // listener behind per exited-then-closed sign-in.
    for (let run = 0; run < 12; run += 1) {
      const result = await start(controller, sender);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const id = result.terminalId;

      // The CLI exits on its own: the claim (and its watcher) stay, so the
      // transcript remains private to this window...
      manager.endSession(id);
      expect(terminalOwner(id)).toBe(sender);
      expect(sender.destroyedListeners()).toBe(1);

      // ...until the window closes the terminal through the terminal IPC path,
      // which releases the claim and must detach the watcher with it.
      releaseClosedTerminal(id, sender);
      expect(terminalOwner(id)).toBeNull();
      expect(sender.destroyedListeners()).toBe(0);
    }

    expect(sender.navigationListeners()).toBe(0);
    expect(sender.destroyedListeners()).toBe(0);
  });

  test("ids are main-generated, unique, and any renderer-supplied id is ignored", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    const controller = controllerFor(manager);

    const first = await controller.start({ provider: "codex", terminalId: "renderer-choice" }, sender);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.terminalId).toMatch(/^signin-[0-9a-f-]{36}$/);
    expect(first.terminalId).not.toBe("renderer-choice");
    expect(terminalOwner("renderer-choice")).toBeNull();
    expect(manager.spawns[0]?.input.terminalId).toBe(first.terminalId);

    manager.endSession(first.terminalId);
    sender.destroy();

    const second = await controller.start({ provider: "codex" }, fakeSender());
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.message);
    expect(second.terminalId).not.toBe(first.terminalId);
  });

  test("a reload after the spawn kills the live login immediately", async () => {
    const manager = fakeManager();
    const sender = fakeSender();
    const controller = controllerFor(manager, ids("signin-1"));
    const result = await start(controller, sender);
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
      terminalIdFactory: ids("signin-1", "signin-2"),
    });

    // The first start holds the queue inside its env read; the second is
    // accepted (and watched) while it waits.
    const one = start(controller, first);
    const two = start(controller, second);
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
      terminalIdFactory: ids("signin-1", "signin-2"),
    });

    const one = start(controller, first);
    const two = start(controller, second);
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

    const result = await start(controller, sender);

    expect(result.ok).toBe(false);
    expect(manager.spawns).toEqual([]);
    expect(terminalOwner("signin-1")).toBeNull();
    expect(sender.navigationListeners()).toBe(0);
    expect(sender.destroyedListeners()).toBe(0);
  });
});
