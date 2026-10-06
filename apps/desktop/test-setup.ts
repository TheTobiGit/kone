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
// without touching a single test file. A nested run's tmpdir already sits
// inside its parent's run dir, so it simply gets a subdir of its own and
// removes only that. The same block lives in
// packages/agent-core/test-setup.ts and packages/git-core/test-setup.ts,
// one per `bun test` process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const testRunDir = mkdtempSync(path.join(tmpdir(), "kone-test-run-"));
process.env.TMPDIR = testRunDir;
process.env.TMP = testRunDir;
process.env.TEMP = testRunDir; // Windows reads TEMP/TMP, not TMPDIR.
// `afterAll` at preload scope runs once, after every test file: `process.on
// "exit"` never fires under `bun test` (the runner exits natively), and this
// is the hook that does. A `--bail` stop or a `process.exit()` skips it and
// leaves that run's dir behind; that is accepted — chasing those leftovers
// with a sweep kept finding new ways to delete a live run, and /tmp clears
// on reboot anyway.
afterAll(() => {
  try {
    rmSync(testRunDir, { recursive: true, force: true });
  } catch {
    // Best effort: a wedged scratch file must not fail the run.
  }
});
