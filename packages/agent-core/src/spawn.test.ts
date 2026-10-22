import { describe, expect, test } from "bun:test";

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLaunchFixture, recordingSpawn } from "./testing/win32Launch.js";
import { escapeCmdCommand, spawnLaunch } from "./windowsLaunch.js";

// The gateway-injection suites stub spawn.ts by its resolved absolute path with
// mock.module (their `probe` returns "ok" so no real CLI is spawned), and bun
// keeps one mock registry per worker process — so their stub can reach this file
// when both land in the same worker (a standalone run never hits it). Importing
// "./spawn.js" here would resolve to that stub. Instead, load the REAL module
// from a temp copy of the source — a unique resolved path no mock can intercept.
// spawn.ts has one relative import now (./windowsLaunch.js), rewritten to the
// real file's URL: windowsLaunch is never stubbed, so it stays real either way.
const SPAWN_SOURCE = fileURLToPath(new URL("./spawn.ts", import.meta.url));
const WINDOWS_LAUNCH_SOURCE = pathToFileURL(fileURLToPath(new URL("./windowsLaunch.ts", import.meta.url)))
  .href;

async function loadRealSpawnModule(): Promise<typeof import("./spawn.js")> {
  const source = readFileSync(SPAWN_SOURCE, "utf8").replace(
    'from "./windowsLaunch.js"',
    `from ${JSON.stringify(WINDOWS_LAUNCH_SOURCE)}`,
  );
  const dir = mkdtempSync(path.join(tmpdir(), "kone-spawn-real-"));
  const copy = path.join(dir, "spawn.ts");
  writeFileSync(copy, source);
  // SAFETY: copy is a byte-identical copy of spawn.ts (read from disk this run),
  // so the loaded module's exports equal typeof import("./spawn.js").
  return (await import(pathToFileURL(copy).href)) as typeof import("./spawn.js");
}

const { probe, probeResult, killTree, runStreaming } = await loadRealSpawnModule();

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
    expect(result).toBeString();
    // The cap stops appending at ~1 MiB; chunk granularity can overshoot by a
    // pipe buffer, so assert against the full 1.5 MiB the child wrote instead
    // of a tight byte bound.
    expect(result!.length).toBeGreaterThanOrEqual(1024 * 1024);
    expect(result!.length).toBeLessThan(1536 * 1024);
  });
});

describe("probeResult", () => {
  test("reports ok with both streams captured", async () => {
    const result = await probeResult(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      {},
      5_000,
    );
    expect(result.outcome).toBe("ok");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.code).toBe(0);
  });

  test("distinguishes a non-zero exit from a clean one, keeping its stderr", async () => {
    const result = await probeResult(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      {},
      5_000,
    );
    expect(result.outcome).toBe("nonzero");
    expect(result.stderr).toBe("boom");
    expect(result.code).toBe(3);
  });

  test("reports a missing binary as \"missing\", not as a failed run", async () => {
    const result = await probeResult("__kone_no_such_binary__", [], {}, 5_000);
    expect(result.outcome).toBe("missing");
    expect(result.code).toBeNull();
  });

  test("reports a wedged child as \"timeout\" rather than as missing", async () => {
    const result = await probeResult(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {},
      300,
    );
    // The whole point of the tagged outcome: this must not look like an
    // uninstalled CLI, which is what a bare null could not express.
    expect(result.outcome).toBe("timeout");
  });

  test("caps each stream independently at ~1 MiB", async () => {
    const result = await probeResult(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(1536 * 1024)); process.stderr.write('y'.repeat(1536 * 1024))",
      ],
      {},
      15_000,
    );
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream.length).toBeGreaterThanOrEqual(1024 * 1024);
      expect(stream.length).toBeLessThan(1536 * 1024);
    }
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

// ── Windows launch resolution ───────────────────────────────────────────────
// The real adapters spawn their CLI by bare name through these helpers. On
// Windows an npm install is a `.cmd` shim, so the launch has to be resolved and
// wrapped before spawn sees it; off Windows it must be byte-for-byte what it
// always was. The spawn below is recorded rather than run, so the assertions
// can be exact about the argv and options the helper hands over.

/** The argv fragment a batch shim launch appends for one argument, written out
 *  the way cmd.exe has to see it (double-escaped, because the shim re-parses). */
function escapedArgForCmd(argument: string): string {
  return `^^^"${argument}^^^"`;
}

describe("runStreaming Windows launch", () => {
  test("resolves an npm .cmd shim through ComSpec, keeping cwd/env/stdio", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings("x");
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const run = runStreaming("x", ["--version"], {
      cwd: fixture.root,
      env,
      launch: { platform: "win32", spawn: fakeSpawn },
    });
    const result = await run.done;
    expect(result.code).toBe(0);
    expect(calls).toEqual([
      {
        file: fixture.comspec,
        args: [
          "/d",
          "/s",
          "/c",
          `"${escapeCmdCommand(path.join(fixture.binDir, "x.cmd"))} ${escapedArgForCmd("--version")}"`,
        ],
        options: {
          cwd: fixture.root,
          env,
          windowsHide: true,
          // A fake win32 host: no process group of its own.
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: true,
        },
      },
    ]);
    expect(Object.keys(calls[0]!.options)).toEqual([
      "cwd",
      "env",
      "windowsHide",
      "detached",
      "stdio",
      "windowsVerbatimArguments",
    ]);
  });

  test("a launch that cannot happen lands in stderr with no exit code and a no-op kill", async () => {
    const fixture = createLaunchFixture();
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const run = runStreaming("__kone_no_such_binary__", [], {
      cwd: fixture.root,
      env,
      launch: { platform: "win32", spawn: fakeSpawn },
    });
    const result = await run.done;
    expect(result).toEqual({
      code: null,
      stdout: "",
      stderr: "__kone_no_such_binary__ isn't on your PATH.\n",
    });
    expect(() => run.kill()).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("off Windows the bare command and argv are spawned exactly as before", async () => {
    const fixture = createLaunchFixture();
    const env = { KONE_TEST: "1" };
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const run = runStreaming("x", ["--version"], {
      cwd: fixture.root,
      env,
      launch: { platform: "linux", spawn: fakeSpawn },
    });
    await run.done;
    expect(calls).toEqual([
      {
        file: "x",
        args: ["--version"],
        options: {
          cwd: fixture.root,
          env,
          windowsHide: true,
          // The same literal object as before this change: no cwd resolution,
          // no wrapping, and no windowsVerbatimArguments key.
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      },
    ]);
    expect(Object.keys(calls[0]!.options)).toEqual([
      "cwd",
      "env",
      "windowsHide",
      "detached",
      "stdio",
    ]);
  });
});

describe("probeResult Windows launch", () => {
  test("a native .exe is spawned directly, with no verbatim-arguments key", async () => {
    const fixture = createLaunchFixture();
    const exe = path.join(fixture.binDir, "x.exe");
    writeFileSync(exe, "not a real image\n");
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn("process.stdout.write('0.0.1')");
    const result = await probeResult("x", ["--version"], env, 5_000, {
      platform: "win32",
      spawn: fakeSpawn,
    });
    expect(result.outcome).toBe("ok");
    expect(result.stdout).toBe("0.0.1");
    expect(calls).toEqual([
      {
        file: exe,
        args: ["--version"],
        options: { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      },
    ]);
    expect("windowsVerbatimArguments" in calls[0]!.options).toBe(false);
  });

  test("reports a missing Windows binary as \"missing\" without spawning", async () => {
    const fixture = createLaunchFixture();
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const result = await probeResult("__kone_no_such_binary__", [], env, 5_000, {
      platform: "win32",
      spawn: fakeSpawn,
    });
    expect(result.outcome).toBe("missing");
    expect(result.code).toBeNull();
    expect(result.error?.code).toBe("ENOENT");
    expect(result.error?.path).toBe("__kone_no_such_binary__");
    expect(calls).toEqual([]);
  });

  test("reports a .ps1-only install as a failure that says what Windows can run", async () => {
    const fixture = createLaunchFixture();
    writeFileSync(path.join(fixture.binDir, "y.ps1"), "# not launchable\n");
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const result = await probeResult("y", ["--version"], env, 5_000, {
      platform: "win32",
      spawn: fakeSpawn,
    });
    expect(result.outcome).toBe("failure");
    expect(result.error?.code).toBe("EINVAL");
    expect(result.error?.message).toContain("isn't something Windows can run");
    expect(calls).toEqual([]);
  });

  test("off Windows the bare command and argv are spawned exactly as before", async () => {
    const { calls, spawn: fakeSpawn } = recordingSpawn("process.stdout.write('1.2.3')");
    const result = await probeResult("x", ["--version"], { KONE_TEST: "1" }, 5_000, {
      platform: "linux",
      spawn: fakeSpawn,
    });
    expect(result.outcome).toBe("ok");
    // The literal object probeResult has always passed: no cwd, no detached,
    // and no windowsVerbatimArguments key.
    expect(calls).toEqual([
      {
        file: "x",
        args: ["--version"],
        options: { env: { KONE_TEST: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      },
    ]);
    expect(Object.keys(calls[0]!.options)).toEqual(["env", "windowsHide", "stdio"]);
  });
});

describe("spawnLaunch", () => {
  test("off Windows spawns the command and argv untouched", async () => {
    const options = { env: { KONE_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"] as const };
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const result = spawnLaunch("x", ["--version"], { ...options, stdio: [...options.stdio] }, {
      platform: "linux",
      spawn: fakeSpawn,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        file: "x",
        args: ["--version"],
        options: { env: options.env, stdio: ["ignore", "pipe", "pipe"] },
      },
    ]);
  });

  test("returns the launch failure as the Error a failed spawn would have raised", () => {
    const fixture = createLaunchFixture();
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    const result = spawnLaunch("__kone_no_such_binary__", ["--version"], { env }, {
      platform: "win32",
      spawn: fakeSpawn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the launch to fail");
    expect(result.error.code).toBe("ENOENT");
    expect(result.error.path).toBe("__kone_no_such_binary__");
    expect(calls).toEqual([]);
  });
});
