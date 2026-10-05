// Stands the agent core's SQLite driver up for the test runner.
//
// See src/sqlite.ts for why the driver is imported through a seam at all.
// Replacing it here rather than in each test file is what makes it work: bunfig
// preloads this before it transpiles a single test module, so the seam is
// already stubbed by the time anything imports a store. Doing it from inside a
// test file is too late for the files that die at load, and it silently stops
// applying if that file ever imports certain other test helpers.
//
// `bun:sqlite`'s Database is API-compatible with DatabaseSync over the surface
// the stores use — exec / prepare, and get / all / run on the statement.
// `StatementSync` is only ever imported as a type, so it erases and needs no
// stand-in here.
import { Database } from "bun:sqlite";
import { afterAll, mock } from "bun:test";
mock.module("./src/sqlite.ts", () => ({
  DatabaseSync: Database,
}));

// bun:sqlite spells the read-only option `readonly`.
mock.module("./src/sqliteReadOnly.ts", () => ({
  openDatabaseReadOnly: (filePath: string) => new Database(filePath, { readonly: true }),
}));

// Keeps test runs from littering the shared temp dir.
//
// Every suite builds its scratch space with mkdtemp under os.tmpdir(), so
// pointing TMPDIR at a directory of this run's own contains all of it — the
// stores' databases included, and anything a spawned child process puts there,
// since it inherits the environment — and removing that one directory when
// the runner exits cleans up without touching a single test file. The same
// block lives in apps/desktop/test-setup.ts and
// packages/git-core/test-setup.ts, one per `bun test` process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const testRunDir = mkdtempSync(path.join(tmpdir(), "kone-test-run-"));
process.env.TMPDIR = testRunDir;
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
