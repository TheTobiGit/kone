// ── Terminal session manager ─────────────────────────────────────────────────
// The server-side heart of the integrated terminal. Owns one PTY session per
// open terminal column, replays scrollback on (re)attach, and pushes a single
// TerminalEvent stream the IPC layer fans out to renderers — the direct
// analogue of the agent layer's AgentService.
//
// Borrowed from research's TerminalManager: per-session state keyed by id,
// output batching, kill escalation (SIGTERM → SIGKILL), and an in-memory
// scrollback cap. kone keeps history in memory (capped) for replay rather than
// persisting to log files — a deliberate v1 simplification; the references
// sanitize + persist scrollback to disk, which we can layer on later.

import { spawnPty, type PtyProcess } from "./Pty.js";
import type {
  EmitTerminalEvent,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./types.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Max bytes of raw output retained for scrollback replay. ~512KB — enough for
 *  a long build's worth of scrollback without unbounded growth. */
const HISTORY_CAP = 512 * 1024;
/** Coalesce raw PTY output and flush at ~60fps (or sooner on a big burst) so a
 *  noisy command doesn't fire one IPC message per read. Mirrors research's
 *  16ms / size-cap batch: parsing/history/emit cost then scales with batches
 *  (~60/s), not with the raw chunk count. */
const OUTPUT_FLUSH_INTERVAL_MS = 16;
const OUTPUT_FLUSH_SIZE = 64 * 1024;

type TerminalSession = {
  terminalId: string;
  process: PtyProcess;
  cwd: string;
  cols: number;
  rows: number;
  status: "starting" | "ready" | "exited" | "closed" | "error";
  history: string;
  /** Raw chunks buffered since the last flush, and their combined length. */
  pendingOutput: string[];
  pendingLength: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  detachData: () => void;
  detachExit: () => void;
};

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private emit: EmitTerminalEvent | null = null;

  /** Register the single event sink. Called once from the IPC layer. */
  onEvent(emit: EmitTerminalEvent): void {
    this.emit = emit;
  }

  private fire(event: TerminalEvent): void {
    this.emit?.(event);
  }

  private snapshot(s: TerminalSession): TerminalSessionSnapshot {
    return {
      terminalId: s.terminalId,
      pid: s.process.pid,
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd,
      status: s.status,
      history: s.history,
    };
  }

  /** Append output to the in-memory scrollback, trimming the head when it
   *  exceeds the cap so replay stays bounded. */
  private appendHistory(s: TerminalSession, data: string): void {
    s.history += data;
    if (s.history.length > HISTORY_CAP) {
      s.history = s.history.slice(s.history.length - HISTORY_CAP);
    }
  }

  /** Buffer a raw PTY chunk; flush now if the batch is large, else arm the
   *  ~60fps timer. */
  private queueOutput(s: TerminalSession, data: string): void {
    s.pendingOutput.push(data);
    s.pendingLength += data.length;
    if (s.pendingLength >= OUTPUT_FLUSH_SIZE) {
      this.flushOutput(s);
      return;
    }
    if (s.flushTimer === null) {
      s.flushTimer = setTimeout(() => this.flushOutput(s), OUTPUT_FLUSH_INTERVAL_MS);
    }
  }

  /** Drain the pending buffer into history and emit one `output` event. Also
   *  called before snapshotting/exit so nothing is left unsent or unrecorded. */
  private flushOutput(s: TerminalSession): void {
    if (s.flushTimer !== null) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (s.pendingOutput.length === 0) return;
    const data = s.pendingOutput.join("");
    s.pendingOutput = [];
    s.pendingLength = 0;
    this.appendHistory(s, data);
    this.fire({ terminalId: s.terminalId, type: "output", data });
  }

  /** Open (or re-attach to) a terminal. If the session already lives and is
   *  running, returns its snapshot for replay; otherwise spawns a fresh PTY. */
  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const existing = this.sessions.get(input.terminalId);
    if (existing && existing.status !== "exited" && existing.status !== "closed") {
      // Re-attach: flush any buffered output so the snapshot's history is
      // current, then re-emit a `started` event. The client always seeds its
      // replay buffer from this event, so a reconnecting renderer paints the
      // full scrollback without racing the returned promise.
      this.flushOutput(existing);
      if (input.cols && input.rows) this.resize({ terminalId: input.terminalId, cols: input.cols, rows: input.rows });
      const snap = this.snapshot(existing);
      this.fire({ terminalId: input.terminalId, type: "started", snapshot: snap });
      return snap;
    }

    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    let process: PtyProcess;
    try {
      process = await spawnPty({
        cwd: input.cwd,
        cols,
        rows,
        env: input.env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fire({
        terminalId: input.terminalId,
        type: "error",
        message: `Could not start terminal: ${message}`,
      });
      throw err;
    }

    const session: TerminalSession = {
      terminalId: input.terminalId,
      process,
      cwd: input.cwd,
      cols,
      rows,
      status: "ready",
      history: "",
      pendingOutput: [],
      pendingLength: 0,
      flushTimer: null,
      detachData: () => {},
      detachExit: () => {},
    };

    session.detachData = process.onData((data) => {
      this.queueOutput(session, data);
    });
    session.detachExit = process.onExit(({ exitCode, signal }) => {
      // Drain buffered output before the exit line so the shell's last bytes
      // aren't lost behind the batch timer.
      this.flushOutput(session);
      session.status = "exited";
      this.fire({
        terminalId: session.terminalId,
        type: "exited",
        exitCode,
        signal,
      });
    });

    this.sessions.set(input.terminalId, session);
    this.fire({ terminalId: input.terminalId, type: "started", snapshot: this.snapshot(session) });
    return this.snapshot(session);
  }

  write(input: TerminalWriteInput): void {
    this.sessions.get(input.terminalId)?.process.write(input.data);
  }

  resize(input: TerminalResizeInput): void {
    const s = this.sessions.get(input.terminalId);
    if (!s) return;
    s.cols = input.cols;
    s.rows = input.rows;
    s.process.resize(input.cols, input.rows);
  }

  /** Clear the renderer's scrollback + the in-memory history. */
  clear(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    if (s.flushTimer !== null) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    s.pendingOutput = [];
    s.pendingLength = 0;
    s.history = "";
    this.fire({ terminalId, type: "cleared" });
  }

  /** Close a terminal: kill the PTY (SIGTERM → SIGKILL), detach, and drop it. */
  async close(input: TerminalCloseInput): Promise<void> {
    const s = this.sessions.get(input.terminalId);
    if (!s) return;
    if (s.flushTimer !== null) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    await this.killSession(s);
    s.detachData();
    s.detachExit();
    s.status = "closed";
    if (input.deleteHistory) s.history = "";
    this.sessions.delete(input.terminalId);
    this.fire({ terminalId: input.terminalId, type: "closed" });
  }

   *  kill-escalation so a stubborn shell (vim holding the TTY) still dies. */
  private async killSession(s: TerminalSession): Promise<void> {
    s.process.kill(
      process.platform === "win32" ? undefined : "SIGTERM",
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          s.process.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 1000);
      s.process.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Kill every PTY — call on app quit so no shell is orphaned. */
  async disposeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((s) =>
        this.close({ terminalId: s.terminalId }).catch(() => {}),
      ),
    );
  }
}

let manager: TerminalManager | null = null;

/** The single TerminalManager instance (lazily created). */
export function getTerminalManager(): TerminalManager {
  if (!manager) manager = new TerminalManager();
  return manager;
}
