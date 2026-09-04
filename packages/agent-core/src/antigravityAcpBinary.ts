import fs from "node:fs";
import path from "node:path";

// Locates the Antigravity ACP server executable + its harness helper.
//
// Resolution order: an explicit binary path the user configured wins, then the
// managed runtime kone downloaded, then a bare name on PATH. Anything
// unresolved is a normal null — the adapter treats it as "no ACP transport"
// and falls back to print mode — never an error thrown at discovery.

export type AntigravityAcpBinarySource = "override" | "managed" | "path";

export type AntigravityAcpResolvedBinary = {
  readonly executablePath: string;
  readonly harnessPath: string;
  readonly source: AntigravityAcpBinarySource;
};

/** Harness filename per platform — it always ships beside the executable. */
export function antigravityHarnessFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "localharness_external.exe" : "localharness_external";
}

/** The managed runtime root for one host: `<userDataDir>/tools/antigravity-acp/`. */
export function resolveAntigravityAcpManagedRoot(userDataDir: string): string {
  return path.join(userDataDir, "tools", "antigravity-acp");
}

/** The versioned install dir inside the managed root, e.g. `darwin-arm64`. */
export function resolveAntigravityAcpManagedDir(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const normalizedArch = arch === "arm64" ? "arm64" : arch === "x64" || arch === "x86_64" ? "x64" : arch;
  return path.join(resolveAntigravityAcpManagedRoot(userDataDir), `${platform}-${normalizedArch}`);
}

type ActiveRecord = {
  readonly version: string;
  readonly executable: string;
  readonly harness: string;
};

/** Read `active.json` from a managed dir: the atomic pointer the installer
 *  flips once a version's files are verified on disk. Null when no version is
 *  installed or the record is malformed — both mean "no managed runtime". */
export function readAntigravityAcpActiveRecord(managedDir: string): ActiveRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(managedDir, "active.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields unknown; every field below is validated before use.
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!(parsed instanceof Object) || Array.isArray(parsed)) return null;
  // SAFETY: parsed is verified as a non-array Object record.
  const record = parsed as { version?: unknown; executable?: unknown; harness?: unknown };
  const version = record.version;
  const executable = record.executable;
  const harness = record.harness;
  if (
    version === null ||
    version === undefined ||
    version instanceof Object ||
    executable === null ||
    executable === undefined ||
    executable instanceof Object ||
    harness === null ||
    harness === undefined ||
    harness instanceof Object
  ) {
    return null;
  }
  const versionText = String(version).trim();
  const executableText = String(executable).trim();
  const harnessText = String(harness).trim();
  if (!versionText || !executableText || !harnessText) return null;
  return { version: versionText, executable: executableText, harness: harnessText };
}

function hasSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function candidateNames(binary: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [binary];
  if (/\.(exe|cmd|bat)$/i.test(binary)) return [binary];
  return [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`];
}

/** Find a bare binary name across PATH, resolving symlinks to the real file. */
export function findOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(separator).filter(Boolean)) {
    for (const name of candidateNames(binary, platform)) {
      const candidate = path.join(dir, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

/** Default executable names to probe on PATH when nothing else resolved. The
 *  ACP server is not normally on PATH — this is a last resort before
 *  print-mode fallback, not a primary source. */
const DEFAULT_PATH_NAMES = ["agy_acp_server.par", "agy_acp_server", "agy_acp_server.exe"];

/** Resolve the ACP server to spawn. Returns null when no transport is
 *  available — the caller falls back to print mode. */
export function resolveAntigravityAcpBinary(input: {
  userDataDir: string;
  /** The user's configured override: an absolute path or a bare name on PATH. */
  binaryPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}): AntigravityAcpResolvedBinary | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const override = input.binaryPath?.trim();

  // 1. The user's explicit override — an absolute path is taken as given, a
  //    bare name is looked up on PATH. The harness always rides beside it.
  if (override) {
    if (hasSeparator(override)) {
      const executablePath = path.resolve(override);
      if (!fs.existsSync(executablePath)) return null;
      return {
        executablePath,
        harnessPath: path.join(path.dirname(executablePath), antigravityHarnessFileName(platform)),
        source: "override",
      };
    }
    const found = findOnPath(override, env, platform);
    if (!found) return null;
    return {
      executablePath: found,
      harnessPath: path.join(path.dirname(found), antigravityHarnessFileName(platform)),
      source: "override",
    };
  }

  // 2. The managed runtime kone installed itself.
  const managedDir = resolveAntigravityAcpManagedDir(input.userDataDir, platform, input.arch);
  const active = readAntigravityAcpActiveRecord(managedDir);
  if (active) {
    const executablePath = path.join(managedDir, active.executable);
    const harnessPath = path.join(managedDir, active.harness);
    if (fs.existsSync(executablePath) && fs.existsSync(harnessPath)) {
      return { executablePath, harnessPath, source: "managed" };
    }
  }

  // 3. A last-resort PATH probe for a manually installed server.
  for (const name of DEFAULT_PATH_NAMES) {
    const found = findOnPath(name, env, platform);
    if (!found) continue;
    return {
      executablePath: found,
      harnessPath: path.join(path.dirname(found), antigravityHarnessFileName(platform)),
      source: "path",
    };
  }
  return null;
}
