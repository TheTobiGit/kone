// Keeps test runs from littering the shared temp dir.
//
// Every suite builds its scratch space with mkdtemp under os.tmpdir(), so
// pointing TMPDIR at a directory of this run's own contains all of it — and
// removing that one directory when the runner exits cleans up without
// touching a single test file. The same block lives in
// packages/agent-core/test-setup.ts and apps/desktop/test-setup.ts, one per
// `bun test` process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "bun:test";

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
