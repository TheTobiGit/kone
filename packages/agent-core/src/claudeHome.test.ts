import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveClaudeExecutable, resolveClaudeInstallation } from "./claudeHome.js";

// resolveClaudeExecutable decides which `claude` the SDK is handed. Getting it
// wrong is what freezes kone's model list to whatever the bundled CLI knows: a
// user's `claude update` only surfaces new models when their own CLI is the one
// running. These tests build real layouts in a temp dir and pass them as
// env/home/resources, so nothing here depends on what the machine has.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kone-claude-home-")));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Create a runnable file at `target`, making its parents. */
function executableAt(target: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
  return target;
}

/** The app.asar.unpacked path the SDK's bundled `claude` would sit at. */
function bundledPath(resources: string, platform: NodeJS.Platform, arch: string): string {
  return path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    platform === "win32" ? "claude.exe" : "claude",
  );
}

/** A PATH holding exactly these dirs (posix separator). */
function envWith(...dirs: string[]): NodeJS.ProcessEnv {
  return { PATH: dirs.join(":") };
}

/** A fresh, empty home directory, so the ~/.local/bin fallback finds nothing. */
function emptyHome(): string {
  return fs.mkdtempSync(path.join(root, "home-"));
}

describe("resolveClaudeExecutable", () => {
  test("a user's claude on PATH wins over the bundled binary", () => {
    const bin = path.join(root, "user-bin");
    const onPath = executableAt(path.join(bin, "claude"));
    executableAt(bundledPath(path.join(root, "resources"), "darwin", "arm64"));

    const resolved = resolveClaudeExecutable({
      env: envWith(bin),
      homeDir: emptyHome(),
      platform: "darwin",
      arch: "arm64",
      resourcesPath: path.join(root, "resources"),
    });

    expect(resolved).toBe(fs.realpathSync(onPath));
  });

  test("a claude at ~/.local/bin is used when PATH doesn't carry it", () => {
    const home = emptyHome();
    const native = executableAt(path.join(home, ".local", "bin", "claude"));

    const resolved = resolveClaudeExecutable({
      env: envWith(path.join(root, "no-such-bin")),
      homeDir: home,
      platform: "darwin",
      resourcesPath: undefined,
    });

    expect(resolved).toBe(native);
  });

  test("no user CLI falls back to the SDK's bundled binary", () => {
    const expected = bundledPath(path.join(root, "resources2"), "darwin", "arm64");
    executableAt(expected);

    const resolved = resolveClaudeExecutable({
      env: envWith(path.join(root, "no-such-bin-2")),
      homeDir: emptyHome(),
      platform: "darwin",
      arch: "arm64",
      resourcesPath: path.join(root, "resources2"),
    });

    expect(resolved).toBe(expected);
  });

  test("no user CLI and no bundled binary resolves to undefined", () => {
    const resolved = resolveClaudeExecutable({
      env: envWith(path.join(root, "no-such-bin-3")),
      homeDir: emptyHome(),
      platform: "darwin",
      arch: "arm64",
      resourcesPath: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  test("Windows follows an npm claude.cmd to the package's native claude.exe", () => {
    const bin = path.join(root, "win-native");
    const entry = path.join(
      bin,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    executableAt(path.join(bin, "claude.cmd"));
    executableAt(entry);

    const install = resolveClaudeInstallation({
      // A lone dir needs no separator even on the win32 PATH shape.
      env: { PATH: bin },
      homeDir: emptyHome(),
      platform: "win32",
      arch: "x64",
      resourcesPath: undefined,
    });

    // The SDK spawns the resolved path directly; a .cmd shim is not an
    // executable it can run, so it is followed to the package entry beside it.
    expect(install.executable).toBe(entry);
    expect(install.source).toBe("npm");
  });

  test("Windows respects PATH order across npm launchers and native binaries", () => {
    const first = path.join(root, "win-path-first");
    const second = path.join(root, "win-path-second");
    const entry = executableAt(path.join(first, "node_modules", "@anthropic-ai", "claude-code", "cli.js"));
    executableAt(path.join(first, "claude.cmd"));
    executableAt(path.join(second, "claude.exe"));

    const install = resolveClaudeInstallation({
      env: { PATH: `${first};${second}` },
      homeDir: emptyHome(),
      platform: "win32",
    });

    expect(install.executable).toBe(entry);
    expect(install.source).toBe("npm");
    expect(install.located?.found).toBe(path.join(first, "claude.cmd"));
  });

  test("Windows follows an npm claude.cmd to cli.js when no native binary ships", () => {
    const bin = path.join(root, "win-old");
    const entry = path.join(
      bin,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    executableAt(path.join(bin, "claude.cmd"));
    executableAt(entry);

    const resolved = resolveClaudeExecutable({
      env: { PATH: bin },
      homeDir: emptyHome(),
      platform: "win32",
      arch: "x64",
      resourcesPath: undefined,
    });

    expect(resolved).toBe(entry);
  });

  test("Windows claude.cmd with no package entry beside it resolves to nothing", () => {
    const bin = path.join(root, "win-broken");
    executableAt(path.join(bin, "claude.cmd"));

    const install = resolveClaudeInstallation({
      env: { PATH: bin },
      homeDir: emptyHome(),
      platform: "win32",
      arch: "x64",
      resourcesPath: undefined,
    });

    // A launcher shim the SDK cannot spawn is not a launch path, and not a
    // channel maintenance could update without guessing.
    expect(install.executable).toBeUndefined();
    expect(install.source).toBe("unknown");
  });
});
