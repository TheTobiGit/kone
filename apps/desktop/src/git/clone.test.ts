import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { GitError } from "./core.js";
import type { CloneProgress, CloneResult } from "./types.js";
import * as cloneModule from "./clone.js";

// The frozen clone API the renderer drives. clone.ts may not implement every
// symbol yet; `requireExport` turns a missing export into an explicit
// "not implemented" failure instead of a cryptic TypeError, so a partially
// implemented clone.ts still reports exactly which piece is missing.

type CloneHooks = {
  spawn?: typeof import("node:child_process").spawn;
  timeoutMs?: number;
  killEscalationMs?: number;
};

type CloneApi = {
  clone: (
    url: string,
    dest: string,
    onProgress: (p: CloneProgress) => void,
    opts?: { signal?: AbortSignal },
  ) => Promise<CloneResult>;
  cancelAllClones: () => void;
  cancelClone: () => void;
  configureCloneForTests: (hooks: CloneHooks) => void;
  resetCloneForTests: () => void;
};

// The clone module's frozen API may not be implemented yet; these views assert
// its exports exist and are callable before the suite trusts them.
// SAFETY: the clone module is the real implementation under its frozen API.
// eslint-disable-next-line anti-slop/no-chained-type-assertions
const api = cloneModule as unknown as CloneApi;
// SAFETY: same module, read loosely for the optional test-reset hook.
// eslint-disable-next-line anti-slop/no-chained-type-assertions
const raw = cloneModule as unknown as Record<string, unknown>;

function requireExport(name: string): void {
  if (typeof raw[name] !== "function") {
    throw new Error(
      `clone.ts does not export ${name} — the frozen clone API is not implemented yet`,
    );
  }
}

// A fake `git` that claims the destination (mkdir -p of its last argv — the
// clone target), prints a receiving-objects line to stderr, then fails. This
// simulates a clone that dies halfway through leaving a partial checkout.
const FAILING_GIT = `#!/usr/bin/env node
const { mkdirSync } = require("node:fs");
mkdirSync(process.argv[process.argv.length - 1], { recursive: true });
process.stderr.write("Receiving objects: 50%\\n");
process.exit(1);
`;

// A fake `git` that claims the destination and then hangs until killed — used
// to hold clones in flight so cancel/timeout paths have something to interrupt.
const HANGING_GIT = `#!/usr/bin/env node
const { mkdirSync } = require("node:fs");
mkdirSync(process.argv[process.argv.length - 1], { recursive: true });
setInterval(() => {}, 1000);
`;

// A fake `git` that succeeds but still narrates progress on stderr.
const SUCCEEDING_GIT = `#!/usr/bin/env node
const { mkdirSync } = require("node:fs");
mkdirSync(process.argv[process.argv.length - 1], { recursive: true });
process.stderr.write("Receiving objects: 50%\\n");
process.exit(0);
`;

const savedPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (typeof raw.resetCloneForTests === "function") {
    // SAFETY: the typeof check on the line above gated the cast.
    (raw.resetCloneForTests as () => void)();
  }
  if (savedPath !== undefined) process.env.PATH = savedPath;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** A fresh throwaway parent folder for clone destinations. */
function newTempParent(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-clone-"));
  tempDirs.push(dir);
  return dir;
}

/** Put a fake `git` script first on PATH; it must take the last argv as its
 *  clone destination (mirroring `git clone --progress <url> <dest>`). */
function installFakeGit(script: string): void {
  const bin = mkdtempSync(path.join(os.tmpdir(), "kone-clone-bin-"));
  tempDirs.push(bin);
  const gitPath = path.join(bin, "git");
  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

/** Build a tiny real repo to clone from. Uses spawnSync so the kone repo's own
 *  working tree is never touched. */
function makeSourceRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kone-clone-src-"));
  tempDirs.push(dir);
  const git = (args: string[]): void => {
    const run = spawnSync("git", args, {
      cwd: dir,
      env: { ...process.env, LC_ALL: "C" },
    });
    if (run.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${run.stderr?.toString()}`);
    }
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@kone.app"]);
  git(["config", "user.name", "Kone Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "one"]);
  return dir;
}

/** Clone leftovers (staging dirs) a correct implementation must never leave. */
function stagingLeftovers(parent: string): string[] {
  return readdirSync(parent).filter((entry) => entry.startsWith(".kone-clone-"));
}

describe("clone", () => {
  test("failed clone does not occupy dest — retry can start", async () => {
    installFakeGit(FAILING_GIT);
    const parent = newTempParent();
    const dest = path.join(parent, "proj");
    const url = "https://github.com/owner/repo.git";

    // SAFETY: toBeInstanceOf(GitError) pins this rejection's type below.
    const first = (await api
      .clone(url, dest, () => {})
      .catch((e: unknown) => e)) as GitError;
    expect(first).toBeInstanceOf(GitError);

    // The partial checkout must be swept so the destination is reusable.
    expect(existsSync(dest)).toBe(false);
    expect(stagingLeftovers(parent)).toEqual([]);

    // Retrying into the same dest must reach the fake git again and fail on
    // its own failure — never on "a folder already exists".
    // SAFETY: toBeInstanceOf(GitError) pins this rejection's type below.
    const retry = (await api
      .clone(url, dest, () => {})
      .catch((e: unknown) => e)) as GitError;
    expect(retry).toBeInstanceOf(GitError);
    expect(retry.message).not.toMatch(/already exists/);
    expect(existsSync(dest)).toBe(false);
  });

  test("successful local clone lands on dest, staging is gone", async () => {
    const src = makeSourceRepo();
    const parent = newTempParent();
    const dest = path.join(parent, "proj");

    const result = await api.clone(src, dest, () => {});
    expect(result.root).toBe(dest);
    expect(result.name).toBe("proj");
    expect(existsSync(path.join(dest, "a.txt"))).toBe(true);
    expect(existsSync(path.join(dest, ".git"))).toBe(true);
    expect(stagingLeftovers(parent)).toEqual([]);
  });

  test("abort via signal does not abort a sibling clone", async () => {
    const src = makeSourceRepo();
    const parent = newTempParent();
    const dest1 = path.join(parent, "one");
    const dest2 = path.join(parent, "two");
    const first = new AbortController();
    const second = new AbortController();

    const p1 = api.clone(src, dest1, () => {}, { signal: first.signal });
    const p2 = api.clone(src, dest2, () => {}, { signal: second.signal });
    first.abort();

    // SAFETY: toBeInstanceOf(GitError) pins this rejection's type below.
    const err1 = (await p1.catch((e: unknown) => e)) as GitError;
    expect(err1).toBeInstanceOf(GitError);
    expect(err1.message).toBe("Clone cancelled");
    expect(existsSync(dest1)).toBe(false);

    // The sibling, on its own controller, must be untouched.
    const result2 = await p2;
    expect(result2.root).toBe(dest2);
    expect(existsSync(path.join(dest2, ".git"))).toBe(true);
    expect(stagingLeftovers(parent)).toEqual([]);
  });

  test("cancelAllClones aborts every live clone", async () => {
    requireExport("cancelAllClones");
    installFakeGit(HANGING_GIT);
    const parent = newTempParent();
    const dest1 = path.join(parent, "one");
    const dest2 = path.join(parent, "two");

    const p1 = api.clone("https://github.com/owner/a.git", dest1, () => {});
    const p2 = api.clone("https://github.com/owner/b.git", dest2, () => {});
    api.cancelAllClones();

    // SAFETY: toBeInstanceOf(GitError) pins this rejection's type below.
    const err1 = (await p1.catch((e: unknown) => e)) as GitError;
    expect(err1).toBeInstanceOf(GitError);
    expect(err1.message).toBe("Clone cancelled");
    // SAFETY: toBeInstanceOf(GitError) pins this rejection's type above — same sweep.
    const err2 = (await p2.catch((e: unknown) => e)) as GitError;
    expect(err2).toBeInstanceOf(GitError);
    expect(err2.message).toBe("Clone cancelled");
    expect(existsSync(dest1)).toBe(false);
    expect(existsSync(dest2)).toBe(false);
    expect(stagingLeftovers(parent)).toEqual([]);
  });

  test("timeout sweeps staging and dest never appears", async () => {
    requireExport("configureCloneForTests");
    requireExport("resetCloneForTests");
    api.configureCloneForTests({ timeoutMs: 80 });
    installFakeGit(HANGING_GIT);
    const parent = newTempParent();
    const dest = path.join(parent, "proj");

    // SAFETY: toBeInstanceOf(GitError) pins this rejection's type below.
    const err = (await api
      .clone("https://github.com/owner/a.git", dest, () => {})
      .catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.kind).toBe("TIMEOUT");
    expect(err.message).toMatch(/\[kone:TIMEOUT\]/);
    expect(existsSync(dest)).toBe(false);
    expect(stagingLeftovers(parent)).toEqual([]);
  });

  test("progress still parses", async () => {
    installFakeGit(SUCCEEDING_GIT);
    const parent = newTempParent();
    const dest = path.join(parent, "proj");
    const ticks: CloneProgress[] = [];

    const result = await api.clone("https://github.com/owner/repo.git", dest, (tick) =>
      ticks.push(tick),
    );
    expect(result.root).toBe(dest);

    // Receiving objects is the long middle stretch — its parsed tick must land
    // inside that band (0.25..0.9) on the single 0..1 ramp.
    const receiving = ticks.find(
      (tick) => tick.stage.includes("Receiving") && tick.progress > 0.25 && tick.progress < 0.9,
    );
    expect(receiving).toBeDefined();
  });
});
