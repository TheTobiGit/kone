import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Environment for spawned agent CLIs. The rule (kone's "bring your own
// subscription" stance): inherit the user's environment and let each CLI read
// its own on-disk login — never inject or fabricate provider credentials here.
//
// The one real problem we must solve is PATH. When kone is launched from the
// Dock/Finder (not a terminal), Electron inherits a minimal PATH that omits
// ~/.local/bin, ~/.bun/bin, etc. — exactly where agent CLIs install. So on

const execFileAsync = promisify(execFile);

let cachedPath: string | null = null;

/** The login shell's PATH, recovered once and cached. Returns null on Windows
 *  or if the probe fails (we then keep the inherited PATH). */
async function loginShellPath(): Promise<string | null> {
  if (process.platform === "win32") return null;
  if (cachedPath !== null) return cachedPath;

  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // A login+interactive shell so it sources the user's profile (where PATH is
    // extended). Print a sentinel-wrapped PATH so we can parse it cleanly.
    const { stdout } = await execFileAsync(
      shell,
      ["-lic", "printf '__KONE_PATH__%s__KONE_END__' \"$PATH\""],
      { timeout: 5_000, windowsHide: true },
    );
    const match = stdout.match(/__KONE_PATH__(.*)__KONE_END__/s);
    cachedPath = match?.[1]?.trim() ?? "";
    return cachedPath;
  } catch {
    cachedPath = "";
    return cachedPath;
  }
}

/** Known per-user install dirs for agent CLIs on Windows. When kone is
 *  launched from Explorer (not a terminal), the inherited PATH omits these —
 *  exactly where native-installed providers (codex, cursor, droid, opencode)
 *  `.bun\bin` for bun-installed tools, `scoop\shims` for Scoop-managed
 *  binaries. */
export function windowsCliDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.USERPROFILE;
  if (!profile) return [];
  return [`${profile}\\.local\\bin`, `${profile}\\.bun\\bin`, `${profile}\\scoop\\shims`];
}

/** The inherited env with the known Windows CLI dirs appended to PATH (existing
 *  entries win; deduped). PATH is `;`-separated on Windows. */
export function mergeWindowsPath(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const seen = new Set((env.PATH ?? "").split(";").filter(Boolean));
  const merged = [...seen];
  for (const dir of windowsCliDirs(env)) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  env.PATH = merged.join(";");
  return env;
}

/** Build the environment for an agent subprocess: the inherited env with the
 *  login-shell PATH merged in (recovered entries appended so an explicit
 *  process PATH still wins for anything it already resolves). On Windows the
 *  merge is the known install dirs instead of a shell probe. */
export async function buildAgentEnv(
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return mergeWindowsPath(base);
  const env: NodeJS.ProcessEnv = { ...base };
  const shellPath = await loginShellPath();
  if (shellPath) {
    const seen = new Set((env.PATH ?? "").split(":").filter(Boolean));
    const merged = [...seen];
    for (const dir of shellPath.split(":")) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        merged.push(dir);
      }
    }
    // Common install dirs, in case the shell probe missed them.
    for (const dir of [`${os.homedir()}/.local/bin`, `${os.homedir()}/.bun/bin`]) {
      if (!seen.has(dir)) {
        seen.add(dir);
        merged.push(dir);
      }
    }
    env.PATH = merged.join(":");
  }
  return env;
}

// ── PATH lookup ──────────────────────────────────────────────────────────────

/** Candidate filenames for one PATH entry: the bare name, plus the extensions
 *  a Windows shell would try. A name that already carries one of those
 *  extensions is used as-is. */
function candidateNames(binary: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [binary];
  if (/\.(exe|cmd|bat)$/i.test(binary)) return [binary];
  return [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`];
}

/** A PATH hit: the entry as it sits on PATH, what it resolves to, and the
 *  directory it was found in. The three differ for a shim symlinked into a
 *  versioned install (`found` is the shim, `real` its target, `dir` where the
 *  shell picks it up), and callers that identify the install channel need all
 *  three. */
export type PathHit = { found: string; real: string; dir: string };

/** What cmd.exe itself tries for a bare command when PATHEXT is unset. */
const DEFAULT_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

/** The extensions Windows will start a command from, in the order it tries
 *  them: PATHEXT from `env`, under any key casing (Windows env keys are
 *  case-insensitive, a JS object's are not — the same reason
 *  `commandInterpreter` in providerSignIn scans for ComSpec), falling back to
 *  cmd.exe's default when it is missing or holds no entry. Empty entries are
 *  dropped (PATHEXT commonly ends in `;`) and a leading dot is added if the user
 *  wrote `EXE`, so callers can append an entry straight to a bare name. This is
 *  the raw list, PATHEXT's unlaunchable suffixes included; a launch wants
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

/** The suffixes node-pty can actually start on Windows: a native image
 *  (`.exe`, `.com`), or a batch shim (`.cmd`, `.bat`) that `cmdLaunch` wraps in
 *  ComSpec. PATHEXT usually lists more — `.PS1`, `.VBS`, `.JS` — but those need
 *  an interpreter kone does not supply, so none of them is ever a launch
 *  candidate, whatever the user's PATHEXT says. Compared case-insensitively,
 *  the way Windows compares filenames. */
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
function hasWindowsLaunchExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** A directory's entries keyed by their lowercased name — the way Windows
 *  itself compares filenames, and the reason a supported suffix finds
 *  `codex.EXE` from the lowercased completion guess (the tests injected a win32
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
  for (const dir of (env.PATH ?? "").split(";").filter(Boolean)) {
    const hit = findWindowsLaunchableIn(dir, binary, env);
    if (hit) return hit;
  }
  return null;
}

/** Find a bare binary name across PATH, keeping both the entry and its target.
 *  Returns null when nothing on PATH matches. */
export function findOnPathEntry(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PathHit | null {
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(separator).filter(Boolean)) {
    for (const name of candidateNames(binary, platform)) {
      const candidate = path.join(dir, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        return { found: candidate, real: fs.realpathSync(candidate), dir };
      } catch {
        // A dangling symlink still tells us where the install was meant to be.
        return { found: candidate, real: candidate, dir };
      }
    }
  }
  return null;
}

/** Find a bare binary name across PATH, resolving symlinks to the real file.
 *  Returns null when nothing on PATH matches. */
export function findOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return findOnPathEntry(binary, env, platform)?.real ?? null;
}
