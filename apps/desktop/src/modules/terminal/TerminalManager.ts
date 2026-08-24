// ── Terminal session manager ─────────────────────────────────────────────────
// The server-side heart of the integrated terminal. Owns one PTY session per
// open terminal column, replays scrollback on (re)attach, and pushes a single
// TerminalEvent stream the IPC layer fans out to renderers — the direct
// analogue of the agent layer's AgentService.
//
// Per-session state keyed by id, output batching, kill escalation
// (SIGTERM → SIGKILL on the whole process tree), renderer-ACK backpressure,
// history sanitization + mode-replay preambles, subprocess-activity polling,
// and an in-memory scrollback cap. kone keeps history in memory (capped) for
// replay rather than persisting to log files — a deliberate v1 simplification;
// sanitizing + persisting scrollback to disk can be layered on later.
//
// Data model: per-session monotonic `sequence` numbers so renderers can dedupe
// re-attach snapshots, an `activity` event when a real subprocess starts/stops
// under the shell, and ACK-based PTY pause/resume so a slow renderer can't
// balloon memory.

import { inspectSubprocessActivityAsync, killProcessTree } from "@kone/git-core/processTree.js";
import { createModeReplayTracker, type ModeReplayTracker } from "./modeReplay.js";
import { sanitizeTerminalHistoryChunk } from "./sanitize.js";
import { spawnPty, type PtyProcess } from "./Pty.js";
import type {
  EmitTerminalEvent,
  TerminalAckInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./types.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Max bytes of sanitized output retained for scrollback replay. ~512KB — enough
 *  for a long build's worth of scrollback without unbounded growth. */
const HISTORY_CAP = 512 * 1024;
/** Coalesce raw PTY output and flush at ~60fps (or sooner on a big burst) so a
 *  noisy command doesn't fire one IPC message per read. A 16ms / size-cap
 *  batch: parsing/history/emit cost then scales with batches (~60/s), not with
 *  the raw chunk count. */
const OUTPUT_FLUSH_INTERVAL_MS = 16;
const OUTPUT_FLUSH_SIZE = 64 * 1024;

// ── Renderer-ACK backpressure ────────────────────────────────────────────────
/** Pause the PTY when the renderer hasn't acked this many bytes of output. */
const ACK_HIGH_WATERMARK = 100_000;
/** Resume once unacked output drains below this. */
const ACK_LOW_WATERMARK = 5_000;
/** If no ack arrives within this window while paused, force-resume — the
 *  renderer may have detached; each ack resets the countdown. */
const ACK_FORCE_RESUME_TIMEOUT_MS = 10_000;

/** Poll cadence for subprocess-activity detection under each running shell. */
const SUBPROCESS_POLL_INTERVAL_MS = 1_000;

type TerminalSession = {
  terminalId: string;
  process: PtyProcess;
  cwd: string;
  /** Extra env the session was opened with — re-passed on restart so a shell
   *  never silently loses its environment. */
  env?: Record<string, string>;
  cols: number;
  rows: number;
  status: "starting" | "ready" | "exited" | "closed" | "error";
  /** Sanitized scrollback (queries stripped) — the replay half of `history`. */
  history: string;
  /** Tail of a control sequence split across chunks, held between onData
   *  calls so sanitization never drops half a sequence. */
  pendingControlSequence: string;
  /** Raw chunks buffered since the last flush, plus the sanitized text they
   *  contribute — the renderer gets the raw bytes, history gets the text. */
  pendingOutput: Array<{ raw: string; sanitized: string }>;
  pendingLength: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  detachData: () => void;
  detachExit: () => void;
  /** Monotonic event counter — never resets, so re-attach dedupe works even
   *  across restarts. */
  sequence: number;
  exitCode: number | null;
  exitSignal: number | null;
  hasRunningSubprocess: boolean;
  childCommandLabel: string | null;
  /** Output bytes emitted but not yet acked by the renderer. */
  unackedBytes: number;
  paused: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** Headless xterm tracking live terminal modes for the replay preamble. */
  modeTracker: ModeReplayTracker;
};

type TerminalManagerOptions = {
  /** Test seam: how a PTY is spawned. Defaults to the real node-pty path. */
  spawn?: typeof spawnPty;
};

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private emit: EmitTerminalEvent | null = null;
  private spawn: typeof spawnPty;

  constructor(options: TerminalManagerOptions = {}) {
    this.spawn = options.spawn ?? spawnPty;
  }

  /** Register the single event sink. Called once from the IPC layer. */
  onEvent(emit: EmitTerminalEvent): void {
    this.emit = emit;
  }

  private fire(event: TerminalEvent): void {
    this.emit?.(event);
  }

  /** Stamp an event with the session's next sequence number. */
  private stamp<T extends { terminalId: string }>(
    s: TerminalSession,
    event: T,
  ): T & { sequence: number } {
    s.sequence += 1;
    return { ...event, sequence: s.sequence };
  }

  private snapshot(s: TerminalSession): TerminalSessionSnapshot {
    return {
      terminalId: s.terminalId,
      pid: s.process.pid,
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd,
      status: s.status,
      // Mode-restoring preamble first, then the sanitized scrollback — feeding
      // this verbatim replays a fresh xterm into the same input state the live
      // one was in (app cursor keys, bracketed paste, kitty flags, …).
      history: s.modeTracker.buildPreamble() + s.history,
      sequence: s.sequence,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
      hasRunningSubprocess: s.hasRunningSubprocess,
      childCommandLabel: s.childCommandLabel,
    };
  }

  /** Append sanitized output to the in-memory scrollback, trimming the head
   *  when it exceeds the cap so replay stays bounded. */
  private appendHistory(s: TerminalSession, data: string): void {
    s.history += data;
    if (s.history.length > HISTORY_CAP) {
      s.history = s.history.slice(s.history.length - HISTORY_CAP);
    }
  }

  /** Buffer a raw PTY chunk; flush now if the batch is large, else arm the
   *  ~60fps timer. */
  private queueOutput(s: TerminalSession, raw: string, sanitized: string): void {
    s.pendingOutput.push({ raw, sanitized });
    s.pendingLength += raw.length;
    if (s.pendingLength >= OUTPUT_FLUSH_SIZE) {
      this.flushOutput(s);
      return;
    }
    if (s.flushTimer === null) {
      s.flushTimer = setTimeout(() => this.flushOutput(s), OUTPUT_FLUSH_INTERVAL_MS);
    }
  }

  /** Drain the pending buffer into history and emit one `output` event. The
   *  renderer gets the raw bytes; only history stores the sanitized text. Also
   *  called before snapshotting/exit so nothing is left unsent or unrecorded. */
  private flushOutput(s: TerminalSession): void {
    if (s.flushTimer !== null) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (s.pendingOutput.length === 0) return;
    let raw = "";
    let sanitized = "";
    for (const chunk of s.pendingOutput) {
      raw += chunk.raw;
      sanitized += chunk.sanitized;
    }
    s.pendingOutput = [];
    s.pendingLength = 0;
    this.appendHistory(s, sanitized);
    this.accountOutput(s, raw.length);
    this.fire(this.stamp(s, { terminalId: s.terminalId, type: "output", data: raw }));
  }

  // ── Renderer-ACK backpressure ─────────────────────────────────────────────
  /** Track emitted bytes; pause the PTY once the renderer falls too far
   *  behind (it can't ack what it hasn't received). */
  private accountOutput(s: TerminalSession, byteCount: number): void {
    s.unackedBytes += byteCount;
    if (!s.paused && s.unackedBytes >= ACK_HIGH_WATERMARK) {
      s.paused = true;
      s.process.pause();
      this.armForceResume(s);
    }
  }

  /** If no ack arrives within the window, resume anyway — the renderer may be
   *  gone, and a stalled shell is worse than a burst. Each ack re-arms. */
  private armForceResume(s: TerminalSession): void {
    if (s.ackTimer !== null) clearTimeout(s.ackTimer);
    s.ackTimer = setTimeout(() => {
      s.ackTimer = null;
      if (s.paused) {
        s.paused = false;
        s.process.resume();
      }
    }, ACK_FORCE_RESUME_TIMEOUT_MS);
  }

  /** Renderer consumed output; resume once it catches up. */
  ack(input: TerminalAckInput): void {
    const s = this.sessions.get(input.terminalId);
    if (!s) return;
    s.unackedBytes = Math.max(0, s.unackedBytes - input.byteCount);
    if (s.paused) {
      if (s.unackedBytes < ACK_LOW_WATERMARK) {
        s.paused = false;
        s.process.resume();
      }
      this.armForceResume(s);
    }
  }

  // ── Subprocess-activity polling ───────────────────────────────────────────
  private schedulePoll(s: TerminalSession): void {
    if (s.pollTimer !== null) return;
    s.pollTimer = setTimeout(() => {
      s.pollTimer = null;
      void this.pollSubprocessActivity(s);
    }, SUBPROCESS_POLL_INTERVAL_MS);
  }

  private async pollSubprocessActivity(s: TerminalSession): Promise<void> {
    if (s.status !== "ready") return;
    const inspection = await inspectSubprocessActivityAsync(s.process.pid);
    // Only trust an "idle" reading when the process snapshot actually
    // succeeded; a failed capture means absence is unproven, so keep the last
    // known state rather than flashing the busy state off.
    if (!inspection.captureComplete) {
      this.schedulePoll(s);
      return;
    }
    if (
      inspection.hasRunningSubprocess !== s.hasRunningSubprocess ||
      inspection.childCommandLabel !== s.childCommandLabel
    ) {
      s.hasRunningSubprocess = inspection.hasRunningSubprocess;
      s.childCommandLabel = inspection.childCommandLabel;
      this.fire(
        this.stamp(s, {
          terminalId: s.terminalId,
          type: "activity",
          hasRunningSubprocess: s.hasRunningSubprocess,
          childCommandLabel: s.childCommandLabel,
        }),
      );
    }
    this.schedulePoll(s);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /** Open (or re-attach to) a terminal. If the session already lives and is
   *  running, returns its snapshot for replay; otherwise spawns a fresh PTY. */
  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const existing = this.sessions.get(input.terminalId);
    if (existing && existing.status !== "exited" && existing.status !== "closed") {
      // Re-attach: flush any buffered output so the snapshot's history is
      // current, then re-emit a `started` event carrying the session's current
      // sequence. The client always seeds its replay buffer from this event, so
      // a reconnecting renderer paints the full scrollback without racing the
      // returned promise — and can use the sequence to drop a stale re-seed.
      this.flushOutput(existing);
      if (input.cols && input.rows) {
        this.resize({ terminalId: input.terminalId, cols: input.cols, rows: input.rows });
      }
      const snap = this.snapshot(existing);
      this.fire(this.stamp(existing, { terminalId: input.terminalId, type: "started", snapshot: snap }));
      return snap;
    }

    const session = await this.spawnSession(input);
    const snap = this.snapshot(session);
    this.fire(this.stamp(session, { terminalId: input.terminalId, type: "started", snapshot: snap }));
    this.schedulePoll(session);
    return snap;
  }

  /** Spawn a fresh PTY for `terminalId` and wire the session's handlers. Used
   *  by both open (new session) and restart (replacing the old one). */
  private async spawnSession(input: TerminalOpenInput): Promise<TerminalSession> {
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    let process: PtyProcess;
    try {
      process = await this.spawn({
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
        sequence: 0,
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
      pendingControlSequence: "",
      pendingOutput: [],
      pendingLength: 0,
      flushTimer: null,
      detachData: () => {},
      detachExit: () => {},
      sequence: 0,
      exitCode: null,
      exitSignal: null,
      hasRunningSubprocess: false,
      childCommandLabel: null,
      unackedBytes: 0,
      paused: false,
      ackTimer: null,
      pollTimer: null,
      modeTracker: createModeReplayTracker(cols, rows),
    };
    if (input.env) session.env = input.env;

    session.detachData = process.onData((data) => {
      // Raw bytes feed the mode tracker (it must see queries to track kitty
      // flags etc.) and go to the renderer; history only stores the sanitized
      // text so a replay can't re-trigger a shell reply.
      session.modeTracker.feed(data);
      const sanitized = sanitizeTerminalHistoryChunk(session.pendingControlSequence, data);
      session.pendingControlSequence = sanitized.pendingControlSequence;
      this.queueOutput(session, data, sanitized.visibleText);
    });
    session.detachExit = process.onExit(({ exitCode, signal }) => {
      // Drain buffered output before the exit line so the shell's last bytes
      // aren't lost behind the batch timer, then stop the activity poll.
      this.flushOutput(session);
      if (session.pollTimer !== null) {
        clearTimeout(session.pollTimer);
        session.pollTimer = null;
      }
      session.status = "exited";
      session.exitCode = exitCode !== undefined && exitCode !== null && Number.isFinite(exitCode) ? exitCode : null;
      session.exitSignal = signal !== undefined && signal !== null && Number.isFinite(signal) ? signal : null;
      this.fire(
        this.stamp(session, {
          terminalId: session.terminalId,
          type: "exited",
          exitCode: session.exitCode,
          signal: session.exitSignal ?? undefined,
        }),
      );
    });

    this.sessions.set(input.terminalId, session);
    return session;
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
    s.modeTracker.resize(input.cols, input.rows);
  }

  /** Restart a terminal in place: tree-kill the current process, reset all
   *  session state, and spawn a fresh shell. The sequence counter is carried
   *  forward so re-attach dedupe still holds across the reset. */
  async restart(input: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const s = this.sessions.get(input.terminalId);
    if (!s) throw new Error(`No terminal session '${input.terminalId}' to restart.`);

    // Detach the session's own observers before forcing the PTY to die, so the
    // deliberate kill can't masquerade as a natural shell exit and emit a
    // spurious `exited` event mid-restart.
    if (s.flushTimer !== null) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (s.ackTimer !== null) {
      clearTimeout(s.ackTimer);
      s.ackTimer = null;
    }
    if (s.pollTimer !== null) {
      clearTimeout(s.pollTimer);
      s.pollTimer = null;
    }
    s.detachData();
    s.detachExit();
    s.modeTracker.dispose();
    await this.killSession(s);
    const carriedSequence = s.sequence;

    const restartInput: TerminalOpenInput = {
      terminalId: input.terminalId,
      cwd: input.cwd ?? s.cwd,
      cols: input.cols ?? s.cols,
      rows: input.rows ?? s.rows,
    };
    if (s.env) restartInput.env = s.env;
    const spawn = await this.spawnSession(restartInput);
    spawn.sequence = carriedSequence;

    const snap = this.snapshot(spawn);
    this.fire(
      this.stamp(spawn, { terminalId: input.terminalId, type: "restarted", snapshot: snap }),
    );
    this.schedulePoll(spawn);
    return snap;
  }

  /** Close a terminal: tree-kill the PTY (SIGTERM → SIGKILL), detach, and
   *  drop it. */
  async close(input: TerminalCloseInput): Promise<void> {
    const s = this.sessions.get(input.terminalId);
    if (!s) return;
    if (s.flushTimer !== null) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (s.ackTimer !== null) {
      clearTimeout(s.ackTimer);
      s.ackTimer = null;
    }
    if (s.pollTimer !== null) {
      clearTimeout(s.pollTimer);
      s.pollTimer = null;
    }
    // Detach the session's own observers before forcing the PTY to die, so the
    // deliberate kill can't masquerade as a natural shell exit and emit a
    // spurious `exited` event during a deliberate close.
    s.detachData();
    s.detachExit();
    s.modeTracker.dispose();
    await this.killSession(s);
    s.status = "closed";
    if (input.deleteHistory) s.history = "";
    this.sessions.delete(input.terminalId);
    this.fire(this.stamp(s, { terminalId: input.terminalId, type: "closed" }));
  }

  /** SIGTERM on the whole process tree with a 1s grace, then SIGKILL on the
   *  tree — which reaps both the children that ignored SIGTERM and any the shell
   *  started during the grace period, so no `npm run dev` grandchild outlives
   *  the tab. The one-shot exit listener disposes itself, so repeated kills can't
   *  leak listeners. */
  private async killSession(s: TerminalSession): Promise<void> {
    if (s.paused) {
      s.paused = false;
      s.process.resume();
    }
    const pid = s.process.pid;
    killProcessTree(pid, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killProcessTree(pid, "SIGKILL");
        resolve();
      }, 1000);
      const detach = s.process.onExit(() => {
        clearTimeout(timer);
        detach();
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
