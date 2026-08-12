import os from "node:os";
import path from "node:path";

import { buildAgentEnv } from "./processEnv.js";

// Antigravity CLI install/auth detection. Same "bring your own subscription"
// stance as codexHome/droidHome: kone never runs an `agy` login and never reads
// a credential — Antigravity keeps its session in its own store under
// ~/.gemini/antigravity-cli, which discovery only ever asks the CLI about
// ground truth). Auth/install facts were verified against the live CLI.

export const ANTGRAVITY_BINARY = "agy";

/** Resolve the executable to spawn from the user's configured override. A blank
 *  path falls back to `agy`. */
export function resolveAntigravityBinary(binaryPath: string | null | undefined): string {
  return binaryPath?.trim() || ANTGRAVITY_BINARY;
}

/** Env for a long-lived print-mode turn child: the agent env plus the two
 *  capture-hook variables the installed plugin's shell wrapper keys off. */
export async function buildAntigravityEnv(
  eventFile: string,
  base?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv(base);
  return {
    ...env,
    KONE_ANTIGRAVITY_EVENTS: eventFile,
    KONE_ANTIGRAVITY_HOOK_DECISION: "allow",
  };
}

/** Env for short, bounded probes (`--version` / `models`) — headless and
 *  non-interactive so nothing can block waiting on a human. */
export async function buildAntigravityProbeEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv();
  return { ...env, CI: "true", DEBIAN_FRONTEND: "noninteractive" };
}

/** `agy --version` prints a bare semver line. Treated as presence/telemetry
 *  only — model/effort behavior is discovered from `agy models`, never gated
 *  on a version (the CLI owns its update channel). */
export function parseAntigravityVersion(stdout: string): string | undefined {
  const semver = stdout.match(/\b(\d+\.\d+\.\d+[\w.-]*)\b/)?.[1];
  return semver ?? (stdout.trim().split("\n")[0]?.trim() || undefined);
}

/** Where Antigravity keeps its per-user state (auth store, plugins, brain
 *  transcripts). */
export function antigravityHomeDir(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/** The kone capture plugin's install dir — a global (secret-free) plugin every
 *  `agy` session loads. The hooks stream capture events to a per-turn file;
 *  the mcp_config.json hands the agent the kone gateway via the stdio proxy. */
export function koneCapturePluginDir(): string {
  return path.join(antigravityHomeDir(), "plugins", "kone-capture");
}

/** Where the CLI writes one conversation's transcript — the turn-rendering
export function antigravityTranscriptPath(conversationId: string): string {
  return path.join(
    antigravityHomeDir(),
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}
