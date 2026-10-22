import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Test harness for the per-family Windows launch suites.
//
// A launch has to be exercised in a throwaway SUBPROCESS for two reasons: the
// adapters read `process.platform` themselves (so a scenario that claims to be
// win32 must only claim it where nothing else can see it), and several suites
// stub spawn.ts / jsonRpc.ts through bun's per-worker mock registry — a real
// adapter imported in the test process would run against a stub.
//
// Each fixture is an npm-shaped install on a temp PATH: `x.cmd`, an
// extensionless `x` that is NOT executable (what npm's sh shim looks like to
// Windows) and `x.ps1`. `ComSpec` points at a recorder, so a launch that goes
// through cmd.exe leaves its argv behind; a non-Windows control instead puts an
// EXECUTABLE extensionless `x` on PATH and records what the bare name received.

/** The environment variables the recorder reads: where to append the argv
 *  lines, and what to print on stdout (a version string, say). */
const RECORD_ENV = "KONE_LAUNCH_RECORD";
const STDOUT_ENV = "KONE_LAUNCH_STDOUT";

/** The directory the agent-core package lives in. Subprocesses run with this as
 *  their cwd so the adapters' own imports resolve, and tests build absolute
 *  module URLs from it (a script in a temp dir cannot resolve `@kone/*`). */
const AGENT_CORE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The absolute URL of a module under `src/`, for a script that has to import
 *  the real adapter from a temp directory outside the package. */
export function agentCoreModuleUrl(relativeToSrc: string): string {
  return pathToFileURL(path.join(AGENT_CORE_DIR, "src", relativeToSrc)).href;
}

/** One recorded launch: exactly what the spawn seam handed to child_process. */
export type SpawnCall = { file: string; args: readonly string[]; options: SpawnOptions };

/** A spawn stand-in and the launches it recorded. */
export type RecordingSpawn = { calls: SpawnCall[]; spawn: typeof spawn };

/** A spawn stand-in that records every launch and returns a REAL child running
 *  `script` through this process's own binary, so the caller's stream handling
 *  (`stdout`, `stdin`, exit) still works and only the launch is synthetic.
 *  Pipes are used on all three stdio ends because the JSON-RPC transport writes
 *  to the child's stdin. */
export function recordingSpawn(script = "process.stdout.write('1.2.3')"): RecordingSpawn {
  const calls: SpawnCall[] = [];
  // SAFETY: the seam only calls spawn as (file, args, options) and treats the
  // return value as a ChildProcess; a real piped child of `script` is exactly
  // that, so this records the launch without changing how the caller uses it.
  const fake = ((file: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ file, args, options });
    return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  }) as typeof spawn;
  return { calls, spawn: fake };
}

/** A program that stands in for whichever binary a launch resolves to: it
 *  appends its argv to the record file and prints the canned stdout, so the
 *  recorder can tell the test both "what was started" and "how". */
function recorderSource(): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const record = process.env.${RECORD_ENV};
if (record) fs.appendFileSync(record, JSON.stringify(process.argv.slice(2)) + "\\n");
const stdout = process.env.${STDOUT_ENV};
if (stdout) process.stdout.write(stdout);
`;
}

/** Write a file and give it an exact mode, whatever the umask is (the
 *  non-executable extensionless shim and the executable control both depend on
 *  the bit being exactly as asked). */
function write(fullPath: string, contents: string, mode: number): void {
  fs.writeFileSync(fullPath, contents);
  fs.chmodSync(fullPath, mode);
}

/** One line of the record file back as the argv the recorder saw. */
function parseRecord(line: string): string[] {
  // SAFETY: every line is written by this harness's recorder as
  // `JSON.stringify(argv)`, so it parses back to the argv array it wrote.
  return JSON.parse(line) as string[];
}

/** A throwaway install layout for one launch scenario. `binDir` goes on PATH,
 *  `comspec` stands in for cmd.exe, and every recorded launch lands in
 *  `recordFile`. */
export type LaunchFixture = {
  /** Where the scenario's files live (the fixture's private temp dir). */
  readonly root: string;
  /** The directory put on PATH: the CLI's install location. */
  readonly binDir: string;
  /** HOME / USERPROFILE for the subprocess — empty of any real install. */
  readonly homeDir: string;
  /** The recorder started where a batch shim needs cmd.exe. */
  readonly comspec: string;
  readonly recordFile: string;
  /** What the recorder prints on stdout (the CLI's version, usually). */
  readonly stdout: string;
  /** npm's Windows install: `<name>.cmd`, an extensionless `<name>` shell
   *  script that is not executable, and `<name>.ps1`. */
  installNpmSiblings(name: string): void;
  /** A single extensionless, executable `<name>`: the non-Windows control's
   *  binary, and what a PATH lookup finds off Windows. */
  installExecutable(name: string): void;
  /** The environment a launch subprocess runs with. `windows` decides the PATH
   *  separator: a win32 scenario resolves a `;`-separated PATH, exactly as
   *  Windows does, while the control needs the host's `:`. */
  env(options: { windows: boolean }): NodeJS.ProcessEnv;
  /** Every argv line the recorder has written, oldest first. */
  records(): string[][];
};

/** Build a fixture: temp dirs, the ComSpec recorder and an empty record file.
 *  `stdout` is what every recorder prints, so a probe sees a version line. */
export function createLaunchFixture(options: { stdout?: string } = {}): LaunchFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kone-win32-launch-"));
  const binDir = path.join(root, "bin");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(binDir);
  fs.mkdirSync(homeDir);

  const comspec = path.join(root, "cmd-recorder");
  write(comspec, recorderSource(), 0o755);

  const recordFile = path.join(root, "record.jsonl");
  const stdout = options.stdout ?? "0.0.1\n";

  const records = (): string[][] => {
    if (!fs.existsSync(recordFile)) return [];
    return fs
      .readFileSync(recordFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(parseRecord);
  };

  return {
    root,
    binDir,
    homeDir,
    comspec,
    recordFile,
    stdout,
    installNpmSiblings(name: string): void {
      // The batch shim Windows would run. Its content is never read here: the
      // recorder stands in for cmd.exe, so the launch stops at the wrapper.
      write(path.join(binDir, `${name}.cmd`), "@echo off\r\n", 0o644);
      // npm's extensionless sibling, mode 644 — a shell script Windows cannot
      // start, and the reason a plain spawn of the bare name fails.
      write(path.join(binDir, name), "#!/bin/sh\nexit 1\n", 0o644);
      write(path.join(binDir, `${name}.ps1`), "# not launchable\n", 0o644);
    },
    installExecutable(name: string): void {
      write(path.join(binDir, name), recorderSource(), 0o755);
    },
    env({ windows }: { windows: boolean }): NodeJS.ProcessEnv {
      const separator = windows ? ";" : ":";
      return {
        PATH: [binDir, path.dirname(process.execPath)].join(separator),
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
        ComSpec: comspec,
        USERPROFILE: homeDir,
        HOME: homeDir,
        SHELL: "/bin/false",
        CI: "1",
        [RECORD_ENV]: recordFile,
        [STDOUT_ENV]: stdout,
      };
    },
    records,
  };
}

/** What a launch subprocess did: its exit code, its streams, and every argv the
 *  recorder saw. */
export type LaunchRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  records: string[][];
};

/** Run one launch scenario in a subprocess and report what the recorder saw.
 *
 *  `body` is the script's work — importing a real adapter and triggering one
 *  launch — and runs after the optional platform claim. With `windows` set, the
 *  script redefines `process.platform` as "win32" as its first statement, so
 *  the throwaway process (and only it) sees Windows. The subprocess is killed
 *  if it outlives `timeoutMs`, so a wedged scenario fails the assertion instead
 *  of hanging the suite. */
export async function runLaunchScript(input: {
  fixture: LaunchFixture;
  body: string;
  windows: boolean;
  timeoutMs?: number;
}): Promise<LaunchRun> {
  const scriptPath = path.join(input.fixture.root, `scenario-${Date.now()}-${Math.random()}.mjs`);
  const platformClaim = input.windows
    ? 'Object.defineProperty(process, "platform", { value: "win32" });\n'
    : "";
  fs.writeFileSync(scriptPath, `${platformClaim}${input.body}`);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: AGENT_CORE_DIR,
    env: input.fixture.env({ windows: input.windows }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (buf: Buffer) => (stdout += buf.toString()));
  child.stderr.on("data", (buf: Buffer) => (stderr += buf.toString()));

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      stderr += `\n[launch scenario timed out after ${input.timeoutMs ?? 15_000}ms]`;
      child.kill("SIGKILL");
    }, input.timeoutMs ?? 15_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `\n[launch scenario failed to start: ${error.message}]`;
      resolve(null);
    });
  });

  return { code, stdout, stderr, records: input.fixture.records() };
}

/** A stand-in for System32's taskkill on the scenario's PATH: it records the
 *  argv `killTree` sends (so the Windows teardown is observable from outside)
 *  and really kills that pid, so the scenario can exit instead of hanging on
 *  its own child. Returns the record file the caller asserts on.
 *
 *  killTree spawns taskkill by its absolute Windows path
 *  (`C:\Windows\System32\taskkill.exe` for an env without SystemRoot). That
 *  name holds no `/`, so on this host it is a PATH lookup for a file with that
 *  literal name — which is what this writes into `binDir`. A bare `taskkill`
 *  never reaches it, so a regression to the PATH lookup fails the scenario. */
export function installTaskkillRecorder(fixture: LaunchFixture): string {
  const recordFile = `${fixture.recordFile}.taskkill`;
  const recorder = path.join(fixture.root, "taskkill-recorder.js");
  write(
    recorder,
    `const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(argv) + "\\n");
const pid = Number(argv[1]);
if (Number.isInteger(pid) && pid > 0) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
`,
    0o644,
  );
  // A shell wrapper, because bun will not load a script whose own name ends
  // in `.exe`.
  write(
    // Written out rather than taken from `taskkillPath`, so the stand-in cannot
    // follow that function into a regression.
    path.join(fixture.binDir, "C:\\Windows\\System32\\taskkill.exe"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`,
    0o755,
  );
  return recordFile;
}
