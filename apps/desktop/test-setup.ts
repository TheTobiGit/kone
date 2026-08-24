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
import { mock } from "bun:test";

mock.module("@kone/agent-core/sqlite.js", () => ({
  DatabaseSync: Database,
}));
