import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

// windowState.ts imports electron bindings at module top (only used inside
// functions), and Bun cannot load the electron package outside Electron — so
// stub the package before importing the module under test. `shell`, `ipcMain`,
// and `nativeTheme` are required even though this file never calls them: an
// electron mock that omits a key leaks into later files that do. `displayError`
// lets tests simulate a broken
// display list so the getInitialWindowState fallback path is exercised.
type Rect = { x: number; y: number; width: number; height: number };

const USER_DATA = "/tmp/kone-window-state-test";
const displays: Array<{ workArea: Rect }> = [];
let displayError: Error | null = null;

mock.module("electron", () => ({
  app: { getPath: () => USER_DATA },
  screen: {
    getAllDisplays: () => {
      if (displayError) throw displayError;
      return displays;
    },
  },
  ipcMain: { handle: () => {} },
  nativeTheme: { themeSource: "system" },
  shell: {
    openPath: async () => "",
    showItemInFolder: () => {},
  },
}));

const {
  createRendererRecoveryGate,
  getInitialWindowState,
  manageWindowState,
  parsePersistedWindowState,
  RENDERER_RECOVERY_MAX_ATTEMPTS,
  RENDERER_RECOVERY_RELOAD_DELAY_MS,
  RENDERER_RECOVERY_WINDOW_MS,
  resolveVisibleWindowState,
} = await import("./windowState.js");

const STATE_FILE = path.join(USER_DATA, "window-state.json");
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };

function writeSavedState(state: unknown) {
  mkdirSync(USER_DATA, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

// A stand-in for BrowserWindow whose event registrations are recorded instead
// of wired to a real window. Bounds come from a getter so a test can simulate
// a user move by swapping the returned rectangle before firing the event.
function fakeWindow(getBounds: () => Rect) {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    isDestroyed: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    getNormalBounds: getBounds,
    on(event: string, fn: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return win;
    },
  };
  return { win, listeners };
}

afterEach(() => {
  displays.length = 0;
  displayError = null;
});

describe("renderer recovery gate", () => {
  test("allows up to MAX_ATTEMPTS reloads within the rolling window", () => {
    const gate = createRendererRecoveryGate();

    for (let i = 0; i < RENDERER_RECOVERY_MAX_ATTEMPTS; i++) {
      expect(gate.requestRecovery(1_000 + i)).toBe(true);
    }
    // Fourth attempt inside the window is denied — a boot-crash cannot loop.
    expect(gate.requestRecovery(1_000 + RENDERER_RECOVERY_MAX_ATTEMPTS)).toBe(false);
  });

  test("re-allows recovery once attempts age out of the window", () => {
    const gate = createRendererRecoveryGate();

    expect(gate.requestRecovery(0)).toBe(true);
    expect(gate.requestRecovery(1_000)).toBe(true);
    expect(gate.requestRecovery(2_000)).toBe(true);
    expect(gate.requestRecovery(3_000)).toBe(false);

    // First attempt (t=0) expired: window is 60s, so at t=60_001 only the
    // t=1_000 and t=2_000 attempts remain — room for one more.
    expect(gate.requestRecovery(RENDERER_RECOVERY_WINDOW_MS + 1)).toBe(true);
    expect(
      gate.requestRecovery(RENDERER_RECOVERY_WINDOW_MS + 2),
    ).toBe(false);
  });

  test("attempts recorded before the window are pruned, not counted", () => {
    const gate = createRendererRecoveryGate();

    expect(gate.requestRecovery(0)).toBe(true);
    expect(gate.requestRecovery(RENDERER_RECOVERY_WINDOW_MS * 2)).toBe(true);
    // Only one live attempt remains; a third inside the window is still fine.
    expect(gate.requestRecovery(RENDERER_RECOVERY_WINDOW_MS * 2 + 1)).toBe(true);
  });

  test("gates are per-window instances with independent counters", () => {
    const first = createRendererRecoveryGate();
    const second = createRendererRecoveryGate();

    for (let i = 0; i < RENDERER_RECOVERY_MAX_ATTEMPTS; i++) {
      expect(first.requestRecovery(1_000 + i)).toBe(true);
    }
    expect(first.requestRecovery(2_000)).toBe(false);
    expect(second.requestRecovery(2_000)).toBe(true);
  });

  test("defaults: 500ms reload delay, 3 attempts, 60s window", () => {
    expect(RENDERER_RECOVERY_RELOAD_DELAY_MS).toBe(500);
    expect(RENDERER_RECOVERY_MAX_ATTEMPTS).toBe(3);
    expect(RENDERER_RECOVERY_WINDOW_MS).toBe(60_000);
  });
});

describe("getInitialWindowState restore", () => {
  test("rejects non-finite saved dimensions instead of opening with Infinity", () => {
    displays.push({ workArea: PRIMARY });
    // JSON.stringify turns Infinity into null (already rejected). 1e309 is
    // valid JSON and JSON.parse yields Infinity — the hole `typeof ===
    // "number"` does not catch.
    mkdirSync(USER_DATA, { recursive: true });
    writeFileSync(
      STATE_FILE,
      '{"width":1e309,"height":800,"x":100,"y":80}',
    );

    const state = getInitialWindowState();

    expect(Number.isFinite(state.width)).toBe(true);
    expect(Number.isFinite(state.height)).toBe(true);
    expect(state.width).toBeGreaterThan(0);
    expect(state.height).toBeGreaterThan(0);
  });

  test("clamps a saved size that is larger than the current display", () => {
    displays.push({ workArea: PRIMARY });
    writeSavedState({ width: 3000, height: 2000, x: 0, y: 0 });

    const state = getInitialWindowState();

    expect(state.width).toBeLessThanOrEqual(PRIMARY.width);
    expect(state.height).toBeLessThanOrEqual(PRIMARY.height);
    expect(state.width).toBeGreaterThanOrEqual(960);
    expect(state.height).toBeGreaterThanOrEqual(640);
  });

  test("centers a window saved on an unplugged display instead of dropping x/y", () => {
    displays.push({ workArea: PRIMARY });
    writeSavedState({ width: 1280, height: 840, x: 4000, y: 3000 });

    const state = getInitialWindowState();

    expect(state.x).toBeDefined();
    expect(state.y).toBeDefined();
    expect(state.x! + state.width).toBeLessThanOrEqual(PRIMARY.x + PRIMARY.width);
    expect(state.y! + state.height).toBeLessThanOrEqual(PRIMARY.y + PRIMARY.height);
    expect(state.x!).toBeGreaterThanOrEqual(PRIMARY.x);
    expect(state.y!).toBeGreaterThanOrEqual(PRIMARY.y);
  });

  test("close without a user move does not overwrite unrestorable saved bounds", () => {
    displays.push({ workArea: PRIMARY });
    const saved = { width: 1280, height: 840, x: 4000, y: 80, isMaximized: false };
    writeSavedState(saved);

    const restored = getInitialWindowState();
    const fallbackBounds = {
      x: restored.x ?? 80,
      y: restored.y ?? 60,
      width: restored.width,
      height: restored.height,
    };
    const listeners = new Map<string, Array<() => void>>();
    const win = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      getNormalBounds: () => fallbackBounds,
      on(event: string, fn: () => void) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
        return win;
      },
    };
    manageWindowState(win, { persistEnabled: restored.persistEnabled });
    for (const fn of listeners.get("close") ?? []) fn();

    const onDisk: { x?: number; y?: number } = JSON.parse(
      readFileSync(STATE_FILE, "utf8"),
    );
    expect(onDisk.x).toBe(4000);
    expect(onDisk.y).toBe(80);
  });

  test("falls back to finite defaults when the display list is unavailable", () => {
    displays.push({ workArea: PRIMARY });
    writeSavedState({ width: 1280, height: 840, x: 4000, y: 3000 });
    displayError = new Error("display service unavailable");

    const state = getInitialWindowState();

    expect(Number.isFinite(state.width)).toBe(true);
    expect(Number.isFinite(state.height)).toBe(true);
    expect(state.width).toBeGreaterThan(0);
    expect(state.height).toBeGreaterThan(0);
  });
});

describe("parsePersistedWindowState", () => {
  test("accepts a well-formed persisted state", () => {
    const parsed = parsePersistedWindowState({
      width: 1100,
      height: 780,
      x: 120,
      y: 80,
      isMaximized: true,
    });

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      width: 1100,
      height: 780,
      x: 120,
      y: 80,
      isMaximized: true,
    });
  });

  test("rejects a non-positive, non-number, or missing width", () => {
    const rejects = (value: unknown) =>
      expect(parsePersistedWindowState(value)).toBeNull();

    rejects({ width: -1, height: 800 });
    rejects({ width: 0, height: 800 });
    rejects({ width: null, height: 800 });
    rejects({ height: 800 });
  });

  test("rejects a non-object value", () => {
    expect(parsePersistedWindowState(null)).toBeNull();
    expect(parsePersistedWindowState("window")).toBeNull();
    expect(parsePersistedWindowState(42)).toBeNull();
  });

  test("rejects a width of 1e309, which JSON.parse turns into Infinity", () => {
    const parsed = JSON.parse('{"width":1e309,"height":800}');

    expect(parsed.width).toBe(Infinity);
    expect(parsePersistedWindowState(parsed)).toBeNull();
  });

  test("omits x when it is not a number but still returns width and height", () => {
    const parsed = parsePersistedWindowState({
      width: 1100,
      height: 780,
      x: "off-screen",
      y: 80,
    });

    expect(parsed).not.toBeNull();
    expect(parsed!.width).toBe(1100);
    expect(parsed!.height).toBe(780);
    expect(parsed!.x).toBeUndefined();
  });
});

describe("resolveVisibleWindowState", () => {
  const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

  test("keeps visible saved bounds unchanged with persistEnabled true", () => {
    const resolved = resolveVisibleWindowState(
      { width: 1200, height: 800, x: 100, y: 90 },
      [WORK_AREA],
    );

    expect(resolved.x).toBe(100);
    expect(resolved.y).toBe(90);
    expect(resolved.width).toBe(1200);
    expect(resolved.height).toBe(800);
    expect(resolved.persistEnabled).toBe(true);
  });

  test("centers off-screen saved bounds on the work area with persistEnabled false", () => {
    const resolved = resolveVisibleWindowState(
      { width: 1280, height: 840, x: 4000, y: 3000 },
      [WORK_AREA],
    );

    expect(resolved.width).toBe(1280);
    expect(resolved.height).toBe(840);
    expect(resolved.x).toBe(320);
    expect(resolved.y).toBe(100);
    expect(resolved.x!).toBeGreaterThanOrEqual(WORK_AREA.x);
    expect(resolved.y!).toBeGreaterThanOrEqual(WORK_AREA.y);
    expect(resolved.x! + resolved.width).toBeLessThanOrEqual(WORK_AREA.x + WORK_AREA.width);
    expect(resolved.y! + resolved.height).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height);
    expect(resolved.persistEnabled).toBe(false);
  });

  test("clamps an oversized saved size to the work area with persistEnabled true", () => {
    const resolved = resolveVisibleWindowState(
      { width: 3000, height: 2000, x: 0, y: 0 },
      [WORK_AREA],
    );

    expect(resolved.width).toBeLessThanOrEqual(WORK_AREA.width);
    expect(resolved.height).toBeLessThanOrEqual(WORK_AREA.height);
    expect(resolved.width).toBeLessThan(3000);
    expect(resolved.height).toBeLessThan(2000);
    expect(resolved.x).toBe(0);
    expect(resolved.y).toBe(0);
    expect(resolved.persistEnabled).toBe(true);
  });

  test("keeps bounds on the display with the largest intersection", () => {
    const secondDisplay = { x: 1920, y: 0, width: 1920, height: 1040 };
    const resolved = resolveVisibleWindowState(
      { width: 1000, height: 700, x: 2100, y: 100 },
      [WORK_AREA, secondDisplay],
    );

    expect(resolved.x).toBe(2100);
    expect(resolved.y).toBe(100);
    expect(resolved.width).toBe(1000);
    expect(resolved.height).toBe(700);
    expect(resolved.persistEnabled).toBe(true);
  });

  test("omits x and y when no work areas are available and reports persistEnabled false", () => {
    const resolved = resolveVisibleWindowState(
      { width: 1200, height: 800, x: 100, y: 90 },
      [],
    );

    expect(resolved.width).toBe(1200);
    expect(resolved.height).toBe(800);
    expect(resolved.x).toBeUndefined();
    expect(resolved.y).toBeUndefined();
    expect(resolved.persistEnabled).toBe(false);
  });
});

describe("manageWindowState", () => {
  test("writes the new bounds after a user move from an off-display restore", () => {
    displays.push({ workArea: PRIMARY });
    writeSavedState({ width: 1280, height: 840, x: 4000, y: 3000 });

    const restored = getInitialWindowState();
    expect(restored.persistEnabled).toBe(false);

    let bounds = {
      x: restored.x ?? 80,
      y: restored.y ?? 60,
      width: restored.width,
      height: restored.height,
    };
    const { win, listeners } = fakeWindow(() => bounds);
    manageWindowState(win, { persistEnabled: restored.persistEnabled });

    bounds = { x: 200, y: 150, width: restored.width, height: restored.height };
    for (const fn of listeners.get("move") ?? []) fn();
    for (const fn of listeners.get("close") ?? []) fn();

    const onDisk: { x?: number; y?: number } = JSON.parse(
      readFileSync(STATE_FILE, "utf8"),
    );
    expect(onDisk.x).toBe(200);
    expect(onDisk.y).toBe(150);
  });

  test("registers a maximize listener", () => {
    const { win, listeners } = fakeWindow(() => ({ x: 0, y: 0, width: 1280, height: 840 }));

    manageWindowState(win, { persistEnabled: true });

    expect(listeners.has("maximize")).toBe(true);
  });
});
