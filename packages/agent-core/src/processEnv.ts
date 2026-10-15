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
