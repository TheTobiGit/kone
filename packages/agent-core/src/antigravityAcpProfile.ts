import fs from "node:fs";
import path from "node:path";

import { buildAgentEnv } from "./processEnv.js";

// Profile + launch environment for the Antigravity ACP server.
//
// Shared-profile mode (the default): the server inherits the login the user
// already completed in the `agy` CLI. kone writes no settings, pins no auth
// method, and leaves profile resolution to the server itself — GEMINI_HOME is
// passed through untouched when the user has one, otherwise left unset so the
// server resolves its profile exactly as the CLI does. The only things kone
// imposes are the harness path and a browser suppressor, so a missing login
// surfaces a capturable sign-in URL instead of a popup. kone never reads or
// copies a credential; a missing login is answered with "run `agy` once",
// the same prompt the print-mode adapter already uses.
//
// An isolated profile (private GEMINI_HOME + pinned method) stays available
// for machines where the CLI login must not be shared, but nothing uses it yet.

export type AntigravityAcpProfileMode = "shared" | "isolated";

// ── auth config ─────────────────────────────────────────────────────────────

/** v1 sign-in methods: a personal Google account, or Gemini Enterprise with
 *  a GCP project + location that resolves the license. */
export type AntigravityAcpAuthMethod = "oauth-personal" | "oauth-business";

export type AntigravityAcpAuth = {
  readonly authMethod: AntigravityAcpAuthMethod;
  readonly gcpProject: string;
  readonly gcpLocation: string;
};

export const ANTIGRAVITY_ACP_DEFAULT_AUTH: AntigravityAcpAuth = {
  authMethod: "oauth-personal",
  gcpProject: "",
  gcpLocation: "",
};

/** Label for the provider card once the method has authenticated. */
export function antigravityAcpAuthLabel(method: AntigravityAcpAuthMethod): string {
  return method === "oauth-business" ? "Gemini Enterprise" : "Google account";
}

/** What is missing before this method can authenticate, or null when the
 *  config is complete. Personal sign-in never needs config. */
export function antigravityAcpAuthConfigIssue(auth: AntigravityAcpAuth): string | null {
  if (auth.authMethod === "oauth-personal") return null;
  return auth.gcpProject.trim() && auth.gcpLocation.trim()
    ? null
    : "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.";
}

// ── profile layout ──────────────────────────────────────────────────────────

export type AntigravityAcpProfile = {
  /** GEMINI_HOME for the server, or null in shared mode — null leaves the
   *  variable exactly as the user's environment has it (usually unset), so
   *  the server resolves its profile the same way the `agy` CLI does. */
  readonly geminiHome: string | null;
  /** `<geminiHome>/antigravity-acp`, or null when the profile is the
   *  server's own default and kone manages no files inside it. */
  readonly acpDirectory: string | null;
  readonly platform: NodeJS.Platform;
  /** Shell command the server's browser launcher runs instead of opening a
   *  real browser — it reports the sign-in URL back to kone. */
  readonly browserCommand: string;
};

/** kone's private Antigravity profile root for isolated mode: one instance, so
 *  no per-instance hashing — everything for this provider lives in one
 *  directory. Unused in shared mode, which manages no profile at all. */
export function resolveAntigravityAcpProfileDir(userDataDir: string): string {
  return path.join(userDataDir, "providers", "antigravity");
}

/** Shared-mode profile: no directories, no settings writes — the server uses
 *  the `agy` CLI's own login. Only the browser suppressor is kone's. */
export function resolveAntigravityAcpSharedProfile(
  platform: NodeJS.Platform = process.platform,
  runtimeExecutable: string = process.execPath,
): AntigravityAcpProfile {
  return {
    geminiHome: null,
    acpDirectory: null,
    platform,
    browserCommand: buildAntigravityBrowserCommand(runtimeExecutable, platform),
  };
}

/** The profile settings document: the selected method plus the Enterprise
 *  scope. Never holds a credential. */
export type AntigravityAcpProfileDocument = {
  auth: { type: AntigravityAcpAuthMethod };
  gcp?: { project?: string; location?: string };
};

/** `settings.json` content for the profile. Names the selected method so a
 *  native logout clears only that method's credentials, and carries the GCP
 *  pair for Enterprise. */
export function antigravityAcpProfileSettings(auth: AntigravityAcpAuth): string {
  const document: AntigravityAcpProfileDocument = {
    auth: { type: auth.authMethod },
  };
  const project = auth.gcpProject.trim();
  const location = auth.gcpLocation.trim();
  if (project || location) {
    document.gcp = {};
    if (project) document.gcp.project = project;
    if (location) document.gcp.location = location;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Create the profile directories (mode 0700) and rewrite settings.json so a
 *  method/project/location edit in Settings takes effect on next launch. */
export function ensureAntigravityAcpProfile(
  profileDir: string,
  auth: AntigravityAcpAuth,
  platform: NodeJS.Platform = process.platform,
  runtimeExecutable: string = process.execPath,
): AntigravityAcpProfile {
  const geminiHome = path.resolve(profileDir);
  const acpDirectory = path.join(geminiHome, "antigravity-acp");
  fs.mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(acpDirectory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    fs.chmodSync(geminiHome, 0o700);
    fs.chmodSync(acpDirectory, 0o700);
  }
  fs.writeFileSync(path.join(acpDirectory, "settings.json"), antigravityAcpProfileSettings(auth));
  return {
    geminiHome,
    acpDirectory,
    platform,
    browserCommand: buildAntigravityBrowserCommand(runtimeExecutable, platform),
  };
}

// ── browser suppression ─────────────────────────────────────────────────────

/** Marker the suppressor helper prints ahead of the sign-in URL on stderr. */
export const ANTIGRAVITY_ACP_BROWSER_MARKER = "__KONE_ANTIGRAVITY_AUTH_URL__";

/** A `BROWSER=` command that reports the sign-in URL instead of opening one:
 *  `<runtime> -e <script> -- %s`, printing the marker + JSON url on stderr
 *  and exiting 0 (a non-zero exit makes the launcher fall back to a real OS
 *  browser). Runs on the Electron binary via ELECTRON_RUN_AS_NODE, the same
 *  mechanism the capture-hook scripts use. */
export function buildAntigravityBrowserCommand(
  runtimeExecutable: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const script = `process.stderr.on("error",()=>process.exit(0)).write("${ANTIGRAVITY_ACP_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;
  if (platform === "win32") {
    const quoted = runtimeExecutable.replaceAll('"', '""');
    return `"${quoted}" -e "${script.replaceAll('"', '""')}" -- "%s"`;
  }
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  return `${quote(runtimeExecutable)} -e ${quote(script)} -- %s`;
}

/** Pull a sign-in URL out of one stderr line, from either the suppressor
 *  helper or the server's own native message. Null when the line carries no
 *  URL. */
export function parseAntigravityBrowserLine(line: string): string | null {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text.startsWith(ANTIGRAVITY_ACP_BROWSER_MARKER)) {
    try {
      // SAFETY: JSON.parse yields unknown; non-string payloads are rejected
      // below and only a string is ever returned as a URL candidate.
      const url: unknown = JSON.parse(text.slice(ANTIGRAVITY_ACP_BROWSER_MARKER.length));
      return url === null || url === undefined || url instanceof Object ? null : String(url);
    } catch {
      return null;
    }
  }
  if (text.startsWith(ANTIGRAVITY_ACP_AUTH_STDOUT_PREFIX)) {
    return text.slice(ANTIGRAVITY_ACP_AUTH_STDOUT_PREFIX.length);
  }
  return null;
}

// ── environment + spawn ─────────────────────────────────────────────────────

/** Prefix the server prints ahead of the Google sign-in URL on stdout when it
 *  needs an interactive login. */
export const ANTIGRAVITY_ACP_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";

/** Message the adapter surfaces when the server reports it has no usable
 *  sign-in (request error code -32000, or the stdout prefix above with no
 *  sign-in handler attached). */
export const ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Antigravity in Settings before you continue.";

/** Ambient keys that must never leak into the server's environment: stored
 *  API keys / project overrides on the machine would silently switch which
 *  account or backend the server authenticates as. GEMINI_HOME is deliberately
 *  absent — shared mode passes the user's own value through so the server
 *  finds the CLI's login, and isolated mode overrides it below. */
const REMOVED_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
]);

/** Launch environment for every ACP server process: the agent env minus
 *  anything that could redirect auth, plus the harness wiring. Shared mode
 *  adds no credential and pins no profile — the server authenticates as the
 *  CLI's login. Isolated mode additionally points GEMINI_HOME at kone's
 *  private profile and forces file storage inside it. */
export async function buildAntigravityAcpEnv(
  profile: AntigravityAcpProfile,
  harnessPath: string,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const base = await buildAgentEnv(baseEnv);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || REMOVED_ENV_KEYS.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  const isolated: NodeJS.ProcessEnv =
    profile.geminiHome === null
      ? {}
      : { GEMINI_HOME: profile.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: "1" };
  return {
    ...env,
    ...isolated,
    ANTIGRAVITY_HARNESS_PATH: harnessPath,
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
}

export type AntigravityAcpExecutable = {
  readonly executablePath: string;
  readonly harnessPath: string;
};

export type AntigravityAcpSpawnInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
};

/** The stdio spawn for one ACP server process. Linux builds take an empty
 *  `--uid=` flag (their registry entry ships it); other platforms take no
 *  args. */
export function buildAntigravityAcpSpawnInput(input: {
  executable: AntigravityAcpExecutable;
  profile: AntigravityAcpProfile;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): AntigravityAcpSpawnInput {
  return {
    command: input.executable.executablePath,
    args: input.profile.platform === "linux" ? ["--uid="] : [],
    cwd: input.cwd,
    env: input.env,
  };
}

// ── sign-in URL + error recognition ─────────────────────────────────────────

export type AntigravityAuthUrl = {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
};

const MAX_AUTH_URL_LENGTH = 16_384;

/** Validate a Google sign-in URL before it is ever shown or opened: exact
 *  accounts.google.com authorization endpoint, a code response, a non-empty
 *  state, and a loopback redirect. Null when the URL is not that shape. */
export function parseAntigravityAuthUrl(raw: string): AntigravityAuthUrl | null {
  if (!raw || raw.length > MAX_AUTH_URL_LENGTH || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    state === null ||
    state.length === 0 ||
    state.length > 512 ||
    redirectUri === null ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) {
    return null;
  }
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return null;
  }
  if (Number(redirect.port) < 1_024) return null;
  return { authorizationUrl: raw, redirectUri, state };
}

/** True when an ACP failure means "no usable sign-in" rather than a real
 *  request error: the server's -32000 auth failure, or the sign-in message
 *  above. The adapter maps these to the Settings sign-in prompt instead of a
 *  turn failure. */
export function isAntigravitySignInRequiredError(cause: unknown): boolean {
  if (cause instanceof Object && !Array.isArray(cause)) {
    // SAFETY: cause is verified as a non-array Object record.
    const record = cause as { code?: unknown; message?: unknown };
    const code = record.code;
    if (code !== null && code !== undefined && !(code instanceof Object) && Number(code) === -32000) {
      return true;
    }
    const message = record.message;
    if (
      message !== null &&
      message !== undefined &&
      !(message instanceof Object) &&
      String(message).includes(ANTIGRAVITY_ACP_SIGN_IN_REQUIRED_MESSAGE)
    ) {
      return true;
    }
  }
  return false;
}
