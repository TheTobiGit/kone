import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyOpenCodeSpawnFailure, probeOpenCodeVersion } from "./opencodeHome.js";
import { OpenCodeServerPool } from "./opencodeServer.js";
import {
  agentCoreModuleUrl,
  createLaunchFixture,
  recordingSpawn,
  runLaunchScript,
  type LaunchFixture,
} from "./testing/win32Launch.js";
import { setUserDataDir } from "./userDataDir.js";
import { escapeCmdCommand, launchFailureError } from "./windowsLaunch.js";

// The opencode server boot (opencodeServer.ts) and the version probe
// (opencodeHome.ts) spawn `opencode` themselves rather than through spawn.ts's
// helpers, so each has to route through the shared launch seam on its own. On
// Windows an npm install is a `.cmd` shim: the launch is ComSpec with the
// escaped command line, and the bare `opencode` sibling is never what starts.
//
// The server boot is exercised with an injected spawn (the launch is what is
// under test, not the server). The dispose teardown needs a real child — and a
// `taskkill` stand-in to observe it — so that scenario runs in the harness's
// throwaway subprocess, where `process.platform` can be claimed as win32
// without any other module seeing it.

// The server ledger lives under the user data dir; point it at a temp one so no
// case can read or write the machine's real orphan list.
setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-opencode-launch-userdata-")));

const BINARY = "opencode";
const SERVER_MODULE = agentCoreModuleUrl("opencodeServer.ts");
const USER_DATA_MODULE = agentCoreModuleUrl("userDataDir.ts");

/** Where a Windows launch finds cmd.exe, as the scenario env spells it. */
const COMSPEC = "C:\\Windows\\System32\\cmd.exe";

/** One recorded argv line back as the argv array it was written from. */
function parseRecord(line: string): string[] {
  // SAFETY: the record files this suite reads are written by the harness
  // recorder (or its taskkill stand-in) as `JSON.stringify(argv)`.
  return JSON.parse(line) as string[];
}

/** A parse of the argv lines a helper script appended, oldest first. Empty when
 *  the script never ran. */
function readRecordFile(file: string): string[][] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(parseRecord);
  } catch {
    return [];
  }
}

/** A stand-in `taskkill` on the scenario's PATH: it records the argv `killTree`
 *  sends (so the Windows teardown is observable from the outside) and really
 *  kills that pid, so the scenario can exit instead of hanging on its own
 *  child. Returns the record file the caller asserts on. */
function installTaskkillRecorder(fixture: LaunchFixture): string {
  const recordFile = `${fixture.recordFile}.taskkill`;
  writeFileSync(
    path.join(fixture.binDir, "taskkill"),
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(argv) + "\\n");
const pid = Number(argv[1]);
if (Number.isInteger(pid) && pid > 0) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
`,
    { mode: 0o755 },
  );
  return recordFile;
}

/** A stand-in cmd.exe for a `serve` scenario: it prints the fixture's canned
 *  stdout (the listening line) and then idles, so the server reaches readiness
 *  and a teardown has something to kill — the harness's own ComSpec recorder
 *  exits immediately. PATH is narrowed to the fixture's bin dir alone: a
 *  single entry is the one spelling both the Windows resolution (`;`-split)
 *  and this host's own `taskkill` lookup (`:`-split) read the same way. */
function withIdlingComspec(fixture: LaunchFixture): LaunchFixture {
  const comspec = path.join(fixture.root, "cmd-idle");
  writeFileSync(
    comspec,
    `#!${process.execPath}
process.stdout.write(process.env.KONE_LAUNCH_STDOUT || "");
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  return {
    ...fixture,
    env: (options) => ({ ...fixture.env(options), PATH: fixture.binDir, ComSpec: comspec }),
  };
}

describe("OpenCode server boot through the launch seam", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  }

  test("on Windows the boot is ComSpec running the npm shim", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const env = { PATH: fixture.binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: COMSPEC };
    const { calls, spawn } = recordingSpawn();
    const pool = new OpenCodeServerPool();
    try {
      // The recording child is not a server: it exits without a listening line,
      // which settles the boot through the same rejection path a failed spawn
      // takes. The launch itself is what this case asserts.
      const failure = await pool
        .start({
          cwd: scratchDir("kone-opencode-launch-"),
          env,
          binary: BINARY,
          launch: { platform: "win32", spawn },
        })
        .then(() => undefined, (error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
      const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
      expect(calls[0]?.file).toBe(COMSPEC);
      expect(calls[0]?.args).toEqual([
        "/d",
        "/s",
        "/c",
        `"${escapeCmdCommand(shim)} ^^^"serve^^^" ^^^"--hostname=127.0.0.1^^^" ^^^"--port=0^^^""`,
      ]);
      expect(calls[0]?.options.windowsVerbatimArguments).toBe(true);
      // No process group off cmd.exe's own console, and no console window.
      expect(calls[0]?.options.detached).toBe(false);
      expect(calls[0]?.options.windowsHide).toBe(true);
      expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(calls[0]?.options.cwd).toBeString();
      expect(calls[0]?.options.env?.PATH).toBe(fixture.binDir);
      expect(calls[0]?.options.env?.KONE_OPENCODE_SERVER).toBeString();
    } finally {
      await pool.dispose();
    }
  });

  test("a missing CLI fails the boot with ENOENT, without spawning anything", async () => {
    const emptyPath = scratchDir("kone-opencode-empty-");
    const { calls, spawn } = recordingSpawn();
    const pool = new OpenCodeServerPool();
    try {
      const failure = await pool
        .start({
          cwd: scratchDir("kone-opencode-launch-"),
          env: { PATH: emptyPath },
          binary: BINARY,
          launch: { platform: "win32", spawn },
        })
        .then(() => undefined, (error: NodeJS.ErrnoException) => error);
      expect(failure?.code).toBe("ENOENT");
      expect(failure?.message).toContain("isn't on your PATH");
      expect(calls).toHaveLength(0);
    } finally {
      await pool.dispose();
    }
  });

  test("off Windows the boot spawns the bare name with the unchanged options", async () => {
    const cwd = scratchDir("kone-opencode-launch-");
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin" };
    const { calls, spawn } = recordingSpawn();
    const pool = new OpenCodeServerPool();
    try {
      await pool.start({ cwd, env, binary: BINARY, launch: { platform: "linux", spawn } }).catch(() => {});
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe(BINARY);
      expect(calls[0]?.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"]);
      expect(calls[0]?.options.cwd).toBe(cwd);
      expect(calls[0]?.options.detached).toBe(true);
      expect(calls[0]?.options.windowsHide).toBe(true);
      expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(calls[0]?.options.env?.PATH).toBe(env.PATH);
      // A literal options object: no Windows-only key leaks into the launch.
      expect(Object.keys(calls[0]?.options ?? {})).toEqual(["cwd", "env", "detached", "stdio", "windowsHide"]);
    } finally {
      await pool.dispose();
    }
  });

  test("dispose tears the cmd.exe wrapper's whole tree down with taskkill", async () => {
    const fixture = createLaunchFixture({
      stdout: "opencode server listening on http://127.0.0.1:3210\n",
    });
    fixture.installNpmSiblings(BINARY);
    const taskkillRecord = installTaskkillRecorder(fixture);
    const scenario = withIdlingComspec(fixture);
    const run = await runLaunchScript({
      fixture: scenario,
      windows: true,
      body: `
        const { setUserDataDir } = await import(${JSON.stringify(USER_DATA_MODULE)});
        setUserDataDir(process.env.HOME);
        const { OpenCodeServerPool } = await import(${JSON.stringify(SERVER_MODULE)});
        const pool = new OpenCodeServerPool();
        const server = await pool.start({ cwd: process.env.HOME, env: process.env, binary: ${JSON.stringify(BINARY)} });
        // Let the background prewarm reach readiness so dispose() (not the
        // unready path) owns both children.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await server.dispose();
        await pool.dispose();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const kills = readRecordFile(taskkillRecord);
    expect(kills.length).toBeGreaterThanOrEqual(1);
    for (const argv of kills) {
      expect(argv).toHaveLength(4);
      expect(argv[0]).toBe("/pid");
      expect(argv[1]).toMatch(/^\d+$/);
      expect(argv.slice(2)).toEqual(["/T", "/F"]);
    }
  }, 20_000);
});

describe("OpenCode version probe through the launch seam", () => {
  // probeOpenCodeVersion builds its own environment (the agent env), so the
  // PATH a launch resolves against is swapped for the case and restored after.
  let savedPath: string | undefined;
  let savedComspec: string | undefined;

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedComspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = savedComspec;
    savedPath = undefined;
    savedComspec = undefined;
  });

  function usePath(binDir: string): void {
    savedPath = process.env.PATH;
    savedComspec = process.env.ComSpec;
    process.env.PATH = binDir;
    process.env.ComSpec = COMSPEC;
  }

  test("on Windows the probe is ComSpec running the npm shim", async () => {
    const fixture = createLaunchFixture({ stdout: "1.14.19\n" });
    fixture.installNpmSiblings(BINARY);
    // The probe builds its own env, so PATH carries the fixture in Windows
    // form: the first `;`-separated entry is the bin dir, whatever the agent
    // env appends to it afterwards (`:`-joined, i.e. one unusable entry here).
    usePath(`${fixture.binDir};C:\\Windows\\System32`);
    const { calls, spawn } = recordingSpawn("process.stdout.write('1.14.19\\n')");
    const result = await probeOpenCodeVersion({ platform: "win32", spawn });
    expect(result).toEqual({ version: "1.14.19" });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(calls[0]?.file).toBe(COMSPEC);
    expect(calls[0]?.args).toEqual([
      "/d",
      "/s",
      "/c",
      `"${escapeCmdCommand(shim)} ^^^"--version^^^""`,
    ]);
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(true);
    expect(calls[0]?.options.windowsHide).toBe(true);
    expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("a missing CLI resolves the ENOENT the classifier reads as not-installed", async () => {
    const emptyPath = mkdtempSync(path.join(tmpdir(), "kone-opencode-probe-empty-"));
    try {
      usePath(`${emptyPath};C:\\Windows\\System32`);
      const { calls, spawn } = recordingSpawn();
      const result = await probeOpenCodeVersion({ platform: "win32", spawn });
      const error = result.error;
      expect(error).toBeInstanceOf(Error);
      // SAFETY: probeOpenCodeVersion resolves the ErrnoException a failed
      // launch would have produced; its `code` is the missing-ness signal.
      const failure = error as NodeJS.ErrnoException;
      expect(failure.code).toBe("ENOENT");
      expect(failure.message).toContain("isn't on your PATH");
      expect(calls).toHaveLength(0);
      expect(classifyOpenCodeSpawnFailure(failure).readiness).toBe("not-installed");
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  test("off Windows the probe spawns the bare name with the unchanged options", async () => {
    const fixture = createLaunchFixture();
    fixture.installExecutable(BINARY);
    usePath(fixture.binDir);
    const { calls, spawn } = recordingSpawn("process.stdout.write('1.14.19\\n')");
    const result = await probeOpenCodeVersion({ platform: "linux", spawn });
    expect(result).toEqual({ version: "1.14.19" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(BINARY);
    expect(calls[0]?.args).toEqual(["--version"]);
    expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(calls[0]?.options.windowsHide).toBe(true);
    expect(Object.keys(calls[0]?.options ?? {}).sort()).toEqual(["env", "stdio", "windowsHide"]);
    expect(Object.hasOwn(calls[0]?.options ?? {}, "windowsVerbatimArguments")).toBe(false);
  });
});

describe("OpenCode not-installed classification", () => {
  test("reads a launch failure's ENOENT code, not just its message", () => {
    const error = launchFailureError(BINARY, {
      ok: false,
      reason: "missing",
      message: `${BINARY} isn't on your PATH.`,
    });
    expect(error.code).toBe("ENOENT");
    expect(classifyOpenCodeSpawnFailure(error)).toMatchObject({
      provider: "opencode",
      readiness: "not-installed",
      available: false,
    });
  });
});
