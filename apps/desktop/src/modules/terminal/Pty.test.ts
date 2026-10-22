import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProviderSignInLaunch } from "@kone/agent-core/providerSignIn.js";

import {
  buildPtyEnv,
  createPtySubscriptions,
  resolvePtyEnv,
  spawnPty,
  type NodePtyEventSource,
  type PtySpawnInput,
} from "./Pty.js";

type ExitEvent = { exitCode: number; signal?: number };

/** A fake node-pty event source: every registered listener is kept in an
 *  array, and each registration's disposer removes exactly that listener when
 *  called. Mirrors how node-pty's onData/onExit subscriptions behave so the
 *  per-registration unsubscribe contract is observable without a real PTY. */
function makeFakeEventSource() {
  const exitListeners: Array<(ev: ExitEvent) => void> = [];
  const dataListeners: Array<(data: string) => void> = [];
  const source: NodePtyEventSource = {
    onData(listener) {
      dataListeners.push(listener);
      return {
        dispose() {
          const index = dataListeners.indexOf(listener);
          if (index !== -1) dataListeners.splice(index, 1);
        },
      };
    },
    onExit(listener) {
      exitListeners.push(listener);
      return {
        dispose() {
          const index = exitListeners.indexOf(listener);
          if (index !== -1) exitListeners.splice(index, 1);
        },
      };
    },
  };
  return { source, exitListeners, dataListeners };
}

// buildPtyEnv is the pure env-building half of spawnPty — no real shells are
// spawned here, just the scrub/merge/pin pipeline the PTY child inherits.

describe("buildPtyEnv", () => {
  test("blocklist keys are removed even when present in the base env", () => {
    const env = buildPtyEnv({
      TERM: "xterm-ghostty",
      COLORTERM: "ghostty",
      NO_COLOR: "1",
      ELECTRON_RUN_AS_NODE: "1",
      PORT: "3000",
      PATH: "/usr/bin",
    });
    expect(env.TERM).not.toBe("xterm-ghostty");
    expect(env.COLORTERM).not.toBe("ghostty");
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });

  test("TERM and COLORTERM are pinned to the embedded terminal", () => {
    const env = buildPtyEnv({ PATH: "/usr/bin" });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  test("the pin wins over both the base env and the extra env", () => {
    const env = buildPtyEnv(
      { TERM: "xterm-ghostty", COLORTERM: "ghostty" },
      { TERM: "vt100", COLORTERM: "16color" },
    );
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  test("extra env wins over the base env", () => {
    const env = buildPtyEnv(
      { LANG: "en_US.UTF-8", EDITOR: "vim" },
      { EDITOR: "code --wait" },
    );
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.EDITOR).toBe("code --wait");
  });

  test("arbitrary user vars pass through untouched", () => {
    const env = buildPtyEnv({
      PATH: "/opt/homebrew/bin:/usr/bin",
      TOOLCHAIN_DIR: "/opt/toolchain",
      TOOLCHAIN_VERSION: "1.2.3",
    });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.TOOLCHAIN_DIR).toBe("/opt/toolchain");
    expect(env.TOOLCHAIN_VERSION).toBe("1.2.3");
  });

  test("undefined base values are dropped, not carried as undefined keys", () => {
    const env = buildPtyEnv({ HOME: "/Users/me", FOO: undefined });
    expect(env.HOME).toBe("/Users/me");
    expect("FOO" in env).toBe(false);
  });

  test("blocklisted keys are dropped from the caller env too", () => {
    const env = buildPtyEnv(
      { PATH: "/usr/bin" },
      { ELECTRON_RUN_AS_NODE: "1", PORT: "3000", ELECTRON_RENDERER_PORT: "9222" },
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.ELECTRON_RENDERER_PORT).toBeUndefined();
  });
});

describe("the sign-in launch → PTY environment", () => {
  test("a complete env keeps browser suppressors and runtime vars removed", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kone-pty-env-"));
    try {
      const exe = path.join(dir, "codex");
      writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      chmodSync(exe, 0o755);

      const base = {
        PATH: dir,
        HOME: dir,
        BROWSER: "www-browser",
        NO_BROWSER: "true",
        ELECTRON_RUN_AS_NODE: "1",
        PORT: "3000",
      };
      const launch = resolveProviderSignInLaunch({
        provider: "codex",
        settings: { codex: { binaryPath: exe } },
        env: base,
      });
      expect(launch.ok).toBe(true);
      if (!launch.ok) throw new Error(launch.message);
      expect(launch.env.BROWSER).toBeUndefined();
      expect(launch.env.NO_BROWSER).toBeUndefined();

      // The PTY's final env: complete, so the fresh inherited base is not
      // merged back in — and the blocklist still scrubs the caller env.
      const final = resolvePtyEnv({ env: launch.env, completeEnv: true }, base);
      expect(final.BROWSER).toBeUndefined();
      expect(final.NO_BROWSER).toBeUndefined();
      expect(final.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(final.PORT).toBeUndefined();
      expect(final.PATH).toBe(dir);
      expect(final.TERM).toBe("xterm-256color");

      // The pre-fix path (merge over a freshly inherited env) would restore
      // the browser sentinels; complete envs must not.
      expect(buildPtyEnv(base, launch.env).BROWSER).toBe("www-browser");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnPty command", () => {
  test("a pre-built Windows command line reaches node-pty as one string", async () => {
    const spawns: Array<{ file: string; args: string[] | string }> = [];
    // node-pty's native binding is not loadable under `bun test`, and spawnPty
    // imports it lazily — so a fake is enough to see exactly what it is handed.
    mock.module("node-pty", () => ({
      spawn: (file: string, args: string[] | string) => {
        spawns.push({ file, args });
        return {
          pid: 1,
          cols: 80,
          rows: 24,
          write: () => {},
          resize: () => {},
          kill: () => {},
          pause: () => {},
          resume: () => {},
          onData: () => ({ dispose: () => {} }),
          onExit: () => ({ dispose: () => {} }),
        };
      },
    }));
    const commandLine = '/d /s /c "C:\\Program^ Files\\nodejs\\codex.cmd ^^^"login^^^""';
    const input: PtySpawnInput = {
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: "/usr/bin" },
      completeEnv: true,
      command: { file: "cmd.exe", args: commandLine },
    };
    try {
      await spawnPty(input);
    } finally {
      mock.restore();
    }
    // A string must stay a string: node-pty appends it to the command line
    // verbatim, while an array would be re-quoted for CommandLineToArgvW and
    // lose the ^-escapes cmd.exe needs.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.file).toBe("cmd.exe");
    expect(spawns[0]?.args).toBe(commandLine);
  });
});

describe("createPtySubscriptions", () => {
  test("unsubscribing an earlier onExit handler leaves later handlers subscribed", () => {
    const { source, exitListeners } = makeFakeEventSource();
    const subs = createPtySubscriptions(source);

    const ran: string[] = [];
    const unsubA = subs.onExit(() => ran.push("A"));
    subs.onExit(() => ran.push("B"));

    unsubA();
    for (const fire of exitListeners) fire({ exitCode: 0 });

    expect(ran).toEqual(["B"]);
  });

  test("unsubscribing an earlier onData handler leaves later handlers subscribed", () => {
    const { source, dataListeners } = makeFakeEventSource();
    const subs = createPtySubscriptions(source);

    const ran: string[] = [];
    const unsubA = subs.onData(() => ran.push("A"));
    subs.onData(() => ran.push("B"));

    unsubA();
    for (const fire of dataListeners) fire("data");

    expect(ran).toEqual(["B"]);
  });
});
