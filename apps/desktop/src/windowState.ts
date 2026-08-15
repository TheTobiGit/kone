import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "./atomicWrite.js";

import { app, type BrowserWindow, type Rectangle, screen } from "electron";

// Persists the main window's size / position between launches so the app
// reopens the way the user left it. State lives in a small JSON file under the
// per-user app data directory.

type WindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

const DEFAULT_STATE: WindowState = {
  width: 1280,
  height: 840,
};

const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

// How long a window must be idle after a resize/move before we write to disk.
const PERSIST_DEBOUNCE_MS = 400;

// How much of the window must overlap a display for a saved position to be
// reused — guards against restoring onto an unplugged monitor.
const VISIBLE_MARGIN_X = 100;
const VISIBLE_MARGIN_Y = 50;

let cachedPath: string | null = null;
function stateFilePath() {
  cachedPath ??= path.join(app.getPath("userData"), "window-state.json");
  return cachedPath;
}

function readState(): WindowState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(stateFilePath(), "utf8"),
    ) as Partial<WindowState>;

    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      return null;
    }

    return {
      width: parsed.width,
      height: parsed.height,
      x: typeof parsed.x === "number" ? parsed.x : undefined,
      y: typeof parsed.y === "number" ? parsed.y : undefined,
      isMaximized: parsed.isMaximized === true,
    };
  } catch {
    return null;
  }
}

// True if the window would remain grabbable on some currently-connected
// display — otherwise a window restored from an unplugged monitor would open
// off-screen.
function isVisibleOnSomeDisplay({ x, y, width }: Rectangle) {
  return screen.getAllDisplays().some(({ workArea: area }) => {
    return (
      x >= area.x - width + VISIBLE_MARGIN_X &&
      x <= area.x + area.width - VISIBLE_MARGIN_X &&
      y >= area.y - VISIBLE_MARGIN_Y &&
      y <= area.y + area.height - VISIBLE_MARGIN_Y
    );
  });
}

/**
 * Returns the BrowserWindow options (width / height / x / y) to open with,
 * derived from the last saved session and clamped to a sane minimum.
 */
export function getInitialWindowState(): WindowState {
  const saved = readState();
  if (!saved) {
    return { ...DEFAULT_STATE };
  }

  const width = Math.max(saved.width, MIN_WIDTH);
  const height = Math.max(saved.height, MIN_HEIGHT);

  const state: WindowState = { width, height, isMaximized: saved.isMaximized };

  if (
    saved.x !== undefined &&
    saved.y !== undefined &&
    isVisibleOnSomeDisplay({ x: saved.x, y: saved.y, width, height })
  ) {
    state.x = saved.x;
    state.y = saved.y;
  }

  return state;
}

/**
 * Starts tracking a window and persists its bounds whenever they change
 * (debounced) and on close.
 */
export function manageWindowState(win: BrowserWindow) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWritten = "";

  const persist = () => {
    if (win.isDestroyed()) return;

    // Keep the *normal* (unmaximized) bounds so restoring works after the user
    // un-maximizes; getNormalBounds() reports those even while maximized.
    const { width, height, x, y } = win.getNormalBounds();
    const serialized = JSON.stringify(
      { width, height, x, y, isMaximized: win.isMaximized() },
      null,
      2,
    );

    // that ended at the same bounds, or close after an already-saved resize).
    if (serialized === lastWritten) return;

    try {
      writeFileAtomicSync(stateFilePath(), serialized);
      lastWritten = serialized;
    } catch {
      // Persisting window state is best-effort; never crash the app over it.
    }
  };

  const schedulePersist = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
  };

  win.on("resize", schedulePersist);
  win.on("move", schedulePersist);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    persist();
  });
}

// ── Renderer crash recovery gate ─────────────────────────────────────────────
// Long sessions can OOM the Electron renderer at V8's heap ceiling, leaving a
// dead white window while agent CLIs and terminal PTYs (which live in this
// process) keep running. Recovery = reload after a short delay; the gate below
// bounds those reloads (MAX_ATTEMPTS per rolling WINDOW_MS) so a renderer that
// dies immediately on boot cannot reload-loop forever. Pure on purpose — the
// window lifecycle wiring lives in main.ts, this stays unit-testable.

/** Delay before reloading a crashed renderer, letting the process fully exit. */
export const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
/** Max reloads per rolling window (a boot-crash must not reload-loop). */
export const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
/** Rolling window over which reload attempts are counted. */
export const RENDERER_RECOVERY_WINDOW_MS = 60_000;

export type RendererRecoveryGate = {
  /**
   * Prunes expired attempts, then reports whether another reload is allowed
   * within the rolling window — recording the attempt when it is. False once
   * MAX_ATTEMPTS reloads have happened in WINDOW_MS; true again once the
   * earliest attempt ages out of the window.
   */
  requestRecovery(now: number): boolean;
};

/** Bounded reload gate for `render-process-gone` recovery. One per window. */
export function createRendererRecoveryGate(
  maxAttempts = RENDERER_RECOVERY_MAX_ATTEMPTS,
  windowMs = RENDERER_RECOVERY_WINDOW_MS,
): RendererRecoveryGate {
  let attempts: number[] = [];

  return {
    requestRecovery(now: number): boolean {
      attempts = attempts.filter((timestamp) => now - timestamp < windowMs);
      if (attempts.length >= maxAttempts) return false;
      attempts.push(now);
      return true;
    },
  };
}
