import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareVersions, npmPrefixFor, resolveProviderMaintenance } from "./providerMaintenance.js";

// The install-channel detection is the part of maintenance that has to be right:
// resolve the channel wrongly and kone offers an update command that writes to a
// different install tree than the one it just inspected — which is how a machine
// ends up with two copies of a CLI and a version readout that never moves.
//
// These tests build real directory layouts in a temp dir and put them on a fake
// PATH, so the detection runs against actual files and symlinks (the layouts are
// the ones seen on a real machine — see the shapes in providerMaintenance.ts).
// `checkLatest: false` throughout: nothing here touches the network.

// Realpath'd up front: on macOS the temp dir is itself a symlink (/var →
// /private/var), and detection reports real paths — so the fixtures have to be
// stated in the same terms the assertions read back.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kone-maint-")));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Create an executable file, making its parents. */
function file(...segments: string[]): string {
  const target = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
  return target;
}

/** Create `linkPath` as a symlink to `target`, making its parents. */
function link(target: string, ...segments: string[]): string {
  const linkPath = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
  return linkPath;
}

function envWith(...dirs: string[]): NodeJS.ProcessEnv {
  return { PATH: dirs.join(":") };
}

describe("compareVersions", () => {
  test("orders by major, minor, then patch", () => {
    expect(compareVersions("0.48.0", "0.52.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("treats a `v` prefix and a two-segment version as the same release", () => {
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
  });

  test("sorts a prerelease before the release it leads to", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
  });

  test("falls back to a stable string compare for non-semver builds", () => {
    // cursor-agent reports date-stamped builds; the point is not to throw.
    expect(Number.isFinite(compareVersions("2026.07.01-a", "2026.07.23-b"))).toBe(true);
  });
});

describe("npmPrefixFor", () => {
  test("derives the global tree that owns a unix install", () => {
    expect(npmPrefixFor("/usr/local/lib/node_modules/@openai/codex/bin/codex.js")).toBe(
      "/usr/local",
    );
  });

  test("keeps npm's own directory on Windows layouts", () => {
    expect(npmPrefixFor("C:/Users/x/AppData/Roaming/npm/node_modules/@openai/codex/bin/x.js")).toBe(
      "C:/Users/x/AppData/Roaming/npm",
    );
  });

  test("is null when the path owns no global tree", () => {
    expect(npmPrefixFor("/Users/x/.local/bin/droid")).toBeNull();
  });
});

describe("resolveProviderMaintenance", () => {
  test("an npm-global codex updates through npm, pinned to its own prefix", async () => {
    const real = file("npm-tree/lib/node_modules/@openai/codex/bin/codex.js");
    link(real, "npm-tree/bin/codex");

    const m = await resolveProviderMaintenance({
      provider: "codex",
      currentVersion: "0.48.0",
      env: envWith(path.join(root, "npm-tree/bin")),
      checkLatest: false,
    });

    expect(m.installSource).toBe("npm");
    expect(m.updateCommand).toBe(
      `npm install -g --prefix ${path.join(root, "npm-tree")} @openai/codex@latest`,
    );
    expect(m.canUpdate).toBe(true);
    // No lookup was asked for, so standing must stay unknown rather than
    // silently reading as "current".
    expect(m.latestVersion).toBeNull();
    expect(m.standing).toBe("unknown");
  });

  test("a bun-global opencode upgrades through its own updater, told which channel", async () => {
    const real = file("bunhome/.bun/install/global/node_modules/opencode-ai/bin/opencode");
    link(real, "bunhome/.bun/bin/opencode");

    const m = await resolveProviderMaintenance({
      provider: "opencode",
      env: envWith(path.join(root, "bunhome/.bun/bin")),
      checkLatest: false,
    });

    // Detected off the PATH shim, whose target dir names no channel at all.
    expect(m.installSource).toBe("bun");
    expect(m.updateCommand).toBe("opencode upgrade --method bun");
  });

  test("a Homebrew opencode goes through brew, not its own updater", async () => {
    const real = file("homebrew/Cellar/opencode/1.0.0/bin/opencode");
    link(real, "homebrew/bin/opencode");

    const m = await resolveProviderMaintenance({
      provider: "opencode",
      env: envWith(path.join(root, "homebrew/bin")),
      checkLatest: false,
    });

    expect(m.installSource).toBe("homebrew");
    expect(m.updateCommand).toBe("brew upgrade anomalyco/tap/opencode");
  });

  test("a self-updating cursor-agent can update but is never 'behind'", async () => {
    const real = file("cursorhome/.local/share/cursor-agent/versions/2026.07.23-abc/cursor-agent");
    link(real, "cursorhome/.local/bin/cursor-agent");

    const m = await resolveProviderMaintenance({
      provider: "cursor",
      currentVersion: "2026.07.23-abc",
      env: envWith(path.join(root, "cursorhome/.local/bin")),
      checkLatest: true, // allowed — there's simply nowhere to ask
    });

    expect(m.installSource).toBe("native");
    expect(m.updateCommand).toBe("cursor-agent update");
    // The whole point: no registry, so no claim about being out of date.
    expect(m.latestKnowable).toBe(false);
    expect(m.standing).toBe("unknown");
  });

  test("an unrecognised layout still gets the CLI's own updater when it has one", async () => {
    file("plainbin/droid");

    const m = await resolveProviderMaintenance({
      provider: "droid",
      env: envWith(path.join(root, "plainbin")),
      checkLatest: false,
    });

    expect(m.installSource).toBe("unknown");
    expect(m.updateCommand).toBe("droid update");
  });

  test("an unrecognised layout with no self-updater offers no command", async () => {
    file("plainbin2/codex");

    const m = await resolveProviderMaintenance({
      provider: "codex",
      env: envWith(path.join(root, "plainbin2")),
      checkLatest: false,
    });

    expect(m.installSource).toBe("unknown");
    expect(m.canUpdate).toBe(false);
    expect(m.updateCommand).toBeNull();
  });

  test("an explicit binary path is honoured over PATH", async () => {
    const real = file("override/lib/node_modules/@openai/codex/bin/codex.js");
    const shim = link(real, "override/bin/codex");

    const m = await resolveProviderMaintenance({
      provider: "codex",
      binaryOverride: shim,
      env: envWith("/nonexistent"),
      checkLatest: false,
    });

    expect(m.binary).toBe(shim);
    expect(m.resolvedPath).toBe(shim);
    expect(m.installSource).toBe("npm");
  });

  test("a missing binary resolves to nothing rather than guessing", async () => {
    const m = await resolveProviderMaintenance({
      provider: "droid",
      env: envWith("/nonexistent"),
      checkLatest: false,
    });

    expect(m.resolvedPath).toBeNull();
    expect(m.currentVersion).toBeNull();
    // `droid update` still stands as the command for a bare-name install; it's
    // the *page* that declines to offer it while nothing is installed.
    expect(m.installSource).toBe("unknown");
  });

  test("Claude is bundled: no install to inspect, nothing to update", async () => {
    const m = await resolveProviderMaintenance({
      provider: "claudeAgent",
      currentVersion: "2.1.0",
      env: envWith("/nonexistent"),
      checkLatest: true,
    });

    expect(m.installSource).toBe("bundled");
    expect(m.binary).toBeNull();
    expect(m.canUpdate).toBe(false);
    expect(m.latestKnowable).toBe(false);
  });
});
