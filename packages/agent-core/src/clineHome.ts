import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAgentEnv } from "./processEnv.js";

// Cline install/auth detection. Same "bring your own subscription" stance as
// codexHome/droidHome: kone never runs `cline auth` and never reads a
// credential. Cline keeps its accounts and provider settings under its data
// dir (~/.cline/data), which we only ever probe for *presence*, never open.

export const CLINE_BINARY = "cline";

/** Resolve the executable to spawn from the user's configured override. A blank
 *  path falls back to `cline`. */
export function resolveClineBinary(binaryPath: string | null | undefined): string {
  const configured = binaryPath?.trim();
  return configured || CLINE_BINARY;
}

/** Cline finishes an `authenticate` it can't satisfy from stored credentials by
 *  opening a browser tab (OAuth). A desktop app spawning a browser mid-turn is
 *  never what the user asked for, so every child we start is told there is no
 *  browser to open. */
const CLINE_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const;

/** Env for a long-lived ACP session child. Deliberately *not* `CI=true` — that
 *  flips CLIs into a non-interactive posture that suppresses parts of a real
 *  user turn. Probes get the stricter env below instead. */
export async function buildClineEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv();
  return { ...env, ...CLINE_BROWSERLESS_ENV };
}

/** Env for short, bounded probes (`--version`) — headless and non-interactive
 *  so nothing can block waiting on a human. */
export async function buildClineProbeEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildClineEnv();
  return { ...env, CI: "true", DEBIAN_FRONTEND: "noninteractive" };
}

/** `cline --version` prints bare semver (`3.0.65`). Presence/telemetry only —
 *  never gate behaviour on it; the mode/model surface is read from the live
 *  handshake instead. */
export function parseClineVersion(stdout: string): string | undefined {
  const semver = stdout.match(/\b(\d+\.\d+\.\d+[\w.-]*)\b/)?.[1];
  return semver ?? (stdout.trim().split("\n")[0]?.trim() || undefined);
}

/** Where Cline keeps its per-user data (settings, sessions, logs). Honours
 *  `CLINE_DATA_DIR`, the same override the CLI's `--data-dir` flag mirrors. */
export function clineDataDir(env?: NodeJS.ProcessEnv): string {
  const override = (env ?? process.env).CLINE_DATA_DIR?.trim();
  return override || path.join(os.homedir(), ".cline", "data");
}

/** The file Cline keeps provider accounts in. The `settings` directory alone is
 *  weak evidence — the CLI lays out its whole data tree (logs, db, sessions,
 *  settings) on first run — so this file, checked for existence and size and
 *  never opened, is the signal. // UNVERIFIED (no signed-in account): that the
 *  file is absent on a machine that never signed in; the live probe host
 *  already had one. */
const CLINE_PROVIDER_SETTINGS_FILE = path.join("settings", "providers.json");

/** Cline ships no cheap `status` subcommand, so login is detected structurally
 *  rather than by asking the CLI. Two headless-detectable signals: an exported
 *  `CLINE_API_KEY`, or a non-empty provider-settings file under the data dir.
 *  Presence is the whole signal, which keeps discovery credential-free by
 *  construction. It is a heuristic — a stale file can outlive a revoked
 *  account — so the adapter also treats the CLI's own "Authentication required"
 *  answer to `session/new` as the authoritative not-signed-in verdict. */
export async function detectClineAuth(
  env?: NodeJS.ProcessEnv,
): Promise<{ authenticated: boolean; label?: string }> {
  if ((env ?? process.env).CLINE_API_KEY?.trim()) {
    return { authenticated: true, label: "Cline API Key" };
  }
  try {
    const stat = await fs.stat(path.join(clineDataDir(env), CLINE_PROVIDER_SETTINGS_FILE));
    if (stat.isFile() && stat.size > 0) return { authenticated: true, label: "Cline Login" };
  } catch {
    // No provider settings — not signed in.
  }
  return { authenticated: false };
}
