// ── Terminal data model ──────────────────────────────────────────────────────
// The contract for kone's integrated terminal. A terminal is a first-class
// column in the thread strip (niri-style), not a bottom drawer — with the
// PTY/transport model built on node-pty on the main process, xterm.js in the
// renderer, and one pushed event stream on the "terminal:event" IPC channel
// (mirroring how the agent layer fans out "agent:event").
//
// Everything here is flat + serializable — it all crosses the IPC boundary.
// Mirror any change in apps/web/app/types/desktop.d.ts.

/** Client-chosen, globally-unique terminal id (the renderer mints it, like
 *  thread ids in the agent layer). */
export type TerminalId = string;

export type TerminalStatus =
  | "starting"
  | "ready"
  | "exited"
  | "closed"
  | "error";

/** Open a PTY shell. `cwd` is the project root the strip column belongs to. */
export type TerminalOpenInput = {
  terminalId: TerminalId;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Extra env merged over the inherited + login-shell PATH env. */
  env?: Record<string, string>;
};

export type TerminalWriteInput = {
  terminalId: TerminalId;
  /** Raw bytes the user typed in xterm (already includes escape sequences). */
  data: string;
};

export type TerminalResizeInput = {
  terminalId: TerminalId;
  cols: number;
  rows: number;
};

export type TerminalCloseInput = {
  terminalId: TerminalId;
  /** Drop the persisted scrollback too (a "close terminal" vs "hide"). */
  deleteHistory?: boolean;
};

/** A point-in-time snapshot of one terminal — what the renderer replays on
 *  (re)attach so a column that was hidden keeps its scrollback. */
export type TerminalSessionSnapshot = {
  terminalId: TerminalId;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
  status: TerminalStatus;
  /** Accumulated raw output (ANSI intact) capped to a byte ceiling, replayed
   *  into xterm on attach so the terminal shows its prior scrollback. */
  history: string;
};

/** One terminal event pushed on the "terminal:event" channel. */
export type TerminalEvent =
  | { terminalId: TerminalId; type: "started"; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "output"; data: string }
  | { terminalId: TerminalId; type: "exited"; exitCode: number | null; signal?: number }
  | { terminalId: TerminalId; type: "error"; message: string }
  | { terminalId: TerminalId; type: "cleared" }
  | { terminalId: TerminalId; type: "restarted"; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "closed" };

/** Sink the manager pushes events into; the IPC layer fans them to renderers. */
export type EmitTerminalEvent = (event: TerminalEvent) => void;
