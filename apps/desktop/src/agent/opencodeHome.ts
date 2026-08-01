import { spawn } from "node:child_process";

import { buildAgentEnv } from "./processEnv.js";
import type { ProviderStatus } from "./types.js";

export const OPENCODE_BINARY = "opencode";
export const MINIMUM_OPENCODE_VERSION = "1.14.19";

export function parseOpenCodeVersion(stdout: string): string | undefined {
  return stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
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

export function classifyOpenCodeSpawnFailure(error: unknown): ProviderStatus {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("enoent") || lower.includes("notfound")) {
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

export async function probeOpenCodeVersion(): Promise<{ version?: string; error?: unknown }> {
  const env = await buildOpenCodeEnv();
  return new Promise((resolve) => {
    const child = spawn(OPENCODE_BINARY, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once("error", (error) => resolve({ error }));
    child.once("close", () => resolve({ version: parseOpenCodeVersion(stdout) }));
  });
}

export function isOpenCodeVersionSupported(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, MINIMUM_OPENCODE_VERSION) >= 0;
}
