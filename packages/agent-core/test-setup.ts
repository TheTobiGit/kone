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
import { mock } from "bun:test";

mock.module("./src/sqlite.ts", () => ({
  DatabaseSync: Database,
}));
