// ── PTY adapter ──────────────────────────────────────────────────────────────
// A thin wrapper around node-pty: resolves the user's shell, builds a sane env
// (login-shell PATH, like the agent layer), and exposes the small surface the
// TerminalManager drives. kone runs on Electron's Node (not Bun), so node-pty
// is the only adapter — including on Windows, where node-pty's ConPTY binding
// is loaded directly (there is no Bun runtime path in the Electron main
// not apply here).

import { existsSync } from "node:fs";

import * as nodePty from "node-pty";

import { buildAgentEnv } from "../agent/processEnv.js";

/** Env keys carrying the *host* terminal's identity. We inherit the user's full
 *  environment (PATH, toolchains) but must scrub these, then pin our own — the
 *  embedded shell is talking to xterm.js, not to iTerm/Ghostty/VS Code. An
 *  inherited `TERM=xterm-ghostty` makes curses apps bail with "unknown terminal
 *  type" and redraw as garbage, and an inherited `NO_COLOR`/`FORCE_COLOR` from a
 *  harness shell breaks colour. */
const HOST_TERMINAL_ENV_BLOCKLIST = [
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
] as const;

export type PtyProcess = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): () => void;
};

export type PtySpawnInput = {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
};

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
 *  missing binary, so we walk the fallback list (both references do the same)
 *  rather than failing hard on a missing $SHELL. Bare names (no slash) are left
 *  for node-pty to resolve via PATH. */
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

/** Spawn a login PTY shell in `cwd` with the recovered login-shell PATH. */
export async function spawnPty(input: PtySpawnInput): Promise<PtyProcess> {
  const { shell, args } = await resolveShell();
  const baseEnv = await buildAgentEnv();
  const env: Record<string, string | undefined> = { ...baseEnv, ...input.env };
  // Scrub the host terminal's identity, then pin our own so curses apps (vim,
  // top) and colour output match the embedded xterm.js — see the blocklist note.
  for (const key of HOST_TERMINAL_ENV_BLOCKLIST) delete env[key];
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";

  const pty = nodePty.spawn(shell, args, {
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    env,
    // String encoding so onData delivers strings (xterm writes strings).
    encoding: "utf8",
    name: process.platform === "win32" ? "xterm-color" : "xterm-256color",
  });

  let dataDisposer: nodePty.IDisposable | null = null;
  let exitDisposer: nodePty.IDisposable | null = null;

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
    onData: (cb) => {
      dataDisposer = pty.onData(cb);
      return () => dataDisposer?.dispose();
    },
    onExit: (cb) => {
      exitDisposer = pty.onExit(cb);
      return () => exitDisposer?.dispose();
    },
  };
}
