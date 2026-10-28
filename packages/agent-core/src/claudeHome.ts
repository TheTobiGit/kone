import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { buildAgentEnv, pathEnvKey, type PathHit } from "./processEnv.js";

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

/** The platform's `claude` executable name, for the paths kone builds itself
 *  (the SDK's bundled binary). A native Windows binary is `claude.exe`. */
function claudeExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

/** Windows launcher-script extensions the SDK cannot spawn directly (Node's
 *  `spawn` rejects them with EINVAL). An npm global install writes a `claude`
 *  command through one of these, so it has to be followed to the package's own
 *  entry before the SDK is handed it. */
const WINDOWS_LAUNCHER_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/** Entry points of the npm `@anthropic-ai/claude-code` package, relative to the
 *  global `node_modules` directory that sits beside the launcher shim. Newer
 *  versions ship a native `bin/claude.exe`; older ones only ship `cli.js`. */
const NPM_CLAUDE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

/** How a resolved `claude` was installed: the native installer's own channel,
 *  an npm global, the SDK's bundled binary, or a layout kone can't name. This
 *  travels with the launch path so discovery and maintenance describe the same
 *  copy the session actually runs. */
export type ClaudeInstallSource = "native" | "npm" | "bundled" | "unknown";

/** Which `claude` kone would run, and where it came from. `executable` is what
 *  the SDK is handed (`located.real`, with a Windows npm shim followed to its
 *  package entry); undefined when nothing resolves. */
export type ClaudeInstallation = {
  executable: string | undefined;
  source: ClaudeInstallSource;
  /** The PATH entry / native home the CLI was found at, when a user install
   *  exists — `found` is the shim, `real` the path the session spawns. */
  located: PathHit | null;
};

export type ClaudeInstallInput = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Overridable for tests; production reads Electron's live value. */
  resourcesPath?: string;
  /** Overridable for tests; otherwise the env's home, then the OS home. */
  homeDir?: string;
  /** The configured binary name or path; defaults to `claude`. */
  binary?: string;
};

/** Candidate filenames for one PATH entry. On Windows the native `.exe` leads
 *  and the npm launcher shims follow — the trailing extensionless `claude` npm
 *  also writes is deliberately absent: it is a shell script the SDK cannot
 *  spawn, and its `.cmd` sibling is the same install. */
function claudeCandidateNames(binary: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [binary];
  if (/\.(exe|cmd|bat|ps1)$/i.test(binary)) return [binary];
  return [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`];
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function hitAt(candidate: string): PathHit | null {
  if (!existsSync(candidate)) return null;
  let real = candidate;
  try {
    real = realpathSync(candidate);
  } catch {
    // A dangling symlink still tells us where the install was meant to be.
  }
  return { found: candidate, real, dir: path.dirname(candidate) };
}

/** The user's own installed Claude Code CLI, if any: the configured name (or
 *  `claude`) across PATH, then the native installer's standard `~/.local/bin`
 *  home. The home is checked directly because a minimal launch PATH may not
 *  carry it — buildAgentEnv only appends it when the login-shell probe
 *  succeeds, and a settings inspection must find the copy the runtime runs. */
function locateInstalledClaude(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
}): PathHit | null {
  if (hasPathSeparator(input.binary)) return hitAt(path.resolve(input.binary));
  const names = claudeCandidateNames(input.binary, input.platform);
  const separator = input.platform === "win32" ? ";" : ":";
  const dirs = [
    ...(input.env[pathEnvKey(input.env, input.platform)] ?? "").split(separator).filter(Boolean),
    path.join(input.homeDir, ".local", "bin"),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const hit = hitAt(path.join(dir, name));
      if (hit) return hit;
    }
  }
  return null;
}

/** Follow a Windows npm launcher shim to the package entry the SDK can spawn.
 *  Returns the path unchanged when it isn't a shim, and undefined when it is a
 *  shim with no known entry beside it — handing the `.cmd` over would only fail
 *  the spawn, and claiming it launched would be a lie. */
function resolveLauncherEntry(commandPath: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return commandPath;
  // Host path semantics, not `path.win32`: in production the host *is* Windows,
  // and the lookup stays file-based (and therefore testable from any host).
  if (!WINDOWS_LAUNCHER_EXTENSIONS.has(path.extname(commandPath).toLowerCase())) {
    return commandPath;
  }
  const shimDir = path.dirname(commandPath);
  for (const segments of NPM_CLAUDE_ENTRY_CANDIDATES) {
    const candidate = path.join(shimDir, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Name the install channel from the launch path. The versioned native home and
 *  the `@anthropic-ai/claude-code` package tree are the two layouts kone knows;
 *  anything else is reported as unrecognised rather than guessed at. */
function claudeSourceFromPath(commandPath: string): ClaudeInstallSource {
  const normalized = commandPath.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  ) {
    return "native";
  }
  if (normalized.includes("/node_modules/@anthropic-ai/claude-code/")) return "npm";
  return "unknown";
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
function bundledClaudeExecutable(input: {
  platform: NodeJS.Platform;
  arch: string;
  resourcesPath: string | undefined;
}): string | undefined {
  if (!input.resourcesPath) return undefined;
  const pkg = `@anthropic-ai/claude-agent-sdk-${input.platform}-${input.arch}`;
  const unpacked = path.join(
    input.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    pkg,
    claudeExecutableName(input.platform),
  );
  return existsSync(unpacked) ? unpacked : undefined;
}

function homeFromEnv(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

/** Resolve the user's own installed Claude Code CLI, its launch path and where
 *  it came from — one contract the adapter (which spawns it), discovery (which
 *  reads its version) and maintenance (which updates it) all share, so the
 *  three can never disagree about which copy is running. A user install wins;
 *  the SDK's bundled binary is the fallback in a packaged build, then nothing
 *  (the caller omits the option and the SDK resolves its own, which is fine
 *  unpacked). */
export function resolveClaudeInstallation(input: ClaudeInstallInput = {}): ClaudeInstallation {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const binary = input.binary?.trim() || "claude";
  const located = locateInstalledClaude({
    binary,
    env,
    platform,
    homeDir: input.homeDir ?? homeFromEnv(env),
  });
  if (located) {
    const launch =
      resolveLauncherEntry(located.real, platform) ??
      resolveLauncherEntry(located.found, platform);
    if (launch) {
      return {
        executable: launch,
        source: claudeSourceFromPath(launch),
        located: launch === located.real ? located : { ...located, real: launch },
      };
    }
    // A Windows launcher shim with no importable package entry beside it: the
    // install is present but unspawnable, so there is no launch path and no
    // channel maintenance could update without guessing.
    return { executable: undefined, source: "unknown", located: null };
  }
  // SAFETY: the assertion only widens `process` with Electron's `resourcesPath`
  // property. Its absence reads as "not packaged".
  const resourcesPath = input.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath;
  const bundled = bundledClaudeExecutable({
    platform,
    arch: input.arch ?? process.arch,
    resourcesPath,
  });
  return { executable: bundled, source: bundled ? "bundled" : "unknown", located: null };
}

/** Resolve just the launch path the SDK is handed. See
 *  `resolveClaudeInstallation` for the provenance that travels with it. */
export function resolveClaudeExecutable(input: ClaudeInstallInput = {}): string | undefined {
  return resolveClaudeInstallation(input).executable;
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
    // SAFETY: every field read off raw is optional and only feeds a boolean, so
    // a deviant credentials file just reads as undefined ("no file login").
    const raw = JSON.parse(readFileSync(credsPath, "utf8")) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number } | null;
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return false;
    // A refresh token would let the CLI renew, but we don't have it here — treat
    // a not-yet-expired access token as a usable login and let the CLI refresh.
    if (oauth.expiresAt !== undefined && oauth.expiresAt !== null && Number.isFinite(oauth.expiresAt) && oauth.expiresAt < Date.now()) return false;
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
  const env = await buildAgentEnv(base, "claudeAgent");
  if (hasLocalOAuthLogin(env) && !hasExternalAuthOverride(env)) {
    for (const key of DIRECT_CREDENTIAL_KEYS) delete env[key];
  }
  // Identify kone in the SDK's User-Agent.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "kone/0.1.0";
  // The task tools (TaskCreate / TaskUpdate / TaskList / TaskGet) are off in
  // SDK sessions unless asked for, and they are what fills the thread dock's
  // Tasks section (claudeTaskTracker). A user's own setting still wins.
  env.CLAUDE_CODE_ENABLE_TASKS ??= "1";
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
