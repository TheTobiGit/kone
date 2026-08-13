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
  /** Replay payload: a mode-restoring preamble followed by the sanitized,
   *  accumulated output (queries stripped, ANSI styling intact) capped to a
   *  byte ceiling. Safe to feed xterm verbatim — it can't re-trigger a reply
   *  the shell would echo as junk. */
  history: string;
  /** Monotonic per-session event counter at snapshot time. Renderers use it to
   *  drop a stale re-seed (the manager re-emits `started` on re-attach). */
  sequence: number;
  exitCode: number | null;
  exitSignal: number | null;
  /** True while a non-shell subprocess (vim, `npm run dev`) is alive under the
   *  PTY. Drives the strip's busy state. */
  hasRunningSubprocess: boolean;
  /** Normalized command name of that subprocess, when known. */
  childCommandLabel: string | null;
};

/** One terminal event pushed on the "terminal:event" channel. */
export type TerminalEvent =
  | { terminalId: TerminalId; type: "started"; sequence: number; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "output"; sequence: number; data: string }
  | { terminalId: TerminalId; type: "exited"; sequence: number; exitCode: number | null; signal?: number }
  | { terminalId: TerminalId; type: "error"; sequence: number; message: string }
  | { terminalId: TerminalId; type: "restarted"; sequence: number; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "closed"; sequence: number }
  | {
      terminalId: TerminalId;
      type: "activity";
      sequence: number;
      hasRunningSubprocess: boolean;
      childCommandLabel: string | null;
    };

/** Restart a terminal in place: tree-kill the current process, reset history,
 *  spawn a fresh shell. `cwd`/`cols`/`rows` fall back to the session's own. */
export type TerminalRestartInput = {
  terminalId: TerminalId;
  cwd?: string;
  cols?: number;
  rows?: number;
};

/** Renderer flow-control ack: the renderer consumed `byteCount` bytes of an
 *  `output` event. Lets the manager pause/resume the PTY when the renderer
 *  falls behind (backpressure). */
export type TerminalAckInput = {
  terminalId: TerminalId;
  byteCount: number;
};

/** Sink the manager pushes events into; the IPC layer fans them to renderers. */
export type EmitTerminalEvent = (event: TerminalEvent) => void;
