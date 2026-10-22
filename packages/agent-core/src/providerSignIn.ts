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

/** A renderer's request to start a login. The PTY id is MAIN-generated (see
 *  providerSignInController), so the renderer names only the provider and the
 *  initial grid; any `terminalId` here is IGNORED (kept optional for the
 *  browser-only dev stand-in). */
export type ProviderSignInStartInput = {
  provider: ProviderKind;
  /** @deprecated Ignored by the main process; sign-in ids are main-generated. */
  terminalId?: string;
  cols?: number;
  rows?: number;
};

/** Runtime schema for a start request — the IPC boundary's one gate. Only a
 *  known provider and optional grid size get through; an unknown `terminalId`
 *  is stripped, never trusted. */
export const ProviderSignInStartInputSchema: z.ZodType<ProviderSignInStartInput> = z.object({
  provider: ProviderKindSchema,
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

/** The resolved launch, or the plain sentence that says why there is none.
 *  `command` stays populated on a failure so the dialog can still show what it
 *  would have run (null only for a provider with no login subcommand). */
export type ProviderSignInLaunch =
  | {
      ok: true;
      /** Executable node-pty spawns, resolved: an absolute path for a custom
       *  binary, a PATH hit as found for a bare name. On Windows a `.cmd`/`.bat`
       *  target is replaced by cmd.exe itself — see `cmdLaunch`. */
      file: string;
      /** The argv. A pre-built STRING is the Windows batch case: cmd.exe gets
       *  one already-escaped command line, which node-pty appends verbatim,
       *  while an array would be re-quoted for CommandLineToArgvW and lose the
       *  carets. Every other launch is a plain argv array. */
      args: string[] | string;
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

/** What node-pty is handed for one spawn: the executable and either an argv
 *  array or (the Windows batch case) one pre-built command line. */
type SpawnTarget = { file: string; args: string[] | string };

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

/** Whether `filePath` is a real file the OS can execute. `platform` is the
 *  launch's platform, not the host's: a Windows target has no executable bit,
 *  so the X_OK check is skipped for win32 however the resolver is being run
 *  (the tests exercise the Windows path from Linux). */
function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (platform !== "win32") fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The RESOLVED executable for a configured or default binary name, or the
 *  sentence saying why there is none. The requested name is only for the
 *  message; what comes back is the absolute path node-pty should spawn, so a
 *  PATH hit can never be re-resolved to something else (or to a shell shim
 *  that isn't the file we just validated). */
function locateBinary(
  file: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { ok: true; found: string } | { ok: false; message: string } {
  if (hasPathSeparator(file)) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) return { ok: false, message: `${file} doesn't exist.` };
    if (!isExecutableFile(resolved, platform)) {
      return { ok: false, message: `${file} isn't executable.` };
    }
    return { ok: true, found: resolved };
  }
  const hit = findOnPathEntry(file, env, platform);
  if (!hit) return { ok: false, message: `${file} isn't on your PATH.` };
  if (!isExecutableFile(hit.found, platform)) {
    return { ok: false, message: `${file} isn't executable.` };
  }
  return { ok: true, found: hit.found };
}

// ── Windows batch shims ─────────────────────────────────────────────────────
// npm installs a CLI on Windows as a `.cmd` shim (next to a `.ps1`), not as an
// executable: a batch file is text the command interpreter reads, and
// CreateProcess cannot start one — node-pty's spawn would fail with EINVAL.
// So a resolved `.cmd`/`.bat` is replaced by the command interpreter, with the
// script as the first word of a single command line. The escaping below is
// cross-spawn's (lib/util/escape.js), which exists for exactly this case; Node
// documents the same requirement ("Spawning .bat and .cmd files on Windows").

/** What cmd.exe treats specially outside quotes. `^` is in the set, so the
 *  second escaping pass for batch targets also escapes the first pass's
 *  carets — that is intended, not double work (see `escapeCmdArgument`). */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** One argument as cmd.exe should see it, following cross-spawn's algorithm
 *  (itself based on https://qntm.org/cmd):
 *
 *  1. Backslashes before an embedded `"` are doubled and the quote escaped,
 *     and trailing backslashes are doubled — otherwise the closing quote we
 *     add next would be escaped by them.
 *  2. The whole argument is wrapped in quotes, so spaces and `&`/`|`/`;` stay
 *     one word.
 *  3. Every metacharacter is caret-escaped. `doubleEscapeMetaChars` does it a
 *     second time for a `.cmd`/`.bat` target: cmd.exe reads the line once, and
 *     the batch file's own re-parse (which the shim does when it forwards to
 *     node) would otherwise consume the carets. cross-spawn only does this for
 *     `node_modules\.bin\*.cmd`, but a global npm shim (`%APPDATA%\npm\codex.cmd`)
 *     forwards `%*` the same way, so every batch target here gets it. */
export function escapeCmdArgument(argument: string, doubleEscapeMetaChars = false): string {
  let escaped = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_CHARS, "^$1");
  return escaped;
}

/** The script path in command position. cross-spawn escapes metacharacters
 *  (spaces included) but adds no quotes: the `/d /s /c "…"` wrapper already
 *  delimits the line, and quotes here would nest inside that. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/** The command interpreter to run a batch shim: `ComSpec` under any casing
 *  (`ComSpec`, `COMSPEC`, `comspec` — Windows env keys are case-insensitive, a
 *  JS object is not), else the conventional `cmd.exe` on PATH. */
function commandInterpreter(env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "comspec" && value) return value;
  }
  return "cmd.exe";
}

/** What node-pty should actually spawn for a resolved executable path. Windows
 *  `.cmd`/`.bat` targets go through cmd.exe; everything else — a native `.exe`
 *  on Windows, any binary elsewhere — is spawned directly with its argv.
 *
 *  The batch case returns args as one STRING on purpose. node-pty's Windows
 *  path appends a string to the command line untouched, but re-quotes an argv
 *  ARRAY for CommandLineToArgvW, which escapes the `"` we built and would
 *  strip the carets cmd.exe has to see. The interpreter flags:
 *    • `/d` — skip AutoRun commands, so the user's registry can't inject a
 *      command ahead of the login.
 *    • `/s` — take the command line verbatim, stripping only the outer pair of
 *      quotes (hence the extra wrapping quotes around the whole line).
 *    • `/c` — run it and exit. */
function cmdLaunch(
  platform: NodeJS.Platform,
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnTarget {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args: [...args] };
  }
  const commandLine = [
    escapeCmdCommand(file),
    ...args.map((arg) => escapeCmdArgument(arg, true)),
  ].join(" ");
  return {
    file: commandInterpreter(env),
    args: `/d /s /c "${commandLine}"`,
  };
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

/** Words that a POSIX shell runs unchanged: no whitespace, quoting, expansion
 *  or control characters. Kept deliberately narrow (`$`, backtick, `'`, `"`,
 *  `;`, `&`, `(`, `)`, `|`, globs and `~`/`=`/`%` expansions all quote). */
const SAFE_POSIX_WORD = /^[A-Za-z0-9_@:./-]+$/;
/** The same for PowerShell: a Windows path's backslashes and drive colon are
 *  ordinary, but `$`, quotes, spaces and cmd/PowerShell metacharacters are not. */
const SAFE_WINDOWS_WORD = /^[A-Za-z0-9_@:./\\-]+$/;

/** Shell-quote one word for the command the user sees and copies. Spawning
 *  never parses this text — node-pty gets the executable plus argv, or (for a
 *  Windows batch shim) the cmd.exe line built by `cmdLaunch`, which has its own
 *  escaping. A configured `binaryPath` may contain spaces, quotes or
 *  metacharacters, and an unquoted display would paste as a different command
 *  (or run the wrong thing). Simple words stay bare so the common case reads
 *  exactly as before.
 *
 *  POSIX: single quotes, with an embedded `'` written as `'\''`. Nothing inside
 *  single quotes is expanded — `$`, backticks and `"` stay literal.
 *  Windows/PowerShell: single quotes too, with `'` doubled. PowerShell does not
 *  expand `$` inside single quotes either. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    if (SAFE_WINDOWS_WORD.test(value)) return value;
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (SAFE_POSIX_WORD.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command-position word. PowerShell needs the call operator `&` before a
 *  quoted executable path, otherwise a leading `'C:\…'` is a string
 *  expression, not a program to run. POSIX needs nothing extra. */
export function shellQuoteExecutable(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const quoted = shellQuote(file, platform);
  if (platform === "win32" && quoted !== file) return `& ${quoted}`;
  return quoted;
}

/** The complete copy/paste line: executable in command position, then argv. */
export function formatLoginCommand(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return [shellQuoteExecutable(file, platform), ...args.map((arg) => shellQuote(arg, platform))].join(
    " ",
  );
}

/** Build the dialog's command row from a provider's login spec — the one place
 *  the executable name, args and finish mode are joined. */
function commandFromSpec(
  provider: ProviderKind,
  spec: LoginSpec,
  settings: ProviderSettingsMap,
  platform: NodeJS.Platform,
): ProviderSignInCommand {
  return {
    provider,
    display: formatLoginCommand(binaryFor(provider, settings), spec.args, platform),
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
  platform: NodeJS.Platform = process.platform,
): ProviderSignInCommand | null {
  const spec = LOGIN_COMMANDS[provider];
  if (!spec) return null;
  return commandFromSpec(provider, spec, settings, platform);
}

/** Resolve everything needed to spawn the login: the executable, its args, the
 *  home directory and the credential-safe env. A missing executable is a
 *  returned sentence, never a throw — it is the expected shape of "this CLI
 *  isn't installed". */
export function resolveProviderSignInLaunch(input: {
  provider: ProviderKind;
  settings: ProviderSettingsMap;
  env: NodeJS.ProcessEnv;
  /** The platform the command runs on: it decides both the display/copy line's
   *  shell rules and how the executable is spawned (on win32, a `.cmd`/`.bat`
   *  shim is wrapped in cmd.exe). Defaults to the host's; injected by tests. */
  platform?: NodeJS.Platform;
}): ProviderSignInLaunch {
  const platform = input.platform ?? process.platform;
  const spec = LOGIN_COMMANDS[input.provider];
  if (!spec) {
    return {
      ok: false,
      command: null,
      message: "Droid signs in on its first run — it has no login command.",
    };
  }
  const command = commandFromSpec(input.provider, spec, input.settings, platform);

  const file = launchBinary(input.provider, input.settings, input.env);
  const located = locateBinary(file, input.env, platform);
  if (!located.ok) return { ok: false, command, message: located.message };
  const target = cmdLaunch(platform, located.found, spec.args, input.env);

  return {
    ok: true,
    file: target.file,
    args: target.args,
    cwd: os.homedir(),
    env: signInEnv(input.env),
    banner: signInBanner(command),
    command,
  };
}
