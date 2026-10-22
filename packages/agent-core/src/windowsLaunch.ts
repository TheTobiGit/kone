import fs from "node:fs";
import path from "node:path";

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { PathHit } from "./processEnv.js";

// What kone may actually start on Windows, and how.
//
// Agent CLIs are spawned by bare name with no shell. On Windows an npm install
// is a `.cmd` shim (`codex.cmd` beside an extensionless `codex` sh script and a
// `codex.ps1`), and Node's `child_process.spawn("codex")` never tries `.cmd`
// (libuv only completes `.com`/`.exe`). Spawning a `.cmd` directly fails with
// EINVAL, because a batch file is text the command interpreter reads, not an
// image CreateProcess can start. So a launch needs two answers the plain spawn
// does not give: which file Windows would start, and — for a batch target —
// the cmd.exe command line that starts it.
//
// `resolveLaunch` is the single place that answers both, for provider sign-in
// (node-pty), the agent spawns and anything else that starts a CLI. Everything
// it does is Windows-only: on any other platform the command and argv pass
// through exactly as they were given.

/** Why a launch could not be resolved: the file is not there, it is there but
 *  Windows cannot start it, or the argv cannot be carried through cmd.exe. */
export type LaunchFailureReason = "missing" | "unlaunchable" | "invalid-argument";

/** A launch that cannot happen, with the sentence that says why. */
export type LaunchFailure = { ok: false; reason: LaunchFailureReason; message: string };

/** What to spawn for a command, on the platform the launch targets. */
export type ResolvedLaunch = {
  ok: true;
  /** What to spawn: the command itself off Windows; the resolved path, or ComSpec for a batch target, on Windows. */
  file: string;
  /** The argv for child_process. For a batch target: ["/d", "/s", "/c", "\"<line>\""]. */
  args: string[];
  /** Present (and true) ONLY for the cmd.exe wrapper: the argv is already
   *  quoted for cmd.exe, so Node must not re-quote it for CreateProcess. */
  windowsVerbatimArguments?: true;
};

/** The environment a launch is resolved against, plus the platform it targets
 *  (injected so the Windows rules can be exercised from any host) and the
 *  directory a configured relative path is resolved against. */
export type LaunchOptions = { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string };

// ── What Windows can start ───────────────────────────────────────────────────

/** What cmd.exe itself tries for a bare command when PATHEXT is unset. */
const DEFAULT_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

/** The extensions Windows will start a command from, in the order it tries
 *  them: PATHEXT from `env`, under any key casing (Windows env keys are
 *  case-insensitive, a JS object's are not — the same reason
 *  `commandInterpreter` below scans for ComSpec), falling back to cmd.exe's
 *  default when it is missing or holds no entry. Empty entries are dropped
 *  (PATHEXT commonly ends in `;`) and a leading dot is added if the user wrote
 *  `EXE`, so callers can append an entry straight to a bare name. This is the
 *  raw list, PATHEXT's unlaunchable suffixes included; a launch wants
 *  `windowsLaunchExtensions` instead. */
export function pathExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
  const extensions = (raw ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  return extensions.length > 0 ? extensions : [...DEFAULT_PATH_EXTENSIONS];
}

/** The suffixes a launch accepts on Windows: a native image (`.exe`, `.com`), or
 *  a batch shim (`.cmd`, `.bat`) that `cmdLaunch` wraps in ComSpec. PATHEXT
 *  usually lists more — `.PS1`, `.VBS`, `.JS` — but those need an interpreter
 *  kone does not supply, so none of them is ever a launch candidate, whatever
 *  the user's PATHEXT says. Compared case-insensitively, the way Windows
 *  compares filenames. */
export const SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"] as const;

/** The PATHEXT order narrowed to what Windows can actually start: the user's
 *  own order among the supported suffixes, so a PATHEXT of `.CMD;.EXE` still
 *  tries the `.cmd` first. A PATHEXT with nothing supported in it (`.PS1` only)
 *  falls back to cmd.exe's default order rather than to no candidates at all —
 *  an unusual PATHEXT is no reason to stop finding `codex.cmd`. This is the
 *  list a launch walks; `pathExtensions` stays the raw PATHEXT. */
export function windowsLaunchExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const supported = pathExtensions(env).filter((extension) =>
    SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS.some((entry) => entry === extension.toLowerCase()),
  );
  return supported.length > 0 ? supported : [...DEFAULT_PATH_EXTENSIONS];
}

/** Whether `name` already ends in a suffix Windows can start, so it is used
 *  as-is instead of completed. Deliberately not "is in PATHEXT": a configured
 *  `codex.exe` works under any PATHEXT, and a `.ps1` that PATHEXT happens to
 *  list is still not a program. A dotted name with no supported suffix
 *  (`foo.bar`) is completed like a bare one. */
export function hasWindowsLaunchExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** A directory's entries keyed by their lowercased name — the way Windows
 *  itself compares filenames, and the reason a supported suffix finds
 *  `codex.EXE` from the lowercased completion guess (the tests inject a win32
 *  platform from Linux). An unreadable directory holds nothing, so it yields
 *  nothing. */
function entriesByName(dir: string): Map<string, string> {
  try {
    return new Map(fs.readdirSync(dir).map((entry) => [entry.toLowerCase(), entry]));
  } catch {
    return new Map();
  }
}

/** Find the file Windows would start for `name` in ONE directory: the name
 *  itself when it already ends in a supported suffix, otherwise the first
 *  existing supported completion in PATHEXT order (`codex.cmd` for npm's
 *  `codex`+`codex.cmd`+`codex.ps1` sibling set — the `.ps1` is skipped even
 *  when PATHEXT lists it, because there is no interpreter to run it). Null when
 *  the directory has no launchable match. This is the rule for both a bare name
 *  on PATH and an explicit configured path's own directory, so both ask the
 *  same question here. */
export function findWindowsLaunchableIn(
  dir: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): PathHit | null {
  const names = hasWindowsLaunchExtension(name)
    ? [name]
    : windowsLaunchExtensions(env).map((extension) => `${name}${extension}`);
  const entries = entriesByName(dir);
  for (const candidateName of names) {
    const entry = entries.get(candidateName.toLowerCase());
    if (!entry) continue;
    const candidate = path.join(dir, entry);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    try {
      return { found: candidate, real: fs.realpathSync(candidate), dir };
    } catch {
      return { found: candidate, real: candidate, dir };
    }
  }
  return null;
}

/** The PATH entries a Windows launch searches, in order. Windows env keys are
 *  case-insensitive while a JS object's are not, and a spread `process.env` on
 *  Windows usually carries `Path` — so the PATH key is read under any casing,
 *  with an exact `PATH` preferred when the caller supplied both. Empty entries
 *  (a trailing `;` is common) are dropped. */
function windowsPathEntries(env: NodeJS.ProcessEnv): string[] {
  const value = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
  return (value ?? "").split(";").filter(Boolean);
}

/** Find a bare name among the files Windows can actually START. For each PATH
 *  directory, in order, it tries `findWindowsLaunchableIn`: a name that already
 *  ends in a supported suffix (`.exe`, `.com`, `.cmd`, `.bat`) is tried as-is,
 *  whatever PATHEXT says, and any other name is completed through the supported
 *  entries of PATHEXT.
 *
 *  This is deliberately not `findOnPathEntry`: that one accepts the bare name
 *  and only knows `.exe`/`.cmd`/`.bat`, so on Windows it prefers npm's
 *  extensionless `codex` sh script — which sits beside `codex.cmd` and
 *  `codex.ps1` in `node_modules\.bin` and in `%APPDATA%\npm` — over the `.cmd`.
 *  An extensionless script is not something CreateProcess can launch, and
 *  neither is a `.ps1` (no interpreter is spawned for it, even when PATHEXT
 *  lists it), so neither is ever returned here. Callers that only need "where
 *  does this install live" keep using `findOnPathEntry`; callers that are about
 *  to spawn need this. */
export function findWindowsLaunchableOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): PathHit | null {
  for (const dir of windowsPathEntries(env)) {
    const hit = findWindowsLaunchableIn(dir, binary, env);
    if (hit) return hit;
  }
  return null;
}

// ── The cmd.exe command line ─────────────────────────────────────────────────
// A resolved `.cmd`/`.bat` is replaced by the command interpreter, with the
// script as the first word of a single command line. The escaping below is
// cross-spawn's (lib/util/escape.js), which exists for exactly this case; Node
// documents the same requirement ("Spawning .bat and .cmd files on Windows").

/** What cmd.exe treats specially outside quotes. `^` is in the set, so the
 *  second escaping pass for batch targets also escapes the first pass's
 *  carets — that is intended, not double work (see `escapeCmdArgument`). */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** One argument as cmd.exe should see it, following cross-spawn's algorithm
 *  (itself based on https://qntm.org/cmd):
 *
 *  1. Backslashes before an embedded `"` are doubled and the quote escaped,
 *     and trailing backslashes are doubled — otherwise the closing quote we
 *     add next would be escaped by them.
 *  2. The whole argument is wrapped in quotes, so spaces and `&`/`|`/`;` stay
 *     one word.
 *  3. Every metacharacter is caret-escaped. `doubleEscapeMetaChars` does it a
 *     second time for a `.cmd`/`.bat` target: cmd.exe reads the line once, and
 *     the batch file's own re-parse (which the shim does when it forwards to
 *     node) would otherwise consume the carets. cross-spawn only does this for
 *     `node_modules\.bin\*.cmd`, but a global npm shim (`%APPDATA%\npm\codex.cmd`)
 *     forwards `%*` the same way, so every batch target here gets it. */
export function escapeCmdArgument(argument: string, doubleEscapeMetaChars = false): string {
  let escaped = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_CHARS, "^$1");
  return escaped;
}

/** The script path in command position. cross-spawn escapes metacharacters
 *  (spaces included) but adds no quotes: the `/d /s /c "…"` wrapper already
 *  delimits the line, and quotes here would nest inside that. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/** The command interpreter to run a batch shim: `ComSpec` under any casing
 *  (`ComSpec`, `COMSPEC`, `comspec` — Windows env keys are case-insensitive, a
 *  JS object is not), else the conventional `cmd.exe` on PATH. */
function commandInterpreter(env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "comspec" && value) return value;
  }
  return "cmd.exe";
}

/** What to spawn for a resolved Windows path: a `.cmd`/`.bat` target goes
 *  through cmd.exe; a native `.exe`/`.com` is spawned directly with its argv.
 *
 *  The batch case returns the ARRAY argv `["/d", "/s", "/c", "\"<line>\""]`
 *  plus `windowsVerbatimArguments: true` — exactly what cross-spawn does, so
 *  Node passes the line through without re-quoting it for CommandLineToArgvW
 *  (which would escape the quotes we built and strip the carets cmd.exe has to
 *  see). The interpreter flags:
 *    • `/d` — skip AutoRun commands, so the user's registry can't inject a
 *      command ahead of the launch.
 *    • `/s` — take the command line verbatim, stripping only the outer pair of
 *      quotes (hence the extra wrapping quotes around the whole line).
 *    • `/c` — run it and exit.
 *
 *  An argument containing `\r` or `\n` cannot be carried through cmd.exe: the
 *  line ends there and cmd.exe silently drops the rest. That is refused rather
 *  than launched truncated. */
function cmdLaunch(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedLaunch | LaunchFailure {
  if (!/\.(?:cmd|bat)$/i.test(file)) return { ok: true, file, args: [...args] };
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    return {
      ok: false,
      reason: "invalid-argument",
      message: `${file} is a batch file, and cmd.exe cannot pass an argument that spans lines.`,
    };
  }
  const commandLine = [
    escapeCmdCommand(file),
    ...args.map((arg) => escapeCmdArgument(arg, true)),
  ].join(" ");
  return {
    file: commandInterpreter(env),
    ok: true,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

// ── Finding what to launch ───────────────────────────────────────────────────

/** The suffixes a Windows launch accepts, as a message spells them out:
 *  ".exe, .com, .cmd or .bat". */
function expectedWindowsLaunchSuffixes(): string {
  const extensions = SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS;
  return `${extensions.slice(0, -1).join(", ")} or ${extensions[extensions.length - 1]}`;
}

/** The sentence for "this exists, but not as a program Windows can start". The
 *  expected list is the fixed set kone can start, not the user's PATHEXT: a
 *  `.ps1` the user's PATHEXT happens to list is still not launchable, so
 *  quoting PATHEXT back at them would be a lie. */
function notLaunchableOnWindows(file: string): string {
  return `${file} isn't something Windows can run (expected ${expectedWindowsLaunchSuffixes()}).`;
}

/** The same for a bare name found on PATH: naming where it was found saves the
 *  user a `where codex` to work out which install the message is about. */
function notLaunchableOnPathOnWindows(file: string, found: string): string {
  return `${file} was found on your PATH at ${found}, but it isn't something Windows can run (expected ${expectedWindowsLaunchSuffixes()}).`;
}

/** The first PATH entry that answers to `file`'s name but is not launchable —
 *  the extensionless sh script npm's cmd-shim writes, or its `.ps1` sibling.
 *  Only consulted when the launchable lookup already failed, so the directory
 *  read costs nothing until a launch is refused; it exists purely to turn
 *  "isn't on your PATH" into the truth ("it's there, Windows just can't run
 *  it"). Entries are sorted so the sentence names the same file every time. */
function findUnlaunchableOnWindowsPath(file: string, env: NodeJS.ProcessEnv): string | null {
  const stem = path.basename(file).toLowerCase();
  for (const dir of windowsPathEntries(env)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      // `codex` itself, or a sibling sharing its stem (`codex.ps1`).
      if (lower !== stem && !lower.startsWith(`${stem}.`)) continue;
      const candidate = path.join(dir, entry);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/** A configured path on Windows. A name that already ends in a supported
 *  suffix (`.exe`, `.com`, `.cmd`, `.bat`) is used exactly as configured,
 *  whatever PATHEXT says — that is the Program Files case, where an explicit
 *  `codex.exe` must not depend on the user's PATHEXT listing `.EXE` again.
 *  Anything else — extensionless, a dotted name, or an unsupported suffix like
 *  `.ps1` — gets what cmd.exe gives a bare command: each supported PATHEXT
 *  extension appended in order, first existing file winning. That is how a user
 *  who pointed kone at npm's `codex` still signs in: the runnable `codex.cmd`
 *  beside it is what can be started. The file is never launched as configured
 *  when Windows cannot start it. A relative path is resolved against `cwd`
 *  (the caller's launch directory), falling back to the process's. */
function locateConfiguredOnWindows(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { ok: true; found: string } | LaunchFailure {
  const resolved = path.resolve(cwd ?? process.cwd(), file);
  const hit = findWindowsLaunchableIn(path.dirname(resolved), path.basename(resolved), env);
  if (hit) return { ok: true, found: hit.found };
  // The configured file is there even though nothing launchable is: saying
  // "doesn't exist" would send the user looking for a missing install.
  if (fs.existsSync(resolved)) {
    return { ok: false, reason: "unlaunchable", message: notLaunchableOnWindows(file) };
  }
  return { ok: false, reason: "missing", message: `${file} doesn't exist.` };
}

/** Windows resolution, where "found" is not the same as "can be started". A
 *  bare name is looked up only among launchable suffixes
 *  (`findWindowsLaunchableOnPath` — never the extensionless npm sh script); a
 *  configured path may be extensionless, or carry a suffix Windows cannot run,
 *  and is then completed through the supported PATHEXT entries. Anything that
 *  exists but is not launchable is a sentence, never a spawn: CreateProcess
 *  would fail and the user would see a terminal error instead of the reason.
 *
 *  A name with a path separator is a configured path (its leading separators
 *  are all it takes — one check for `/`, one for `\`); anything else is a bare
 *  name to look up on PATH. `findWindowsLaunchableIn` already insists on a
 *  regular file, so a hit needs no further check: win32 has no executable bit. */
function locateOnWindows(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { ok: true; found: string } | LaunchFailure {
  if (file.includes("/") || file.includes("\\")) return locateConfiguredOnWindows(file, env, cwd);
  const hit = findWindowsLaunchableOnPath(file, env);
  if (!hit) {
    const unlaunchable = findUnlaunchableOnWindowsPath(file, env);
    if (unlaunchable) {
      return {
        ok: false,
        reason: "unlaunchable",
        message: notLaunchableOnPathOnWindows(file, unlaunchable),
      };
    }
    return { ok: false, reason: "missing", message: `${file} isn't on your PATH.` };
  }
  return { ok: true, found: hit.found };
}

// ── The launch itself ────────────────────────────────────────────────────────

/** Resolve what to spawn for `command` + `args` on the target platform.
 *
 *  Off Windows this is a passthrough: no filesystem access, no wrapping, the
 *  command and argv exactly as given, and no extra keys on the result.
 *
 *  On Windows a bare name is resolved among the suffixes Windows can start
 *  (`findWindowsLaunchableOnPath`) and a name carrying a path separator is a
 *  configured path (completed in its own directory). A `.cmd`/`.bat` target is
 *  then wrapped in ComSpec; a native image is spawned directly. A name that
 *  exists but cannot be started, or an argv cmd.exe cannot carry, is a
 *  `LaunchFailure` with a sentence rather than a spawn that fails later. */
export function resolveLaunch(
  command: string,
  args: readonly string[],
  options: LaunchOptions,
): ResolvedLaunch | LaunchFailure {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { ok: true, file: command, args: [...args] };
  const located = locateOnWindows(command, options.env, options.cwd);
  if (!located.ok) return located;
  return cmdLaunch(located.found, args, options.env);
}

/** The failure as the Error a failed child_process spawn would have raised, so
 *  callers keep one error path: `ENOENT` for a file that is not there, `EINVAL`
 *  for a file that cannot be started or an argv cmd.exe cannot carry. `path` is
 *  the requested command, as Node sets it. */
export function launchFailureError(command: string, failure: LaunchFailure): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(failure.message);
  error.code = failure.reason === "missing" ? "ENOENT" : "EINVAL";
  error.path = command;
  return error;
}

/** `options` plus `windowsVerbatimArguments: true` when the launch needs it;
 *  returns the SAME keys as `options` otherwise (no undefined key added), so a
 *  non-Windows launch is indistinguishable from the caller's own options. */
export function withLaunchOptions<T extends object>(
  options: T,
  launch: ResolvedLaunch,
): T & { windowsVerbatimArguments?: boolean } {
  if (!launch.windowsVerbatimArguments) return options;
  return { ...options, windowsVerbatimArguments: true };
}

/** The argv as node-pty wants it: the batch wrapper's args as ONE pre-built
 *  string (`/d /s /c "<line>"`, i.e. `args.join(" ")`), anything else the array
 *  unchanged. node-pty's Windows path appends a string to the command line
 *  untouched, but re-quotes an argv ARRAY for CommandLineToArgvW, which escapes
 *  the quotes we built and would strip the carets cmd.exe has to see. */
export function ptyArgs(launch: ResolvedLaunch): string[] | string {
  return launch.windowsVerbatimArguments ? launch.args.join(" ") : launch.args;
}

// ── Spawning what was resolved ───────────────────────────────────────────────

/** What a launch needs from the machine it runs on: the platform to resolve for
 *  (injected so the Windows rules can be exercised from any host) and the spawn
 *  to call (injected so a test can assert the exact launch). Both default to
 *  the real thing. */
export type LaunchDeps = {
  platform?: NodeJS.Platform;
  spawn?: typeof import("node:child_process").spawn;
};

/** The options a launch is spawned with: child_process's own, with the env
 *  every agent child needs made explicit because the resolution reads its PATH
 *  and PATHEXT, and `cwd` narrowed to a path — that is also the directory a
 *  configured relative path is resolved against, and the resolution has no use
 *  for the `URL` form SpawnOptions also accepts. */
export type SpawnLaunchOptions = Omit<SpawnOptions, "cwd"> & {
  cwd?: string;
  env: NodeJS.ProcessEnv;
};

/** A launch that started, or the Error a failed spawn would have raised. The
 *  child keeps the caller's own `ChildProcess` subtype (a transport that pipes
 *  all three stdio ends asks for `ChildProcessWithoutNullStreams`), which Node's
 *  spawn signature cannot correlate to `options`. */
export type SpawnLaunchResult<T extends ChildProcess = ChildProcess> =
  | { ok: true; child: T }
  | { ok: false; error: NodeJS.ErrnoException };

/** Resolve a launch and start it — the one place the shared spawn helpers
 *  (spawn.ts's streaming run and probe, jsonRpc.ts's transport) go through, so
 *  none of them repeats the resolve / wrap / fail dance.
 *
 *  Off Windows this is the caller's own spawn call: `resolveLaunch` hands back
 *  the command and argv untouched and `withLaunchOptions` the very same options
 *  object, so nothing about a launch on another platform changes — not even an
 *  added key.
 *
 *  A launch that cannot happen is RETURNED, never thrown: the helpers turn it
 *  into the same result a child's `error` event would have produced, which is
 *  the failure shape every adapter already handles. `options.cwd` is also the
 *  directory a configured relative path is resolved against, matching where the
 *  child itself would run. */
export function spawnLaunch<T extends ChildProcess = ChildProcess>(
  command: string,
  args: readonly string[],
  options: SpawnLaunchOptions,
  deps: LaunchDeps = {},
): SpawnLaunchResult<T> {
  const launch = resolveLaunch(command, args, {
    env: options.env,
    platform: deps.platform ?? process.platform,
    cwd: options.cwd,
  });
  if (!launch.ok) return { ok: false, error: launchFailureError(command, launch) };
  const spawnChild = deps.spawn ?? spawn;
  // SAFETY: T is the child shape the caller configured through `options` — the
  // stdio ends it piped are the ones it typed as non-null. Node's spawn
  // signature does not carry that correlation, so the caller declares it.
  return {
    ok: true,
    child: spawnChild(launch.file, launch.args, withLaunchOptions(options, launch)) as T,
  };
}
