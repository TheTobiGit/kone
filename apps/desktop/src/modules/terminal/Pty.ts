// ── PTY adapter ──────────────────────────────────────────────────────────────
// A thin wrapper around node-pty: resolves the user's shell, builds a sane env
// (login-shell PATH, like the agent layer), and exposes the small surface the
// TerminalManager drives. kone runs on Electron's Node (not Bun), so node-pty
// is the only adapter — including on Windows, where node-pty's ConPTY binding
// is loaded directly (there is no Bun runtime path in the Electron main
// not apply here).

import { existsSync } from "node:fs";

import type * as NodePty from "node-pty";

import { buildAgentEnv } from "@kone/agent-core/processEnv.js";

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
  /** When true, `env` is the COMPLETE child environment: no inherited base is
   *  merged in. Used by the main process's provider sign-in path, whose env has
   *  already had browser suppressors and runtime vars removed — merging over a
   *  fresh `buildAgentEnv()` would put them straight back. */
  completeEnv?: boolean;
  /** Run this program instead of the user's login shell. Used by the main
   *  process's provider sign-in path — never forwarded from renderer IPC.
   *  `args` may be a pre-built command line STRING: a Windows `.cmd`/`.bat`
   *  login runs through cmd.exe, and node-pty appends a string verbatim while
   *  it would re-quote an array for CommandLineToArgvW (see agent-core's
   *  providerSignIn). */
  command?: { file: string; args: string[] | string };
};

/** The subscription surface a PTY must expose for createPtySubscriptions to
 *  wrap. node-pty's onData/onExit already return a fresh IDisposable per
 *  registration, so this is just a shape both the real pty and fakes satisfy. */
export type NodePtyEventSource = {
  onData(listener: (data: string) => void): NodePty.IDisposable;
  onExit(
    listener: (ev: { exitCode: number; signal?: number }) => void,
  ): NodePty.IDisposable;
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
async function resolveShell(): Promise<{ file: string; args: string[] }> {
  const candidates = shellCandidates();
  for (const file of candidates) {
    const isPath = file.includes("/") || file.includes("\\");
    if (!isPath || existsSync(file)) {
      return { file, args: shellArgs(file) };
    }
  }
  const fallback = candidates[candidates.length - 1] ?? "/bin/sh";
  return { file: fallback, args: shellArgs(fallback) };
}

/** Build the env for the embedded shell: scrub the host terminal's identity
 *  and Electron/dev-server runtime vars from `baseEnv`, let `extra` (caller
 *  env) win, then pin our own TERM/COLORTERM so curses apps (vim, top) and
 *  colour output match the embedded xterm.js — see the blocklist note.
 *
 *  `extra` is scrubbed too: a caller env is not an escape hatch for the
 *  runtime vars the blocklist exists to keep out (`ELECTRON_RUN_AS_NODE`,
 *  `PORT`, …). With `options.complete`, `baseEnv` is ignored entirely: the
 *  caller has built the whole environment and merging would restore what it
 *  removed. Pure so the pipeline is testable without spawning a real shell. */
export function buildPtyEnv(
  baseEnv: Record<string, string | undefined>,
  extra?: Record<string, string> | undefined,
  options: { complete?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!options.complete) {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (HOST_TERMINAL_ENV_BLOCKLIST.has(key)) continue;
      env[key] = value;
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (HOST_TERMINAL_ENV_BLOCKLIST.has(key)) continue;
      env[key] = value;
    }
  }
  // node-pty only writes `name` into the child's TERM on the Unix path; the
  // ConPTY path leaves the environment untouched, so Windows children inherit
  // a missing or 16-color TERM unless it is set here.
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/** The final child env for one spawn: complete envs replace, ordinary terminals
 *  inherit. Shared with the tests so the launch → PTY pipeline is asserted
 *  through the same branch spawnPty takes. */
export function resolvePtyEnv(
  input: Pick<PtySpawnInput, "env" | "completeEnv">,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  return buildPtyEnv(baseEnv, input.env, { complete: input.completeEnv === true });
}

/** Spawn a login PTY shell in `cwd` with the recovered login-shell PATH. When
 *  `input.command` names a program, spawn that instead — the shell's arguments
 *  (`-l`, zsh's `nopromptsp`) belong to a shell, not to an arbitrary CLI. */
export async function spawnPty(input: PtySpawnInput): Promise<PtyProcess> {
  const { file, args } = input.command ?? (await resolveShell());
  // A complete env comes from a main-process caller that already resolved the
  // login-shell PATH; skip the probe and the merge.
  const baseEnv = input.completeEnv ? {} : await buildAgentEnv();
  const env = resolvePtyEnv(input, baseEnv);
  // Loaded here, not at module scope: node-pty's native binding is absent in
  // some checkouts (and in every pure test run), and the pure helpers above
  // must stay importable without it. The real app always builds the binding.
  const nodePty = await import("node-pty");

  const pty = nodePty.spawn(file, args, {
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
