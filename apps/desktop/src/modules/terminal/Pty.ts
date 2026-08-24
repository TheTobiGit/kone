// ── PTY adapter ──────────────────────────────────────────────────────────────
// A thin wrapper around node-pty: resolves the user's shell, builds a sane env
// (login-shell PATH, like the agent layer), and exposes the small surface the
// TerminalManager drives. kone runs on Electron's Node (not Bun), so node-pty
// is the only adapter — including on Windows, where node-pty's ConPTY binding
// is loaded directly (there is no Bun runtime path in the Electron main
// not apply here).

import { existsSync } from "node:fs";

import * as nodePty from "node-pty";

import { buildAgentEnv } from "../../agent/processEnv.js";

/** Env keys carrying the *host* terminal's identity, plus Electron/dev-server
 *  runtime vars. We inherit the user's full environment (PATH, toolchains) but
 *  must scrub these, then pin our own — the embedded shell is talking to
 *  xterm.js, not to iTerm/Ghostty/VS Code. An inherited `TERM=xterm-ghostty`
 *  makes curses apps bail with "unknown terminal type" and redraw as garbage,
 *  and an inherited `NO_COLOR`/`FORCE_COLOR` from a harness shell breaks
 *  colour. Electron runtime vars and the dev server's `PORT` must not leak
 *  into the shell either: a shell inheriting `ELECTRON_RUN_AS_NODE` can
 *  misbehave (it flips any Electron binary it spawns into Node mode), and
 *  `ELECTRON_RENDERER_PORT`/`PORT` would collide with the dev server. */
const HOST_TERMINAL_ENV_BLOCKLIST: ReadonlySet<string> = new Set([
  "TERM",
  "TERMINFO",
  "TERMINFO_DIRS",
  "TERMCAP",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "ITERM_PROFILE",
  "ITERM_SESSION_ID",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "ALACRITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR",
  "VTE_VERSION",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "PORT",
]);

export type PtyProcess = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** Pause the child's data flow — node-pty stops emitting onData until
   *  resume() is called. Used for backpressure. */
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): () => void;
};

export type PtySpawnInput = {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
};

/** The subscription surface a PTY must expose for createPtySubscriptions to
 *  wrap. node-pty's onData/onExit already return a fresh IDisposable per
 *  registration, so this is just a shape both the real pty and fakes satisfy. */
export type NodePtyEventSource = {
  onData(listener: (data: string) => void): nodePty.IDisposable;
  onExit(
    listener: (ev: { exitCode: number; signal?: number }) => void,
  ): nodePty.IDisposable;
};

/** The event subscription surface createPtySubscriptions builds: each method
 *  registers one listener and returns its own unsubscribe closure. */
export type PtySubscriptions = {
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (ev: { exitCode: number; signal?: number }) => void): () => void;
};

/** Wrap a PTY's event registrations so each unsubscribe owns exactly its own
 *  registration. Each returned closure captures the IDisposable handed back by
 *  that single onData/onExit call, so disposing one handler can never release
 *  a handler registered later (or earlier) on the same event. */
export function createPtySubscriptions(source: NodePtyEventSource): PtySubscriptions {
  return {
    onData: (listener) => {
      const disposer = source.onData(listener);
      return () => disposer.dispose();
    },
    onExit: (listener) => {
      const disposer = source.onExit(listener);
      return () => disposer.dispose();
    },
  };
}

/** Shell candidates in fallback order — the user's $SHELL first, then common
 */
function shellCandidates(): string[] {
  if (process.platform === "win32") {
    return ["pwsh.exe", "powershell.exe", "cmd.exe"];
  }
  const fromEnv = process.env.SHELL;
  const base = ["/bin/zsh", "/bin/bash", "/bin/sh"];
  return fromEnv ? [fromEnv, ...base] : base;
}

/** Login args for a resolved shell. zsh gets `nopromptsp` so it doesn't emit the
 *  partial-line save/restore sequence that corrupts xterm's first prompt line
 */
function shellArgs(shell: string): string[] {
  const name = shell.toLowerCase();
  if (name.endsWith("cmd.exe")) return [];
  if (name.endsWith("zsh")) return ["-l", "-o", "nopromptsp"];
  return ["-l"];
}

/** The first shell candidate that actually exists on disk. node-pty throws on a
 *  missing binary, so we walk the fallback list rather than failing hard on a
 *  missing $SHELL. Bare names (no slash) are left for node-pty to resolve via
 *  PATH. */
async function resolveShell(): Promise<{ shell: string; args: string[] }> {
  const candidates = shellCandidates();
  for (const shell of candidates) {
    const isPath = shell.includes("/") || shell.includes("\\");
    if (!isPath || existsSync(shell)) {
      return { shell, args: shellArgs(shell) };
    }
  }
  const fallback = candidates[candidates.length - 1] ?? "/bin/sh";
  return { shell: fallback, args: shellArgs(fallback) };
}

/** Build the env for the embedded shell: scrub the host terminal's identity
 *  and Electron/dev-server runtime vars from `baseEnv`, let `extra` (caller
 *  env) win, then pin our own TERM/COLORTERM so curses apps (vim, top) and
 *  colour output match the embedded xterm.js — see the blocklist note. Pure
 *  so the pipeline is testable without spawning a real shell. */
export function buildPtyEnv(
  baseEnv: Record<string, string | undefined>,
  extra?: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (HOST_TERMINAL_ENV_BLOCKLIST.has(key)) continue;
    env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) env[key] = value;
  }
  // node-pty only writes `name` into the child's TERM on the Unix path; the
  // ConPTY path leaves the environment untouched, so Windows children inherit
  // a missing or 16-color TERM unless it is set here.
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/** Spawn a login PTY shell in `cwd` with the recovered login-shell PATH. */
export async function spawnPty(input: PtySpawnInput): Promise<PtyProcess> {
  const { shell, args } = await resolveShell();
  const env = buildPtyEnv(await buildAgentEnv(), input.env);

  const pty = nodePty.spawn(shell, args, {
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    env,
    // String encoding so onData delivers strings (xterm writes strings).
    encoding: "utf8",
    name: "xterm-256color",
  });

  const subs = createPtySubscriptions(pty);

  return {
    pid: pty.pid,
    cols: pty.cols,
    rows: pty.rows,
    write: (data: string) => pty.write(data),
    resize: (cols: number, rows: number) => pty.resize(cols, rows),
    kill: (signal?: string) => {
      try {
        pty.kill(signal);
      } catch {
        // Already dead — nothing to do.
      }
    },
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    onData: subs.onData,
    onExit: subs.onExit,
  };
}
