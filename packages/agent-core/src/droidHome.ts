import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAgentEnv } from "./processEnv.js";

// Factory Droid install/auth detection. Same "bring your own subscription"
// stance as codexHome/cursorHome: kone never runs a droid login and never reads
// a credential — Factory keeps its session under ~/.factory, which we only ever
// probe for *presence*, never open.

export const DROID_BINARY = "droid";

/** `factory` is Factory's brand, not its binary, and it's what users reach for
 *  when asked to point kone at an install. Map both onto the real executable. */
const AMBIGUOUS_DROID_BINARIES = new Set(["factory", "factory-cli"]);

/** Resolve the executable to spawn from the user's configured override. A blank
 *  path — or one of the ambiguous names above — falls back to `droid`. */
export function resolveDroidBinary(binaryPath: string | null | undefined): string {
  const configured = binaryPath?.trim();
  if (!configured) return DROID_BINARY;
  return AMBIGUOUS_DROID_BINARIES.has(configured) ? DROID_BINARY : configured;
}

/** Droid finishes a login it thinks is missing by opening a browser tab (its
 *  primary auth method is device pairing). A desktop app spawning a browser
 *  mid-turn is never what the user asked for, so every child we start is told
 *  there is no browser to open. */
const DROID_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const;

/** Env for a long-lived ACP session child. Deliberately *not* `CI=true` — that
 *  flips CLIs into a non-interactive posture that suppresses parts of a real
 *  user turn. Probes get the stricter env below instead. */
export async function buildDroidEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv();
  return { ...env, ...DROID_BROWSERLESS_ENV };
}

/** Env for short, bounded probes (`--version`) — headless and non-interactive
 *  so nothing can block waiting on a human. */
export async function buildDroidProbeEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildDroidEnv();
  return { ...env, CI: "true", DEBIAN_FRONTEND: "noninteractive" };
}

/** `droid --version` prints bare semver (`0.186.0`). The CLI auto-updates — it
 *  moved 0.185.0 → 0.186.0 during the afternoon this adapter was written — so
 *  treat the version as presence/telemetry only and never gate behaviour on it. */
export function parseDroidVersion(stdout: string): string | undefined {
  const semver = stdout.match(/\b(\d+\.\d+\.\d+[\w.-]*)\b/)?.[1];
  return semver ?? (stdout.trim().split("\n")[0]?.trim() || undefined);
}

/** Where Factory keeps its per-user state (settings, custom models, auth). */
export function droidHomeDir(): string {
  return path.join(os.homedir(), ".factory");
}

/** Credential files the CLI writes once a device-pairing login completes. We
 *  check for *existence only* and never open them. */
const DROID_CREDENTIAL_FILES = ["auth.v2.file", "auth.encrypted"];

/** Droid ships no `status` subcommand, so login is detected structurally rather
 *  than by asking the CLI. Two auth methods exist (its ACP handshake advertises
 *  both): an exported `FACTORY_API_KEY`, or a device-pairing login that leaves a
 *  credential file under ~/.factory. kone never reads either — presence is the
 *  whole signal, which keeps discovery credential-free by construction. */
export async function detectDroidAuth(
  env?: NodeJS.ProcessEnv,
): Promise<{ authenticated: boolean; label?: string }> {
  if ((env ?? process.env).FACTORY_API_KEY?.trim()) {
    return { authenticated: true, label: "Factory API Key" };
  }
  for (const name of DROID_CREDENTIAL_FILES) {
    try {
      await fs.access(path.join(droidHomeDir(), name));
      return { authenticated: true, label: "Factory Login" };
    } catch {
      // Not this one — try the next credential file.
    }
  }
  return { authenticated: false };
}
