import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runAntigravityHelperProcess } from "./adapters/AntigravityPrintAdapter.js";
import { resolveAntigravityBinary } from "./antigravityHome.js";
import {
  agentCoreModuleUrl,
  createLaunchFixture,
  recordingSpawn,
  runLaunchScript,
  type LaunchFixture,
} from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

// The Antigravity print adapter's two non-probe spawns: the short helper
// (`agy plugin install` / `agy models`, runAntigravityHelperProcess) and the
// per-turn `agy -p` invocation. Both spawn a bare/configured binary directly,
// so on Windows each has to go through the shared launch seam: the npm `.cmd`
// shim runs through ComSpec, and an argv cmd.exe cannot carry (a multi-line
// print prompt) is refused with a sentence rather than launched truncated.
//
// The helper is exercised with an injected spawn, since the launch is what is
// under test. The turn spawn lives inside the adapter class and needs a full
// startSession + sendTurn, so it runs in the harness's throwaway subprocess
// with `process.platform` claimed as win32 — the adapter's own `resolveBinary`
// is the only injection point and it names the binary, not the platform.

const BINARY = "agy";
const TURN_MODEL = "Gemini 3.5 Flash (Medium)";

/** Where a Windows launch finds cmd.exe, as the scenario env spells it. */
const COMSPEC = "C:\\Windows\\System32\\cmd.exe";

/** The env a launch resolves against for a scenario: the fixture's install dir
 *  on PATH, cmd.exe named as Windows would. */
function launchEnv(fixture: LaunchFixture): NodeJS.ProcessEnv {
  return { PATH: fixture.binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: COMSPEC };
}

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

describe("Antigravity helper process through the launch seam", () => {
  test("on Windows the helper is ComSpec running the npm shim", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const env = launchEnv(fixture);
    const { calls, spawn } = recordingSpawn("process.stdout.write('models\\n')");
    const result = await runAntigravityHelperProcess(resolveAntigravityBinary(undefined), ["models"], {
      env,
      launch: { platform: "win32", spawn },
    });
    expect(result).toEqual({ stdout: "models\n", stderr: "", code: 0 });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(calls[0]?.file).toBe(COMSPEC);
    expect(calls[0]?.args).toEqual(["/d", "/s", "/c", `"${escapeCmdCommand(shim)} ^^^"models^^^""`]);
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(true);
    expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(calls[0]?.options.cwd).toBeUndefined();
  });

  test("an argv cmd.exe cannot carry is refused, not launched truncated", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const { calls, spawn } = recordingSpawn();
    const failure = await runAntigravityHelperProcess(
      BINARY,
      ["-p", "first line\nsecond line"],
      { env: launchEnv(fixture), launch: { platform: "win32", spawn } },
    ).then(() => undefined, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("cannot pass an argument that spans lines");
    expect(calls).toHaveLength(0);
  });

  test("off Windows the helper spawns the bare name with the unchanged options", async () => {
    const fixture = createLaunchFixture();
    fixture.installExecutable(BINARY);
    const env = launchEnv(fixture);
    const { calls, spawn } = recordingSpawn("process.stdout.write('models\\n')");
    const result = await runAntigravityHelperProcess(BINARY, ["models"], {
      cwd: fixture.root,
      env,
      launch: { platform: "linux", spawn },
    });
    expect(result).toEqual({ stdout: "models\n", stderr: "", code: 0 });
    expect(calls[0]?.file).toBe(BINARY);
    expect(calls[0]?.args).toEqual(["models"]);
    expect(calls[0]?.options).toStrictEqual({
      cwd: fixture.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  test("on Windows a timed-out helper is torn down with taskkill", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const taskkillRecord = `${fixture.recordFile}.taskkill`;
    // A cmd.exe that never finishes: the helper's timeout is the only way out,
    // and on Windows the child is cmd.exe, so the real CLI would survive a
    // bare `child.kill()`.
    const slowComspec = path.join(fixture.root, "cmd-slow");
    writeFileSync(slowComspec, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    writeFileSync(
      path.join(fixture.binDir, "taskkill"),
      `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(taskkillRecord)}, JSON.stringify(argv) + "\\n");
const pid = Number(argv[1]);
if (Number.isInteger(pid) && pid > 0) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
`,
      { mode: 0o755 },
    );
    const scenario: LaunchFixture = {
      ...fixture,
      // PATH is narrowed to the bin dir alone: a single entry is what both the
      // Windows resolution (`;`-split) and this host's `taskkill` lookup
      // (`:`-split) read as that directory.
      env: (options) => ({ ...fixture.env(options), PATH: fixture.binDir, ComSpec: slowComspec }),
    };
    const run = await runLaunchScript({
      fixture: scenario,
      windows: true,
      body: `
        const { runAntigravityHelperProcess } = await import(${JSON.stringify(
          agentCoreModuleUrl("adapters/AntigravityPrintAdapter.ts"),
        )});
        const outcome = await runAntigravityHelperProcess(${JSON.stringify(BINARY)}, ["models"], {
          env: process.env,
          timeoutMs: 150,
        }).then(() => "resolved", (error) => error.message);
        process.stdout.write("KONE_OUTCOME:" + JSON.stringify(outcome));
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("KONE_OUTCOME:");
    expect(run.stdout).toContain("timed out after 150ms");
    const kills = readRecordFile(taskkillRecord);
    expect(kills).toHaveLength(1);
    expect(kills[0]![0]).toBe("/pid");
    expect(kills[0]![1]).toMatch(/^\d+$/);
    expect(kills[0]!.slice(2)).toEqual(["/T", "/F"]);
  }, 20_000);
});

describe("Antigravity print-mode turn launch", () => {
  /** The scenario body shared by the turn cases: start a full-access session
   *  and send one prompt, then report the events the adapter emitted. */
  function turnBody(fixture: LaunchFixture, prompt: string, threadId: string): string {
    return `
      const { AntigravityPrintAdapter } = await import(${JSON.stringify(
        agentCoreModuleUrl("adapters/AntigravityPrintAdapter.ts"),
      )});
      const events = [];
      const adapter = new AntigravityPrintAdapter((event) => events.push(event), undefined, {
        homeDir: ${JSON.stringify(fixture.homeDir)},
      });
      await adapter.startSession({
        threadId: ${JSON.stringify(threadId)},
        provider: "antigravity",
        cwd: ${JSON.stringify(fixture.root)},
        mode: "full-access",
      });
      await adapter.sendTurn({ threadId: ${JSON.stringify(threadId)}, input: ${JSON.stringify(prompt)} });
      // Let the print process close and the turn settle before reporting.
      await new Promise((resolve) => setTimeout(resolve, 750));
      process.stdout.write("KONE_EVENTS:" + JSON.stringify(events));
    `;
  }

  /** The events the body reported, as the adapter emitted them. */
  function reportedEvents(stdout: string): { type?: string; message?: string }[] {
    const marker = stdout.lastIndexOf("KONE_EVENTS:");
    if (marker < 0) throw new Error(`scenario never reported its events:\n${stdout}`);
    // SAFETY: the body writes its own events array as JSON after the marker.
    return JSON.parse(stdout.slice(marker + "KONE_EVENTS:".length)) as {
      type?: string;
      message?: string;
    }[];
  }

  test("on Windows the turn is ComSpec running the npm shim", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({ fixture, windows: true, body: turnBody(fixture, "hello from kone", "t-win") });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // The capture-plugin install first, then the turn itself.
    expect(run.records).toHaveLength(2);
    const turn = run.records[1]!;
    expect(turn.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(turn).toHaveLength(4);
    const line = turn[3]!;
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(line.startsWith(`"${escapeCmdCommand(shim)} `)).toBe(true);
    // Every arg is one cmd.exe word — the prompt is the last, spaces escaped.
    expect(line).toContain(`^^^"-p^^^"`);
    expect(line.endsWith(`^^^"hello^^^ from^^^ kone^^^""`)).toBe(true);
    expect(line).not.toContain("\n");
  }, 20_000);

  test("on Windows a multi-line prompt fails the turn instead of truncating it", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: turnBody(fixture, "first line\nsecond line", "t-multiline"),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // Only the plugin install launched; the turn never became a command line.
    expect(run.records).toHaveLength(1);
    expect(run.records[0]!.join(" ")).toContain("plugin");
    const aborted = reportedEvents(run.stdout).find((event) => event.type === "turn.aborted");
    expect(aborted?.message).toContain("cannot pass an argument that spans lines");
  }, 20_000);

  test("off Windows the turn spawns the bare name with the unchanged argv", async () => {
    const fixture = createLaunchFixture();
    fixture.installExecutable(BINARY);
    const run = await runLaunchScript({ fixture, windows: false, body: turnBody(fixture, "hello from kone", "t-posix") });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.records).toHaveLength(2);
    const turn = run.records[1]!;
    // The bare name was spawned directly: argv starts at the CLI's own flags.
    expect(turn[0]).toBe("--new-project");
    expect(turn).toContain("--dangerously-skip-permissions");
    expect(turn[turn.indexOf("--model") + 1]).toBe(TURN_MODEL);
    expect(turn).toContain("-p");
    expect(turn.at(-1)).toBe("hello from kone");
  }, 20_000);
});
