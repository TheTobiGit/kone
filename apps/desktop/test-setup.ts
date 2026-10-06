// Stands the desktop layer's SQLite driver up for the test runner.
//
// The agent core's stores (the only sqlite users) moved to
// packages/agent-core, which carries its own bunfig preload for its own tests.
// This file stays because `bun test` in apps/desktop still runs the desktop's
// remaining suites, and the agent-core sources they import (via
// @kone/agent-core/…) route their node:sqlite through the same seam — which is
// stubbed here before any test module transpiles, exactly as before the move.
// See packages/agent-core/src/sqlite.ts for why the seam exists at all.
//
// `bun:sqlite`'s Database is API-compatible with DatabaseSync over the surface
// the stores use — exec / prepare, and get / all / run on the statement.
import { Database } from "bun:sqlite";
import { afterAll, mock } from "bun:test";

mock.module("@kone/agent-core/sqlite.js", () => ({
  DatabaseSync: Database,
}));

// Keeps test runs from littering the shared temp dir.
//
// Every suite builds its scratch space with mkdtemp under os.tmpdir(), so
// pointing the temp vars at a directory of this run's own contains all of it
// — and removing that one directory once every test file has run cleans up
// without touching a single test file. The same block lives in
// packages/agent-core/test-setup.ts and packages/git-core/test-setup.ts,
// one per `bun test` process.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const systemTmpDir = tmpdir();

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** True when no live process has `pid`. Only ESRCH counts as gone — anything
 *  else (EPERM, a garbage pid) counts as alive. Under-cleaning is safe;
 *  over-deleting is not. */
function pidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // SAFETY: process.kill rejects with an ErrnoException, so reading code is sound.
    return (err as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/** A `--bail` stop or a `process.exit()` skips the afterAll below — no hook
 *  fires reliably for those — so each run sweeps what earlier runs left. A
 *  directory goes only when its run is certainly over: the pid stamped in its
 *  name resolves to nothing (PID liveness, not age, so a concurrent run from
 *  another agent is never touched no matter how long it takes; a recycled pid
 *  only ever spares a leftover). A name with no pid falls back to an hour's
 *  age, so ancient junk still drains. */
for (const entry of safeReadDir(systemTmpDir)) {
  if (!entry.startsWith("kone-test-run-")) continue;
  const pid = /kone-test-run-(\d+)-/.exec(entry)?.[1];
  const full = path.join(systemTmpDir, entry);
  const stale =
    pid === undefined
      ? (() => {
          try {
            return Date.now() - statSync(full).mtimeMs > 3_600_000;
          } catch {
            return false;
          }
        })()
      : pidDead(Number(pid));
  if (!stale) continue;
  try {
    rmSync(full, { recursive: true, force: true });
  } catch {
    // Best effort: a wedged scratch file must not fail the run.
  }
}

const testRunDir = mkdtempSync(path.join(systemTmpDir, `kone-test-run-${process.pid}-`));
process.env.TMPDIR = testRunDir;
process.env.TMP = testRunDir;
process.env.TEMP = testRunDir; // Windows reads TEMP/TMP, not TMPDIR.
// `afterAll` at preload scope runs once, after every test file: `process.on
// "exit"` never fires under `bun test` (the runner exits natively), and this
// is the hook that does.
afterAll(() => {
  try {
    rmSync(testRunDir, { recursive: true, force: true });
  } catch {
    // Best effort: a wedged scratch file must not fail the run.
  }
});
