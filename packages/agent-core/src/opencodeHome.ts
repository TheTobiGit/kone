import { buildAgentEnv } from "./processEnv.js";
import type { ProviderStatus } from "./types.js";
import { spawnLaunch, type LaunchDeps } from "./windowsLaunch.js";

export const OPENCODE_BINARY = "opencode";
export const MINIMUM_OPENCODE_VERSION = "1.14.19";

export function parseOpenCodeVersion(stdout: string): string | undefined {
  // v2 prints `opencode v2.0.12` (no word boundary between `v` and the digit,
  // so `\b` would miss it); v1 prints a bare `1.14.19`. Match digits directly.
  return stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
}

export async function buildOpenCodeEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv();
  return { ...env, OPENCODE_CONFIG_CONTENT: "{}" };
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

export function classifyOpenCodeSpawnFailure(cause: unknown): ProviderStatus {
  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();
  // A launch that could not resolve at all (windowsLaunch.ts) carries the
  // missing-ness in its `code` rather than in a "spawn opencode ENOENT"
  // message, so both are read: the same failure still means "not installed".
  // SAFETY: a spawn failure — the child's "error" or the launch seam's
  // stand-in for it — is Node's ErrnoException; the `code` string is all this
  // reads.
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || lower.includes("enoent") || lower.includes("notfound")) {
    return { provider: "opencode", label: "OpenCode", available: false, authStatus: "unknown", readiness: "not-installed", message: "OpenCode CLI (`opencode`) is not installed or not on PATH." };
  }
  if (lower.includes("quarantine")) {
    return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", message: "macOS is blocking the OpenCode binary. Run `xattr -d com.apple.quarantine $(which opencode)` to fix this." };
  }
  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", message: "The OpenCode binary may be corrupted. Try reinstalling OpenCode." };
  }
  return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", message: "OpenCode could not be started." };
}

/** Read the CLI's version by running `opencode --version`. Resolves `{ error }`
 *  for anything that stops the command from running — a launch the shared seam
 *  cannot resolve (not on PATH on Windows, a shim it cannot start) surfaces the
 *  same way a child's "error" event does, with the ENOENT code marking
 *  "nothing there to run". `launch` injects the platform and spawn the launch
 *  is resolved for/with (see windowsLaunch.ts's `spawnLaunch`); production
 *  leaves it out. */
export async function probeOpenCodeVersion(
  launch?: LaunchDeps,
): Promise<{ version?: string; error?: unknown }> {
  const env = await buildOpenCodeEnv();
  return new Promise((resolve) => {
    const launched = spawnLaunch(
      OPENCODE_BINARY,
      ["--version"],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      launch,
    );
    if (!launched.ok) {
      // The failure a child's "error" event would have reported, without a
      // child: the caller classifies it exactly like a spawn error.
      resolve({ error: launched.error });
      return;
    }
    const child = launched.child;
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once("error", (error) => resolve({ error }));
    child.once("close", () => resolve({ version: parseOpenCodeVersion(stdout) }));
  });
}

export function isOpenCodeVersionSupported(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, MINIMUM_OPENCODE_VERSION) >= 0;
}

/** True for OpenCode v2+ (`2.x.x`). v2 removed `models --verbose`, changed
 *  `serve` output to `server listening on ...` + `server password ...`, moved
 *  HTTP routes under `/api/*` with Basic auth, and emits `{id,type,data}`
 *  SSE events. Only the model-inventory probes key off it; a running server's
 *  protocol is read from its own listening line (opencodeServer.ts). */
export function isOpenCodeV2(version: string | undefined): boolean {
  if (!version) return false;
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) && major >= 2;
}
