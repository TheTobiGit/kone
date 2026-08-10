import { describe, expect, mock, test } from "bun:test";

// windowState.ts imports electron bindings at module top (only used inside
// functions), and Bun cannot load the electron package outside Electron — so
// stub the package before importing the module under test.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/kone-test" },
  screen: { getAllDisplays: () => [] },
}));

const {
  createRendererRecoveryGate,
  RENDERER_RECOVERY_MAX_ATTEMPTS,
  RENDERER_RECOVERY_RELOAD_DELAY_MS,
  RENDERER_RECOVERY_WINDOW_MS,
} = await import("./windowState.js");

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
