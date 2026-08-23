import { describe, expect, test } from "bun:test";

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The gateway-injection suites stub spawn.ts by its resolved absolute path with
// mock.module (their `probe` returns "ok" so no real CLI is spawned), and bun
// keeps one mock registry per worker process — so their stub can reach this file
// when both land in the same worker (a standalone run never hits it). Importing
// "./spawn.js" here would resolve to that stub. Instead, load the REAL module
// from a temp copy of the source — a unique resolved path no mock can intercept.
// spawn.ts has no relative imports, so a plain copy needs no rewrite.
const SPAWN_SOURCE = fileURLToPath(new URL("./spawn.ts", import.meta.url));

async function loadRealSpawnModule(): Promise<typeof import("./spawn.js")> {
  const source = readFileSync(SPAWN_SOURCE, "utf8");
  const dir = mkdtempSync(path.join(tmpdir(), "kone-spawn-real-"));
  const copy = path.join(dir, "spawn.ts");
  writeFileSync(copy, source);
  // SAFETY: copy is a byte-identical copy of spawn.ts (read from disk this run),
  // so the loaded module's exports equal typeof import("./spawn.js").
  return (await import(pathToFileURL(copy).href)) as typeof import("./spawn.js");
}

const { probe, killTree } = await loadRealSpawnModule();

describe("probe", () => {
  test("resolves with the accumulated stdout for a quick command", async () => {
    const result = await probe(
      process.execPath,
      ["-e", "process.stdout.write('v1.2.3')"],
      {},
      5_000,
    );
    expect(result).toBe("v1.2.3");
  });

  test("resolves null when the binary is unavailable", async () => {
    const result = await probe("__kone_no_such_binary__", [], {}, 5_000);
    expect(result).toBeNull();
  });

  test("resolves null on timeout instead of hanging", async () => {
    // The child never exits; only the timeout path can settle the promise.
    const result = await probe(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {},
      300,
    );
    expect(result).toBeNull();
  });

  test("caps very large stdout at ~1 MiB", async () => {
    const result = await probe(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1536 * 1024))"],
      {},
      15_000,
    );
    expect(typeof result).toBe("string");
    // The cap stops appending at ~1 MiB; chunk granularity can overshoot by a
    // pipe buffer, so assert against the full 1.5 MiB the child wrote instead
    // of a tight byte bound.
    expect(result!.length).toBeGreaterThanOrEqual(1024 * 1024);
    expect(result!.length).toBeLessThan(1536 * 1024);
  });
});

describe("killTree", () => {
  test("escalates to SIGKILL for a child that ignores SIGTERM, proving exit before resolving", async () => {
    if (process.platform === "win32") return;
    // The child swallows SIGTERM and keeps running, so only the SIGKILL
    // escalation can actually reap it.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    try {
      const pid = child.pid!;
      // Give the child a moment to install its SIGTERM handler.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await killTree(pid);
      // killTree only resolves once the process is confirmed gone, so this
      // must already be true — no external poll needed.
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);

  test("resolves promptly for a child that exits cleanly on SIGTERM", async () => {
    if (process.platform === "win32") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid!;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const start = Date.now();
    await killTree(pid);
    // No SIGKILL escalation needed — should settle well under the 1.5s grace period.
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 5_000);

  test("resolves immediately for an already-dead pid", async () => {
    if (process.platform === "win32") return;
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const start = Date.now();
    await killTree(child.pid!);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
