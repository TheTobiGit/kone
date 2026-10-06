// Keeps test runs from littering the shared temp dir.
//
// Every suite builds its scratch space with mkdtemp under os.tmpdir(), so
// pointing the temp vars at a directory of this run's own contains all of it
// — and removing that one directory once every test file has run cleans up
// without touching a single test file. The same block lives in
// packages/agent-core/test-setup.ts and apps/desktop/test-setup.ts, one per
// `bun test` process.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "bun:test";

const systemTmpDir = tmpdir();

const HEARTBEAT = "heartbeat";
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 600_000;
const LEGACY_STALE_MS = 3_600_000;

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The nearest ancestor of `dir` that is a run dir, or null. A tmpdir inside
 *  one means this run is nested inside another. */
function enclosingRunDir(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    if (path.basename(current).startsWith("kone-test-run-")) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function touchHeartbeat(dir: string): void {
  try {
    writeFileSync(path.join(dir, HEARTBEAT), "");
  } catch {
    // Best effort: a missing heartbeat just reads as stale later.
  }
}

/** Age of the run's heartbeat, or null when it has none (legacy dir). */
function heartbeatAgeMs(dir: string): number | null {
  try {
    return Date.now() - statSync(path.join(dir, HEARTBEAT)).mtimeMs;
  } catch {
    return null;
  }
}

function dirOlderThanMs(dir: string, ms: number): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs > ms;
  } catch {
    return false;
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Rewrite the heartbeat now and every 30 s on an unref'd timer, so proof
 *  of life never holds the process open. */
function keepHeartbeatFresh(dir: string): void {
  touchHeartbeat(dir);
  heartbeatTimer = setInterval(() => touchHeartbeat(dir), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

const outerRunDir = enclosingRunDir(systemTmpDir);
if (outerRunDir) {
  // Nested: an outer run owns this tmpdir, so create nothing, sweep nothing,
  // and remove nothing afterwards — just keep the outer heartbeat fresh
  // while this run is alive.
  keepHeartbeatFresh(outerRunDir);
  afterAll(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
} else {
  // A `--bail` stop or a `process.exit()` skips the afterAll below — no hook
  // fires reliably for those — so each run sweeps what earlier runs left. A
  // directory goes only on a stale heartbeat: a live run rewrites its own
  // every 30 s, so ten quiet minutes means it is gone, in any PID namespace
  // (PIDs can't be trusted across the sandboxes some agents run in). A dir
  // with no heartbeat falls back to an hour on the dir itself.
  for (const entry of safeReadDir(systemTmpDir)) {
    if (!entry.startsWith("kone-test-run-")) continue;
    const full = path.join(systemTmpDir, entry);
    const age = heartbeatAgeMs(full);
    const stale = age === null ? dirOlderThanMs(full, LEGACY_STALE_MS) : age > HEARTBEAT_STALE_MS;
    if (!stale) continue;
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      // Best effort: a wedged scratch file must not fail the run.
    }
  }

  const testRunDir = mkdtempSync(path.join(systemTmpDir, "kone-test-run-"));
  process.env.TMPDIR = testRunDir;
  process.env.TMP = testRunDir;
  process.env.TEMP = testRunDir; // Windows reads TEMP/TMP, not TMPDIR.
  // `afterAll` at preload scope runs once, after every test file: `process.on
  // "exit"` never fires under `bun test` (the runner exits natively), and this
  // is the hook that does.
  keepHeartbeatFresh(testRunDir);
  afterAll(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      rmSync(testRunDir, { recursive: true, force: true });
    } catch {
      // Best effort: a wedged scratch file must not fail the run.
    }
  });
}
