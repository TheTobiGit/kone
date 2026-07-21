import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

// Environment for spawned agent CLIs. The rule (kone's "bring your own
// subscription" stance): inherit the user's environment and let each CLI read
// its own on-disk login — never inject or fabricate provider credentials here.
//
// The one real problem we must solve is PATH. When kone is launched from the
// Dock/Finder (not a terminal), Electron inherits a minimal PATH that omits
// ~/.local/bin, ~/.bun/bin, etc. — exactly where agent CLIs install. So on
// macOS/Linux we recover the login shell's PATH once and merge it in.

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

/** Build the environment for an agent subprocess: the inherited env with the
 *  login-shell PATH merged in (recovered entries appended so an explicit
 *  process PATH still wins for anything it already resolves). */
export async function buildAgentEnv(
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
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
