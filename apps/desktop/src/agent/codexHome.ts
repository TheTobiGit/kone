import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// CODEX_HOME resolution + auth/version helpers for the Codex adapter. `codex
// login` (run by the user, outside kone) is what makes auth.json exist — kone
// never writes here, only reads, matching the "bring your own subscription"
// stance: detect an already-logged-in CLI, never hold its credentials.

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

export type CodexAuth = { authenticated: boolean; label?: string };

/** Read <CODEX_HOME>/auth.json to see if the CLI is logged in. Never throws —
 *  a missing/unreadable file just means "not authenticated". */
export function readCodexAuth(env: NodeJS.ProcessEnv = process.env): CodexAuth {
  if (env.OPENAI_API_KEY?.trim()) return { authenticated: true, label: "API Key" };

  const authPath = path.join(resolveCodexHome(env), "auth.json");
  if (!existsSync(authPath)) return { authenticated: false };
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as {
      OPENAI_API_KEY?: string | null;
      tokens?: { access_token?: string } | null;
    };
    if (raw.tokens?.access_token) return { authenticated: true, label: "ChatGPT Sign-In" };
    if (raw.OPENAI_API_KEY) return { authenticated: true, label: "API Key" };
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

// ── CLI version gating ───────────────────────────────────────────────────────
// codex app-server's `initialize` response carries a `userAgent` string with
// the CLI version baked in; kone needs at least this version for the
// app-server JSON-RPC surface used here (the thread/turn split, item/* events).

export const MIN_CODEX_CLI_VERSION = "0.37.0";

const VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export function parseCodexCliVersion(userAgent: string): string | null {
  return VERSION_PATTERN.exec(userAgent)?.[1] ?? null;
}

/** true when `version` is >= MIN_CODEX_CLI_VERSION. Best-effort — an
 *  unparsable version is treated as supported rather than blocking the user. */
export function isCodexCliVersionSupported(version: string | null): boolean {
  if (!version) return true;
  const segments = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = segments(version);
  const need = segments(MIN_CODEX_CLI_VERSION);
  for (let i = 0; i < 3; i++) {
    const diff = (have[i] ?? 0) - (need[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
