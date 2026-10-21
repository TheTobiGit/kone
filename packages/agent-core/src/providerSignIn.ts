import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { resolveAntigravityBinary } from "./antigravityHome.js";
import { resolveClaudeInstallation } from "./claudeHome.js";
import { resolveClineBinary } from "./clineHome.js";
import { resolveCursorBinary } from "./cursorHome.js";
import { resolveDroidBinary } from "./droidHome.js";
import { findOnPathEntry } from "./processEnv.js";
import { defaultProviderBinary } from "./providerMaintenance.js";
import { ProviderKindSchema } from "./types.js";
import type { ProviderKind, ProviderSettingsMap } from "./types.js";

// In-app provider sign-in: the ONE place that decides what command "Sign in"
// runs for a provider CLI. The renderer never names a command — it names a
// provider, and this module resolves that provider's own login subcommand plus
// the executable the user configured (ProviderConfig.binaryPath). That is the
// whole security boundary: a compromised renderer can ask to sign in, but it
// cannot turn the bridge into "run anything".
//
// kone still never sees the credential. The CLI is handed a real PTY, opens
// its own browser (or asks its own questions in the terminal), and writes its
// login wherever it always does. Afterwards the caller re-probes provider
// health; nothing here reads, logs or stores what the CLI wrote.

/** How the CLI finishes a login: opens a sign-in page, or asks in the terminal
 *  (opencode's provider menu). */
export type ProviderSignInFinish = "browser" | "terminal";

/** The login command kone would run for a provider, resolved in the main
 *  process. Mirrors the renderer contract in apps/web/app/types/desktop.d.ts. */
export type ProviderSignInCommand = {
  provider: ProviderKind;
  /** What the user sees and can copy, e.g. "cursor-agent login". */
  display: string;
  /** Where it runs, tilde-abbreviated for display. Always "~" for a login. */
  cwd: string;
  finish: ProviderSignInFinish;
};

/** A renderer's request to start a login in a PTY it minted. Mirrors the
 *  renderer contract. */
export type ProviderSignInStartInput = {
  provider: ProviderKind;
  terminalId: string;
  cols?: number;
  rows?: number;
};

/** Runtime schema for a start request — the IPC boundary's one gate. Only a
 *  known provider and a non-empty renderer-minted PTY id get through. */
export const ProviderSignInStartInputSchema: z.ZodType<ProviderSignInStartInput> = z.object({
  provider: ProviderKindSchema,
  terminalId: z.string().trim().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

/** The resolved launch, or the plain sentence that says why there is none.
 *  `command` stays populated on a failure so the dialog can still show what it
 *  would have run (null only for a provider with no login subcommand). */
export type ProviderSignInLaunch =
  | {
      ok: true;
      /** Executable node-pty spawns, exactly as resolved (a bare name is left
       *  for PATH; a custom path is absolute). */
      file: string;
      args: string[];
      /** Absolute home directory — the one cwd a login may write in. */
      cwd: string;
      env: Record<string, string>;
      /** Written into the PTY's history before the program's first byte, so the
       *  terminal shows the dim cwd and the command exactly as the user could
       *  have typed it. */
      banner: string;
      command: ProviderSignInCommand;
    }
  | { ok: false; command: ProviderSignInCommand | null; message: string };

type LoginSpec = {
  args: string[];
  finish: ProviderSignInFinish;
};

// Env decisions, per provider, are deliberate and narrow: every login starts
// from kone's agent env and only has kone's own browser sentinels removed (the
// login is the one child that genuinely needs the browser). Home/config-dir
// variables are inherited untouched, so the credential lands where the
// matching health probe will look:
//   • codex — plain CODEX_HOME, never kone's gateway overlay (that overlay's
//     auth.json symlink would still write to the real home; the plain env
//     simply avoids depending on the link).
//   • claudeAgent — CLAUDE_CONFIG_DIR inherited; HOME never overridden, since
//     macOS keychain OAuth needs it intact.
//   • cursor — no home/config-dir variable; cursor-agent keeps its login in the
//     OS keychain.
//   • opencode — no home/config-dir variable in the probe env;
//     OPENCODE_CONFIG_CONTENT is probe-only config content, not a credential
//     location.
//   • antigravity — auth lives under ~/.gemini/antigravity-cli with no env
//     override in the probe. HOME is inherited untouched.
//   • cline — CLINE_DATA_DIR inherited (detectClineAuth reads it); otherwise
//     the default ~/.cline/data is used.
//   • droid — unreachable: no login command (see LOGIN_COMMANDS).
//
// CI/DEBIAN_FRONTEND are deliberately not added either: a login is interactive,
// not a bounded probe, and CI mode can suppress the very prompts it needs.

/** The login command each CLI documents for itself. `claude auth login` is the
 *  real subcommand (bare `claude login` is not); opencode's `auth login` asks
 *  its provider questions in the terminal, so it finishes there. Droid has no
 *  login subcommand at all — it signs in on first run. */
const LOGIN_COMMANDS = {
  codex: { args: ["login"], finish: "browser" },
  claudeAgent: { args: ["auth", "login"], finish: "browser" },
  cursor: { args: ["login"], finish: "browser" },
  opencode: { args: ["auth", "login"], finish: "terminal" },
  antigravity: { args: ["login"], finish: "browser" },
  cline: { args: ["auth"], finish: "browser" },
  droid: null,
} as const satisfies Record<ProviderKind, LoginSpec | null>;

/** Default binary names come from providerMaintenance's definitions, so
 *  sign-in and install/maintenance can never disagree about which executable a
 *  provider owns. */
function defaultBinary(provider: ProviderKind): string {
  return defaultProviderBinary(provider);
}

/** The provider's own resolver, where it has one: those map ambiguous override
 *  names onto the executable the adapter would actually spawn (Cursor's `cursor`
 *  / `agent` → `cursor-agent`), so the dialog and the launch agree with
 *  discovery. Providers without a resolver take the trimmed override as-is. */
function binaryFor(provider: ProviderKind, settings: ProviderSettingsMap): string {
  const override = settings[provider]?.binaryPath;
  switch (provider) {
    case "cursor":
      return resolveCursorBinary(override);
    case "cline":
      return resolveClineBinary(override);
    case "antigravity":
      return resolveAntigravityBinary(override);
    case "droid":
      return resolveDroidBinary(override);
    default:
      return override?.trim() || defaultBinary(provider);
  }
}

function configuredBinary(provider: ProviderKind, settings: ProviderSettingsMap): string | undefined {
  return settings[provider]?.binaryPath?.trim() || undefined;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/** A packaged JS entry is not something node-pty can launch as a CLI. Claude's
 *  resolver follows an npm install to its package entry on Windows but leaves
 *  `cli.js` on Unix, where the `claude` shim on PATH is the right thing to run
 *  instead. */
function isJavaScriptEntry(value: string): boolean {
  return /\.(?:c|m)?js$/i.test(value);
}

/** The executable to spawn. The override is normalized exactly as the
 *  provider's adapter would normalize it (see `binaryFor`); without one, Claude
 *  gets its installed CLI when that resolves to a native executable. */
function launchBinary(
  provider: ProviderKind,
  settings: ProviderSettingsMap,
  env: NodeJS.ProcessEnv,
): string {
  if (provider === "claudeAgent" && !configuredBinary(provider, settings)) {
    const executable = resolveClaudeInstallation({ binary: defaultBinary(provider), env }).executable;
    if (executable && !isJavaScriptEntry(executable)) return executable;
  }
  return binaryFor(provider, settings);
}

/** Whether `filePath` is a real file the OS can execute. */
function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function locateBinary(
  file: string,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; message: string } {
  if (hasPathSeparator(file)) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) return { ok: false, message: `${file} doesn't exist.` };
    if (!isExecutableFile(resolved)) return { ok: false, message: `${file} isn't executable.` };
    return { ok: true };
  }
  const hit = findOnPathEntry(file, env);
  if (!hit) return { ok: false, message: `${file} isn't on your PATH.` };
  if (!isExecutableFile(hit.found)) return { ok: false, message: `${file} isn't executable.` };
  return { ok: true };
}

/** kone's own "there is no browser" sentinels. They are right for sessions and
 *  probes, but a login must be allowed to open the page it needs, so drop the
 *  sentinel pair if some inherited env still carries it. A real user `BROWSER`
 *  is left alone. */
function withoutBrowserSuppressors(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (next.NO_BROWSER === "true") delete next.NO_BROWSER;
  if (next.BROWSER === "www-browser") delete next.BROWSER;
  return next;
}

/** The environment a login child gets: kone's agent env flattened to the string
 *  map node-pty takes, with kone's own browser sentinels removed. Nothing is
 *  added and no home/config-dir variable is rewritten — see the per-provider
 *  notes above LOGIN_COMMANDS for why inheriting them is the right call. */
function signInEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env = withoutBrowserSuppressors(base);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Shell-quote one word for the command the user sees and copies. Spawning
 *  never parses this text — node-pty gets the executable and argv array
 *  directly — but a configured `binaryPath` may contain spaces, quotes or
 *  metacharacters, and an unquoted display would paste as a different command
 *  (or run the wrong thing). Simple tokens stay bare so the common case reads
 *  exactly as before.
 *
 *  POSIX shells get single quotes with the `'\''` escape; Windows gets double
 *  quotes with embedded quotes backslash-escaped. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build the dialog's command row from a provider's login spec — the one place
 *  the executable name, args and finish mode are joined. */
function commandFromSpec(
  provider: ProviderKind,
  spec: LoginSpec,
  settings: ProviderSettingsMap,
): ProviderSignInCommand {
  const display = [binaryFor(provider, settings), ...spec.args]
    .map((part) => shellQuote(part))
    .join(" ");
  return {
    provider,
    display,
    cwd: "~",
    finish: spec.finish,
  };
}

/** The dim cwd + prompt line the login terminal opens with. Part of history,
 *  not just the first output, so a renderer attaching a moment late still sees
 *  what is running. */
function signInBanner(command: ProviderSignInCommand): string {
  return `\x1b[2m${command.cwd}\x1b[0m\r\n\x1b[32m❯\x1b[0m ${command.display}\r\n\r\n`;
}

/** The login command for `provider`, for display. Never spawns, never checks
 *  whether the executable exists — `start` does that. Null when the CLI has no
 *  login subcommand. */
export function resolveProviderSignInCommand(
  provider: ProviderKind,
  settings: ProviderSettingsMap,
): ProviderSignInCommand | null {
  const spec = LOGIN_COMMANDS[provider];
  if (!spec) return null;
  return commandFromSpec(provider, spec, settings);
}

/** Resolve everything needed to spawn the login: the executable, its args, the
 *  home directory and the credential-safe env. A missing executable is a
 *  returned sentence, never a throw — it is the expected shape of "this CLI
 *  isn't installed". */
export function resolveProviderSignInLaunch(input: {
  provider: ProviderKind;
  settings: ProviderSettingsMap;
  env: NodeJS.ProcessEnv;
}): ProviderSignInLaunch {
  const spec = LOGIN_COMMANDS[input.provider];
  if (!spec) {
    return {
      ok: false,
      command: null,
      message: "Droid signs in on its first run — it has no login command.",
    };
  }
  const command = commandFromSpec(input.provider, spec, input.settings);

  const file = launchBinary(input.provider, input.settings, input.env);
  const located = locateBinary(file, input.env);
  if (!located.ok) return { ok: false, command, message: located.message };

  return {
    ok: true,
    file,
    args: [...spec.args],
    cwd: os.homedir(),
    env: signInEnv(input.env),
    banner: signInBanner(command),
    command,
  };
}
