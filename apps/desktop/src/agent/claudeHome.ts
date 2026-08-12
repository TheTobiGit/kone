import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { buildAgentEnv } from "./processEnv.js";

// Auth/env helpers for the Claude adapter, the analogue of codexHome.ts. Same
// "bring your own subscription" stance: kone never runs `claude login`, never
// writes credentials, never holds a token. The Claude Agent SDK drives the
// user's own Claude Code login (macOS keychain OAuth, or ~/.claude on-disk
// credentials, or an external Bedrock/Vertex backend) — we only *read* what's
// already there to report status, and we make sure a stray API key in the
// environment can't silently override the user's real subscription.

/** Where Claude Code keeps its config/credentials. `CLAUDE_CONFIG_DIR` wins;
 *  otherwise ~/.claude. Note: to isolate a Claude session you set
 *  CLAUDE_CONFIG_DIR, never HOME — overriding HOME breaks the macOS keychain
 *  OAuth lookup. */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
}

/** Where the SDK's bundled `claude` binary really lives in a packaged build.
 *
 *  The SDK resolves its native binary relative to its own module path — which,
 *  once packaged, is *inside* app.asar. Electron's asar shim patches `fs` but
 *  not `child_process.spawn`, so the OS walks the path, hits app.asar (a file,
 *  not a directory) and the spawn fails with ENOTDIR. electron-builder does
 *  unpack the binary, so the working path is the app.asar.unpacked twin.
 *
 *  Returns undefined when that path isn't there (notably `electron dev`, where
 *  nothing is packed) — the caller then omits the option and lets the SDK
 *  resolve the binary itself, which works fine unpacked. */
export function resolveClaudeExecutable(): string | undefined {
  if (!process.resourcesPath) return undefined;
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  const unpacked = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    pkg,
    binary,
  );
  return existsSync(unpacked) ? unpacked : undefined;
}

// Direct-credential env keys — a token/key that, if present, the CLI would use
// *instead of* the user's subscription login. We strip these when a real login
// exists so the subscription always wins over a leaked/stale key.
const DIRECT_CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

// External-auth backends — when any of these is set the user has deliberately
// pointed Claude at Bedrock/Vertex/a custom gateway, so we must NOT strip the
// direct-credential keys (they may be the intended auth for that backend).
const EXTERNAL_AUTH_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

function hasExternalAuthOverride(env: NodeJS.ProcessEnv): boolean {
  return EXTERNAL_AUTH_KEYS.some((key) => Boolean(env[key]?.trim()));
}

/** True when a usable Claude Code OAuth login exists on disk (a `claude login`
 *  subscription). Best-effort and read-only: a missing/unreadable/expired
 *  credentials file just means "can't prove a file-based login" — the user may
 *  still be logged in via the macOS keychain, which we can't read here. */
export function hasLocalOAuthLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  const credsPath = path.join(resolveClaudeConfigDir(env), ".credentials.json");
  if (!existsSync(credsPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(credsPath, "utf8")) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number } | null;
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return false;
    // A refresh token would let the CLI renew, but we don't have it here — treat
    // a not-yet-expired access token as a usable login and let the CLI refresh.
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/** The environment for the Claude Agent SDK subprocess: kone's inherited env
 *  (with the login-shell PATH recovered — see processEnv.ts) plus one rule —
 *  when the user has a real subscription login and hasn't opted into an
 *  external backend, delete any direct API-key env vars so the subscription
 *  wins over a leaked key. The SDK's `env` option REPLACES the child env, so we
 *  must pass a complete environment, not a patch. */
export async function buildClaudeEnv(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv(base);
  if (hasLocalOAuthLogin(env) && !hasExternalAuthOverride(env)) {
    for (const key of DIRECT_CREDENTIAL_KEYS) delete env[key];
  }
  // Identify kone in the SDK's User-Agent.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "kone/0.1.0";
  return env;
}

// ── CLI version (display only) ───────────────────────────────────────────────
// The Agent SDK ships its own Claude Code CLI, so a session never depends on a
// user-installed `claude`. We still surface the installed CLI's version when
// present, purely for the status row.

const VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export function parseClaudeCliVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1] ?? undefined;
}

// ── account → status mapping ─────────────────────────────────────────────────

export type ClaudeAccount = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
};

export type ClaudeAuthSummary = {
  authenticated: boolean;
  /** How the CLI is authed, for the status row (e.g. "Claude Pro", "API Key",
   *  "Amazon Bedrock"). */
  label?: string;
};

const API_PROVIDER_LABELS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Claude on AWS",
  anthropicGoogleCloud: "Claude on Google Cloud",
  gateway: "Enterprise Gateway",
};

/** Roll a Claude Agent SDK `account` (from initializationResult) up into a
 *  human auth summary. A third-party backend (Bedrock/Vertex/…) counts as
 *  authenticated even with no email — the external creds are doing the work. */
export function summarizeClaudeAccount(account: ClaudeAccount | undefined): ClaudeAuthSummary {
  if (!account) return { authenticated: false };

  const provider = account.apiProvider;
  if (provider && provider !== "firstParty") {
    return { authenticated: true, label: API_PROVIDER_LABELS[provider] ?? "External backend" };
  }

  // First-party: an email or an OAuth token source means a real login.
  const tokenSource = account.tokenSource ?? account.apiKeySource;
  if (tokenSource === "apiKey") return { authenticated: true, label: "API Key" };
  if (account.email || tokenSource === "oauth") {
    const plan = subscriptionLabel(account.subscriptionType);
    return { authenticated: true, label: plan ?? account.email ?? "Claude Sign-In" };
  }
  return { authenticated: false };
}

function subscriptionLabel(subscriptionType: string | undefined): string | undefined {
  switch (subscriptionType) {
    case "pro":
      return "Claude Pro";
    case "max":
    case "max_5x":
    case "max_20x":
      return "Claude Max";
    case "team":
    case "enterprise":
      return "Claude Team";
    default:
      return undefined;
  }
}
