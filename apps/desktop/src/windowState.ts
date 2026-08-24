import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { writeFileAtomicSync } from "./lib/atomicWrite.js";
import type { JsonValue } from "./lib/jsonValue.js";

import { app, type Rectangle, screen } from "electron";

// Persists the main window's size / position between launches so the app
// reopens the way the user left it. State lives in a small JSON file under the
// per-user app data directory.

export type WindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
  persistEnabled: boolean;
};

export type DisplayWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DEFAULT_STATE = { width: 1280, height: 840 };

const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

// How long a window must be idle after a resize/move before we write to disk.
const PERSIST_DEBOUNCE_MS = 400;

let cachedPath: string | null = null;
function stateFilePath() {
  cachedPath ??= path.join(app.getPath("userData"), "window-state.json");
  return cachedPath;
}

// Reads the persisted window-state JSON as-is; the caller validates it before
// trusting any field, so this reader names no domain type.
function readState(): JsonValue | null {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
  } catch {
    return null;
  }
}

const WindowStateWire = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  x: z.unknown().optional(),
  y: z.unknown().optional(),
  isMaximized: z.unknown().optional(),
});

/**
 * Validates the on-disk state and picks only the fields that are trustworthy.
 * A corrupt or non-finite entry collapses the whole state to null so the
 * caller falls back to the default window rather than opening an infinite or
 * zero-sized window.
 */
export function parsePersistedWindowState(value: JsonValue | null | undefined): {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
} | null {
  const parsed = WindowStateWire.safeParse(value);
  if (!parsed.success) return null;

  const state: Pick<WindowState, "width" | "height" | "x" | "y" | "isMaximized"> = {
    width: parsed.data.width,
    height: parsed.data.height,
    isMaximized: parsed.data.isMaximized === true,
  };

  // Coordinates are optional on disk; a missing or unusable one just means
  // Electron picks a position this launch. Only junk that parses as a finite
  // number is worth keeping.
  if (Number.isFinite(parsed.data.x)) {
    // SAFETY: Number.isFinite guarantees parsed.data.x is a finite number.
    state.x = parsed.data.x as number;
  }
  if (Number.isFinite(parsed.data.y)) {
    // SAFETY: Number.isFinite guarantees parsed.data.y is a finite number.
    state.y = parsed.data.y as number;
  }

  return state;
}

function intersectionArea(a: Rectangle, b: DisplayWorkArea): number {
  const overlapWidth = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  return overlapWidth * overlapHeight;
}

/**
 * Turns a parsed saved state into the bounds the window should open with,
 * choosing the display the window most overlaps and adjusting so the window
 * is always grabbable. When the saved position landed on a display that is no
 * longer connected, this centers instead of restoring off-screen — and flags
 * that the returned placement must not overwrite the saved coordinates yet.
 */
export function resolveVisibleWindowState(
  saved: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    isMaximized?: boolean;
  },
  workAreas: readonly DisplayWorkArea[],
): WindowState {
  const hasPosition = saved.x !== undefined && saved.y !== undefined;

  if (workAreas.length === 0) {
    return {
      width: Math.max(MIN_WIDTH, saved.width),
      height: Math.max(MIN_HEIGHT, saved.height),
      isMaximized: saved.isMaximized,
      // No display info, so the saved coordinates were dropped and must not be
      // overwritten until the user actually changes the window.
      persistEnabled: !hasPosition,
    };
  }

  const savedRect: Rectangle = {
    x: saved.x ?? 0,
    y: saved.y ?? 0,
    width: saved.width,
    height: saved.height,
  };

  // Pick the display the saved rectangle overlaps most. Without saved
  // coordinates there is nothing to match, so the first display stands in.
  // The empty-array case returned above, so the first display always exists.
  let chosenArea = workAreas[0]!;
  let chosenIntersection = 0;
  if (hasPosition) {
    for (const area of workAreas) {
      const intersection = intersectionArea(savedRect, area);
      if (intersection > chosenIntersection) {
        chosenIntersection = intersection;
        chosenArea = area;
      }
    }
  }

  // Clamp to the display's size, but never below the minimum — unless the
  // display itself is smaller, in which case the window fits the display.
  const width = Math.min(chosenArea.width, Math.max(MIN_WIDTH, saved.width));
  const height = Math.min(chosenArea.height, Math.max(MIN_HEIGHT, saved.height));

  let x: number;
  let y: number;
  if (chosenIntersection > 0) {
    // The window genuinely lives on this display; nudge it just enough to stay
    // fully on screen instead of replacing the user's placement.
    x = Math.min(
      Math.max(saved.x!, chosenArea.x),
      chosenArea.x + chosenArea.width - width,
    );
    y = Math.min(
      Math.max(saved.y!, chosenArea.y),
      chosenArea.y + chosenArea.height - height,
    );
  } else {
    // Fallback placement on a display the saved position no longer touches.
    // The original coordinates stay on disk until the user moves the window.
    x = chosenArea.x + (chosenArea.width - width) / 2;
    y = chosenArea.y + (chosenArea.height - height) / 2;
  }

  return {
    width,
    height,
    x,
    y,
    isMaximized: saved.isMaximized,
    persistEnabled: chosenIntersection > 0,
  };
}

/**
 * Returns the BrowserWindow options (width / height / x / y) to open with,
 * derived from the last saved session and made visible on the current display
 * layout. The returned `persistEnabled` tells the caller whether the window
 * may be written back as-is or is only a fallback placement.
 */
export function getInitialWindowState(): WindowState {
  const saved = parsePersistedWindowState(readState());
  if (!saved) {
    return { ...DEFAULT_STATE, persistEnabled: true };
  }

  let workAreas: DisplayWorkArea[] = [];
  try {
    const displays = screen.getAllDisplays();
    if (Array.isArray(displays)) {
      workAreas = displays.map(({ workArea }) => ({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height,
      }));
    }
  } catch {
    // Best-effort: if the display layout can't be read, let Electron place the
    // window itself this launch.
  }

  return resolveVisibleWindowState(saved, workAreas);
}

/**
 * Starts tracking a window and persists its bounds whenever they change
 * (debounced) and on close. While `persistEnabled` is false the saved
 * coordinates on disk are still the user's real placement, so close must not
 * overwrite them with the restored fallback bounds — only the first user
 * change flips tracking on and starts writing the new placement.
 */

/** The window surface this module actually touches; a real BrowserWindow
 *  satisfies it, and so does a test double. */
type ManagedWindow = {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): Rectangle;
  on(event: string, listener: () => void): void;
};

export function manageWindowState(
  win: ManagedWindow,
  options?: { persistEnabled?: boolean },
): void {
  let persistAllowed = options?.persistEnabled ?? true;
  let fallbackBounds: Rectangle | null = null;
  let fallbackMaximized = false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWritten = "";

  // Snapshot the fallback placement up front, before any user gesture can move
  // the window, so a later change is detected against the true starting bounds
  // rather than against a snapshot taken after the first move.
  if (!persistAllowed && !win.isDestroyed()) {
    fallbackBounds = win.getNormalBounds();
    fallbackMaximized = win.isMaximized();
  }

  const persist = () => {
    if (win.isDestroyed()) return;

    if (!persistAllowed) {
      const { width, height, x, y } = win.getNormalBounds();
      const maximized = win.isMaximized();
      const unchanged =
        fallbackBounds !== null &&
        fallbackBounds.x === x &&
        fallbackBounds.y === y &&
        fallbackBounds.width === width &&
        fallbackBounds.height === height &&
        fallbackMaximized === maximized;

      if (unchanged) return;

      // The window left the fallback placement, so the current bounds are now
      // the user's intent and must be persisted from here on.
      persistAllowed = true;
    }

    // Keep the *normal* (unmaximized) bounds so restoring works after the user
    // un-maximizes; getNormalBounds() reports those even while maximized.
    const { width, height, x, y } = win.getNormalBounds();
    const serialized = JSON.stringify(
      { width, height, x, y, isMaximized: win.isMaximized() },
      null,
      2,
    );

    // Skip the write when it would just repeat the last one: a debounced
    // move/resize that settles back on the same bounds, or a close that
    // follows a resize which already wrote these exact bounds.
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
  win.on("maximize", schedulePersist);
  win.on("unmaximize", schedulePersist);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    persist();
  });
  win.on("closed", () => {
    if (timer) clearTimeout(timer);
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
