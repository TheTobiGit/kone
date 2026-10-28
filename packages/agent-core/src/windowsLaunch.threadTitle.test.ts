import { afterAll, describe, expect, test } from "bun:test";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { generateThreadTitle } from "./threadTitle.js";
import { createLaunchFixture, recordingSpawn } from "./testing/win32Launch.js";
import { setUserDataDir } from "./userDataDir.js";
import { escapeCmdArgument, escapeCmdCommand } from "./windowsLaunch.js";

// Thread titles are a one-shot CLI call (`claude -p`, `codex exec`, …). On
// Windows an npm install of that CLI is a `.cmd` shim, so the call has to go
// through cmd.exe like every other agent launch; a launch that cannot happen
// keeps the deterministic fallback title, exactly as a spawn error does.
//
// The generators build their child environment from `process.env` (see
// processEnv.ts), so a test that drives a real generator puts the fixture there
// in Windows form — a `;`-separated PATH — and restores it afterwards.
//
// Claude is the generator under test because its argv is entirely fixed (the
// prompt rides stdin), so the expected cmd.exe command line can be written out
// literally. The generators that instead pass the prompt as an ARGUMENT —
// opencode, cursor, droid and antigravity — cannot carry the multi-line title
// prompt through a `.cmd` at all: windowsLaunch refuses that argv as
// "invalid-argument" and the title falls back to the deterministic one.

/** What the stand-in CLI prints and how: it must wait for the prompt to arrive
 *  on stdin, or the write can race the child's exit. */
const TITLE_ON_STDIN_SCRIPT = `process.stdin.resume();
process.stdin.on("end", () => process.stdout.write('{"title":"Windows launches"}'));`;

/** generateWithClaude's argv, restated literally. The schema is the const in
 *  threadTitle.ts, written out rather than imported so the expectation is not
 *  read back from the module under test. */
const TITLE_SCHEMA_JSON =
  '{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}';
const CLAUDE_ARGS = [
  "-p",
  "--output-format",
  "json",
  "--json-schema",
  TITLE_SCHEMA_JSON,
  "--model",
  "claude-haiku-4-5",
  "--effort",
  "low",
  "--dangerously-skip-permissions",
];

const fixture = createLaunchFixture();
fixture.installNpmSiblings("claude");
// The generators build the provider environment through the settings store, so
// point the per-user state at the fixture before any title is generated.
setUserDataDir(fixture.userDataDir);

afterAll(() => {
  fixture.cleanup();
});

/** The process environment a Windows machine would present: a `;`-separated
 *  PATH whose first entry is `binDir`, Windows' PATHEXT, and the fixture's
 *  cmd.exe recorder as ComSpec. Restored when `body` finishes, so the rest of
 *  the suite sees the host environment again. */
async function withWindowsProcessEnv<T>(binDir: string, body: () => Promise<T>): Promise<T> {
  const saved = {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    ComSpec: process.env.ComSpec,
  };
  process.env.PATH = `${binDir};C:\\Windows\\System32`;
  process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";
  process.env.ComSpec = fixture.comspec;
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A real child that never exits on its own, so the timeout path can be
 *  exercised without a 45-second wait and the teardown can be observed for
 *  real (the signal on POSIX, the pid the Windows tree kill is handed). */
function hangingChild(): ChildProcess {
  return spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** A spawn stand-in that hands back `child`: the launch itself succeeds, and
 *  only the timeout can end it. */
function hangingSpawn(child: ChildProcess): typeof spawnProcess {
  // SAFETY: the seam calls spawn as (file, args, options) and only uses the
  // returned ChildProcess; a real, already-running child is exactly that, so
  // this replaces the launch without changing how the caller uses it.
  return (() => child) as typeof spawnProcess;
}

/** The recorded cmd.exe wrapper for one batch target and its argv. */
function expectedCmdLine(file: string, args: readonly string[]): string {
  return `"${[escapeCmdCommand(file), ...args.map((arg) => escapeCmdArgument(arg, true))].join(" ")}"`;
}

describe("generateThreadTitle Windows launch", () => {
  test("launches Claude's npm shim through cmd.exe and keeps its answer", async () => {
    const { calls, spawn } = recordingSpawn(TITLE_ON_STDIN_SCRIPT);

    const title = await withWindowsProcessEnv(fixture.binDir, () =>
      generateThreadTitle({
        cwd: fixture.root,
        message: "hello",
        provider: "claudeAgent",
        launch: { platform: "win32", spawn },
      }),
    );

    const claudeCmd = path.join(fixture.binDir, "claude.cmd");
    expect(title).toBe("Windows launches");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(fixture.comspec);
    expect(calls[0]!.args).toEqual([
      "/d",
      "/s",
      "/c",
      expectedCmdLine(claudeCmd, CLAUDE_ARGS),
    ]);
    expect(calls[0]!.options).toMatchObject({
      cwd: fixture.root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: true,
    });
  });

  test("a shim Windows cannot start keeps the fallback title", async () => {
    // npm's `.ps1` sibling: the file is there, but there is no interpreter to
    // run it, so the launch is refused before any child exists.
    const ps1Only = path.join(fixture.root, "ps1-only");
    fs.mkdirSync(ps1Only, { recursive: true });
    fs.writeFileSync(path.join(ps1Only, "claude.ps1"), "# not launchable\n", { mode: 0o644 });
    const { calls, spawn } = recordingSpawn(TITLE_ON_STDIN_SCRIPT);

    const title = await withWindowsProcessEnv(ps1Only, () =>
      generateThreadTitle({
        cwd: fixture.root,
        message: "hello",
        provider: "claudeAgent",
        launch: { platform: "win32", spawn },
      }),
    );

    expect(title).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a timeout on Windows tears down the whole process tree", async () => {
    const child = hangingChild();
    const exited = new Promise((resolve) => child.once("close", resolve));
    const treeKilled: (number | undefined)[] = [];

    const title = await withWindowsProcessEnv(fixture.binDir, () =>
      generateThreadTitle({
        cwd: fixture.root,
        message: "hello",
        provider: "claudeAgent",
        launch: {
          platform: "win32",
          spawn: hangingSpawn(child),
          timeoutMs: 5,
          killTree: async (pid) => {
            treeKilled.push(pid);
            child.kill("SIGKILL");
          },
        },
      }),
    );
    await exited;

    expect(title).toBeNull();
    // The child here is cmd.exe; killing only it would leave the CLI running,
    // so the pid handed to the tree kill is the wrapper's.
    expect(treeKilled).toEqual([child.pid]);
  });

  test("off Windows the timeout stays the plain SIGTERM it always was", async () => {
    const child = hangingChild();
    const signalled = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    const treeKilled: (number | undefined)[] = [];

    const title = await generateThreadTitle({
      cwd: fixture.root,
      message: "hello",
      provider: "claudeAgent",
      launch: {
        platform: "linux",
        spawn: hangingSpawn(child),
        timeoutMs: 5,
        killTree: async (pid) => {
          treeKilled.push(pid);
        },
      },
    });

    expect(title).toBeNull();
    expect(await signalled).toBe("SIGTERM");
    expect(treeKilled).toEqual([]);
  });

  test("off Windows the CLI is spawned by bare name with the same argv", async () => {
    const { calls, spawn } = recordingSpawn(TITLE_ON_STDIN_SCRIPT);

    const title = await generateThreadTitle({
      cwd: fixture.root,
      message: "hello",
      provider: "claudeAgent",
      launch: { platform: "linux", spawn },
    });

    expect(title).toBe("Windows launches");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("claude");
    expect(calls[0]!.args).toEqual(CLAUDE_ARGS);
    // No launch key is added on another platform — not even an undefined one.
    expect(Object.keys(calls[0]!.options)).toEqual(["cwd", "env", "windowsHide", "stdio"]);
  });
});
