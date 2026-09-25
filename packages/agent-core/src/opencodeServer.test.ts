import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isRetryableOpenCodeServerFailure,
  OpenCodeServerPool,
  OPENCODE_SERVER_RETRY_DELAYS_MS,
  parseOpenCodeServerListening,
  parseOpenCodeServerPassword,
  type OpenCodeServer,
} from "./opencodeServer.js";

describe("isRetryableOpenCodeServerFailure", () => {
  test("matches the sqlite-busy / locked-database class", () => {
    expect(isRetryableOpenCodeServerFailure("database is locked")).toBe(true);
    expect(isRetryableOpenCodeServerFailure("database is busy")).toBe(true);
    expect(isRetryableOpenCodeServerFailure("SQLITE_BUSY: database is locked")).toBe(true);
    expect(
      isRetryableOpenCodeServerFailure('failed query: update "credential" set ...'),
    ).toBe(true);
    expect(
      isRetryableOpenCodeServerFailure("failed query: update `credential` set ..."),
    ).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isRetryableOpenCodeServerFailure("Database Is Locked")).toBe(true);
    expect(isRetryableOpenCodeServerFailure("FAILED QUERY: UPDATE \"credential\" SET")).toBe(true);
  });

  test("rejects unrelated failures", () => {
    expect(isRetryableOpenCodeServerFailure("EADDRINUSE: address already in use")).toBe(false);
    expect(isRetryableOpenCodeServerFailure("opencode: command not found")).toBe(false);
    expect(isRetryableOpenCodeServerFailure("timed out waiting for the server")).toBe(false);
    expect(isRetryableOpenCodeServerFailure("")).toBe(false);
  });
});

describe("OPENCODE_SERVER_RETRY_DELAYS_MS", () => {
  test("is the bounded 500ms/1500ms ladder", () => {
    expect(OPENCODE_SERVER_RETRY_DELAYS_MS).toEqual([500, 1_500]);
  });
});

describe("openCode v2 serve output", () => {
  test("reads the dialect off the listening line", () => {
    expect(parseOpenCodeServerListening("opencode server listening on http://127.0.0.1:1234")).toEqual({
      url: "http://127.0.0.1:1234",
      dialect: "v1",
    });
    expect(parseOpenCodeServerListening("server listening on http://127.0.0.1:35221")).toEqual({
      url: "http://127.0.0.1:35221",
      dialect: "v2",
    });
    expect(parseOpenCodeServerListening("server password abc")).toBeUndefined();
  });

  test("parses the v2 server password", () => {
    expect(parseOpenCodeServerPassword("server password hLFEhS96sGHe0qJQlMcicPSlP7Hvvfn1egDqfpIYO_o")).toBe(
      "hLFEhS96sGHe0qJQlMcicPSlP7Hvvfn1egDqfpIYO_o",
    );
    expect(parseOpenCodeServerPassword("server listening on http://127.0.0.1:1")).toBeUndefined();
  });
});

describe("openCode warm-spare pool", () => {
  // A fake `serve` binary: binds a real ephemeral port, prints the same
  // listening line the parser reads, then idles. `KONE_FAKE_OPENCODE_COUNT`
  // records every spawn; `KONE_FAKE_OPENCODE_DIE_WHEN` names a file whose
  // appearance makes the fake exit, so spare eviction can be exercised
  // deterministically.
  const fakeSource = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const countFile = process.env.KONE_FAKE_OPENCODE_COUNT;
if (countFile) fs.appendFileSync(countFile, "spawn\\n");
const dieWhen = process.env.KONE_FAKE_OPENCODE_DIE_WHEN;
if (dieWhen) setInterval(() => {
  try {
    fs.accessSync(dieWhen);
    process.exit(0);
  } catch { /* not yet */ }
}, 25);
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  if (process.env.KONE_FAKE_OPENCODE_V2) {
    console.log(\`server listening on http://127.0.0.1:\${port}\`);
    setTimeout(() => console.error("server password fake-secret"), 150);
  } else {
    console.log(\`opencode server listening on http://127.0.0.1:\${port}\`);
  }
});
setInterval(() => {}, 1000);
`;
  const scratch = mkdtempSync(path.join(tmpdir(), "kone-opencode-server-"));
  const fakeBinary = path.join(scratch, "fake-opencode");
  writeFileSync(fakeBinary, fakeSource, { mode: 0o755 });
  chmodSync(fakeBinary, 0o755);

  const owned: OpenCodeServer[] = [];
  // A pool per case rather than one reset between them: nothing a test does
  // to its own pool can reach the next test's.
  let pool = new OpenCodeServerPool();

  beforeEach(() => {
    pool = new OpenCodeServerPool();
  });

  afterEach(async () => {
    await Promise.all(owned.splice(0).map((server) => server.dispose()));
    await pool.dispose();
  });

  function startOpts(cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return {
      cwd,
      env: { ...process.env, ...extraEnv },
      binary: fakeBinary,
    };
  }

  function spawnCount(countFile: string): number {
    try {
      return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  async function waitForSpareCount(want: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (pool.spareCount !== want) {
      if (Date.now() > deadline) {
        throw new Error(`spare count never reached ${want} (at ${pool.spareCount})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("a v1 listening line is ready on its own, with no password", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwd-"));
    const server = await pool.start(startOpts(cwd));
    owned.push(server);
    expect(server.dialect).toBe("v1");
    expect(server.password).toBeUndefined();
  });

  test("a v2 listening line waits for the password line, whichever stream it lands on", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwd-"));
    const server = await pool.start(startOpts(cwd, { KONE_FAKE_OPENCODE_V2: "1" }));
    owned.push(server);
    expect(server.dialect).toBe("v2");
    expect(server.password).toBe("fake-secret");
  });

  test("a second start on the same directory checks out the parked spare", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwd-"));
    const countFile = path.join(scratch, `count-${Date.now()}-a`);
    writeFileSync(countFile, "");

    const first = await pool.start(startOpts(cwd, { KONE_FAKE_OPENCODE_COUNT: countFile }));
    owned.push(first);
    expect(first.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // The successful start replenishes in the background: one spare parked.
    await waitForSpareCount(1);
    expect(spawnCount(countFile)).toBe(2);

    const second = await pool.start(startOpts(cwd, { KONE_FAKE_OPENCODE_COUNT: countFile }));
    owned.push(second);
    // Checkout, not a boot: the pool drained synchronously...
    expect(pool.spareCount).toBe(0);
    expect(second.baseUrl).not.toBe(first.baseUrl);
    // ...and the only spawn that follows is the background replenish parking
    // again. An inline boot here would have booted twice (itself plus its own
    // prewarm), so a settled count of 3 proves the second start booted nothing.
    await waitForSpareCount(1);
    expect(spawnCount(countFile)).toBe(3);
  });

  test("spares never cross environments", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwd-env-"));
    const countFile = path.join(scratch, `count-${Date.now()}-env`);
    writeFileSync(countFile, "");

    const first = await pool.start(
      startOpts(cwd, { KONE_FAKE_OPENCODE_COUNT: countFile, KONE_FAKE_OPENCODE_PROFILE: "one" }),
    );
    owned.push(first);
    await waitForSpareCount(1);

    // Same binary, same directory, different environment: the parked spare
    // was booted under the first profile and cannot answer for the second, so
    // this start boots rather than silently dropping the env it was handed.
    const second = await pool.start(
      startOpts(cwd, { KONE_FAKE_OPENCODE_COUNT: countFile, KONE_FAKE_OPENCODE_PROFILE: "two" }),
    );
    owned.push(second);
    expect(second.baseUrl).not.toBe(first.baseUrl);
    // The first profile's spare is still parked, untouched by a start that
    // was not entitled to it.
    expect(pool.spareCount).toBeGreaterThanOrEqual(1);
  });

  test("spares never cross directories", async () => {
    const cwdA = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwdA-"));
    const cwdB = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwdB-"));
    const countFile = path.join(scratch, `count-${Date.now()}-b`);
    writeFileSync(countFile, "");

    const env = { KONE_FAKE_OPENCODE_COUNT: countFile };
    const a = await pool.start(startOpts(cwdA, env));
    owned.push(a);
    // A parked spare for A must not satisfy B: B boots its own server even
    // while A's spare (or its in-flight prewarm) exists.
    const b = await pool.start(startOpts(cwdB, env));
    owned.push(b);
    expect(spawnCount(countFile)).toBeGreaterThanOrEqual(2);
    expect(a.baseUrl).not.toBe(b.baseUrl);
  });

  test("a spare that dies on its own is evicted, never handed out", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwd-"));
    const countFile = path.join(scratch, `count-${Date.now()}-c`);
    writeFileSync(countFile, "");
    const dieWhen = path.join(scratch, `die-${Date.now()}-c`);

    const env = { KONE_FAKE_OPENCODE_COUNT: countFile, KONE_FAKE_OPENCODE_DIE_WHEN: dieWhen };
    const first = await pool.start(startOpts(cwd, env));
    owned.push(first);
    await waitForSpareCount(1);
    // Kill everything booted from this env (session server and spare alike);
    // the exit watcher evicts the dead spare.
    writeFileSync(dieWhen, "die");
    await waitForSpareCount(0);

    // Later boots must stay alive for the rest of the test.
    rmSync(dieWhen, { force: true });
    const before = spawnCount(countFile);
    const second = await pool.start(startOpts(cwd, env));
    owned.push(second);
    // A fresh boot happened — no dead spare was recycled.
    expect(spawnCount(countFile)).toBeGreaterThan(before);
  });

  test("dispose closes parked spares", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kone-opencode-cwd-"));
    const first = await pool.start(startOpts(cwd));
    owned.push(first);
    await waitForSpareCount(1);
    await pool.dispose();
    expect(pool.spareCount).toBe(0);
  });
});
