// Test-only. Every git suite starts the same way: a throwaway repo on `main`
// with an identity configured, because git refuses to commit without one. What
// a suite seeds on top of that is its own business, so this stops at the point
// where the suites start to differ.

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "./core.js";

/**
 * A fresh repo in a temp directory, on `main` and able to commit. `prefix` names
 * the directory, so a leaked one can be traced back to the suite that made it.
 */
export async function initTestRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@kone.app"]);
  await git(dir, ["config", "user.name", "Kone Test"]);
  return dir;
}
